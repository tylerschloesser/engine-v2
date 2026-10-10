//! The timer wheel (docs/decisions/0007-world-model.md §7: "a timer wheel keyed `(tick,
//! EntityId)`"; M21b Scope "Timer wheel"): at most one timer
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

use std::collections::{BTreeMap, VecDeque};

use crate::bytes::{ByteReader, ByteSink};
use crate::codec::CodecError;
use crate::game::EntityId;
use crate::time::Tick;

/// Ids below this index the dense reverse table (M39ae); ids at or above it use `overflow`, a
/// `BTreeMap`. Entity ids are allocated sequentially from 0 and come from an untrusted snapshot
/// (`decode`), so the table must never be sized from an attacker-chosen id: `Reverse::slot` is the
/// one place that grows it, and refuses to grow past this bound (8 MB at 8 bytes an entry). Both
/// paths answer identically, so which one an id takes is not observable (same canonical bytes).
const DENSE_LIMIT: u32 = 1 << 20;

/// The reverse index `id -> its one timer tick`: dense for `id < DENSE_LIMIT`, a map beyond.
#[derive(Default)]
struct Reverse {
    dense: Vec<Option<Tick>>,
    overflow: BTreeMap<EntityId, Tick>,
    count: usize,
}

impl Reverse {
    fn get(&self, id: EntityId) -> Option<Tick> {
        if id.0 < DENSE_LIMIT {
            self.dense.get(id.0 as usize).copied().flatten()
        } else {
            self.overflow.get(&id).copied()
        }
    }

    fn insert(&mut self, id: EntityId, at: Tick) -> Option<Tick> {
        let old = if id.0 < DENSE_LIMIT {
            let i = id.0 as usize;
            if i >= self.dense.len() {
                // Grow geometrically but never past the bound (the check above caps `i`).
                let want = (i + 1).max(self.dense.len() * 2).min(DENSE_LIMIT as usize);
                self.dense.resize(want, None);
            }
            self.dense[i].replace(at)
        } else {
            self.overflow.insert(id, at)
        };
        if old.is_none() {
            self.count += 1;
        }
        old
    }

    fn remove(&mut self, id: EntityId) -> Option<Tick> {
        let old = if id.0 < DENSE_LIMIT {
            self.dense.get_mut(id.0 as usize).and_then(Option::take)
        } else {
            self.overflow.remove(&id)
        };
        if old.is_some() {
            self.count -= 1;
        }
        old
    }
}

#[derive(Default)]
pub(crate) struct TimerWheel {
    wheel: BTreeMap<Tick, VecDeque<EntityId>>,
    by_entity: Reverse,
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
        let old = self.by_entity.remove(id)?;
        self.remove_from_bucket(id, old);
        Some(old)
    }

    /// Pops the earliest due entry (`tick <= now`) in key order, or `None` if the earliest entry
    /// (if any) is not yet due. Within a tied tick, the bucket's own sorted `Vec` gives ascending
    /// id order.
    pub(crate) fn next_due(&mut self, now: Tick) -> Option<EntityId> {
        let mut entry = self.wheel.first_entry()?;
        if *entry.key() > now {
            return None;
        }
        let bucket = entry.get_mut();
        // `pop_front`, not `Vec::remove(0)` (M39y): draining a bucket of N ids that way moved the
        // rest of it on every pop, N^2/2 id moves per tick (13 MB for the large save's 2,621).
        let id = bucket.pop_front().expect("a bucket is never left empty");
        if bucket.is_empty() {
            entry.remove();
        }
        self.by_entity.remove(id);
        Some(id)
    }

    pub(crate) fn len(&self) -> usize {
        self.by_entity.count
    }

    /// Non-mutating peek (the undo journal's own pre-image capture, docs/plan/
    /// 21b-timers-wakeups-and-tickcx.md fix round 1): `id`'s current timer tick, if any, without
    /// removing it.
    pub(crate) fn tick_of(&self, id: EntityId) -> Option<Tick> {
        self.by_entity.get(id)
    }

    /// `Store::write_canonical`/`hash_state`: key order (M21b
    /// Scope "timers (key order)") -- the wheel's own bucket order, then each bucket's own sorted
    /// order, which together are exactly `(Tick, EntityId)` ascending.
    pub(crate) fn write_canonical(&self, sink: &mut impl ByteSink) {
        sink.put_u32(self.by_entity.count as u32);
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
            w.wheel.entry(tick).or_default().push_back(id);
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

    /// M39ae: an id from an untrusted snapshot never sizes the dense table. A huge id takes the
    /// overflow map, answers exactly as a small one does, and round-trips byte for byte.
    #[test]
    fn huge_id_never_grows_the_dense_table() {
        let huge = EntityId(0x7fff_fff0);
        let mut w = TimerWheel::new();
        w.wake_at(EntityId(3), Tick(7));
        w.wake_at(huge, Tick(7));
        assert!(
            w.by_entity.dense.len() <= DENSE_LIMIT as usize,
            "the dense table is bounded"
        );
        assert!(
            w.by_entity.dense.len() < 1000,
            "and sized by small ids only"
        );
        assert_eq!(w.len(), 2);
        assert_eq!(w.tick_of(huge), Some(Tick(7)));
        assert_eq!(w.wake_at(huge, Tick(9)), Some(Tick(7)));

        let mut buf = Vec::new();
        struct V<'a>(&'a mut Vec<u8>);
        impl ByteSink for V<'_> {
            fn put(&mut self, b: &[u8]) {
                self.0.extend_from_slice(b);
            }
        }
        w.write_canonical(&mut V(&mut buf));
        let mut r = TimerWheel::decode(&mut ByteReader::new(&buf)).unwrap();
        assert!(r.by_entity.dense.len() < 1000, "decode is bounded too");
        assert_eq!(r.len(), 2);
        assert_eq!(r.next_due(Tick(7)), Some(EntityId(3)));
        assert_eq!(r.next_due(Tick(9)), Some(huge));
        assert_eq!(r.cancel(huge), None);
        assert_eq!(r.len(), 0);
    }
}
