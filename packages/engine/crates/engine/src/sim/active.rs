//! Per-system active lists (docs/decisions/0007-world-model.md §7: "per-system active lists in
//! deterministic (insertion) order"; docs/plan/21b-timers-wakeups-and-tickcx.md Scope "Active
//! lists"). `activate`/`deactivate` are idempotent; a removal during the current tick's iteration
//! is a tombstone (the slot becomes `None`, `active_len` unchanged) so indices already handed out
//! this tick stay valid, and compaction (physically dropping tombstones, closing the gaps) happens
//! only at the next fixed point (`Authority::end_tick`, alongside the wake queue's own swap).

use std::collections::BTreeMap;

use crate::bytes::{ByteReader, ByteSink};
use crate::codec::CodecError;
use crate::game::EntityId;
use crate::world::SystemId;

#[derive(Default)]
struct ActiveList {
    items: Vec<Option<EntityId>>,
    index_of: BTreeMap<EntityId, usize>,
}

impl ActiveList {
    fn activate(&mut self, id: EntityId) {
        if let Some(&idx) = self.index_of.get(&id) {
            if self.items[idx].is_none() {
                // Reactivating a still-tombstoned (not yet compacted) entry: restore it in place
                // rather than appending a second entry for the same id.
                self.items[idx] = Some(id);
            }
            // Else: already active, idempotent no-op.
            return;
        }
        let idx = self.items.len();
        self.items.push(Some(id));
        self.index_of.insert(id, idx);
    }

    fn deactivate(&mut self, id: EntityId) {
        if let Some(&idx) = self.index_of.get(&id) {
            self.items[idx] = None;
        }
        // Not present at all: idempotent no-op.
    }

    fn len(&self) -> usize {
        self.items.len()
    }

    fn at(&self, i: usize) -> Option<EntityId> {
        self.items.get(i).copied().flatten()
    }

    /// Physically drops every tombstone, closing gaps while preserving the relative insertion
    /// order of the survivors (docs/plan/21b-timers-wakeups-and-tickcx.md Scope: "tombstone then
    /// compact").
    fn compact(&mut self) {
        if self.items.iter().all(Option::is_some) {
            return; // nothing to compact: no reallocation on the common, steady-state path.
        }
        let mut compacted = Vec::with_capacity(self.items.len());
        self.index_of.clear();
        for id in self.items.drain(..).flatten() {
            self.index_of.insert(id, compacted.len());
            compacted.push(Some(id));
        }
        self.items = compacted;
    }

    fn write_canonical(&self, sink: &mut impl ByteSink) {
        sink.put_u32(self.items.len() as u32);
        for slot in &self.items {
            match slot {
                Some(id) => {
                    sink.put_u8(1);
                    sink.put_u32(id.0);
                }
                None => sink.put_u8(0),
            }
        }
    }

    fn decode(reader: &mut ByteReader) -> Result<Self, CodecError> {
        let count = reader.u32()?;
        let mut items = Vec::with_capacity(count as usize);
        let mut index_of = BTreeMap::new();
        for _ in 0..count {
            let tag = reader.u8()?;
            if tag == 0 {
                items.push(None);
            } else {
                let id = EntityId(reader.u32()?);
                index_of.insert(id, items.len());
                items.push(Some(id));
            }
        }
        Ok(ActiveList { items, index_of })
    }
}

/// [`SystemId::MAX`] fixed lists, indexed by [`SystemId`]. `Default` gives 16 empty lists with no
/// allocation (an empty `Vec`/`BTreeMap` allocates nothing until its first push).
pub(crate) struct ActiveLists {
    systems: [ActiveList; SystemId::MAX],
}

impl Default for ActiveLists {
    fn default() -> Self {
        ActiveLists {
            systems: std::array::from_fn(|_| ActiveList::default()),
        }
    }
}

impl ActiveLists {
    pub(crate) fn new() -> Self {
        ActiveLists::default()
    }

    pub(crate) fn activate(&mut self, sys: SystemId, id: EntityId) {
        self.systems[sys.index()].activate(id);
    }

    pub(crate) fn deactivate(&mut self, sys: SystemId, id: EntityId) {
        self.systems[sys.index()].deactivate(id);
    }

    /// `despawn` (0007 §5/§7: "despawn deactivates everywhere"): every system, not just one.
    pub(crate) fn deactivate_everywhere(&mut self, id: EntityId) {
        for sys in &mut self.systems {
            sys.deactivate(id);
        }
    }

    pub(crate) fn len(&self, sys: SystemId) -> usize {
        self.systems[sys.index()].len()
    }

    pub(crate) fn at(&self, sys: SystemId, i: usize) -> Option<EntityId> {
        self.systems[sys.index()].at(i)
    }

    /// `Authority::end_tick`: every system's own tombstones, in one pass.
    pub(crate) fn compact_all(&mut self) {
        for sys in &mut self.systems {
            sys.compact();
        }
    }

