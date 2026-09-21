//! Sparse per-chunk overlays: world state (docs/decisions/0007-world-model.md §1, §5). An overlay
//! never holds an entry equal to pristine (the canonical-overlay rule): state is a function of the
//! effective world, not of write history, so the modified-tile count can fall.
//!
//! Each entry also caches the pristine value it replaces, so a later canonical check needs no
//! regeneration (Planning decisions 5 of docs/plan/07-world-model-core.md). That cache is never
//! serialized or hashed and is filled only when the chunk is materialized, so it lives in a `Cell`:
//! [`ChunkOverlay::apply_onto`] (called from `TerrainStore::materialize`, which reads terrain
//! through `&self`, 0007 §1) learns it without needing `&mut` on the overlay.

use std::cell::Cell;
use std::collections::BTreeMap;

use super::coords::ChunkCoord;
use super::tile::Tile;

#[derive(Debug)]
struct Entry {
    index: u16,
    tile: Tile,
    pristine_known: Cell<bool>,
    pristine: Cell<Tile>,
}

/// One chunk's sparse overlay: entries sorted ascending by index, never containing a pristine-equal
/// tile (0007 §1 "canonical overlay").
#[derive(Debug, Default)]
pub struct ChunkOverlay {
    entries: Vec<Entry>,
}

impl ChunkOverlay {
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Sorted ascending by index: the canonical entry list (Planning decisions 6). M14's wire
    /// overlay-run encoding and `TerrainStore::write_canonical` both build on this same iterator.
    /// `Clone` (a plain `slice::Iter` under a non-capturing `.map`, so this is free) lets
    /// `wire::OverlayRunsWriter` walk it twice -- once to count runs, once to write them -- without
    /// collecting it into a buffer first (docs/plan/14-wire-framing.md).
    pub fn entries(&self) -> impl Iterator<Item = (u16, Tile)> + Clone + '_ {
        self.entries.iter().map(|e| (e.index, e.tile))
    }

    fn find(&self, index: u16) -> Result<usize, usize> {
        self.entries.binary_search_by_key(&index, |e| e.index)
    }

    /// The effective (overridden) tile at `index`, if this overlay holds an entry there.
    pub(crate) fn get(&self, index: u16) -> Option<Tile> {
        self.find(index).ok().map(|i| self.entries[i].tile)
    }

    /// The pristine value this entry replaced, if materialization has already learned it (Planning
    /// decisions 5 of docs/plan/07-world-model-core.md: unknown until the chunk holding this entry
    /// is next materialized). `pub`, not `pub(crate)`, so a test -- or a future replica -- can
    /// observe exactly when that happens.
    pub fn cached_pristine(&self, index: u16) -> Option<Tile> {
        self.find(index).ok().and_then(|i| {
            let e = &self.entries[i];
            e.pristine_known.get().then(|| e.pristine.get())
        })
    }

    /// Canonical write rule, a pure function of `(entry?, pristine, new)` (Planning decisions 3):
    /// the overlay never holds an entry equal to `pristine`. `pristine` must be the true pristine
    /// value at `index` -- the caller (`TerrainStore::set_tile`) always materializes first, so it
    /// is at hand and this never regenerates. Returns the old effective tile, or `None` if nothing
    /// changed.
    pub(crate) fn write(&mut self, index: u16, pristine: Tile, new: Tile) -> Option<Tile> {
        match self.find(index) {
            Ok(i) => {
                let old = self.entries[i].tile;
                if old == new {
                    // No change, but a materialize since this entry was created/loaded may have
                    // just learned (or refreshed) the pristine value; keep it.
                    self.entries[i].pristine.set(pristine);
                    self.entries[i].pristine_known.set(true);
                    return None;
                }
                if new == pristine {
                    self.entries.remove(i);
                } else {
                    self.entries[i].tile = new;
                    self.entries[i].pristine.set(pristine);
                    self.entries[i].pristine_known.set(true);
                }
                Some(old)
            }
            Err(i) => {
                if new == pristine {
                    None // already pristine (no entry existed): still pristine
                } else {
                    self.entries.insert(
                        i,
                        Entry {
                            index,
                            tile: new,
                            pristine_known: Cell::new(true),
                            pristine: Cell::new(pristine),
                        },
                    );
                    Some(pristine)
                }
            }
        }
    }

    /// Applies this overlay onto a freshly generated pristine slab: for each entry, records the
    /// slab's pristine value (learning it if not already known) and overwrites the slab with the
    /// overlay's effective tile. Called by `TerrainStore::materialize`/`insert_pristine`, both of
    /// which take `&self` on `TerrainStore` (Planning decisions 3), hence `&self` here too.
    pub(crate) fn apply_onto(&self, slab: &mut [Tile]) {
        for e in &self.entries {
            let p = slab[e.index as usize];
            slab[e.index as usize] = e.tile;
            e.pristine.set(p);
            e.pristine_known.set(true);
        }
    }

    /// Every entry's cached pristine value, or `None` if any entry has not learned it yet (never
    /// materialized since it was created via [`ChunkOverlay::load_entries`]). Used by
    /// `TerrainStore::clear_overlay` to restore a cached slab in place instead of dropping it
    /// (Planning decisions 5: "restores slab values from cached pristine values or drops the
    /// slab").
    pub(crate) fn pristine_entries(&self) -> Option<Vec<(u16, Tile)>> {
        let mut out = Vec::with_capacity(self.entries.len());
        for e in &self.entries {
            if !e.pristine_known.get() {
                return None;
            }
            out.push((e.index, e.pristine.get()));
        }
        Some(out)
    }

    /// Replaces every entry with `entries` (any order, deduplicated by index -- last write wins),
    /// pristine unknown until the chunk is next materialized (Planning decisions 5). Used by
    /// `replace_overlay` (replicas) and `read_canonical` (snapshot load).
    pub(crate) fn load_entries(&mut self, entries: &[(u16, Tile)]) {
        self.entries.clear();
        self.entries.reserve(entries.len());
        for &(index, tile) in entries {
            self.entries.push(Entry {
                index,
                tile,
                pristine_known: Cell::new(false),
                pristine: Cell::new(Tile::VOID),
            });
        }
        self.entries.sort_by_key(|e| e.index);
        self.entries.dedup_by(|a, b| {
            if a.index == b.index {
                // Keep the later (last) write for a duplicate index.
                std::mem::swap(a, b);
                true
            } else {
                false
            }
        });
    }
}

