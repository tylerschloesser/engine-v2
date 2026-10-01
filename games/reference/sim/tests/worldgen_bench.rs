//! `slow_worldgen_chunk_reference` (docs/plan/20-reference-game-v0.md "Budgets", wired into
//! `pnpm test:slow` by docs/plan/36-slow-tier-and-benchmarks.md): median ms per generated chunk of
//! `RefWorldgen`, a runner `warn` line above 0008 §6's desktop threshold (never a failure; the
//! checked-in baseline and its 25 % gate are M36 step 5's). The slow nextest profile builds the dev
//! profile (the `engine` crate at `opt-level = 1`), so this number is an upper bound on the release
//! figure; it is printed with its profile.

use engine::world::{ChunkCoord, ChunkDims, Tile};
use engine::worldgen::Worldgen;
use reference_sim::{RefParams, RefWorldgen};
use std::time::Instant;

mod common;
use common::TEST_SEED;

/// 0008 §6: warn above this per chunk (`packages/engine/budgets.json` `worldgenMsPerChunkWarn`).
const WARN_MS_PER_CHUNK: f64 = 0.25;
const WARMUP: i32 = 64;
const BATCHES: i32 = 15;
const CHUNKS_PER_BATCH: i32 = 64;

#[test]
fn slow_worldgen_chunk_reference() {
    let dims = ChunkDims::new(5);
    let params = RefParams::default();
    let mut out = vec![Tile::VOID; dims.area() as usize];
    let mut sink = 0u32;
    let mut gen_batch = |first: i32, out: &mut Vec<Tile>| {
        for i in 0..CHUNKS_PER_BATCH {
            let c = ChunkCoord::new(first + i, (first + i) % 17 - 8);
            RefWorldgen::generate(TEST_SEED, &params, c, out);
            sink = sink.wrapping_add(out[0].to_le_bytes()[0] as u32);
        }
    };
    gen_batch(-WARMUP, &mut out);
    let mut per_chunk_ms = Vec::with_capacity(BATCHES as usize);
    for b in 0..BATCHES {
        let t = Instant::now();
        gen_batch(1_000 + b * CHUNKS_PER_BATCH, &mut out);
        per_chunk_ms.push(t.elapsed().as_secs_f64() * 1000.0 / f64::from(CHUNKS_PER_BATCH));
    }
    per_chunk_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = per_chunk_ms[per_chunk_ms.len() / 2];
    let profile = if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    };
    println!(
        "worldgen-bench reference: median {median:.4} ms/chunk ({profile}, native) sink {sink}"
    );
    assert!(median.is_finite() && median > 0.0);
    if median > WARN_MS_PER_CHUNK {
        println!(
            "warn: reference worldgen median {median:.4} ms/chunk exceeds {WARN_MS_PER_CHUNK} ms/chunk (0008 section 6)"
        );
    }
}
