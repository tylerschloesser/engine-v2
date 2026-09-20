//! `cache_invisible_real_worldgen` (Non-scope of docs/plan/07-world-model-core.md; this brief's
//! own scope, docs/plan/08-worldgen-and-gen-worker.md): the generate-on-miss path M07 proved
//! invisible for a seeded `PristineSource` stays invisible once `Pristine<FixtureGen>` drives it
//! with real worldgen ("Host-side generate-on-miss is not new code" -- Non-scope).

use engine::hash::{Fnv64, mix64};
use engine::testing::{CacheConfig, assert_cache_invisible, prewarm_chunks};
use engine::world::{ChunkCoord, ChunkDims, TerrainStore};
use engine::worldgen::Pristine;
use fx_worldgen::{FixtureGen, FixtureParams};

fn chunk_list() -> Vec<ChunkCoord> {
    let mut out = Vec::new();
    for x in -4..4 {
        for y in -4..4 {
            out.push(ChunkCoord::new(x, y));
        }
    }
    out
}

/// Deterministic Fisher-Yates shuffle over `mix64`, so the read order is fixed but not sequential.
fn shuffle(items: &mut [usize], seed: u64) {
    let mut state = seed;
    let mut i = items.len();
    while i > 1 {
        state = mix64(state);
        let j = (state as usize) % i;
        i -= 1;
        items.swap(i, j);
    }
}

#[test]
fn cache_invisible_real_worldgen() {
    let dims = ChunkDims::new(5);
    let seed = 0xC0FF_EE00_1234_5678;
    let params = FixtureParams::default();
    let chunks = chunk_list();

    assert_cache_invisible(|cfg: &CacheConfig| {
        let store = TerrainStore::new(
            dims,
            Box::new(Pristine::<FixtureGen>::new(seed, params)),
            cfg.capacity,
        );
        prewarm_chunks(&store, &chunks, cfg.prewarm);

        let mut order: Vec<usize> = (0..chunks.len()).collect();
        shuffle(&mut order, seed ^ 0xABCD_EF01_2345_6789);

        let mut h = Fnv64::new();
        for &idx in &order {
            let chunk = chunks[idx];
            for local in [0u16, 1, dims.area() as u16 - 1] {
                let pos = dims.tile_at(chunk, local);
                h.write_u32(store.tile(pos).0);
            }
        }
        vec![h.finish()]
    });
}
