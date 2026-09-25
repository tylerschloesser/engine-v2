//! `worldgen_no_resource_on_water` (docs/plan/20-reference-game-v0.md Tests added; Requirements:
//! "No resources on water"). Scans a wide area of chunks around the origin and asserts every
//! `DEEP_WATER`/`WATER` tile has resource `0`.

use engine::world::{ChunkCoord, ChunkDims};
use engine::worldgen::Worldgen;
use reference_sim::content::{DEEP_WATER, WATER};
use reference_sim::{RefParams, RefWorldgen};

mod common;
use common::TEST_SEED;

#[test]
fn worldgen_no_resource_on_water() {
    let dims = ChunkDims::new(5);
    let params = RefParams::default();
    let mut out = vec![engine::world::Tile::VOID; dims.area() as usize];
    let mut water_tiles_seen = 0u32;
    for cx in -8..8 {
        for cy in -8..8 {
            RefWorldgen::generate(TEST_SEED, &params, ChunkCoord::new(cx, cy), &mut out);
            for t in &out {
                if t.base() == DEEP_WATER || t.base() == WATER {
                    water_tiles_seen += 1;
                    assert_eq!(
                        t.resource(),
                        0,
                        "water tile (base {}) carries a resource",
                        t.base()
                    );
                }
            }
        }
    }
    // A 16x16-chunk scan around the origin should see plenty of water, or this test would pass
    // vacuously.
    assert!(
        water_tiles_seen > 0,
        "no water tiles seen in the scanned area"
    );
}
