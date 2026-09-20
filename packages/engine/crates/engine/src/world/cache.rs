//! The dense chunk cache (docs/decisions/0007-world-model.md §8): pooled slabs, an intrusive LRU
//! list, and a fixed-hasher open-addressing index -- never a `HashMap` (0007 §2 allows it because
//! the cache is not state: excluded from hashes, snapshots and deltas). `TerrainStore` is the only
//! caller; nothing here is part of the public seam except [`CacheCapacity`] and [`CacheEvent`].

use super::coords::ChunkDims;
use super::tile::Tile;
use crate::hash::mix64;

/// The dense-cache budget (0007 §8): bytes, per host, invisible to the sim. Exploration is never
/// refused; it only ever consumes cache. `Unlimited` is test-only (`assert_cache_invisible`'s
/// third leg): the pool grows on demand instead of being reserved once.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CacheCapacity {
    Chunks(u32),
    Unlimited,
}

/// A cache event: a chunk was loaded into or evicted from a slab slot. Not state -- consumed by
/// M09's texel upload and M18's GPU page table (the client slab index is the GPU page slot).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CacheEvent {
    Loaded {
        chunk: super::coords::ChunkCoord,
        slot: u32,
    },
    Evicted {
        chunk: super::coords::ChunkCoord,
        slot: u32,
    },
}

const NONE: u32 = u32::MAX;

struct SlotMeta {
    chunk_key: u64,
    prev: u32,
    next: u32,
}

/// Fixed-hasher open addressing over `mix64(chunk_key)`, tombstone-free via backward-shift delete
/// (Planning decisions 4 of docs/plan/07-world-model-core.md). Not a `HashMap`: entries are
/// `(chunk_key, slot)` pairs in a plain `Vec`, linear-probed.
struct IndexTable {
    slots: Vec<Option<(u64, u32)>>,
    mask: usize,
    len: usize,
}

impl IndexTable {
    fn with_capacity(min_slots: usize) -> Self {
        let size = min_slots.max(2).next_power_of_two();
        IndexTable {
            slots: vec![None; size],
            mask: size - 1,
            len: 0,
        }
    }

    #[inline]
    fn probe(&self, key: u64) -> usize {
        (mix64(key) as usize) & self.mask
    }

    fn get(&self, key: u64) -> Option<u32> {
        let mut i = self.probe(key);
        loop {
            match self.slots[i] {
                None => return None,
                Some((k, slot)) if k == key => return Some(slot),
                _ => i = (i + 1) & self.mask,
            }
        }
    }

    fn clear(&mut self) {
        self.slots.iter_mut().for_each(|s| *s = None);
        self.len = 0;
    }

    /// Doubles and rehashes when the table is more than half full. Only ever needed by the
    /// `Unlimited` capacity's growing pool; a finite pool's table is sized up front to never reach
    /// this (Planning decisions 4).
    fn grow_if_crowded(&mut self) {
        if self.len * 2 < self.slots.len() {
            return;
        }
        let new_size = self.slots.len() * 2;
        let old = std::mem::replace(&mut self.slots, vec![None; new_size]);
        self.mask = self.slots.len() - 1;
        self.len = 0;
        for entry in old.into_iter().flatten() {
            self.insert(entry.0, entry.1);
        }
    }

    fn insert(&mut self, key: u64, slot: u32) {
        let mut i = self.probe(key);
        loop {
            match self.slots[i] {
                None => {
                    self.slots[i] = Some((key, slot));
                    self.len += 1;
                    return;
                }
                Some((k, _)) if k == key => {
                    self.slots[i] = Some((key, slot));
                    return;
                }
                _ => i = (i + 1) & self.mask,
            }
        }
    }

    /// Backward-shift delete (Wikipedia, "Open addressing" / Knuth vol. 3): removes `key` and
    /// slides its cluster back so lookups never need a tombstone.
    fn remove(&mut self, key: u64) {
        let mut i = self.probe(key);
        loop {
            match self.slots[i] {
                None => return, // not present
                Some((k, _)) if k == key => break,
                _ => i = (i + 1) & self.mask,
            }
        }
        self.slots[i] = None;
        self.len -= 1;
        let mut j = i;
        loop {
            j = (j + 1) & self.mask;
            let Some((k, _)) = self.slots[j] else {
                break;
            };
            let ideal = self.probe(k);
            // The entry at j can fill hole i unless its ideal slot lies strictly within (i, j]
            // (cyclically) -- in which case moving it back would put it before its own ideal slot.
            let blocked = if i <= j {
                ideal > i && ideal <= j
            } else {
                ideal > i || ideal <= j
            };
            if blocked {
                continue;
            }
            self.slots[i] = self.slots[j].take();
            i = j;
        }
    }
}

