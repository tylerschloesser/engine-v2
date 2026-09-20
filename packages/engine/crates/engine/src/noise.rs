//! `engine::noise` (docs/decisions/0008-chunk-generation.md §1; Planning decisions 1 of
//! docs/plan/08-worldgen-and-gen-worker.md): optional, unprivileged f64 simplex noise and fBm a
//! game's `Worldgen` impl may use. Ported from `spikes/determinism-hash/src/lib.rs`'s f64
//! instance (`noise64`); the f32 instance is not carried over -- 0008 §1 requires f64 (or an
//! integer lattice coordinate plus a float fraction) for worldgen noise coordinates, and the spike
//! measured no speed difference. Octaves, frequencies, thresholds, biomes and scatter stay the
//! game's; a game that never calls this module has it dropped by LTO.
//!
//! Allowed float ops only (`.claude/rules/determinism.md`): `+ - * floor`, comparisons, `/` on
//! values that cannot be zero, and an integer lattice hash for gradient selection. No NaN can
//! arise: every division here divides by a compile-time-nonzero sum of positive powers of 0.5.

const F2: f64 = 0.366_025_403_784_438_65; // (sqrt(3)-1)/2
const G2: f64 = 0.211_324_865_405_187_13; // (3-sqrt(3))/6
const GRAD: [(f64, f64); 8] = [
    (1.0, 1.0),
    (-1.0, 1.0),
    (1.0, -1.0),
    (-1.0, -1.0),
    (1.0, 0.0),
    (-1.0, 0.0),
    (0.0, 1.0),
    (0.0, -1.0),
];

/// 32-bit lattice hash for gradient selection (`spikes/determinism-hash`): integer ops only.
#[inline]
fn lattice_hash(seed: u32, x: i32, y: i32) -> u32 {
    let mut h = seed ^ (x as u32).wrapping_mul(0x27d4_eb2d) ^ (y as u32).wrapping_mul(0x1656_67b1);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^ (h >> 16)
}

#[inline]
fn corner(seed: u32, i: i32, j: i32, x: f64, y: f64) -> f64 {
    let t = 0.5 - x * x - y * y;
    if t > 0.0 {
        let g = GRAD[(lattice_hash(seed, i, j) & 7) as usize];
        let t2 = t * t;
        t2 * t2 * (g.0 * x + g.1 * y)
    } else {
        0.0
    }
}

/// 2D simplex noise, roughly `[-1, 1]`. Only `+ - * floor`, comparisons and an integer hash: no
/// NaN can arise for finite `x`/`y`.
#[inline]
pub fn simplex2(seed: u32, x: f64, y: f64) -> f64 {
    let s = (x + y) * F2;
    let fi = (x + s).floor();
    let fj = (y + s).floor();
    let t = (fi + fj) * G2;
    let x0 = x - (fi - t);
    let y0 = y - (fj - t);
    let (i1, j1): (i32, i32) = if x0 > y0 { (1, 0) } else { (0, 1) };
    let x1 = x0 - (i1 as f64) + G2;
    let y1 = y0 - (j1 as f64) + G2;
    let x2 = x0 - 1.0 + 2.0 * G2;
    let y2 = y0 - 1.0 + 2.0 * G2;
    let i = fi as i32;
    let j = fj as i32;
    let n = corner(seed, i, j, x0, y0)
        + corner(seed, i.wrapping_add(i1), j.wrapping_add(j1), x1, y1)
        + corner(seed, i.wrapping_add(1), j.wrapping_add(1), x2, y2);
    70.0 * n
}

/// Fractal Brownian motion over [`simplex2`]: lacunarity 2, gain 0.5, `octaves` layers, normalised
/// to roughly `[-1, 1]` by dividing by the sum of amplitudes (a caller passes no literal, unlike
/// the spike's `fbm`: Seams of docs/plan/08-worldgen-and-gen-worker.md). `octaves == 0` returns
/// `0.0` without dividing by zero.
#[inline]
pub fn fbm2(seed: u32, x: f64, y: f64, octaves: u32) -> f64 {
    if octaves == 0 {
        return 0.0;
    }
    let mut sum: f64 = 0.0;
    let mut amp_sum: f64 = 0.0;
    let mut amp: f64 = 1.0;
    let mut fx = x;
    let mut fy = y;
    let mut o: u32 = 0;
    while o < octaves {
        sum += amp * simplex2(seed.wrapping_add(o.wrapping_mul(0x9E37_79B9)), fx, fy);
        amp_sum += amp;
        amp *= 0.5;
        fx *= 2.0;
        fy *= 2.0;
        o += 1;
    }
    sum / amp_sum
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Loosely bounded: simplex corners sum to somewhat more than `[-1, 1]` in principle, but
    /// never blow up, and fBm's normalisation keeps it in the same ballpark (0008 §1 "roughly
    /// [-1, 1]"). Guards against a sign or scale bug, not exact amplitude.
    #[test]
    fn noise_bounded() {
        let mut seed = 0x1234_5678u32;
        for i in 0..2000i32 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let x = (i as f64) * 0.037 - 12.3;
            let y = (i as f64) * -0.021 + 7.7;
            let n = simplex2(seed, x, y);
            assert!(
                n.is_finite() && n.abs() <= 1.5,
                "simplex2 out of range: {n}"
            );
            let f = fbm2(seed, x * 0.1, y * 0.1, 5);
            assert!(f.is_finite() && f.abs() <= 1.5, "fbm2 out of range: {f}");
        }
    }

    #[test]
    fn fbm2_zero_octaves_is_zero_not_nan() {
        assert_eq!(fbm2(1, 0.5, 0.5, 0), 0.0);
    }

    /// Repeated calls with the same inputs give the same result: the determinism rule
    /// (`.claude/rules/determinism.md`) applies here too, mechanically checked at the noise layer.
    /// Plain equality, not `to_bits` (banned, 0002 §3): every value here is finite by construction.
    #[test]
    fn noise_is_deterministic_for_repeated_calls() {
        for _ in 0..5 {
            assert_eq!(simplex2(7, 1.25, -3.5), simplex2(7, 1.25, -3.5));
            assert_eq!(fbm2(7, 1.25, -3.5, 5), fbm2(7, 1.25, -3.5, 5));
        }
    }
}
