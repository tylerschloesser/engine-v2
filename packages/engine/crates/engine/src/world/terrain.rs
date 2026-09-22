//! `TerrainStore` (docs/decisions/0007-world-model.md §1): the unit that composes the pristine
//! function, sparse canonical overlays and the dense LRU cache. `Store<G>` (M12) embeds one on the
//! host and on every client replica.
//!
//! The cache sits behind a `RefCell` (Planning decisions 3 of docs/plan/07-world-model-core.md):
//! [`TerrainStore::tile`] takes `&self` (the `WorldRead` shape, M12/0003) although a read may
//! generate and evict. No reference into a slab ever escapes this module: reads return `Tile` by
//! value; bulk access is [`TerrainStore::copy_chunk`].

use std::cell::RefCell;

use super::cache::{Cache, CacheCapacity, CacheEvent};
use super::coords::{ChunkCoord, ChunkDims, TilePos};
use super::overlay::Overlays;
use super::tile::Tile;
use crate::bytes::{ByteReader, ByteSink};
use crate::codec::CodecError;
use crate::hash::{Fnv64, StateHash};

/// The object-safe seam through which terrain asks for the pristine function `P` (Planning
/// decisions 2): "fill this slab". Separate from `Worldgen` (M08), which is a static, game-typed
/// function with `Params`; `M08` adapts one to the other with `Pristine<W>`.
pub trait PristineSource {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]);
}

/// [`TerrainStore::set_tile`]'s outcome: whether the effective tile actually changed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TileChange {
    Unchanged,
    Changed { old: Tile },
}

/// [`TerrainStore::set_tile`]: the position was outside `[TILE_MIN, TILE_MAX]` (0007 §2). Nothing
/// changed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct OutOfRange;

/// Sparse canonical overlays (world state) over a pure pristine function, cached through an LRU
/// dense slab pool nothing outside this module can observe (0007 Consequences).
pub struct TerrainStore {
    dims: ChunkDims,
    source: Box<dyn PristineSource>,
    overlays: Overlays,
    modified_tiles: u32,
    cache: RefCell<Cache>,
}

impl TerrainStore {
    pub fn new(dims: ChunkDims, source: Box<dyn PristineSource>, capacity: CacheCapacity) -> Self {
        TerrainStore {
            cache: RefCell::new(Cache::new(dims, capacity)),
            dims,
            source,
            overlays: Overlays::default(),
            modified_tiles: 0,
        }
    }

    /// Total: every tile in the coordinate range has a value. Out-of-range reads return
    /// [`Tile::VOID`] (0007 §2). Materializes on a cache miss; that is the only observable effect
    /// (wall-clock time), because `P` is pure (0007 §1).
    pub fn tile(&self, pos: TilePos) -> Tile {
        if !self.dims.in_range(pos) {
            return Tile::VOID;
        }
        let chunk = self.dims.chunk_of(pos);
        let index = self.dims.local_index(pos);
        self.materialize(chunk);
        let cache = self.cache.borrow();
        let slot = cache
            .slot_of(chunk.key())
            .expect("materialize just cached this chunk");
        cache.slab(slot)[index as usize]
    }

    /// Materializes `chunk` if it isn't already cached (loads a slab from `source`, applies the
    /// overlay on top so the slab stays "P + overlay", and touches the LRU) or just touches it if
    /// it is. Returns `true` when it generated. `&self`: cache-only (Planning decisions 3); the
    /// overlay's pristine cache is a `Cell` for the same reason.
    pub fn materialize(&self, chunk: ChunkCoord) -> bool {
        let mut cache = self.cache.borrow_mut();
        if let Some(slot) = cache.slot_of(chunk.key()) {
            cache.touch(slot);
            return false;
        }
        let (slot, evicted) = cache.acquire(chunk.key());
        self.source.generate(chunk, cache.slab_mut(slot));
        if let Some(overlay) = self.overlays.get(chunk) {
            overlay.apply_onto(cache.slab_mut(slot));
        }
        cache.push_event(CacheEvent::Loaded { chunk, slot });
        if let Some(evicted_key) = evicted {
            cache.push_event(CacheEvent::Evicted {
                chunk: ChunkCoord::from_key(evicted_key),
                slot,
            });
        }
        true
    }

