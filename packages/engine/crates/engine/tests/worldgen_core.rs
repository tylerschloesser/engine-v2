//! `Pristine<W>` and `worldgen_fingerprint` (docs/decisions/0007-world-model.md §9,
//! docs/decisions/0008-chunk-generation.md §1). Uses `engine::testing`, hence
//! `required-features = ["testing"]` in `Cargo.toml`.

use engine::testing::TestTerrain;
use engine::world::{ChunkCoord, ChunkDims, PristineSource, Tile};
use engine::worldgen::{Pristine, Worldgen, worldgen_fingerprint};

#[derive(serde::Serialize, serde::Deserialize)]
struct Params;

struct Marked;
impl Worldgen for Marked {
    type Params = Params;
    const WORLDGEN_VERSION: u32 = 3;
    fn generate(seed: u64, _params: &Params, chunk: ChunkCoord, out: &mut [Tile]) {
        for (i, t) in out.iter_mut().enumerate() {
            let base = seed ^ (chunk.x as u64) << 32 ^ (chunk.y as u64) ^ i as u64;
            *t = Tile::new((base & 0xff) as u8, ((base >> 8) & 0xff) as u8, 0);
        }
    }
}

/// `Pristine<W>::generate` is exactly `W::generate(seed, &params, chunk, out)`: no extra
/// indirection changes a byte (Planning decisions 2 of docs/plan/07-world-model-core.md).
#[test]
fn pristine_matches_generate() {
    let dims = ChunkDims::new(4);
    let seed = 0xC0FF_EE00_1234_5678;
    let pristine = Pristine::<Marked>::new(seed, Params);

    for chunk in [
        ChunkCoord::new(0, 0),
        ChunkCoord::new(-5, 9),
        ChunkCoord::new(250_000, -250_000),
    ] {
        let mut via_pristine = vec![Tile::VOID; dims.area() as usize];
        pristine.generate(chunk, &mut via_pristine);

        let mut via_worldgen = vec![Tile::VOID; dims.area() as usize];
        Marked::generate(seed, &Params, chunk, &mut via_worldgen);

        assert_eq!(via_pristine, via_worldgen, "chunk {chunk:?}");
    }
}

/// The fingerprint is stable for a fixed source and sensitive to a changed one (0007 §9: it
/// catches a forgotten `WORLDGEN_VERSION` bump because the underlying generation actually
/// changed).
#[test]
fn fingerprint_stable_and_sensitive() {
    let dims = ChunkDims::new(5);
    let a = TestTerrain::new(1);
    let a2 = TestTerrain::new(1);
    let b = TestTerrain::new(2);

    let fa = worldgen_fingerprint(&a, dims);
    assert_eq!(fa, worldgen_fingerprint(&a2, dims), "same seed must match");
    assert_ne!(
        fa,
        worldgen_fingerprint(&b, dims),
        "different seed must (almost always) differ"
    );
    // Stable across dims choices being re-run: calling twice on the same source is stable.
    assert_eq!(fa, worldgen_fingerprint(&a, dims));
}

#[test]
fn fingerprint_golden() {
    let dims = ChunkDims::new(5);
    let source = TestTerrain::new(0x5EED_1234_ABCD_0042);
    let fingerprint = worldgen_fingerprint(&source, dims);
    engine::assert_golden_hash!("worldgen_fingerprint", fingerprint);
}