    /// `Store::write_canonical`/`hash_state`: system order, then each system's own insertion order
    /// (docs/plan/21b-timers-wakeups-and-tickcx.md Scope). Called only between ticks (after
    /// `Authority::end_tick`'s own compaction), so no tombstone is ever observed here in practice --
    /// `ActiveList::write_canonical` still encodes the tag byte defensively, so a mid-tick call
    /// (native tests only) round-trips exactly rather than silently dropping data.
    pub(crate) fn write_canonical(&self, sink: &mut impl ByteSink) {
        for sys in &self.systems {
            sys.write_canonical(sink);
        }
    }

    pub(crate) fn decode(reader: &mut ByteReader) -> Result<Self, CodecError> {
        let mut systems: [ActiveList; SystemId::MAX] =
            std::array::from_fn(|_| ActiveList::default());
        for sys in &mut systems {
            *sys = ActiveList::decode(reader)?;
        }
        Ok(ActiveLists { systems })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sys(n: u8) -> SystemId {
        SystemId(n)
    }

    #[test]
    fn activate_deactivate_idempotent() {
        let mut a = ActiveLists::new();
        a.activate(sys(0), EntityId(1));
        a.activate(sys(0), EntityId(1)); // idempotent
        assert_eq!(a.len(sys(0)), 1);
        a.deactivate(sys(0), EntityId(2)); // never active: no-op
        assert_eq!(a.len(sys(0)), 1);
    }

    #[test]
    fn insertion_order() {
        let mut a = ActiveLists::new();
        a.activate(sys(1), EntityId(3));
        a.activate(sys(1), EntityId(1));
        a.activate(sys(1), EntityId(2));
        assert_eq!(a.at(sys(1), 0), Some(EntityId(3)));
        assert_eq!(a.at(sys(1), 1), Some(EntityId(1)));
        assert_eq!(a.at(sys(1), 2), Some(EntityId(2)));
    }

    #[test]
    fn iteration_stable_under_deactivate_until_compaction() {
        let mut a = ActiveLists::new();
        a.activate(sys(0), EntityId(1));
        a.activate(sys(0), EntityId(2));
        a.activate(sys(0), EntityId(3));
        let len_before = a.len(sys(0));

        // Deactivating mid-"iteration" must not shrink the list or move any other index this tick.
        a.deactivate(sys(0), EntityId(2));
        assert_eq!(a.len(sys(0)), len_before, "indices stable within a tick");
        assert_eq!(a.at(sys(0), 0), Some(EntityId(1)));
        assert_eq!(a.at(sys(0), 1), None, "tombstoned, not yet compacted");
        assert_eq!(a.at(sys(0), 2), Some(EntityId(3)));

        a.compact_all();
        assert_eq!(a.len(sys(0)), 2, "compaction drops the tombstone");
        assert_eq!(a.at(sys(0), 0), Some(EntityId(1)));
        assert_eq!(a.at(sys(0), 1), Some(EntityId(3)));
    }

    #[test]
    fn reactivate_before_compaction_undoes_the_tombstone_in_place() {
        let mut a = ActiveLists::new();
        a.activate(sys(0), EntityId(1));
        a.activate(sys(0), EntityId(2));
        a.deactivate(sys(0), EntityId(1));
        a.activate(sys(0), EntityId(1));
        assert_eq!(a.len(sys(0)), 2, "no duplicate entry for the same id");
        assert_eq!(a.at(sys(0), 0), Some(EntityId(1)));
        assert_eq!(a.at(sys(0), 1), Some(EntityId(2)));
    }

    #[test]
    fn despawn_deactivates_every_system() {
        let mut a = ActiveLists::new();
        a.activate(sys(0), EntityId(1));
        a.activate(sys(1), EntityId(1));
        a.deactivate_everywhere(EntityId(1));
        a.compact_all();
        assert_eq!(a.len(sys(0)), 0);
        assert_eq!(a.len(sys(1)), 0);
    }

    #[test]
    fn roundtrip() {
        let mut a = ActiveLists::new();
        a.activate(sys(2), EntityId(5));
        a.activate(sys(2), EntityId(7));
        a.activate(sys(15), EntityId(1));
        let mut buf = Vec::new();
        struct V<'a>(&'a mut Vec<u8>);
        impl ByteSink for V<'_> {
            fn put(&mut self, b: &[u8]) {
                self.0.extend_from_slice(b);
            }
        }
        a.write_canonical(&mut V(&mut buf));
        let mut reader = ByteReader::new(&buf);
        let r = ActiveLists::decode(&mut reader).unwrap();
        assert_eq!(r.at(sys(2), 0), Some(EntityId(5)));
        assert_eq!(r.at(sys(2), 1), Some(EntityId(7)));
        assert_eq!(r.at(sys(15), 0), Some(EntityId(1)));
        assert_eq!(r.len(sys(0)), 0);
    }
}
