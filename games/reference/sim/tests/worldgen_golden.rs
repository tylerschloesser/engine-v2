//! `worldgen_golden` (docs/plan/20-reference-game-v0.md Tests added): raw tile bytes of 16
//! chunks near the origin plus pairs straddling `+-2^18` (0007 §9's own fingerprint chunk list,
//! reused here for the same "near the origin and far away" coverage). Native-only byte golden
//! (0002 §3's kind, distinct from the cross-runtime `pnpm golden` scenario kind this crate has no
//! ABI-facing driver for yet); `pnpm golden:bytes` is the only writer (`GOLDEN_BLESS=1`).
//!
use engine::testing::assert_golden_bytes;
use engine::world::{ChunkCoord, ChunkDims, Tile};
use engine::worldgen::Worldgen;
use reference_sim::{RefParams, RefWorldgen};

mod common;
use common::TEST_SEED;

/// Near the origin, plus one cluster per axis-sign combination straddling `+-2^18` (mirrors
/// `engine::worldgen::worldgen_fingerprint`'s own `FINGERPRINT_CHUNKS`, 0007 §9).
const CHUNKS: [(i32, i32); 16] = [
    (0, 0),
    (1, 0),
    (0, 1),
    (-1, 0),
    (0, -1),
    (1, 1),
    (-1, -1),
    (2, -2),
    (262_144, 262_144),
    (262_145, 262_144),
    (262_144, 262_145),
    (262_143, 262_143),
    (-262_144, -262_144),
    (-262_145, -262_144),
    (-262_144, -262_145),
    (-262_143, -262_143),
];

#[test]
fn worldgen_golden() {
    let dims = ChunkDims::new(5);
    let params = RefParams::default();
    let mut bytes = Vec::with_capacity(CHUNKS.len() * dims.area() as usize * 4);
    let mut out = vec![Tile::VOID; dims.area() as usize];
    for &(cx, cy) in &CHUNKS {
        RefWorldgen::generate(TEST_SEED, &params, ChunkCoord::new(cx, cy), &mut out);
        for t in &out {
            bytes.extend_from_slice(&t.to_le_bytes());
        }
    }
    assert_golden_bytes!("worldgen_golden", &bytes);
}