/// Pooled slabs, intrusive LRU (`head` = most recently used), the index table, and the event queue
/// `TerrainStore::drain_cache_events` empties. Slot storage is contiguous: slab `s` occupies
/// `pool[s*area .. (s+1)*area]`.
pub(crate) struct Cache {
    dims: ChunkDims,
    capacity: CacheCapacity,
    pool: Vec<Tile>,
    meta: Vec<SlotMeta>,
    free: Vec<u32>,
    index: IndexTable,
    head: u32,
    tail: u32,
    events: Vec<CacheEvent>,
}

impl Cache {
    pub(crate) fn new(dims: ChunkDims, capacity: CacheCapacity) -> Self {
        let area = dims.area() as usize;
        match capacity {
            CacheCapacity::Chunks(n) => {
                let n = n as usize;
                let mut pool = Vec::with_capacity(n * area);
                pool.resize(n * area, Tile(0));
                let mut meta = Vec::with_capacity(n);
                for _ in 0..n {
                    meta.push(SlotMeta {
                        chunk_key: 0,
                        prev: NONE,
                        next: NONE,
                    });
                }
                let mut free = Vec::with_capacity(n);
                for slot in (0..n as u32).rev() {
                    free.push(slot);
                }
                Cache {
                    dims,
                    capacity,
                    pool,
                    meta,
                    free,
                    index: IndexTable::with_capacity(2 * n),
                    head: NONE,
                    tail: NONE,
                    events: Vec::new(),
                }
            }
            CacheCapacity::Unlimited => Cache {
                dims,
                capacity,
                pool: Vec::new(),
                meta: Vec::new(),
                free: Vec::new(),
                index: IndexTable::with_capacity(16),
                head: NONE,
                tail: NONE,
                events: Vec::new(),
            },
        }
    }

    #[inline]
    pub(crate) fn slot_of(&self, key: u64) -> Option<u32> {
        self.index.get(key)
    }

    pub(crate) fn slab(&self, slot: u32) -> &[Tile] {
        let area = self.dims.area() as usize;
        let start = slot as usize * area;
        &self.pool[start..start + area]
    }

    pub(crate) fn slab_mut(&mut self, slot: u32) -> &mut [Tile] {
        let area = self.dims.area() as usize;
        let start = slot as usize * area;
        &mut self.pool[start..start + area]
    }

    fn push_front(&mut self, slot: u32) {
        self.meta[slot as usize].prev = NONE;
        self.meta[slot as usize].next = self.head;
        if self.head != NONE {
            self.meta[self.head as usize].prev = slot;
        }
        self.head = slot;
        if self.tail == NONE {
            self.tail = slot;
        }
    }

    fn unlink(&mut self, slot: u32) {
        let prev = self.meta[slot as usize].prev;
        let next = self.meta[slot as usize].next;
        if prev != NONE {
            self.meta[prev as usize].next = next;
        } else {
            self.head = next;
        }
        if next != NONE {
            self.meta[next as usize].prev = prev;
        } else {
            self.tail = prev;
        }
        self.meta[slot as usize].prev = NONE;
        self.meta[slot as usize].next = NONE;
    }

    /// Moves `slot` to the front of the LRU list (most recently used).
    pub(crate) fn touch(&mut self, slot: u32) {
        if self.head == slot {
            return;
        }
        self.unlink(slot);
        self.push_front(slot);
    }

    fn grow_one_slab(&mut self) -> u32 {
        let area = self.dims.area() as usize;
        let slot = self.meta.len() as u32;
        self.pool.resize(self.pool.len() + area, Tile(0));
        self.meta.push(SlotMeta {
            chunk_key: 0,
            prev: NONE,
            next: NONE,
        });
        slot
    }

    /// Assigns `key` a slot: reuses a free slot, grows the pool (`Unlimited` only), or evicts the
    /// LRU slot. Returns the slot and, if an eviction happened, the evicted chunk's key.
    pub(crate) fn acquire(&mut self, key: u64) -> (u32, Option<u64>) {
        if matches!(self.capacity, CacheCapacity::Unlimited) {
            self.index.grow_if_crowded();
        }
        let (slot, evicted) = if let Some(slot) = self.free.pop() {
            (slot, None)
        } else if matches!(self.capacity, CacheCapacity::Unlimited) {
            (self.grow_one_slab(), None)
        } else {
            let evict_slot = self.tail;
            let evicted_key = self.meta[evict_slot as usize].chunk_key;
            self.unlink(evict_slot);
            self.index.remove(evicted_key);
            (evict_slot, Some(evicted_key))
        };
        self.meta[slot as usize].chunk_key = key;
        self.push_front(slot);
        self.index.insert(key, slot);
        (slot, evicted)
    }

