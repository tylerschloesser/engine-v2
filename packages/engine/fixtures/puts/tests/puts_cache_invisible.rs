//! `puts_cache_invisible` (docs/plan/12b-world-access-and-sim-driver.md Tests added; 0007
//! Consequences: "replay one log with cache capacity 1, default, and unlimited ... all state
//! hashes equal"). Reruns a real `Authority<Puts>` script at capacity 1, the default and
//! unlimited, crossed with the M07 harness's three prewarm orders, and requires identical
//! checkpoints throughout -- mechanically proving the dense cache never leaks into `puts`'s state.

use engine::authority::Authority;
use engine::game::{Game, WorldWrite as _};
use engine::testing::{CacheConfig, assert_cache_invisible, prewarm_chunks};
use engine::world::{ChunkCoord, ChunkDims, PristineSource, TerrainStore, Tile, TilePos};
use engine::worldgen::Pristine;
use fx_puts::{FlatWorldgen, Puts};

#[test]
fn puts_cache_invisible() {
    assert_cache_invisible(|cfg: &CacheConfig| {
        let dims = ChunkDims::new(<Puts as Game>::CHUNK_BITS);
        let source: Box<dyn PristineSource> = Box::new(Pristine::<FlatWorldgen>::new(99, ()));
        let terrain = TerrainStore::new(dims, source, cfg.capacity);
        let mut a: Authority<Puts> = Authority::new(terrain, Default::default(), 42);

        // A handful of chunks near the origin, materialized up front in `cfg.prewarm`'s order.
        let chunks: Vec<ChunkCoord> = (-2..=2)
            .flat_map(|cy| (-2..=2).map(move |cx| ChunkCoord::new(cx, cy)))
            .collect();
        prewarm_chunks(a.store().terrain(), &chunks, cfg.prewarm);

        let mut checkpoints = Vec::new();
        // Writes across several chunks, forcing materialization (and, at capacity 1, eviction)
        // between them.
        for i in 0..30i32 {
            a.set_tile(TilePos::new(i, i), Tile::new((i % 7) as u8, 0, 0));
            checkpoints.push(a.store().state_hash());
        }
        // Reads-only over a different diagonal: materializes more chunks without writing, so any
        // cache-timing leak into state would show up as a checkpoint mismatch here too.
        for i in 0..30i32 {
            let _ = a.store().terrain().tile(TilePos::new(-i, i));
        }
        checkpoints.push(a.store().state_hash());

        checkpoints
    });
}
