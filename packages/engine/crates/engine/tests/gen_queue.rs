//! `GenQueue` (docs/decisions/0008-chunk-generation.md §4-5; `docs/plan/
//! 08b-gen-workers-and-queue.md` Tests added), through its public API only.

use engine::gen_queue::{GenQueue, GenView};
use engine::view;
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, ChunkRect, PristineSource, TerrainStore, Tile, TilePos,
    WorldPos,
};

struct ZeroSource;
impl PristineSource for ZeroSource {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::VOID);
    }
}

fn store(capacity: CacheCapacity) -> TerrainStore {
    TerrainStore::new(ChunkDims::new(4), Box::new(ZeroSource), capacity)
}

fn view_at(visible: ChunkRect) -> GenView {
    GenView {
        visible,
        center: WorldPos::from_tile(TilePos::new(0, 0)),
        velocity: (0, 0),
    }
}

fn single(c: ChunkCoord) -> ChunkRect {
    ChunkRect::new(c, c)
}

/// Drains the whole pending queue via repeated take/complete cycles (never blocked by the
/// in-flight cap, since each chunk is completed immediately after it is taken), returning the
/// chunks in dispatch order. Test-only: the public API has no direct pending-inspection seam.
fn drain_all(queue: &mut GenQueue, worker: u32) -> Vec<ChunkCoord> {
    let mut out = Vec::new();
    while let Some(c) = queue.take(worker) {
        queue.complete(worker, c);
        out.push(c);
    }
    out
}

#[test]
fn queue_orders_ring_class_then_distance() {
    let s = store(CacheCapacity::Unlimited);
    let mut q = GenQueue::new(ChunkDims::new(4), 1);
    q.set_view(&view_at(single(ChunkCoord::new(0, 0))), &s);
    let order = drain_all(&mut q, 0);
    // Ring 0 (just the visible chunk) first, then ring 1 (the 8 neighbours) before ring 2.
    assert_eq!(order[0], ChunkCoord::new(0, 0));
    let ring1 = single(ChunkCoord::new(0, 0)).expanded(1);
    for &c in &order[1..9] {
        assert!(ring1.contains(c) && c != ChunkCoord::new(0, 0));
    }
    for &c in &order[9..] {
        assert!(!ring1.contains(c));
    }
}

#[test]
fn queue_ties_break_by_chunk_key() {
    let s = store(CacheCapacity::Unlimited);
    let mut q = GenQueue::new(ChunkDims::new(4), 1);
    q.set_view(&view_at(single(ChunkCoord::new(0, 0))), &s);
    let order = drain_all(&mut q, 0);
    // Ring-1 neighbours (0,-1) and (-1,0) of visible chunk (0,0) (dims edge 16, look-ahead point at
    // tile (0,0)) are equidistant: squared distance 128 each ((8,-8) and (-8,8) from the point).
    // `(ring, dist)` alone does not order them; `ChunkCoord::key()` (0007 §2, `(x as u32 as u64) <<
    // 32 | y as u32 as u64`) does: a negative x sorts after a non-negative one, so (0,-1)'s key
    // (4,294,967,295) is far below (-1,0)'s (~1.8e19) -- (0,-1) must dispatch immediately before
    // (-1,0), not in whatever order an unstable sort on the tied pair alone would leave them.
    let a = order
        .iter()
        .position(|&c| c == ChunkCoord::new(0, -1))
        .unwrap();
    let b = order
        .iter()
        .position(|&c| c == ChunkCoord::new(-1, 0))
        .unwrap();
    assert_eq!(b, a + 1, "order: {order:?}");
}

#[test]
fn queue_resorts_only_on_chunk_or_zoom_change() {
    let s = store(CacheCapacity::Unlimited);
    let mut q = GenQueue::new(ChunkDims::new(4), 1);
    let v = single(ChunkCoord::new(0, 0));
    assert!(q.set_view(&view_at(v), &s));
    // Same visible rect, different (irrelevant) velocity: no re-sort.
    let mut v2 = view_at(v);
    v2.velocity = (5000, -5000);
    assert!(!q.set_view(&v2, &s));
    // A different visible rect: re-sorts.
    assert!(q.set_view(&view_at(single(ChunkCoord::new(1, 0))), &s));
}

#[test]
fn queue_in_flight_cap_per_worker() {
    let s = store(CacheCapacity::Unlimited);
    let mut q = GenQueue::new(ChunkDims::new(4), 2);
    q.set_view(&view_at(single(ChunkCoord::new(0, 0))), &s);
    assert!(q.take(0).is_some());
    assert!(q.take(0).is_some());
    assert_eq!(q.take(0), None, "worker 0 already has 2 in flight");
    // A different worker is unaffected.
    assert!(q.take(1).is_some());
}