    /// Removes `key` from the cache if present, returning its slot to the free list. Used when
    /// state changes (`replace_overlay`, and `clear_overlay` when it cannot restore in place) make
    /// a cached slab stale; the next read regenerates it, which is always correct and invisible
    /// (0007 §1).
    pub(crate) fn evict_if_present(&mut self, key: u64) -> Option<u32> {
        let slot = self.index.get(key)?;
        self.index.remove(key);
        self.unlink(slot);
        self.free.push(slot);
        Some(slot)
    }

    pub(crate) fn push_event(&mut self, event: CacheEvent) {
        self.events.push(event);
    }

    /// Drains every queued event without shrinking the queue's capacity, so steady-state draining
    /// allocates nothing after the first few calls establish it (`no_alloc_terrain`).
    pub(crate) fn drain_events(&mut self) -> std::vec::Drain<'_, CacheEvent> {
        self.events.drain(..)
    }

    /// Bytes reserved by the pool: `capacity_slots * dims.slab_bytes()` (0007 §8). For `Unlimited`
    /// (test-only) this is the pool's current size, since there is no fixed capacity to report.
    pub(crate) fn pool_bytes(&self) -> usize {
        self.meta.len() * self.dims.slab_bytes()
    }

    /// Empties the cache (every slot returns to the free list, the index and LRU list reset).
    /// `TerrainStore::read_canonical` calls this because a snapshot load's overlays make every
    /// cached slab's history irrelevant; dropping them is always safe (0007 §1). Not a hot path, so
    /// the small reallocation-free reset here is not measured for allocation.
    pub(crate) fn clear_all(&mut self) {
        self.index.clear();
        self.free.clear();
        self.free.extend((0..self.meta.len() as u32).rev());
        self.head = NONE;
        self.tail = NONE;
        for m in &mut self.meta {
            m.chunk_key = 0;
            m.prev = NONE;
            m.next = NONE;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_table_insert_get_remove() {
        let mut t = IndexTable::with_capacity(16);
        for i in 0..6u64 {
            t.insert(i, i as u32 * 10);
        }
        for i in 0..6u64 {
            assert_eq!(t.get(i), Some(i as u32 * 10));
        }
        t.remove(2);
        assert_eq!(t.get(2), None);
        for i in [0u64, 1, 3, 4, 5] {
            assert_eq!(
                t.get(i),
                Some(i as u32 * 10),
                "key {i} lost after removing 2"
            );
        }
    }

    /// Backward-shift delete under many random insert/remove sequences: every surviving key must
    /// still be found, and nothing removed leaks back (`mix64`-seeded, deterministic).
    #[test]
    fn index_table_survives_random_churn() {
        let mut t = IndexTable::with_capacity(4);
        let mut live: Vec<u64> = Vec::new();
        let mut seed = 0x1234_5678_u64;
        for step in 0..2000u64 {
            seed = mix64(seed ^ step);
            if live.is_empty() || !seed.is_multiple_of(3) {
                let key = seed;
                if !live.contains(&key) {
                    t.grow_if_crowded(); // Cache::acquire does this before every insert
                    t.insert(key, (step % 1000) as u32);
                    live.push(key);
                }
            } else {
                let idx = (seed as usize) % live.len();
                let key = live.swap_remove(idx);
                t.remove(key);
            }
            for &k in &live {
                assert!(t.get(k).is_some(), "lost live key {k} at step {step}");
            }
        }
    }

    fn dims() -> ChunkDims {
        ChunkDims::new(4)
    }

    #[test]
    fn cache_acquire_reuses_free_then_evicts_lru() {
        let mut c = Cache::new(dims(), CacheCapacity::Chunks(2));
        let (s0, e0) = c.acquire(100);
        assert_eq!(e0, None);
        let (s1, e1) = c.acquire(200);
        assert_eq!(e1, None);
        assert_ne!(s0, s1);
        // Capacity is full: acquiring a third key evicts the LRU (100, touched least recently).
        let (_s2, e2) = c.acquire(300);
        assert_eq!(e2, Some(100));
        assert_eq!(c.slot_of(100), None);
        assert!(c.slot_of(200).is_some());
        assert!(c.slot_of(300).is_some());
    }

    #[test]
    fn cache_touch_changes_eviction_order() {
        let mut c = Cache::new(dims(), CacheCapacity::Chunks(2));
        let (s0, _) = c.acquire(1);
        let (_s1, _) = c.acquire(2);
        c.touch(s0); // 1 is now most-recently-used; 2 becomes the LRU
        let (_s2, evicted) = c.acquire(3);
        assert_eq!(evicted, Some(2));
    }

    #[test]
    fn cache_unlimited_never_evicts() {
        let mut c = Cache::new(dims(), CacheCapacity::Unlimited);
        for key in 0..500u64 {
            let (_slot, evicted) = c.acquire(key);
            assert_eq!(evicted, None);
        }
        for key in 0..500u64 {
            assert!(c.slot_of(key).is_some());
        }
    }
}