    /// Inserts externally generated pristine tiles (a gen worker's result, M08b) into the cache.
    /// Idempotent: if `chunk` is already cached, `tiles` is ignored other than a debug-build check
    /// that it agrees with the instance's own generation (Planning decisions 8) -- comparing a
    /// worker result with the instance's synchronous generation for free.
    pub fn insert_pristine(&self, chunk: ChunkCoord, tiles: &[Tile]) {
        debug_assert_eq!(
            tiles.len(),
            self.dims.area() as usize,
            "insert_pristine: tiles.len() must equal the chunk area"
        );
        let mut cache = self.cache.borrow_mut();
        if let Some(slot) = cache.slot_of(chunk.key()) {
            #[cfg(debug_assertions)]
            self.debug_check_pristine(&cache, chunk, slot, tiles);
            cache.touch(slot);
            return;
        }
        let (slot, evicted) = cache.acquire(chunk.key());
        cache.slab_mut(slot).copy_from_slice(tiles);
        if let Some(overlay) = self.overlays.get(chunk) {
            overlay.apply_onto(cache.slab_mut(slot));
        }
        cache.push_event(CacheEvent::Loaded { chunk, slot });
        if let Some(evicted_key) = evicted {
            cache.push_event(CacheEvent::Evicted {
                chunk: ChunkCoord::from_key(evicted_key),
                slot,
            });
        }
    }

    #[cfg(debug_assertions)]
    fn debug_check_pristine(&self, cache: &Cache, chunk: ChunkCoord, slot: u32, tiles: &[Tile]) {
        let slab = cache.slab(slot);
        let overlay = self.overlays.get(chunk);
        for (i, &incoming) in tiles.iter().enumerate() {
            let index = i as u16;
            let has_override = overlay.is_some_and(|o| o.get(index).is_some());
            if !has_override {
                // No overlay entry: the slab already holds the pristine value directly.
                debug_assert_eq!(
                    incoming, slab[i],
                    "insert_pristine mismatch at index {i} in chunk {chunk:?} (0007 planning decisions 8)"
                );
            } else if let Some(p) = overlay.and_then(|o| o.cached_pristine(index)) {
                debug_assert_eq!(
                    incoming, p,
                    "insert_pristine mismatch at index {i} in chunk {chunk:?} (0007 planning decisions 8)"
                );
            }
            // else: overridden but pristine not yet learned -- nothing to check against.
        }
    }

    /// Writes materialize the chunk first (Planning decisions 5), so the pristine value is always
    /// at hand: the slab value when no overlay entry exists, else the entry's cached pristine.
    pub fn set_tile(&mut self, pos: TilePos, new: Tile) -> Result<TileChange, OutOfRange> {
        if !self.dims.in_range(pos) {
            return Err(OutOfRange);
        }
        let chunk = self.dims.chunk_of(pos);
        let index = self.dims.local_index(pos);
        self.materialize(chunk);

        let pristine = match self
            .overlays
            .get(chunk)
            .and_then(|o| o.cached_pristine(index))
        {
            Some(p) => p,
            None => {
                let cache = self.cache.borrow();
                let slot = cache.slot_of(chunk.key()).expect("just materialized");
                cache.slab(slot)[index as usize]
            }
        };

        let overlay = self.overlays.get_or_create(chunk);
        let before = overlay.len();
        let old = overlay.write(index, pristine, new);
        let delta = overlay.len() as i64 - before as i64;
        self.modified_tiles = (self.modified_tiles as i64 + delta) as u32;

        let mut cache = self.cache.borrow_mut();
        let slot = cache.slot_of(chunk.key()).expect("just materialized");
        cache.slab_mut(slot)[index as usize] = new;

        Ok(match old {
            Some(old_tile) => TileChange::Changed { old: old_tile },
            None => TileChange::Unchanged,
        })
    }

    /// The number of modified tiles across every chunk (state, not allocator bytes): 0007 §8's
    /// `max_modified_tiles` counts against this.
    pub fn modified_tiles(&self) -> u32 {
        self.modified_tiles
    }

    pub fn overlay(&self, chunk: ChunkCoord) -> Option<&super::overlay::ChunkOverlay> {
        self.overlays.get(chunk)
    }

