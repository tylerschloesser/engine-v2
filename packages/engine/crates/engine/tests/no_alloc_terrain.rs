//! Own test binary (mirrors `no_alloc_codec.rs`), so the counting `#[global_allocator]` sees only
//! this file's work: after init, reads and cache churn through `TerrainStore` allocate zero bytes
//! (`abi::arena::live_bytes()` unchanged). Overlay growth (writes) is explicitly allowed to
//! allocate (docs/plan/07-world-model-core.md Tests added), so this file never calls `set_tile` in
//! its measured region.

use engine::abi::Arena;
use engine::world::{CacheCapacity, ChunkCoord, ChunkDims, PristineSource, TerrainStore, Tile};

#[global_allocator]
static ALLOCATOR: Arena = Arena;

struct FixedTerrain;
impl PristineSource for FixedTerrain {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        for (i, t) in out.iter_mut().enumerate() {
            *t = Tile::new((chunk.x as i64 + i as i64).rem_euclid(251) as u8, 0, 0);
        }
    }
}

fn live() -> usize {
    engine::abi::arena::live_bytes()
}

#[test]
fn no_alloc_terrain() {
    let dims = ChunkDims::new(5);
    let store = TerrainStore::new(dims, Box::new(FixedTerrain), CacheCapacity::Chunks(64));

    // Warm up: fill the cache to capacity and establish the event queue's steady-state capacity,
    // draining after every op the way real per-tick code would.
    for i in 0..64 {
        store.materialize(ChunkCoord::new(i, 0));
        store.drain_cache_events(|_| {});
    }

    let before = live();
    // Reads across cached and uncached chunks (forcing LRU eviction and re-generation): "cache
    // churn". No writes here -- overlay growth is allowed to allocate, and this loop must not.
    for i in 0..200i32 {
        let chunk = ChunkCoord::new(i % 80, 0);
        let local = ((i as u32) % dims.area()) as u16;
        let pos = dims.tile_at(chunk, local);
        let _ = store.tile(pos);
        store.drain_cache_events(|_| {});
    }
    assert_eq!(live(), before, "reads and cache churn allocated");
}
