//! Throwaway determinism spike. See RESULT.md.
//!
//! `safe` = the rules we intend to follow (f32 + - * floor, integer hash, no NaN).
//! `risky` = operations suspected of diverging, each behind its own export so the
//! driver can tell exactly which ones differ per environment.
//!
//! ABI: plain `extern "C"`, no wasm-bindgen. u64 results cross as wasm i64 (JS BigInt).

use core::hint::black_box;

// ---------------------------------------------------------------- hashing

pub struct Fnv(pub u64);
impl Fnv {
    pub const fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    #[inline]
    pub fn byte(&mut self, b: u8) {
        self.0 = (self.0 ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3);
    }
    #[inline]
    pub fn bytes(&mut self, bs: &[u8]) {
        for &b in bs {
            self.byte(b);
        }
    }
    #[inline]
    pub fn u32(&mut self, v: u32) {
        self.bytes(&v.to_le_bytes());
    }
    #[inline]
    pub fn u64(&mut self, v: u64) {
        self.bytes(&v.to_le_bytes());
    }
}

/// SplitMix64 finalizer.
#[inline]
pub fn mix64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// SplitMix64-style coordinate hash for resource scattering.
#[inline]
pub fn coord_hash(seed: u64, x: i32, y: i32) -> u64 {
    let a = mix64(seed.wrapping_add(0x9E37_79B9_7F4A_7C15));
    let b = mix64(a ^ (x as u32 as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    mix64(b ^ (y as u32 as u64).wrapping_mul(0xD1B5_4A32_D192_ED03))
}

pub struct SplitMix(pub u64);
impl SplitMix {
    #[inline]
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        mix64(self.0)
    }
}

/// 32-bit lattice hash for gradient selection.
#[inline]
fn lattice_hash(seed: u32, x: i32, y: i32) -> u32 {
    let mut h = seed
        ^ (x as u32).wrapping_mul(0x27d4_eb2d)
        ^ (y as u32).wrapping_mul(0x1656_67b1);
    h ^= h >> 15;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^ (h >> 16)
}

// ---------------------------------------------------------------- simplex (f32 and f64 via macro)

macro_rules! simplex_impl {
    ($modname:ident, $t:ty) => {
        pub mod $modname {
            use super::lattice_hash;
            // Literals, not computed with sqrt.
            const F2: $t = 0.366_025_403_784_438_65; // (sqrt(3)-1)/2
            const G2: $t = 0.211_324_865_405_187_13; // (3-sqrt(3))/6
            const GRAD: [($t, $t); 8] = [
                (1.0, 1.0),
                (-1.0, 1.0),
                (1.0, -1.0),
                (-1.0, -1.0),
                (1.0, 0.0),
                (-1.0, 0.0),
                (0.0, 1.0),
                (0.0, -1.0),
            ];

            #[inline]
            fn corner(seed: u32, i: i32, j: i32, x: $t, y: $t) -> $t {
                let t = 0.5 - x * x - y * y;
                if t > 0.0 {
                    let g = GRAD[(lattice_hash(seed, i, j) & 7) as usize];
                    let t2 = t * t;
                    t2 * t2 * (g.0 * x + g.1 * y)
                } else {
                    0.0
                }
            }

            /// 2D simplex noise, roughly [-1, 1]. Only + - * floor, comparisons, int hash.
            #[inline]
            pub fn simplex2(seed: u32, x: $t, y: $t) -> $t {
                let s = (x + y) * F2;
                let fi = (x + s).floor();
                let fj = (y + s).floor();
                let t = (fi + fj) * G2;
                let x0 = x - (fi - t);
                let y0 = y - (fj - t);
                let (i1, j1): (i32, i32) = if x0 > y0 { (1, 0) } else { (0, 1) };
                let x1 = x0 - (i1 as $t) + G2;
                let y1 = y0 - (j1 as $t) + G2;
                let x2 = x0 - 1.0 + 2.0 * G2;
                let y2 = y0 - 1.0 + 2.0 * G2;
                let i = fi as i32;
                let j = fj as i32;
                let n = corner(seed, i, j, x0, y0)
                    + corner(seed, i.wrapping_add(i1), j.wrapping_add(j1), x1, y1)
                    + corner(seed, i.wrapping_add(1), j.wrapping_add(1), x2, y2);
                70.0 * n
            }

            /// fBm: lacunarity 2, gain 0.5. `norm` = 1 / sum of amplitudes, as a literal.
            #[inline]
            pub fn fbm(seed: u32, x: $t, y: $t, octaves: u32, norm: $t) -> $t {
                let mut sum: $t = 0.0;
                let mut amp: $t = 1.0;
                let mut fx = x;
                let mut fy = y;
                let mut o = 0;
                while o < octaves {
                    sum = sum + amp * simplex2(seed.wrapping_add(o.wrapping_mul(0x9E37_79B9)), fx, fy);
                    amp = amp * 0.5;
                    fx = fx * 2.0;
                    fy = fy * 2.0;
                    o += 1;
                }
                sum * norm
            }
        }
    };
}
simplex_impl!(noise32, f32);
simplex_impl!(noise64, f64);

// ---------------------------------------------------------------- chunk generation

pub const CHUNK: usize = 32;
pub const TILES: usize = CHUNK * CHUNK;

#[inline]
fn classify(h: f32, m: f32) -> u8 {
    if h < -0.25 {
        0 // deep water
    } else if h < -0.05 {
        1 // shallow water
    } else if h < 0.0 {
        2 // sand
    } else if h > 0.55 {
        6 // mountain
    } else if m < -0.2 {
        3 // desert
    } else if m < 0.25 {
        4 // grass
    } else {
        5 // forest
    }
}

#[inline]
fn finish_tile(seed: u64, wx: i32, wy: i32, h: f32, m: f32) -> [u8; 4] {
    let terrain = classify(h, m);
    let r = coord_hash(seed, wx, wy);
    let density: u64 = match terrain {
        0 | 1 => 0,
        6 => 6000,
        _ => 1500,
    };
    let resource = if (r & 0xffff) < density { 1 + ((r >> 16) % 3) as u8 } else { 0 };
    let variant = ((r >> 24) & 3) as u8;
    // Float -> int quantization; `as` saturates, and h is never NaN.
    let hq = ((h * 0.5 + 0.5) * 255.0) as u8;
    [terrain, resource, variant, hq]
}

/// f32 generator. `raw` receives the raw noise bit patterns so the hash sees every bit,
/// not just threshold classifications.
pub fn gen_chunk_f32(seed: u64, cx: i32, cy: i32, tiles: &mut [u8; TILES * 4], raw: &mut [u32; TILES * 2]) {
    let s32 = seed as u32 ^ (seed >> 32) as u32;
    let bx = cx.wrapping_mul(CHUNK as i32);
    let by = cy.wrapping_mul(CHUNK as i32);
    const FREQ: f32 = 1.0 / 128.0; // power of two: exact
    let mut ty = 0;
    while ty < CHUNK {
        let wy = by.wrapping_add(ty as i32);
        let mut tx = 0;
        while tx < CHUNK {
            let wx = bx.wrapping_add(tx as i32);
            let x = wx as f32 * FREQ;
            let y = wy as f32 * FREQ;
            let h = noise32::fbm(s32, x, y, 5, 1.0 / 1.9375);
            let m = noise32::fbm(s32 ^ 0x5bd1_e995, x * 0.5, y * 0.5, 3, 1.0 / 1.75);
            let i = ty * CHUNK + tx;
            tiles[i * 4..i * 4 + 4].copy_from_slice(&finish_tile(seed, wx, wy, h, m));
            raw[i * 2] = h.to_bits();
            raw[i * 2 + 1] = m.to_bits();
            tx += 1;
        }
        ty += 1;
    }
}

/// Same generator, f64 coordinates and noise, result narrowed to f32 at the end.
pub fn gen_chunk_f64(seed: u64, cx: i32, cy: i32, tiles: &mut [u8; TILES * 4], raw: &mut [u32; TILES * 2]) {
    let s32 = seed as u32 ^ (seed >> 32) as u32;
    let bx = cx.wrapping_mul(CHUNK as i32);
    let by = cy.wrapping_mul(CHUNK as i32);
    const FREQ: f64 = 1.0 / 128.0;
    let mut ty = 0;
    while ty < CHUNK {
        let wy = by.wrapping_add(ty as i32);
        let mut tx = 0;
        while tx < CHUNK {
            let wx = bx.wrapping_add(tx as i32);
            let x = wx as f64 * FREQ;
            let y = wy as f64 * FREQ;
            let h = noise64::fbm(s32, x, y, 5, 1.0 / 1.9375) as f32;
            let m = noise64::fbm(s32 ^ 0x5bd1_e995, x * 0.5, y * 0.5, 3, 1.0 / 1.75) as f32;
            let i = ty * CHUNK + tx;
            tiles[i * 4..i * 4 + 4].copy_from_slice(&finish_tile(seed, wx, wy, h, m));
            raw[i * 2] = h.to_bits();
            raw[i * 2 + 1] = m.to_bits();
            tx += 1;
        }
        ty += 1;
    }
}

/// k-th test chunk coordinate: clusters around the origin, negative space, and
/// +-250,000 chunks (= +-8,000,000 tiles), plus hashed scattered coords.
pub fn chunk_coord(k: u32) -> (i32, i32) {
    const FAR: i32 = 250_000;
    const BASES: [(i32, i32); 8] = [
        (0, 0),
        (-1, -1),
        (FAR, FAR),
        (-FAR, -FAR),
        (FAR, -FAR),
        (-FAR - 1, 17),
        (123_456, -98_765),
        (-3, FAR),
    ];
    let b = BASES[(k % 8) as usize];
    let r = k / 8;
    if k % 16 == 15 {
        // scattered anywhere in +-262,144 chunks
        let h = mix64(k as u64);
        let x = ((h & 0x7ffff) as i32) - 0x40000;
        let y = (((h >> 20) & 0x7ffff) as i32) - 0x40000;
        (x, y)
    } else {
        (b.0 + (r % 16) as i32 - 8, b.1 + ((r / 16) % 16) as i32 - 8)
    }
}

fn chunks_hash(seed: u64, start: u32, n: u32, f64_variant: bool) -> u64 {
    let mut tiles = [0u8; TILES * 4];
    let mut raw = [0u32; TILES * 2];
    let mut h = Fnv::new();
    let mut k = start;
    while k < start.wrapping_add(n) {
        let (cx, cy) = chunk_coord(k);
        if f64_variant {
            gen_chunk_f64(seed, cx, cy, &mut tiles, &mut raw);
        } else {
            gen_chunk_f32(seed, cx, cy, &mut tiles, &mut raw);
        }
        h.u32(cx as u32);
        h.u32(cy as u32);
        h.bytes(&tiles);
        for &r in raw.iter() {
            h.u32(r);
        }
        k += 1;
    }
    h.0
}

/// Hash over tile bytes only (what would actually ship), no raw float bits.
fn chunks_tiles_only_hash(seed: u64, start: u32, n: u32) -> u64 {
    let mut tiles = [0u8; TILES * 4];
    let mut raw = [0u32; TILES * 2];
    let mut h = Fnv::new();
    let mut k = start;
    while k < start.wrapping_add(n) {
        let (cx, cy) = chunk_coord(k);
        gen_chunk_f32(seed, cx, cy, &mut tiles, &mut raw);
        h.bytes(&tiles);
        k += 1;
    }
    h.0
}

// ---------------------------------------------------------------- sims

const MAX_ENT: usize = 1024;

/// f32 spring sim, semi-implicit Euler, PRNG action stream. Only + - *.
fn sim_f32(seed: u64, n: u32, ticks: u32) -> u64 {
    let n = (n as usize).min(MAX_ENT);
    let mut p = [[0f32; 2]; MAX_ENT];
    let mut v = [[0f32; 2]; MAX_ENT];
    let mut tg = [[0f32; 2]; MAX_ENT];
    let mut rng = SplitMix(seed);
    const K: f32 = 40.0;
    const C: f32 = 6.0;
    const DT: f32 = 0.016_666_668; // literal, not 1.0/60.0
    const U16: f32 = 1.0 / 65536.0;
    let mut h = Fnv::new();
    let mut t = 0;
    while t < ticks {
        // 4 "actions" per tick: retarget an entity.
        let mut a = 0;
        while a < 4 {
            let r = rng.next();
            let e = (r % n as u64) as usize;
            tg[e][0] = (((r >> 16) & 0xffff) as f32 * U16 - 0.5) * 200.0;
            tg[e][1] = (((r >> 32) & 0xffff) as f32 * U16 - 0.5) * 200.0;
            a += 1;
        }
        let mut e = 0;
        while e < n {
            let mut d = 0;
            while d < 2 {
                let acc = K * (tg[e][d] - p[e][d]) - C * v[e][d];
                v[e][d] = v[e][d] + acc * DT;
                p[e][d] = p[e][d] + v[e][d] * DT;
                d += 1;
            }
            e += 1;
        }
        t += 1;
        if t % 1000 == 0 || t == ticks {
            let mut e = 0;
            while e < n {
                h.u32(p[e][0].to_bits());
                h.u32(p[e][1].to_bits());
                h.u32(v[e][0].to_bits());
                h.u32(v[e][1].to_bits());
                e += 1;
            }
        }
    }
    h.0
}

/// Same sim in 16.16 fixed point (i32 state, i64 intermediates).
fn sim_fixed(seed: u64, n: u32, ticks: u32) -> u64 {
    let n = (n as usize).min(MAX_ENT);
    let mut p = [[0i32; 2]; MAX_ENT];
    let mut v = [[0i32; 2]; MAX_ENT];
    let mut tg = [[0i32; 2]; MAX_ENT];
    let mut rng = SplitMix(seed);
    const K: i64 = 40 << 16;
    const C: i64 = 6 << 16;
    const DT: i64 = 1092; // ~1/60 in 16.16
    let mut h = Fnv::new();
    let mut t = 0;
    while t < ticks {
        let mut a = 0;
        while a < 4 {
            let r = rng.next();
            let e = (r % n as u64) as usize;
            tg[e][0] = ((((r >> 16) & 0xffff) as i64 - 32768) * 200) as i32;
            tg[e][1] = ((((r >> 32) & 0xffff) as i64 - 32768) * 200) as i32;
            a += 1;
        }
        let mut e = 0;
        while e < n {
            let mut d = 0;
            while d < 2 {
                let acc = ((K * (tg[e][d] as i64 - p[e][d] as i64)) >> 16) - ((C * v[e][d] as i64) >> 16);
                v[e][d] = (v[e][d] as i64 + ((acc * DT) >> 16)) as i32;
                p[e][d] = (p[e][d] as i64 + ((v[e][d] as i64 * DT) >> 16)) as i32;
                d += 1;
            }
            e += 1;
        }
        t += 1;
        if t % 1000 == 0 || t == ticks {
            let mut e = 0;
            while e < n {
                h.u32(p[e][0] as u32);
                h.u32(p[e][1] as u32);
                h.u32(v[e][0] as u32);
                h.u32(v[e][1] as u32);
                e += 1;
            }
        }
    }
    h.0
}

// ---------------------------------------------------------------- risky variants

/// Random f32 inputs spanning several magnitudes; never NaN/inf.
#[inline]
fn rand_f32(rng: &mut SplitMix) -> (f32, f32) {
    let r = rng.next();
    let a = ((r & 0xff_ffff) as f32 * (1.0 / 16_777_216.0) - 0.5) * 2.0; // [-1,1)
    let b = (((r >> 24) & 0xff_ffff) as f32 * (1.0 / 16_777_216.0) - 0.5) * 2.0;
    let scale = match (r >> 48) & 3 {
        0 => 1.0,
        1 => 10.0,
        2 => 1000.0,
        _ => 1.0e6,
    };
    (a * scale, b * scale)
}

pub const N_TRIG_FNS: u32 = 12;
pub const TRIG_NAMES: [&str; N_TRIG_FNS as usize] = [
    "sin", "cos", "tan", "exp", "ln", "powf", "atan2", "sqrt", "cbrt", "hypot", "sin_f64", "pow_f64",
];

/// Transcendentals via std (native: system libm; wasm: compiler-builtins' libm inside the module).
fn risky_std(f: u32, seed: u64, n: u32) -> u64 {
    let mut rng = SplitMix(seed);
    let mut h = Fnv::new();
    let mut i = 0;
    while i < n {
        let (a, b) = rand_f32(&mut rng);
        let (a, b) = (black_box(a), black_box(b));
        let small = a * 1.0e-6 * 8.0; // keep exp/pow finite when scale is 1e6
        match f {
            0 => h.u32(a.sin().to_bits()),
            1 => h.u32(a.cos().to_bits()),
            2 => h.u32(a.tan().to_bits()),
            3 => h.u32(small.exp().to_bits()),
            4 => h.u32((a * a + 1.0e-3).ln().to_bits()),
            5 => h.u32((a * a + 1.0e-3).powf(b * 1.0e-6 * 3.0).to_bits()),
            6 => h.u32(a.atan2(b).to_bits()),
            7 => h.u32((a * a).sqrt().to_bits()),
            8 => h.u32(a.cbrt().to_bits()),
            9 => h.u32(a.hypot(b).to_bits()),
            10 => h.u64((a as f64).sin().to_bits()),
            _ => h.u64(((a as f64) * (a as f64) + 1.0e-3).powf(b as f64 * 1.0e-6 * 3.0).to_bits()),
        }
        i += 1;
    }
    h.0
}

/// Hand-written sin/cos restricted to + - * floor (the "Factorio way"). Not correctly
/// rounded (abs error ~1e-6), but built only from fully specified IEEE ops, so it should be
/// bit-identical everywhere. Input in radians; range-reduced via turns.
pub mod det {
    const INV_TAU: f32 = 0.159_154_94;
    /// sin(2*pi*t) for t in [-0.25, 0.25], odd polynomial (Taylor to x^11 in radians).
    #[inline]
    fn sin_quarter(t: f32) -> f32 {
        let x = t * 6.283_185_5;
        let x2 = x * x;
        x * (1.0
            + x2 * (-0.166_666_67
                + x2 * (0.008_333_334
                    + x2 * (-0.000_198_412_7 + x2 * (0.000_002_755_731_9 + x2 * -0.000_000_025_052_108)))))
    }
    #[inline]
    pub fn sin(x: f32) -> f32 {
        let mut t = x * INV_TAU;
        t = t - (t + 0.5).floor(); // [-0.5, 0.5)
        if t > 0.25 {
            t = 0.5 - t;
        } else if t < -0.25 {
            t = -0.5 - t;
        }
        sin_quarter(t)
    }
    #[inline]
    pub fn cos(x: f32) -> f32 {
        sin(x + 1.570_796_4)
    }
}

fn safe_det_trig(seed: u64, n: u32) -> u64 {
    let mut rng = SplitMix(seed);
    let mut h = Fnv::new();
    let mut i = 0;
    while i < n {
        let (a, _) = rand_f32(&mut rng);
        let a = black_box(a);
        h.u32(det::sin(a).to_bits());
        h.u32(det::cos(a).to_bits());
        i += 1;
    }
    h.0
}

#[cfg(not(feature = "libm-crate"))]
fn risky_libm(_f: u32, _seed: u64, _n: u32) -> u64 {
    0 // feature off: reported as "n/a"
}

/// Same functions via the pinned pure-Rust `libm` crate (identical source on every target).
#[cfg(feature = "libm-crate")]
fn risky_libm(f: u32, seed: u64, n: u32) -> u64 {
    let mut rng = SplitMix(seed);
    let mut h = Fnv::new();
    let mut i = 0;
    while i < n {
        let (a, b) = rand_f32(&mut rng);
        let (a, b) = (black_box(a), black_box(b));
        let small = a * 1.0e-6 * 8.0;
        match f {
            0 => h.u32(libm::sinf(a).to_bits()),
            1 => h.u32(libm::cosf(a).to_bits()),
            2 => h.u32(libm::tanf(a).to_bits()),
            3 => h.u32(libm::expf(small).to_bits()),
            4 => h.u32(libm::logf(a * a + 1.0e-3).to_bits()),
            5 => h.u32(libm::powf(a * a + 1.0e-3, b * 1.0e-6 * 3.0).to_bits()),
            6 => h.u32(libm::atan2f(a, b).to_bits()),
            7 => h.u32(libm::sqrtf(a * a).to_bits()),
            8 => h.u32(libm::cbrtf(a).to_bits()),
            9 => h.u32(libm::hypotf(a, b).to_bits()),
            10 => h.u64(libm::sin(a as f64).to_bits()),
            _ => h.u64(libm::pow((a as f64) * (a as f64) + 1.0e-3, b as f64 * 1.0e-6 * 3.0).to_bits()),
        }
        i += 1;
    }
    h.0
}

/// mul_add (fused) alongside the unfused a*b+c; also counts how often they differ.
fn risky_mul_add(seed: u64, n: u32, which: u32) -> u64 {
    let mut rng = SplitMix(seed);
    let mut h = Fnv::new();
    let mut differ: u64 = 0;
    let mut i = 0;
    while i < n {
        let (a, b) = rand_f32(&mut rng);
        let (c, _) = rand_f32(&mut rng);
        let (a, b, c) = (black_box(a), black_box(b), black_box(c));
        let fused = a.mul_add(b, c);
        let plain = a * b + c;
        if fused.to_bits() != plain.to_bits() {
            differ += 1;
        }
        match which {
            0 => h.u32(fused.to_bits()),
            1 => h.u32(plain.to_bits()),
            _ => {}
        }
        i += 1;
    }
    if which == 2 {
        differ
    } else {
        h.0
    }
}

/// Division (non-NaN), f64<->f32 and int<->float conversions incl. saturating/out-of-range casts.
fn risky_conv(seed: u64, n: u32) -> u64 {
    let mut rng = SplitMix(seed);
    let mut h = Fnv::new();
    let mut i = 0;
    while i < n {
        let r = rng.next();
        let (a, b) = rand_f32(&mut rng);
        let (a, b, r) = (black_box(a), black_box(b), black_box(r));
        let d = f64::from_bits((r & 0x800f_ffff_ffff_ffff) | (((r >> 52) & 0x3f) + 1000) << 52); // finite f64
        h.u32((d as f32).to_bits()); // f64 -> f32 rounding
        h.u64((a as f64 * b as f64).to_bits()); // widen, multiply
        h.u32(((a as f64 * b as f64 + d) as f32).to_bits()); // narrow
        h.u32((a / (b * b + 1.0)).to_bits()); // plain division, never NaN
        h.u32((r as f32).to_bits()); // u64 -> f32
        h.u32(((r as i64) as f32).to_bits()); // i64 -> f32
        h.u64((r as f64).to_bits()); // u64 -> f64
        h.u32((a * 1.0e4) as i32 as u32); // f32 -> i32
        h.u32((a * 1.0e6 * 1.0e6) as i32 as u32); // saturating
        h.u32((a * 1.0e6) as u8 as u32); // saturating to u8
        h.u64((d * 1.0e300) as i64 as u64); // saturating f64 -> i64
        i += 1;
    }
    h.0
}

pub const N_NAN_ROWS: u32 = 14;
pub const NAN_NAMES: [&str; N_NAN_ROWS as usize] = [
    "0/0 runtime",
    "inf-inf",
    "inf*0",
    "sqrt(-1)",
    "-(0/0)",
    "qNaN(payload 1)+1",
    "sNaN(payload 1)+1",
    "sNaN f32->f64->f32 (no arithmetic)",
    "qNaN payload f32->f64 low32",
    "NaN.min(1)",
    "NaN*0 as i32",
    "0/0 const-folded by compiler",
    "normalize zero vector x/len",
    "two NaN payloads a+b",
];

/// Returns the bit pattern produced by NaN-making operation `row`.
fn nan_row(row: u32) -> u32 {
    let zero = black_box(0.0f32);
    let inf = black_box(f32::INFINITY);
    let neg1 = black_box(-1.0f32);
    let one = black_box(1.0f32);
    let qnan_p = black_box(f32::from_bits(0x7fc0_0001));
    let snan_p = black_box(f32::from_bits(0x7f80_0001));
    match row {
        0 => (zero / zero).to_bits(),
        1 => (inf - inf).to_bits(),
        2 => (inf * zero).to_bits(),
        3 => neg1.sqrt().to_bits(),
        4 => (-(zero / zero)).to_bits(),
        5 => (qnan_p + one).to_bits(),
        6 => (snan_p + one).to_bits(),
        7 => ((snan_p as f64) as f32).to_bits(),
        8 => (qnan_p as f64).to_bits() as u32,
        9 => qnan_p.min(one).to_bits(),
        10 => ((qnan_p * zero) as i32) as u32,
        11 => {
            let z = 0.0f32;
            (z / z).to_bits()
        }
        12 => {
            let (x, y) = (zero, zero);
            let len = (x * x + y * y).sqrt();
            (x / len).to_bits()
        }
        _ => (black_box(f32::from_bits(0xffc0_0123)) + black_box(f32::from_bits(0x7fc0_0456))).to_bits(),
    }
}

fn nan_hash() -> u64 {
    let mut h = Fnv::new();
    let mut r = 0;
    while r < N_NAN_ROWS {
        h.u32(nan_row(r));
        r += 1;
    }
    h.0
}

// ---------------------------------------------------------------- safe API (usable from main.rs)

pub mod api {
    pub fn safe_chunks(seed: u64, start: u32, n: u32) -> u64 {
        super::chunks_hash(seed, start, n, false)
    }
    pub fn safe_chunks_tiles_only(seed: u64, start: u32, n: u32) -> u64 {
        super::chunks_tiles_only_hash(seed, start, n)
    }
    pub fn safe_chunks_f64(seed: u64, start: u32, n: u32) -> u64 {
        super::chunks_hash(seed, start, n, true)
    }
    pub fn safe_sim_f32(seed: u64, n: u32, ticks: u32) -> u64 {
        super::sim_f32(seed, n, ticks)
    }
    pub fn safe_sim_fixed(seed: u64, n: u32, ticks: u32) -> u64 {
        super::sim_fixed(seed, n, ticks)
    }
    pub fn safe_det_trig(seed: u64, n: u32) -> u64 {
        super::safe_det_trig(seed, n)
    }
    pub fn risky_std(f: u32, seed: u64, n: u32) -> u64 {
        super::risky_std(f, seed, n)
    }
    pub fn risky_libm(f: u32, seed: u64, n: u32) -> u64 {
        super::risky_libm(f, seed, n)
    }
    pub fn risky_mul_add(seed: u64, n: u32, which: u32) -> u64 {
        super::risky_mul_add(seed, n, which)
    }
    pub fn risky_conv(seed: u64, n: u32) -> u64 {
        super::risky_conv(seed, n)
    }
    pub fn risky_nan_row(row: u32) -> u32 {
        super::nan_row(row)
    }
    pub fn risky_nan_hash() -> u64 {
        super::nan_hash()
    }
}

// ---------------------------------------------------------------- extern "C" ABI

#[export_name = "safe_chunks"]
pub extern "C" fn ffi_safe_chunks(seed: u64, start: u32, n: u32) -> u64 {
    api::safe_chunks(seed, start, n)
}
#[export_name = "safe_chunks_tiles_only"]
pub extern "C" fn ffi_safe_chunks_tiles_only(seed: u64, start: u32, n: u32) -> u64 {
    api::safe_chunks_tiles_only(seed, start, n)
}
#[export_name = "safe_chunks_f64"]
pub extern "C" fn ffi_safe_chunks_f64(seed: u64, start: u32, n: u32) -> u64 {
    api::safe_chunks_f64(seed, start, n)
}
#[export_name = "safe_sim_f32"]
pub extern "C" fn ffi_safe_sim_f32(seed: u64, n: u32, ticks: u32) -> u64 {
    api::safe_sim_f32(seed, n, ticks)
}
#[export_name = "safe_sim_fixed"]
pub extern "C" fn ffi_safe_sim_fixed(seed: u64, n: u32, ticks: u32) -> u64 {
    api::safe_sim_fixed(seed, n, ticks)
}
#[export_name = "safe_det_trig"]
pub extern "C" fn ffi_safe_det_trig(seed: u64, n: u32) -> u64 {
    api::safe_det_trig(seed, n)
}
#[export_name = "risky_std"]
pub extern "C" fn ffi_risky_std(f: u32, seed: u64, n: u32) -> u64 {
    api::risky_std(f, seed, n)
}
#[export_name = "risky_libm"]
pub extern "C" fn ffi_risky_libm(f: u32, seed: u64, n: u32) -> u64 {
    api::risky_libm(f, seed, n)
}
#[export_name = "risky_mul_add"]
pub extern "C" fn ffi_risky_mul_add(seed: u64, n: u32, which: u32) -> u64 {
    api::risky_mul_add(seed, n, which)
}
#[export_name = "risky_conv"]
pub extern "C" fn ffi_risky_conv(seed: u64, n: u32) -> u64 {
    api::risky_conv(seed, n)
}
#[export_name = "risky_nan_row"]
pub extern "C" fn ffi_risky_nan_row(row: u32) -> u32 {
    api::risky_nan_row(row)
}
#[export_name = "risky_nan_hash"]
pub extern "C" fn ffi_risky_nan_hash() -> u64 {
    api::risky_nan_hash()
}

// ---------------------------------------------------------------- precision probe (not a determinism test)

/// Compares the f32 generator against the f64 generator for one chunk.
/// which=0: number of tiles (of 1024) whose terrain byte differs; which=1: max |h32-h64| * 1e6.
#[export_name = "probe_precision"]
pub extern "C" fn ffi_probe_precision(seed: u64, cx: i32, cy: i32, which: u32) -> u32 {
    let mut t32 = [0u8; TILES * 4];
    let mut t64 = [0u8; TILES * 4];
    let mut r32 = [0u32; TILES * 2];
    let mut r64 = [0u32; TILES * 2];
    gen_chunk_f32(seed, cx, cy, &mut t32, &mut r32);
    gen_chunk_f64(seed, cx, cy, &mut t64, &mut r64);
    let mut mism = 0u32;
    let mut maxerr = 0f32;
    let mut i = 0;
    while i < TILES {
        if t32[i * 4] != t64[i * 4] {
            mism += 1;
        }
        let d = f32::from_bits(r32[i * 2]) - f32::from_bits(r64[i * 2]);
        let d = if d < 0.0 { -d } else { d };
        if d > maxerr {
            maxerr = d;
        }
        i += 1;
    }
    if which == 0 {
        mism
    } else {
        (maxerr * 1.0e6) as u32
    }
}