    /// Every chunk holding an overlay, ascending key order.
    pub fn overlay_chunks(&self) -> impl Iterator<Item = ChunkCoord> + '_ {
        self.overlays.chunks()
    }

    /// Replaces `chunk`'s overlay wholesale (a replica applying a full resync, M12b/M22). Any
    /// cached slab for `chunk` is evicted -- its pristine values are unknown for the new entries, so
    /// the next read regenerates and re-applies, which is always correct (0007 §1).
    pub fn replace_overlay(&mut self, chunk: ChunkCoord, entries: &[(u16, Tile)]) {
        let before = self.overlays.get(chunk).map_or(0, |o| o.len());
        self.overlays.load_chunk(chunk, entries);
        let after = entries.len();
        self.modified_tiles = (self.modified_tiles as i64 + after as i64 - before as i64) as u32;
        self.cache.borrow_mut().evict_if_present(chunk.key());
    }

    /// Drops `chunk`'s overlay entirely. If the chunk is cached and every entry's pristine value is
    /// known, restores the slab in place (cheap, keeps the chunk warm); otherwise evicts it, so the
    /// next read regenerates (Planning decisions 5).
    pub fn clear_overlay(&mut self, chunk: ChunkCoord) {
        let Some(overlay) = self.overlays.get(chunk) else {
            return;
        };
        if overlay.is_empty() {
            return;
        }
        let restore = overlay.pristine_entries();
        let removed = overlay.len() as u32;
        self.overlays.clear_chunk(chunk);
        self.modified_tiles = self.modified_tiles.saturating_sub(removed);

        let mut cache = self.cache.borrow_mut();
        if let Some(slot) = cache.slot_of(chunk.key()) {
            match restore {
                Some(entries) => {
                    let slab = cache.slab_mut(slot);
                    for (index, pristine) in entries {
                        slab[index as usize] = pristine;
                    }
                }
                None => {
                    cache.evict_if_present(chunk.key());
                }
            }
        }
    }

    pub fn is_cached(&self, chunk: ChunkCoord) -> bool {
        self.cache.borrow().slot_of(chunk.key()).is_some()
    }

    pub fn slot_of(&self, chunk: ChunkCoord) -> Option<u32> {
        self.cache.borrow().slot_of(chunk.key())
    }

    /// Moves `chunk` to the front of the LRU list if it is cached; a no-op otherwise (it does not
    /// materialize).
    pub fn touch(&self, chunk: ChunkCoord) {
        let mut cache = self.cache.borrow_mut();
        if let Some(slot) = cache.slot_of(chunk.key()) {
            cache.touch(slot);
        }
    }

    /// Materializes `chunk` if needed and copies its dense slab into `out` (`out.len()` must equal
    /// `dims.area()`). Returns `true` when it generated. The only bulk read of a slab: it copies
    /// out, never returning a reference into one (0007 Consequences).
    pub fn copy_chunk(&self, chunk: ChunkCoord, out: &mut [Tile]) -> bool {
        let generated = self.materialize(chunk);
        let cache = self.cache.borrow();
        let slot = cache.slot_of(chunk.key()).expect("just materialized");
        out.copy_from_slice(cache.slab(slot));
        generated
    }

    /// Starts recording [`CacheEvent`]s for a consumer that will drain them.
    ///
    /// Off by default: recording is opt-in, so a store nobody drains never queues anything
    /// (M15 fix round 3 -- the host's own `TerrainStore` was queuing load/evict events forever for
    /// a consumer that does not exist in the sim role). Call this wherever a store is paired with
    /// something that calls [`TerrainStore::drain_cache_events`]; `drain_cache_events`' contract is
    /// unchanged once enabled. Enabling is idempotent, and is normally done at construction, before
    /// any read materializes a chunk -- events that happen while recording is off are not
    /// retroactively queued.
    pub fn enable_cache_events(&self) {
        self.cache.borrow_mut().set_record_events(true);
    }

    /// Cache events queued and not yet drained. Exists so a store with no consumer can *assert*
    /// it stays empty (`host_terrain_queues_no_cache_events`) rather than leaving that a claim.
    pub fn queued_cache_events(&self) -> usize {
        self.cache.borrow().queued_events()
    }

    /// Empties the queued cache events, calling `f` for each in the order they occurred.
    pub fn drain_cache_events(&self, mut f: impl FnMut(CacheEvent)) {
        let mut cache = self.cache.borrow_mut();
        for event in cache.drain_events() {
            f(event);
        }
    }

    /// Monotonic count of chunks whose *cached contents were invalidated* -- `replace_overlay`/
    /// `clear_overlay`'s own eviction (`Cache::evict_if_present`) -- over this store's lifetime,
    /// bumped whether or not [`TerrainStore::enable_cache_events`] was ever called. **Not** a count
    /// of every eviction: `materialize`'s own LRU capacity eviction does not move this (fix round 1,
    /// docs/plan/15c-terrain-visibility-and-cache-invalidation.md Deviations -- counting capacity
    /// churn here closed a feedback loop under a cache smaller than the working set, since
    /// `set_view`'s own retention-ring touch pass cannot prevent LRU eviction from happening at all,
    /// only from happening to the *wrong* chunk). A peek, not a drain: unlike
    /// [`TerrainStore::drain_cache_events`] (which `client::upload`'s `Uploader::on_frame` already
    /// drains every frame, for *every* eviction including LRU), reading this never consumes
    /// anything, so a second consumer in the same `frame()` call (`GenQueue::set_view`) can compare
    /// it against its own last-seen value without starving the first.
    pub fn cache_invalidation_seq(&self) -> u64 {
        self.cache.borrow().invalidation_seq()
    }

    /// Deterministic memory accounting (0007 §8, Planning decisions 11): the cache pool's reserved
    /// bytes plus the overlays' live entry bytes. Not an allocator measurement (`size_of`-based, so
    /// it is identical in every build).
    pub fn memory_bytes(&self) -> usize {
        let pool_bytes = self.cache.borrow().pool_bytes();
        let overlay_bytes = self.modified_tiles as usize * std::mem::size_of::<(u16, Tile)>();
        pool_bytes + overlay_bytes
    }

    /// Canonical terrain bytes (Planning decisions 6): chunk count, then per chunk in ascending key
    /// order `key u64, entry count u32`, entries `index u16 + tile u32` ascending index. Pristine
    /// values, cache contents and `modified_tiles` are never written -- state is only what overlays
    /// hold.
    pub fn write_canonical(&self, sink: &mut impl ByteSink) {
        sink.put_u32(self.overlays.chunk_count() as u32);
        for (chunk, overlay) in self.overlays.iter() {
            sink.put_u64(chunk.key());
            sink.put_u32(overlay.len() as u32);
            for (index, tile) in overlay.entries() {
                sink.put_u16(index);
                sink.put_u32(tile.0);
            }
        }
    }

    /// Reads canonical terrain bytes written by [`TerrainStore::write_canonical`], replacing every
    /// overlay. Any cached slabs are dropped: they may no longer reflect the loaded overlays, and
    /// dropping them is always safe (cache invisibility, 0007 §1).
    pub fn read_canonical(&mut self, reader: &mut ByteReader) -> Result<(), CodecError> {
        let chunk_count = reader.u32()?;
        self.overlays.clear();
        let mut modified_tiles: u64 = 0;
        for _ in 0..chunk_count {
            let key = reader.u64()?;
            let entry_count = reader.u32()?;
            let mut entries = Vec::with_capacity(entry_count as usize);
            for _ in 0..entry_count {
                let index = reader.u16()?;
                let tile = Tile(reader.u32()?);
                entries.push((index, tile));
            }
            self.overlays
                .load_chunk(ChunkCoord::from_key(key), &entries);
            modified_tiles += entry_count as u64;
        }
        if modified_tiles > u32::MAX as u64 {
            return Err(CodecError::Malformed);
        }
        self.modified_tiles = modified_tiles as u32;
        self.cache.borrow_mut().clear_all();
        Ok(())
    }
}

