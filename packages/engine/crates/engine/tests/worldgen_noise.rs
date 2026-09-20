//! `engine::noise`'s own native golden over raw f64 bits (Planning decisions 3 of
//! docs/plan/08-worldgen-and-gen-worker.md): last-bit drift in `simplex2`/`fbm2` must not hide
//! behind a threshold. Uses `engine::testing`, hence `required-features = ["testing"]` in
//! `Cargo.toml` (same reasoning as `codec`/`world_terrain`).

use engine::hash::Fnv64;
use engine::noise::{fbm2, simplex2};

/// Raw bits of `simplex2`/`fbm2` over a spread of seeds and coordinates (including the far range
/// worldgen samples, 0008 §6), hashed so one golden covers the whole surface without checking in
/// every value by hand.
#[test]
fn noise_raw_bits_golden() {
    let mut h = Fnv64::new();
    let mut seed = 0x9E37_79B9u32;
    for i in 0..500i32 {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        // Every 97th sample lands far from the origin (worldgen's far-coordinate range, 0008 §6).
        let far = if i % 97 == 0 { 250_000.0 } else { 0.0 };
        let x = (i as f64) * 0.073 - 31.0 + far;
        let y = (i as f64) * -0.051 + 17.0 - far;
        // `.to_bits()` is the point of a raw-bits golden (0002 §3 "the hash/codec canonicalises
        // as a backstop"): every input here is finite by construction (bounded coordinates, no
        // division), so no NaN can reach it.
        #[allow(clippy::disallowed_methods)]
        {
            h.write_u64(simplex2(seed, x, y).to_bits());
            h.write_u64(fbm2(seed, x * 0.01, y * 0.01, 5).to_bits());
            h.write_u64(fbm2(seed ^ 0x5bd1_e995, x * 0.005, y * 0.005, 3).to_bits());
        }
    }
    engine::assert_golden_hash!("noise_raw_bits", h.finish());
}