/// The state half of terrain: an ordered map of [`ChunkOverlay`] by chunk key, iterated for
/// canonical bytes, hashes and (later) deltas in ascending key order (0007 §2).
#[derive(Default)]
pub struct Overlays(BTreeMap<u64, ChunkOverlay>);

impl Overlays {
    pub fn get(&self, chunk: ChunkCoord) -> Option<&ChunkOverlay> {
        self.0.get(&chunk.key())
    }

    pub fn chunk_count(&self) -> usize {
        self.0.len()
    }

    /// Ascending chunk-key order (0007 §2, Planning decisions 6).
    pub fn iter(&self) -> impl Iterator<Item = (ChunkCoord, &ChunkOverlay)> + '_ {
        self.0.iter().map(|(&k, o)| (ChunkCoord::from_key(k), o))
    }

    /// Ascending chunk-key order.
    pub fn chunks(&self) -> impl Iterator<Item = ChunkCoord> + '_ {
        self.0.keys().map(|&k| ChunkCoord::from_key(k))
    }

    pub(crate) fn get_or_create(&mut self, chunk: ChunkCoord) -> &mut ChunkOverlay {
        self.0.entry(chunk.key()).or_default()
    }

    pub(crate) fn clear_chunk(&mut self, chunk: ChunkCoord) {
        self.0.remove(&chunk.key());
    }

    pub(crate) fn load_chunk(&mut self, chunk: ChunkCoord, entries: &[(u16, Tile)]) {
        if entries.is_empty() {
            self.0.remove(&chunk.key());
        } else {
            self.0.entry(chunk.key()).or_default().load_entries(entries);
        }
    }

    pub(crate) fn clear(&mut self) {
        self.0.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(v: u32) -> Tile {
        Tile(v)
    }

    #[test]
    fn overlay_never_holds_pristine() {
        let mut o = ChunkOverlay::default();
        assert_eq!(o.write(5, t(1), t(2)), Some(t(1)));
        assert_eq!(o.get(5), Some(t(2)));
        // Writing the pristine value back must remove the entry, not store tile == pristine.
        assert_eq!(o.write(5, t(1), t(1)), Some(t(2)));
        assert_eq!(o.get(5), None);
        assert!(o.is_empty());
        // Writing the pristine value where no entry ever existed is a true no-op.
        assert_eq!(o.write(9, t(4), t(4)), None);
        assert!(o.is_empty());
    }

    #[test]
    fn set_back_to_pristine_drops_entry_and_count() {
        let mut o = ChunkOverlay::default();
        o.write(1, t(9), t(10));
        o.write(2, t(9), t(11));
        assert_eq!(o.len(), 2);
        o.write(1, t(9), t(9)); // back to pristine
        assert_eq!(o.len(), 1);
        assert_eq!(o.get(1), None);
        assert_eq!(o.get(2), Some(t(11)));
    }

    #[test]
    fn overlay_sorted() {
        let mut o = ChunkOverlay::default();
        for &i in &[50u16, 3, 999, 7, 1] {
            o.write(i, t(0), t(i as u32 + 1));
        }
        let indices: Vec<u16> = o.entries().map(|(i, _)| i).collect();
        let mut sorted = indices.clone();
        sorted.sort_unstable();
        assert_eq!(indices, sorted);
    }

    #[test]
    fn write_same_value_is_unchanged() {
        let mut o = ChunkOverlay::default();
        o.write(1, t(9), t(10));
        assert_eq!(o.write(1, t(9), t(10)), None);
        assert_eq!(o.len(), 1);
    }

    #[test]
    fn cached_pristine_unknown_until_applied() {
        let mut o = ChunkOverlay::default();
        o.load_entries(&[(3, t(20))]);
        assert_eq!(o.cached_pristine(3), None);
        assert_eq!(o.pristine_entries(), None);
        let mut slab = [t(0), t(1), t(2), t(99), t(4)];
        o.apply_onto(&mut slab);
        assert_eq!(slab[3], t(20)); // overlay applied
        assert_eq!(o.cached_pristine(3), Some(t(99))); // pristine learned from the slab
        assert_eq!(o.pristine_entries(), Some(vec![(3, t(99))]));
    }

    #[test]
    fn load_entries_dedups_last_write_wins() {
        let mut o = ChunkOverlay::default();
        o.load_entries(&[(1, t(1)), (2, t(2)), (1, t(9))]);
        assert_eq!(o.len(), 2);
        assert_eq!(o.get(1), Some(t(9)));
    }
}
