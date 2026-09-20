//! `fx_worldgen::export_instance!(FixtureGen)` already installs `engine::abi::Arena` as this
//! binary's `#[global_allocator]` (a library's global allocator applies to any binary that links
//! it, including its own integration tests), so `worldgen_contract_fixture` can prove
//! `FixtureGen::generate` allocates zero bytes on top of the mechanical rules
//! `engine::testing::assert_worldgen_contract` checks (docs/decisions/0008-chunk-generation.md
//! §1), with no second `#[global_allocator]` of its own (that would conflict).

use engine::testing::assert_worldgen_contract;
use engine::world::{ChunkCoord, ChunkDims, Tile};
use engine::worldgen::Worldgen;
use fx_worldgen::{FixtureGen, FixtureParams};

#[test]
fn worldgen_contract_fixture() {
    let dims = ChunkDims::new(5);
    let seed = 0xC0FF_EE12_3456_789A;
    let params = FixtureParams::default();
    assert_worldgen_contract::<FixtureGen>(seed, &params, dims);

    // `abi::arena` shows zero allocation inside `generate` (Tests added of
    // docs/plan/08-worldgen-and-gen-worker.md): warm up first (the scratch buffer above already
    // exercised every code path), then measure one more call in isolation.
    let mut out = vec![Tile::VOID; dims.area() as usize];
    FixtureGen::generate(seed, &params, ChunkCoord::new(3, -3), &mut out);
    let before = engine::abi::arena::live_bytes();
    FixtureGen::generate(seed, &params, ChunkCoord::new(7, -7), &mut out);
    assert_eq!(
        engine::abi::arena::live_bytes(),
        before,
        "FixtureGen::generate allocated"
    );
}
