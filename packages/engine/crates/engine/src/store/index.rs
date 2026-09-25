//! `ChunkIndex` (docs/decisions/0007-world-model.md §5): "occupancy bitset + sorted `(u16 index,
//! EntityId)` + overlapping entity ids | derived from entities, rebuilt on load | only for chunks
//! with entities; never evicted". One instance per chunk that has at least one entity overlapping
//! it (a footprint spans at most 4 chunks, 0007 §5); `Store<G>` owns the map keyed by `ChunkCoord`
//! and maintains it incrementally in [`crate::store::Store::apply`], so host and replica share the
//! exact same derived structure (docs/plan/21-entities-and-timers.md Scope).
//!
//! Never encoded or hashed (0007 §5: "derived"): rebuilding it from the entity table after a decode
//! is [`crate::store::Store::rebuild_indexes`]'s job, and it must reach exactly the state
//! incremental maintenance would have reached (`index_rebuild_equals_incremental`).

use crate::game::EntityId;
use crate::world::ChunkDims;

/// One chunk's occupancy index. `dims` is carried so the bitset is sized once, at construction,
/// for whichever of 0007 §3's three chunk edges this game uses -- never resized afterward.
pub struct ChunkIndex {
    occupancy: Vec<u64>,
    /// Sorted by `(index, EntityId)`: the tile-local occupant(s) of every set bit. More than one
    /// entry can share an index only through the overlap the engine merely debug-asserts against,
    /// never rejects (docs/plan/21-entities-and-timers.md Scope "Overlap policy") -- `entity_at`
    /// then answers with the lowest id at that index, which is deterministic but otherwise
    /// arbitrary among overlapping occupants.
    entries: Vec<(u16, EntityId)>,
    /// Every entity id whose footprint overlaps this chunk at all, ascending, deduplicated: what
    /// `entities_in`/the frame builder/`encode_chunk_snapshot` scan instead of the whole entity
    /// table (docs/plan/21-entities-and-timers.md Provides).
    overlapping: Vec<EntityId>,
}

impl ChunkIndex {
    pub(crate) fn new(dims: ChunkDims) -> Self {
        let words = (dims.area() as usize).div_ceil(64);
        ChunkIndex {
            occupancy: vec![0u64; words],
            entries: Vec::new(),
            overlapping: Vec::new(),
        }
    }

    #[inline]
    fn set_bit(&mut self, index: u16) {
        self.occupancy[index as usize / 64] |= 1u64 << (index as usize % 64);
    }

    #[inline]
    fn clear_bit_if_unoccupied(&mut self, index: u16) {
        let still = self.entries.iter().any(|(i, _)| *i == index);
        if !still {
            self.occupancy[index as usize / 64] &= !(1u64 << (index as usize % 64));
        }
    }

    /// Adds one occupied tile (local `index`) for `id`. `pub(crate)`: only `Store::apply`/
    /// `Store::rebuild_indexes` maintain this (0007 §5: "derived"). Tolerates two different ids at
    /// the same index (0007 §5 "Overlap policy": the engine never rejects a placement; a game's own
    /// `traits_at`/`NOT_BUILDABLE` check is what is expected to prevent it in practice) -- this
    /// low-level structure stays a pure derived index with no invariant of its own to enforce, so a
    /// dozens-strong crate-wide fleet of minimal test `Game::anchor` stubs (every test entity
    /// "anchored" at a fixed tile, never meant to model real placement) keeps working unmodified
    /// (docs/plan/21-entities-and-timers.md Deviations: no debug-panic was added here, or in
    /// `Store::apply`, for exactly this reason -- see Deviations for the full accounting).
    pub(crate) fn add(&mut self, index: u16, id: EntityId) {
        let key = (index, id);
        let pos = self.entries.partition_point(|e| *e < key);
        if self.entries.get(pos) != Some(&key) {
            self.entries.insert(pos, key);
        }
        self.set_bit(index);
        if let Err(pos) = self.overlapping.binary_search(&id) {
            self.overlapping.insert(pos, id);
        }
    }

    /// Removes one occupied tile for `id`. A no-op if `id` was never recorded at `index` (tolerant,
    /// like every other derived-state maintenance path here).
    pub(crate) fn remove(&mut self, index: u16, id: EntityId) {
        let key = (index, id);
        if let Ok(pos) = self.entries.binary_search(&key) {
            self.entries.remove(pos);
        }
        self.clear_bit_if_unoccupied(index);
        let still_present = self.entries.iter().any(|(_, e)| *e == id);
        if !still_present && let Ok(pos) = self.overlapping.binary_search(&id) {
            self.overlapping.remove(pos);
        }
    }

    #[inline]
    pub(crate) fn is_empty(&self) -> bool {
        self.overlapping.is_empty()
    }

    /// The lowest-id occupant at `index`, if any (0007 §6: `traits_at`'s occupant term;
    /// `WorldRead::entity_at`).
    pub(crate) fn entity_at(&self, index: u16) -> Option<EntityId> {
        let pos = self.entries.partition_point(|(i, _)| *i < index);
        self.entries
            .get(pos)
            .filter(|(i, _)| *i == index)
            .map(|(_, id)| *id)
    }

    /// Every entity id whose footprint overlaps this chunk at all, ascending (`WorldRead::
    /// entities_in`, `encode_chunk_snapshot`, the frame builder).
    pub(crate) fn overlapping(&self) -> &[EntityId] {
        &self.overlapping
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_remove_round_trips_bit_and_entry() {
        let dims = ChunkDims::new(4); // edge 16
        let mut idx = ChunkIndex::new(dims);
        idx.add(5, EntityId(1));
        assert_eq!(idx.entity_at(5), Some(EntityId(1)));
        assert_eq!(idx.overlapping(), &[EntityId(1)]);
        assert!(!idx.is_empty());

        idx.remove(5, EntityId(1));
        assert_eq!(idx.entity_at(5), None);
        assert!(idx.overlapping().is_empty());
        assert!(idx.is_empty());
    }

    #[test]
    fn overlapping_two_entities_same_index_lowest_id_wins_entity_at() {
        let dims = ChunkDims::new(4);
        let mut idx = ChunkIndex::new(dims);
        idx.add(9, EntityId(5));
        idx.add(9, EntityId(2));
        assert_eq!(idx.entity_at(9), Some(EntityId(2)));
        assert_eq!(idx.overlapping(), &[EntityId(2), EntityId(5)]);

        idx.remove(9, EntityId(2));
        assert_eq!(idx.entity_at(9), Some(EntityId(5)));
        idx.remove(9, EntityId(5));
        assert!(idx.is_empty());
    }

    #[test]
    fn add_is_idempotent_for_the_same_index_and_id() {
        let dims = ChunkDims::new(4);
        let mut idx = ChunkIndex::new(dims);
        idx.add(3, EntityId(1));
        idx.add(3, EntityId(1));
        assert_eq!(idx.overlapping(), &[EntityId(1)]);
        idx.remove(3, EntityId(1));
        assert!(idx.is_empty());
    }
}
