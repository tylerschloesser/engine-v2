//! The timer wheel (docs/decisions/0007-world-model.md §7: "a timer wheel keyed `(tick,
//! EntityId)`"; docs/plan/21b-timers-wakeups-and-tickcx.md Scope "Timer wheel"): at most one timer
//! per entity, `wake_at` replaces, `cancel_wake`/despawn removes, `next_due` pops entries with
//! `tick <= now` in key order. A sorted `BTreeMap<(Tick, EntityId), ()>` gives exactly that
//! iteration order for free; `by_entity` is the reverse index `wake_at`/`cancel_wake` need to find
//! and remove an entity's *current* entry in O(log n) without a linear scan.

use std::collections::BTreeMap;

use crate::bytes::{ByteReader, ByteSink};
use crate::codec::CodecError;
use crate::game::EntityId;
use crate::time::Tick;

#[derive(Default)]
pub(crate) struct TimerWheel {
    wheel: BTreeMap<(Tick, EntityId), ()>,
    by_entity: BTreeMap<EntityId, Tick>,
}

impl TimerWheel {
    pub(crate) fn new() -> Self {
        TimerWheel::default()
    }

    /// Sets `id`'s one timer to `at`, replacing any existing one (0007 §7: "at most one timer per
    /// entity"). Returns the previous tick, if any (the undo journal's own rollback value).
    pub(crate) fn wake_at(&mut self, id: EntityId, at: Tick) -> Option<Tick> {
        let old = self.by_entity.insert(id, at);
        if let Some(old_tick) = old {
            self.wheel.remove(&(old_tick, id));
        }
        self.wheel.insert((at, id), ());
        old
    }

    /// Removes `id`'s timer if any. Returns the removed tick (also used to restore an exact prior
    /// state: `set_exact(id, Some(tick))`/`set_exact(id, None)`).
    pub(crate) fn cancel(&mut self, id: EntityId) -> Option<Tick> {
        let old = self.by_entity.remove(&id)?;
        self.wheel.remove(&(old, id));
        Some(old)
    }

    /// Pops the earliest due entry (`tick <= now`) in key order, or `None` if the earliest entry
    /// (if any) is not yet due. The wheel's own natural `BTreeMap` order is `(Tick, EntityId)`
    /// ascending, so the first entry is always the earliest.
    pub(crate) fn next_due(&mut self, now: Tick) -> Option<EntityId> {
        let (&(tick, id), _) = self.wheel.iter().next()?;
        if tick > now {
            return None;
        }
        self.wheel.remove(&(tick, id));
        self.by_entity.remove(&id);
        Some(id)
    }

    pub(crate) fn len(&self) -> usize {
        self.wheel.len()
    }

    /// `Store::write_canonical`/`hash_state`: key order (docs/plan/21b-timers-wakeups-and-tickcx.md
    /// Scope "timers (key order)") -- the wheel's own iteration order.
    pub(crate) fn write_canonical(&self, sink: &mut impl ByteSink) {
        sink.put_u32(self.wheel.len() as u32);
        for &(tick, id) in self.wheel.keys() {
            sink.put_u32(tick.0);
            sink.put_u32(id.0);
        }
    }

    pub(crate) fn decode(reader: &mut ByteReader) -> Result<Self, CodecError> {
        let mut w = TimerWheel::default();
        let count = reader.u32()?;
        for _ in 0..count {
            let tick = Tick(reader.u32()?);
            let id = EntityId(reader.u32()?);
            w.wheel.insert((tick, id), ());
            w.by_entity.insert(id, tick);
        }
        Ok(w)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fires_at_exact_tick_in_key_order() {
        let mut w = TimerWheel::new();
        w.wake_at(EntityId(2), Tick(5));
        w.wake_at(EntityId(1), Tick(5));
        w.wake_at(EntityId(3), Tick(6));

        assert_eq!(w.next_due(Tick(4)), None, "nothing due yet");
        assert_eq!(w.next_due(Tick(5)), Some(EntityId(1)), "lower id first");
        assert_eq!(w.next_due(Tick(5)), Some(EntityId(2)));
        assert_eq!(w.next_due(Tick(5)), None, "id 3 is not due until tick 6");
        assert_eq!(w.next_due(Tick(6)), Some(EntityId(3)));
        assert_eq!(w.next_due(Tick(100)), None, "wheel is empty");
    }

    #[test]
    fn wake_at_replaces() {
        let mut w = TimerWheel::new();
        w.wake_at(EntityId(1), Tick(5));
        let old = w.wake_at(EntityId(1), Tick(10));
        assert_eq!(old, Some(Tick(5)));
        assert_eq!(w.len(), 1);
        assert_eq!(w.next_due(Tick(5)), None, "old tick must be gone");
        assert_eq!(w.next_due(Tick(10)), Some(EntityId(1)));
    }

    #[test]
    fn cancel_removes() {
        let mut w = TimerWheel::new();
        w.wake_at(EntityId(1), Tick(5));
        assert_eq!(w.cancel(EntityId(1)), Some(Tick(5)));
        assert_eq!(w.cancel(EntityId(1)), None, "already cancelled");
        assert_eq!(w.next_due(Tick(5)), None);
    }

    #[test]
    fn roundtrip() {
        let mut w = TimerWheel::new();
        w.wake_at(EntityId(2), Tick(5));
        w.wake_at(EntityId(1), Tick(9));
        let mut buf = Vec::new();
        struct V<'a>(&'a mut Vec<u8>);
        impl ByteSink for V<'_> {
            fn put(&mut self, b: &[u8]) {
                self.0.extend_from_slice(b);
            }
        }
        w.write_canonical(&mut V(&mut buf));
        let mut reader = ByteReader::new(&buf);
        let mut r = TimerWheel::decode(&mut reader).unwrap();
        assert_eq!(r.next_due(Tick(5)), Some(EntityId(2)));
        assert_eq!(r.next_due(Tick(9)), Some(EntityId(1)));
    }
}
