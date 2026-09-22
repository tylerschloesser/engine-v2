//! `GenQueue`: the prioritised generation queue a client instance owns (docs/decisions/
//! 0008-chunk-generation.md §4-5; `docs/plan/08b-gen-workers-and-queue.md` Seams). Lives in the
//! client instance, in preallocated storage (0008 §4 "a preallocated array of a few hundred
//! entries sorted in place"); `TerrainFeed` (`client/terrain_feed.rs`) is the ABI-facing wrapper
//! that drives it from `frame` and turns `take`/`complete` into `genRequest`/`genResult` records.
//!
//! Priority = ring class (visible, then ring 1, then ring 2), then distance to the look-ahead point
//! `center + velocity * 0.5s` (0008 §4). Generation covers `visible.expanded(2)` (ring 1 = upload,
//! ring 2 = generate-only) plus up to 2 look-ahead chunks treated like ring 1 (0008 §5); retention
//! -- protecting a cached chunk from the LRU cache's own eviction -- extends to `visible.expanded(3)`
//! (Planning decisions 4: touched on every re-sort). Cancellation drops not-yet-dispatched entries
//! that fall outside that ring-3 bound (0008 §4); an in-flight job is never cancelled, and a late
//! result is still accepted by `complete` regardless of the current view (0008 §4, `queue_keeps_
//! late_results`).

use crate::view;
use crate::world::{ChunkCoord, ChunkDims, ChunkRect, TerrainStore, TilePos, WorldPos};

/// At most 2 jobs in flight per worker (0008 §4): re-prioritisation then takes effect within about
/// 1ms of work.
const MAX_IN_FLIGHT_PER_WORKER: usize = 2;
/// Ring 1: generate + upload.
const RING_UPLOAD: i32 = 1;
/// Ring 2: generate only (the outer edge of the generation set).
const RING_GEN: i32 = 2;
/// Ring 3: retain (protected from LRU eviction), then LRU beyond it.
const RING_RETAIN: i32 = 3;
/// "A few hundred entries" (0008 §4); comfortably above the view-bound worst case (169 generated,
/// 225 retained, 0008 §5) with slack for in-between camera positions during a re-sort.
const MAX_PENDING: usize = 512;

/// Seconds ahead the look-ahead point leads the camera (0008 §4): expressed as a division by 2
/// applied to a Q24.8-per-second velocity, i.e. exactly 0.5s, with no float involved.
const LOOKAHEAD_HALF: i64 = 2;

/// The queue's view of the world this pass (Planning decisions 3 of docs/plan/
/// 08b-gen-workers-and-queue.md): `visible` and `center` come from `view::visible_rect` and the
/// camera block; `velocity` is Q24.8 tiles/second. Integer-only beyond `view::visible_rect` itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GenView {
    pub visible: ChunkRect,
    pub center: WorldPos,
    pub velocity: (i32, i32),
}

/// Cumulative counters (`requested`/`dispatched`/`delivered`/`cancelled`/`requeued`, monotonic,
/// matching `RingStats`' `pushed`/`popped`/`drops` convention) plus the current `pending`/
/// `in_flight` snapshot (Planning decisions 8: exact values are budgets, asserted against
/// `budgets.json` for a scripted join and a scripted pan).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GenStats {
    pub requested: u32,
    pub dispatched: u32,
    pub delivered: u32,
    pub cancelled: u32,
    pub requeued: u32,
    pub pending: u32,
    pub in_flight: u32,
}

#[derive(Clone, Copy, Debug)]
struct Entry {
    chunk: ChunkCoord,
    ring: u8,
    dist: u64,
}

pub struct GenQueue {
    dims: ChunkDims,
    pending: Vec<Entry>,
    in_flight: Vec<[Option<ChunkCoord>; MAX_IN_FLIGHT_PER_WORKER]>,
    last_visible: Option<ChunkRect>,
    /// `store.cache_eviction_seq()` as of the last `set_view` that actually re-scanned (Planning
    /// decisions: "GenQueue::set_view ... must not skip its rescan when a chunk it cares about was
    /// evicted since the last call"). A peek against `TerrainStore::cache_eviction_seq`, never a
    /// drain of `drain_cache_events` -- that queue is `Uploader::on_frame`'s own, and `frame()`
    /// calls `TerrainFeed::on_frame` (which owns this queue) before `Uploader::on_frame` in the
    /// same tick, so a drain here would starve the uploader's `changed` check of exactly the event
    /// that made it necessary (docs/plan/15c-terrain-visibility-and-cache-invalidation.md
    /// Deviations).
    last_eviction_seq: u64,
    requested: u32,
    dispatched: u32,
    delivered: u32,
    cancelled: u32,
    requeued: u32,
}