#[test]
fn queue_cancels_undispatched_beyond_ring3() {
    let s = store(CacheCapacity::Unlimited);
    let mut q = GenQueue::new(ChunkDims::new(4), 1);
    q.set_view(&view_at(single(ChunkCoord::new(0, 0))), &s);
    assert_eq!(q.stats().cancelled, 0);
    // Move far away: everything previously pending (all within ring2 = radius 2) falls outside
    // the new view's ring3 too, and must be cancelled, not silently dropped uncounted.
    let before_pending = q.pending();
    q.set_view(&view_at(single(ChunkCoord::new(50, 50))), &s);
    assert_eq!(q.stats().cancelled, before_pending);
}

#[test]
fn queue_keeps_late_results() {
    let s = store(CacheCapacity::Unlimited);
    let mut q = GenQueue::new(ChunkDims::new(4), 1);
    q.set_view(&view_at(single(ChunkCoord::new(0, 0))), &s);
    let chunk = q.take(0).unwrap();
    // The view moves on before the result comes back.
    q.set_view(&view_at(single(ChunkCoord::new(50, 50))), &s);
    let before = q.stats().delivered;
    q.complete(0, chunk); // late result: still accepted
    assert_eq!(q.stats().delivered, before + 1);
}

#[test]
fn queue_generation_superset_of_lookahead() {
    let s = store(CacheCapacity::Unlimited);
    let mut q = GenQueue::new(ChunkDims::new(4), 1);
    let mut view = view_at(single(ChunkCoord::new(0, 0)));
    view.velocity = (2000, 0); // Q24.8: well beyond 1 tile/s in +x
    q.set_view(&view, &s);
    let mut lookahead = [ChunkCoord::default(); 2];
    let n = view::lookahead_chunks(
        view.visible,
        view.velocity,
        ChunkDims::new(4),
        &mut lookahead,
    );
    assert!(n > 0);
    let pending = drain_all(&mut q, 0);
    for &c in &lookahead[..n] {
        assert!(
            pending.contains(&c),
            "look-ahead chunk {c:?} missing from generation set"
        );
    }
}

#[test]
fn queue_counts_at_view_bound() {
    let s = store(CacheCapacity::Unlimited);
    let mut q = GenQueue::new(ChunkDims::new(5), 1);
    // 9x9 visible chunks: the view bound of 0008 §5.
    let visible = ChunkRect::new(ChunkCoord::new(-4, -4), ChunkCoord::new(4, 4));
    q.set_view(&view_at(visible), &s);
    // Generation set: visible.expanded(2) = 13x13 = 169.
    assert_eq!(q.pending(), 169);
    assert_eq!(q.stats().requested, 169);
    // Retention bound: visible.expanded(3) = 15x15 = 225.
    let retained = visible.expanded(3).iter().count();
    assert_eq!(retained, 225);
}

#[test]
fn queue_requeue_in_flight() {
    let s = store(CacheCapacity::Unlimited);
    let mut q = GenQueue::new(ChunkDims::new(4), 1);
    q.set_view(&view_at(single(ChunkCoord::new(0, 0))), &s);
    let a = q.take(0).unwrap();
    let b = q.take(0).unwrap();
    assert_eq!(q.in_flight(), 2);
    let before = q.stats().requeued;
    q.requeue_in_flight(0);
    assert_eq!(q.in_flight(), 0);
    assert_eq!(q.stats().requeued, before + 2);
    // Both chunks are dispatchable again, at the front of the queue.
    let redispatched = [q.take(0).unwrap(), q.take(0).unwrap()];
    assert!(redispatched.contains(&a));
    assert!(redispatched.contains(&b));
}

#[test]
fn queue_touches_retained() {
    let s = store(CacheCapacity::Chunks(2));
    // Within visible.expanded(3) (max x = 3) but outside visible.expanded(2) (max x = 2): not
    // regenerated, but must be protected from eviction by the touch pass.
    let touched = ChunkCoord::new(3, 0);
    let other = ChunkCoord::new(100, 100);
    s.materialize(touched);
    s.materialize(other);
    s.drain_cache_events(|_| {});

    let mut q = GenQueue::new(ChunkDims::new(4), 1);
    q.set_view(&view_at(single(ChunkCoord::new(0, 0))), &s);

    // Capacity 2, both slots full: materializing a third chunk evicts the LRU. If `touched` was
    // protected by `set_view`'s touch pass, `other` (never touched) is the one evicted.
    s.materialize(ChunkCoord::new(200, 200));
    assert!(s.is_cached(touched), "touched retained chunk was evicted");
    assert!(
        !s.is_cached(other),
        "untouched chunk should have been the LRU victim"
    );
}
