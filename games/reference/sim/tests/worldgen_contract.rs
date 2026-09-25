//! Proves `RefWorldgen` obeys the mechanical `Worldgen` rules (docs/decisions/
//! 0008-chunk-generation.md §1) via `engine::testing::assert_worldgen_contract` (Consumes) and
//! that `generate` allocates nothing on top (`.claude/rules/determinism.md`, `fx-worldgen`'s own
//! precedent, `export_game!(RefGame)` already installs `engine::abi::Arena` as this binary's
//! `#[global_allocator]`, so no second one is declared here).

use engine::testing::assert_worldgen_contract;
use engine::world::{ChunkCoord, ChunkDims, Tile};
use engine::worldgen::Worldgen;
use reference_sim::{RefParams, RefWorldgen};

mod common;
use common::TEST_SEED;

#[test]
fn worldgen_contract() {
    let dims = ChunkDims::new(5);
    let params = RefParams::default();
    assert_worldgen_contract::<RefWorldgen>(TEST_SEED, &params, dims);

    let mut out = vec![Tile::VOID; dims.area() as usize];
    RefWorldgen::generate(TEST_SEED, &params, ChunkCoord::new(3, -3), &mut out); // warm up
    let before = engine::abi::arena::live_bytes();
    RefWorldgen::generate(TEST_SEED, &params, ChunkCoord::new(7, -7), &mut out);
    assert_eq!(
        engine::abi::arena::live_bytes(),
        before,
        "RefWorldgen::generate allocated"
    );
}