impl GenQueue {
    pub fn new(dims: ChunkDims, workers: u32) -> Self {
        GenQueue {
            dims,
            pending: Vec::with_capacity(MAX_PENDING),
            in_flight: vec![[None; MAX_IN_FLIGHT_PER_WORKER]; workers as usize],
            last_visible: None,
            last_eviction_seq: 0,
            requested: 0,
            dispatched: 0,
            delivered: 0,
            cancelled: 0,
            requeued: 0,
        }
    }

    fn is_in_flight_anywhere(&self, chunk: ChunkCoord) -> bool {
        self.in_flight
            .iter()
            .any(|slots| slots.contains(&Some(chunk)))
    }

    fn is_pending(&self, chunk: ChunkCoord) -> bool {
        self.pending.iter().any(|e| e.chunk == chunk)
    }

    fn classify_ring(
        chunk: ChunkCoord,
        visible: ChunkRect,
        ring1: ChunkRect,
        lookahead: &[ChunkCoord],
    ) -> u8 {
        if visible.contains(chunk) {
            0
        } else if ring1.contains(chunk) || lookahead.contains(&chunk) {
            1
        } else {
            2
        }
    }

    /// `center + velocity * 0.5s`, floored to the containing tile (`WorldPos::tile`): the point
    /// `dist` sorts every entry against.
    fn lookahead_point(center: WorldPos, velocity: (i32, i32)) -> TilePos {
        let x = center.x as i64 + velocity.0 as i64 / LOOKAHEAD_HALF;
        let y = center.y as i64 + velocity.1 as i64 / LOOKAHEAD_HALF;
        WorldPos::clamped(x, y).tile()
    }

    /// Squared distance, in tile units, from `chunk`'s own centre tile to `point`.
    fn chunk_dist(&self, chunk: ChunkCoord, point: TilePos) -> u64 {
        let edge = self.dims.edge() as i64;
        let cx = chunk.x as i64 * edge + edge / 2;
        let cy = chunk.y as i64 * edge + edge / 2;
        let dx = cx - point.x as i64;
        let dy = cy - point.y as i64;
        (dx * dx + dy * dy) as u64
    }

    fn maybe_enqueue(&mut self, chunk: ChunkCoord, ring: u8, point: TilePos, store: &TerrainStore) {
        if store.is_cached(chunk) || self.is_in_flight_anywhere(chunk) || self.is_pending(chunk) {
            return;
        }
        if self.pending.len() >= self.pending.capacity() {
            return; // "a few hundred", never expected in practice (0008 §5's own worst case)
        }
        let dist = self.chunk_dist(chunk, point);
        self.pending.push(Entry { chunk, ring, dist });
        self.requested += 1;
    }

    /// Re-sorts the queue against `view` if the visible chunk rect changed since the last call, or
    /// if a chunk was evicted from `store`'s cache since the last call even though the view did not
    /// (`store.cache_eviction_seq()`, docs/plan/15c-terrain-visibility-and-cache-invalidation.md:
    /// `replace_overlay`/`clear_overlay` evict a resident chunk with the camera held still, and
    /// without this check the chunk would never be requested again -- Planning decisions "re-sort
    /// when the camera crosses a chunk boundary or a zoom change alters the chunk set" predates
    /// that finding). Returns whether it re-sorted. On a re-sort: cancels pending entries that fell
    /// outside `visible.expanded(3)`; reclassifies and re-distances the survivors; enqueues
    /// newly-entering chunks from `visible.expanded(2)` plus up to 2 look-ahead chunks (Planning
    /// decisions 4, 8 of docs/decisions/0008-chunk-generation.md) -- `maybe_enqueue`'s own
    /// `store.is_cached(chunk)` check is what actually re-requests an evicted chunk, once this
    /// method decides not to skip the scan; touches every cached chunk within `visible.expanded(3)`
    /// so the cache's own LRU never evicts it out from under the view.
    pub fn set_view(&mut self, view: &GenView, store: &TerrainStore) -> bool {
        let eviction_seq = store.cache_eviction_seq();
        if self.last_visible == Some(view.visible) && self.last_eviction_seq == eviction_seq {
            return false;
        }
        self.last_visible = Some(view.visible);
        self.last_eviction_seq = eviction_seq;

        let ring1 = view.visible.expanded(RING_UPLOAD);
        let ring2 = view.visible.expanded(RING_GEN);
        let ring3 = view.visible.expanded(RING_RETAIN);

        let mut lookahead = [ChunkCoord::default(); 2];
        let n_lookahead =
            view::lookahead_chunks(view.visible, view.velocity, self.dims, &mut lookahead);
        let lookahead = &lookahead[..n_lookahead];

        let point = Self::lookahead_point(view.center, view.velocity);

        // Cancel entries that fell outside the retention bound.
        let mut i = 0;
        while i < self.pending.len() {
            if ring3.contains(self.pending[i].chunk) {
                i += 1;
            } else {
                self.pending.swap_remove(i);
                self.cancelled += 1;
            }
        }

        // Reclassify and re-distance survivors against the new view.
        for e in self.pending.iter_mut() {
            e.ring = Self::classify_ring(e.chunk, view.visible, ring1, lookahead);
            e.dist = 0; // placeholder overwritten right below; keeps a single distance formula
        }
        let dims = self.dims;
        for e in self.pending.iter_mut() {
            let edge = dims.edge() as i64;
            let cx = e.chunk.x as i64 * edge + edge / 2;
            let cy = e.chunk.y as i64 * edge + edge / 2;
            let dx = cx - point.x as i64;
            let dy = cy - point.y as i64;
            e.dist = (dx * dx + dy * dy) as u64;
        }

        // Enqueue newly-entering chunks from the generation set.
        for chunk in ring2.iter() {
            let ring = Self::classify_ring(chunk, view.visible, ring1, lookahead);
            self.maybe_enqueue(chunk, ring, point, store);
        }
        for &chunk in lookahead {
            self.maybe_enqueue(chunk, 1, point, store);
        }

        // Protect every retained, cached chunk from LRU eviction.
        for chunk in ring3.iter() {
            if store.is_cached(chunk) {
                store.touch(chunk);
            }
        }

        // `(ring, dist)` alone is not a total order: two chunks at the same ring and distance (the
        // orthogonal neighbours of a view centre, say) compare equal, and `sort_unstable_by` makes
        // no promise about their relative order in that case. `ChunkCoord::key()` (0007 §2, a
        // canonical `(x, y)` packing) as the last tie-break makes dispatch order a pure function of
        // the view alone (`queue_ties_break_by_chunk_key`).
        self.pending.sort_unstable_by(|a, b| {
            (a.ring, a.dist, a.chunk.key()).cmp(&(b.ring, b.dist, b.chunk.key()))
        });
        true
    }