impl StateHash for TerrainStore {
    /// The same canonical writer that produces snapshot bytes (`hash.rs`'s "hashing is encoding
    /// into a sink that has no buffer"): `Fnv64` implements `ByteSink`.
    fn hash_state(&self, h: &mut Fnv64) {
        self.write_canonical(h);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::mix64;

    struct DeterministicSource {
        seed: u64,
    }

    impl PristineSource for DeterministicSource {
        fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
            let base = mix64(self.seed ^ chunk.key());
            for (i, slot) in out.iter_mut().enumerate() {
                let v = mix64(base.wrapping_add(i as u64));
                *slot = Tile::new(
                    (v & 0x7f) as u8,
                    ((v >> 8) & 0x7f) as u8,
                    ((v >> 16) & 0xffff) as u16,
                );
            }
        }
    }

    fn store(capacity: CacheCapacity) -> TerrainStore {
        TerrainStore::new(
            ChunkDims::new(4),
            Box::new(DeterministicSource { seed: 0xC0FFEE }),
            capacity,
        )
    }

    #[test]
    fn out_of_range_reads_void_writes_rejected() {
        let mut s = store(CacheCapacity::Chunks(4));
        let bad = TilePos::new(super::super::coords::TILE_MAX + 1, 0);
        assert_eq!(s.tile(bad), Tile::VOID);
        assert_eq!(s.set_tile(bad, Tile::new(1, 0, 0)), Err(OutOfRange));
    }

