//! The timer wheel (docs/decisions/0007-world-model.md §7: "a timer wheel keyed `(tick,
//! EntityId)`"; docs/plan/21b-timers-wakeups-and-tickcx.md Scope "Timer wheel"): at most one timer
//! per entity, `wake_at` replaces, `cancel_wake`/despawn removes, `next_due` pops entries with
//! `tick <= now` in key order.
//!
//! **Bucketed, not a flat `BTreeMap<(Tick, EntityId), ()>`** (Scope: "implementation free ... as
//! long as ... steady state does not allocate"): a flat map's every `wake_at` reschedule inserts a
//! *new* key (the tick strictly increases each cycle) while removing an old, scattered one --
//! empirically this leaves `std::collections::BTreeMap` with slowly, unboundedly growing node
//! storage even at a constant live-entry count (`tick_state_steady_no_alloc`'s own Deviations entry
//! has the measured numbers), because inserts always land at the high end while removals happen
//! throughout the tree. Bucketing by `Tick` first (`BTreeMap<Tick, Vec<EntityId>>`, each bucket
//! sorted by id for key order within a tie) keeps the outer map's *own* key churn bounded by the
//! number of distinct ticks with at least one pending entity -- small and, for a periodic workload,
//! eventually constant -- while the actual per-entity churn moves into `Vec::insert`/`remove`,
//! which reuses its own already-`realloc`'d capacity once warm. `by_entity` is the reverse index
//! `wake_at`/`cancel` need to find and remove an entity's *current* bucket entry in O(log n) without
//! a linear scan.

use std::collections::BTreeMap;

use crate::bytes::{ByteReader, ByteSink};
use crate::codec::CodecError;
use crate::game::EntityId;
use crate::time::Tick;

#[derive(Default)]
pub(crate) struct TimerWheel {
    wheel: BTreeMap<Tick, Vec<EntityId>>,
    by_entity: BTreeMap<EntityId, Tick>,
}

impl TimerWheel {
    pub(crate) fn new() -> Self {
        TimerWheel::default()
    }

    /// Removes `id` from its current bucket (if any), dropping the bucket entirely once empty.
    fn remove_from_bucket(&mut self, id: EntityId, at: Tick) {
        if let Some(v) = self.wheel.get_mut(&at) {
            if let Ok(pos) = v.binary_search(&id) {
                v.remove(pos);
            }
            if v.is_empty() {
                self.wheel.remove(&at);
            }
        }
    }

    /// Sets `id`'s one timer to `at`, replacing any existing one (0007 §7: "at most one timer per
    /// entity"). Returns the previous tick, if any (the undo journal's own rollback value).
    pub(crate) fn wake_at(&mut self, id: EntityId, at: Tick) -> Option<Tick> {
        let old = self.by_entity.insert(id, at);
        if let Some(old_tick) = old {
            self.remove_from_bucket(id, old_tick);
        }
        let bucket = self.wheel.entry(at).or_default();
        if let Err(pos) = bucket.binary_search(&id) {
            bucket.insert(pos, id);
        }
        old
    }

    /// Removes `id`'s timer if any. Returns the removed tick (also used to restore an exact prior
    /// state: `set_exact(id, Some(tick))`/`set_exact(id, None)`).
    pub(crate) fn cancel(&mut self, id: EntityId) -> Option<Tick> {
        let old = self.by_entity.remove(&id)?;
        self.remove_from_bucket(id, old);
        Some(old)
    }

    /// Pops the earliest due entry (`tick <= now`) in key order, or `None` if the earliest entry
    /// (if any) is not yet due. Within a tied tick, the bucket's own sorted `Vec` gives ascending
    /// id order.
    pub(crate) fn next_due(&mut self, now: Tick) -> Option<EntityId> {
        let (&tick, _) = self.wheel.iter().next()?;
        if tick > now {
            return None;
        }
        let bucket = self
            .wheel
            .get_mut(&tick)
            .expect("just found by iter().next()");
        let id = bucket.remove(0);
        if bucket.is_empty() {
            self.wheel.remove(&tick);
        }
        self.by_entity.remove(&id);
        Some(id)
    }

    pub(crate) fn len(&self) -> usize {
        self.by_entity.len()
    }

    /// Non-mutating peek (the undo journal's own pre-image capture, docs/plan/
    /// 21b-timers-wakeups-and-tickcx.md fix round 1): `id`'s current timer tick, if any, without
    /// removing it.
    pub(crate) fn tick_of(&self, id: EntityId) -> Option<Tick> {
        self.by_entity.get(&id).copied()
    }

    /// `Store::write_canonical`/`hash_state`: key order (docs/plan/21b-timers-wakeups-and-tickcx.md
    /// Scope "timers (key order)") -- the wheel's own bucket order, then each bucket's own sorted
    /// order, which together are exactly `(Tick, EntityId)` ascending.
    pub(crate) fn write_canonical(&self, sink: &mut impl ByteSink) {
        sink.put_u32(self.by_entity.len() as u32);
        for (&tick, ids) in &self.wheel {
            for &id in ids {
                sink.put_u32(tick.0);
                sink.put_u32(id.0);
            }
        }
    }

    pub(crate) fn decode(reader: &mut ByteReader) -> Result<Self, CodecError> {
        let mut w = TimerWheel::default();
        let count = reader.u32()?;
        for _ in 0..count {
            let tick = Tick(reader.u32()?);
            let id = EntityId(reader.u32()?);
            w.wheel.entry(tick).or_default().push(id);
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