    /// Dispatches the highest-priority pending chunk to `worker`, if it has a free in-flight slot
    /// and the queue is non-empty. `None` otherwise -- the pump only calls this once it already
    /// holds a free ring slot (Planning decisions 5: claim first, take second).
    pub fn take(&mut self, worker: u32) -> Option<ChunkCoord> {
        let slots = self.in_flight.get_mut(worker as usize)?;
        let free = slots.iter().position(|s| s.is_none())?;
        if self.pending.is_empty() {
            return None;
        }
        let entry = self.pending.remove(0);
        slots[free] = Some(entry.chunk);
        self.dispatched += 1;
        Some(entry.chunk)
    }

    /// Marks `chunk` as no longer in flight for `worker` and counts it delivered, regardless of
    /// whether the current view still wants it (0008 §4: "a late result is cached anyway").
    pub fn complete(&mut self, worker: u32, chunk: ChunkCoord) {
        if let Some(slots) = self.in_flight.get_mut(worker as usize) {
            for slot in slots.iter_mut() {
                if *slot == Some(chunk) {
                    *slot = None;
                    break;
                }
            }
        }
        self.delivered += 1;
    }

    /// Clears every in-flight slot for `worker` (a lost gen instance, M37) and re-queues each
    /// chunk at the head of the pending list (highest priority: it is already overdue), unless it
    /// is somehow already pending. The next `set_view` gives requeued entries a real ring/distance.
    pub fn requeue_in_flight(&mut self, worker: u32) {
        let mut taken: [Option<ChunkCoord>; MAX_IN_FLIGHT_PER_WORKER] =
            [None; MAX_IN_FLIGHT_PER_WORKER];
        if let Some(slots) = self.in_flight.get_mut(worker as usize) {
            for (i, slot) in slots.iter_mut().enumerate() {
                taken[i] = slot.take();
            }
        }
        for chunk in taken.into_iter().flatten() {
            self.requeued += 1;
            if !self.is_pending(chunk) && self.pending.len() < self.pending.capacity() {
                self.pending.insert(
                    0,
                    Entry {
                        chunk,
                        ring: 0,
                        dist: 0,
                    },
                );
            }
        }
    }

    pub fn pending(&self) -> u32 {
        self.pending.len() as u32
    }

    pub fn in_flight(&self) -> u32 {
        self.in_flight
            .iter()
            .map(|slots| slots.iter().filter(|s| s.is_some()).count() as u32)
            .sum()
    }

    pub fn stats(&self) -> GenStats {
        GenStats {
            requested: self.requested,
            dispatched: self.dispatched,
            delivered: self.delivered,
            cancelled: self.cancelled,
            requeued: self.requeued,
            pending: self.pending(),
            in_flight: self.in_flight(),
        }
    }
}