    #[test]
    fn set_tile_then_read_reflects_write() {
        let mut s = store(CacheCapacity::Chunks(4));
        let pos = TilePos::new(3, 3);
        let before = s.tile(pos);
        let new = Tile::new(9, 9, 9);
        assert_ne!(before, new);
        let change = s.set_tile(pos, new).unwrap();
        assert_eq!(change, TileChange::Changed { old: before });
        assert_eq!(s.tile(pos), new);
        assert_eq!(s.modified_tiles(), 1);
    }

    #[test]
    fn clear_overlay_restores_slab() {
        let mut s = store(CacheCapacity::Chunks(4));
        let pos = TilePos::new(1, 1);
        let chunk = ChunkDims::new(4).chunk_of(pos);
        let before = s.tile(pos); // materializes, learns pristine trivially (no entry yet)
        s.set_tile(pos, Tile::new(5, 5, 5)).unwrap();
        assert_eq!(s.tile(pos), Tile::new(5, 5, 5));
        s.clear_overlay(chunk);
        assert_eq!(s.tile(pos), before);
        assert_eq!(s.modified_tiles(), 0);
        assert!(s.overlay(chunk).is_none_or(|o| o.is_empty()));
    }

    /// M15c step 2: `replace_overlay`'s eviction (a host snapshot landing on an already-resident,
    /// pristine-generated chunk -- the exact race in "The bug, confirmed at M15b's gate") must now
    /// be observable the same way `materialize`'s own LRU eviction already is.
    #[test]
    fn replace_overlay_evicts_and_reports_cache_event() {
        let mut s = store(CacheCapacity::Chunks(4));
        s.enable_cache_events();
        let chunk = ChunkCoord::new(0, 0);
        s.materialize(chunk);
        assert!(s.is_cached(chunk));
        s.drain_cache_events(|_| {}); // discard the `Loaded` from `materialize`

        let seq_before = s.cache_invalidation_seq();
        s.replace_overlay(chunk, &[(0, Tile::new(1, 0, 0))]);
        assert!(
            !s.is_cached(chunk),
            "replace_overlay must still evict (0007 §1)"
        );
        assert_eq!(
            s.cache_invalidation_seq(),
            seq_before + 1,
            "cache_invalidation_seq must bump even before anything drains the event queue"
        );

        let mut events = Vec::new();
        s.drain_cache_events(|e| events.push(e));
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], CacheEvent::Evicted { chunk: c, .. } if c == chunk));
    }

    #[test]
    fn canonical_roundtrip() {
        let mut s = store(CacheCapacity::Chunks(8));
        for i in 0..20i32 {
            s.set_tile(TilePos::new(i, i * 2), Tile::new(i as u8, 1, 2))
                .unwrap();
        }
        let mut buf = Vec::new();
        struct VecSink<'a>(&'a mut Vec<u8>);
        impl ByteSink for VecSink<'_> {
            fn put(&mut self, bytes: &[u8]) {
                self.0.extend_from_slice(bytes);
            }
        }
        s.write_canonical(&mut VecSink(&mut buf));

        let mut s2 = store(CacheCapacity::Chunks(8));
        let mut reader = ByteReader::new(&buf);
        s2.read_canonical(&mut reader).unwrap();

        for i in 0..20i32 {
            assert_eq!(
                s.tile(TilePos::new(i, i * 2)),
                s2.tile(TilePos::new(i, i * 2))
            );
        }
        assert_eq!(s.modified_tiles(), s2.modified_tiles());

        let mut h1 = Fnv64::new();
        s.hash_state(&mut h1);
        let mut h2 = Fnv64::new();
        s2.hash_state(&mut h2);
        assert_eq!(h1.finish(), h2.finish());
    }

    #[test]
    fn canonical_bytes_independent_of_write_history() {
        let pos = TilePos::new(7, 7);

        let mut a = store(CacheCapacity::Chunks(4));
        a.set_tile(pos, Tile::new(1, 0, 0)).unwrap();
        a.set_tile(pos, Tile::new(2, 0, 0)).unwrap();

        let mut b = store(CacheCapacity::Chunks(4));
        b.set_tile(pos, Tile::new(2, 0, 0)).unwrap();

        let mut buf_a = Vec::new();
        let mut buf_b = Vec::new();
        struct VecSink<'a>(&'a mut Vec<u8>);
        impl ByteSink for VecSink<'_> {
            fn put(&mut self, bytes: &[u8]) {
                self.0.extend_from_slice(bytes);
            }
        }
        a.write_canonical(&mut VecSink(&mut buf_a));
        b.write_canonical(&mut VecSink(&mut buf_b));
        assert_eq!(buf_a, buf_b);
    }

    #[test]
    fn loaded_entries_learn_pristine_on_materialize() {
        let dims = ChunkDims::new(4);
        let pos = TilePos::new(2, 2);
        let chunk = dims.chunk_of(pos);
        let index = dims.local_index(pos);

        // Build canonical bytes for one overlay entry, without ever computing pristine ourselves.
        let mut buf = Vec::new();
        struct VecSink<'a>(&'a mut Vec<u8>);
        impl ByteSink for VecSink<'_> {
            fn put(&mut self, bytes: &[u8]) {
                self.0.extend_from_slice(bytes);
            }
        }
        {
            let mut sink = VecSink(&mut buf);
            sink.put_u32(1);
            sink.put_u64(chunk.key());
            sink.put_u32(1);
            sink.put_u16(index);
            sink.put_u32(Tile::new(9, 0, 0).0);
        }

        let mut s = store(CacheCapacity::Chunks(4));
        let mut reader = ByteReader::new(&buf);
        s.read_canonical(&mut reader).unwrap();
        assert_eq!(s.overlay(chunk).unwrap().cached_pristine(index), None);

        // Reading a tile materializes the chunk, which learns the pristine value.
        assert_eq!(s.tile(pos), Tile::new(9, 0, 0));
        assert!(s.overlay(chunk).unwrap().cached_pristine(index).is_some());
    }

    #[test]
    fn cache_events_report_slots() {
        let s = store(CacheCapacity::Chunks(2));
        s.enable_cache_events();
        let mut events = Vec::new();
        let c0 = ChunkCoord::new(0, 0);
        let c1 = ChunkCoord::new(1, 0);
        let c2 = ChunkCoord::new(2, 0);
        s.materialize(c0);
        s.materialize(c1);
        s.materialize(c2); // evicts c0 (LRU): a Loaded for c2 plus an Evicted for c0
        s.drain_cache_events(|e| events.push(e));
        assert_eq!(events.len(), 4);
        assert!(matches!(events[0], CacheEvent::Loaded { chunk, .. } if chunk == c0));
        assert!(matches!(events[1], CacheEvent::Loaded { chunk, .. } if chunk == c1));
        assert!(matches!(events[2], CacheEvent::Loaded { chunk, .. } if chunk == c2));
        assert!(matches!(events[3], CacheEvent::Evicted { chunk, .. } if chunk == c0));
        // Draining again reports nothing new.
        let mut more = Vec::new();
        s.drain_cache_events(|e| more.push(e));
        assert!(more.is_empty());
    }

    #[test]
    fn lru_evicts_least_recent() {
        let s = store(CacheCapacity::Chunks(2));
        let c0 = ChunkCoord::new(0, 0);
        let c1 = ChunkCoord::new(1, 0);
        let c2 = ChunkCoord::new(2, 0);
        s.materialize(c0);
        s.materialize(c1);
        s.materialize(c2);
        assert!(!s.is_cached(c0));
        assert!(s.is_cached(c1));
        assert!(s.is_cached(c2));
    }

    #[test]
    fn touch_protects_from_eviction() {
        let s = store(CacheCapacity::Chunks(2));
        let c0 = ChunkCoord::new(0, 0);
        let c1 = ChunkCoord::new(1, 0);
        let c2 = ChunkCoord::new(2, 0);
        s.materialize(c0);
        s.materialize(c1);
        s.touch(c0); // c0 now more recently used than c1
        s.materialize(c2); // evicts c1, not c0
        assert!(s.is_cached(c0));
        assert!(!s.is_cached(c1));
    }

    #[test]
    fn memory_bytes_matches_pool_reservation_when_empty() {
        let dims = ChunkDims::new(5);
        let s = TerrainStore::new(
            dims,
            Box::new(DeterministicSource { seed: 1 }),
            CacheCapacity::Chunks(1024),
        );
        assert_eq!(s.memory_bytes(), 1024 * dims.slab_bytes());
    }
}
