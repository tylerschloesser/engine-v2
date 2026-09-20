//! Worldgen (docs/decisions/0008-chunk-generation.md): the pure, synchronous, non-allocating
//! function a game writes (§1); [`Pristine`] adapts it to [`crate::world::PristineSource`] so
//! `TerrainStore` (M07) can call it on a cache miss; [`worldgen_fingerprint`] and
//! [`WorldgenStamp`] are the 0007 §9 stamp; [`GenCore`] is the `gen`-role wrapper the ABI's
//! `gen_chunk` export calls (`abi::registry`).

use std::cell::RefCell;
use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use serde::ser::Serialize;

use crate::abi::Status;
use crate::hash::{Fnv64, mix64};
use crate::world::{ChunkCoord, ChunkDims, PristineSource, Tile};

/// The game's pure worldgen function (0008 §1, exactly). No `&self`, no world handle, no RNG, no
/// clock: the signature is the enforcement. Must write every element of `out` (row-major,
/// `dims.area()` tiles, where `dims` is whatever `ChunkDims` the game compiled `GenCore<Self>`
/// with -- fixed at compile time per game, 0007 §3). The only source of randomness is [`hash2`];
/// never the sim PRNG.
pub trait Worldgen {
    /// Stored in world params next to the seed; typed for the game's TypeScript by `ts-rs` (0014
    /// §4's config path). `HexU64` carries the seed itself, kept separate (Planning decisions 8).
    type Params: Serialize + DeserializeOwned;
    /// Bumped by the author when `generate`'s output changes; stamped into world params,
    /// snapshots and log segment headers (0007 §9), compared by [`WorldgenStamp`] on load.
    const WORLDGEN_VERSION: u32;
    /// Must write every element of `out`. No other inputs exist.
    fn generate(seed: u64, params: &Self::Params, chunk: ChunkCoord, out: &mut [Tile]);
}

/// The engine's stateless coordinate hash (0008 §1): the only source of randomness a [`Worldgen`]
/// impl may use for scatter, variants and the like. Ported from `spikes/determinism-hash`'s
/// `coord_hash`, itself [`mix64`] applied three times.
#[inline]
pub fn hash2(seed: u64, x: i32, y: i32) -> u64 {
    let a = mix64(seed.wrapping_add(0x9E37_79B9_7F4A_7C15));
    let b = mix64(a ^ (x as u32 as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    mix64(b ^ (y as u32 as u64).wrapping_mul(0xD1B5_4A32_D192_ED03))
}

/// Adapts a static, game-typed [`Worldgen`] to [`PristineSource`], the object-safe seam
/// `TerrainStore` calls on a cache miss (Planning decisions 2 of
/// docs/plan/07-world-model-core.md: a call per miss makes `dyn` free).
pub struct Pristine<W: Worldgen> {
    seed: u64,
    params: W::Params,
    _marker: PhantomData<fn() -> W>,
}

impl<W: Worldgen> Pristine<W> {
    pub fn new(seed: u64, params: W::Params) -> Self {
        Pristine {
            seed,
            params,
            _marker: PhantomData,
        }
    }
}

impl<W: Worldgen> PristineSource for Pristine<W> {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        W::generate(self.seed, &self.params, chunk, out);
    }
}

/// The 16 chunks [`worldgen_fingerprint`] hashes (0007 §9): near the origin and near `+-2^18`, one
/// cluster per axis-sign combination plus a few origin neighbours, fixed forever (a changed list
/// would change every stamped fingerprint).
const FINGERPRINT_CHUNKS: [(i32, i32); 16] = [
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

/// A 64-bit hash of the pristine tiles of 16 fixed chunks (0007 §9): stamped beside
/// `WORLDGEN_VERSION` so a save load can tell a divergent generator from a merely-forgotten
/// version bump. Runs once per world create/load, so the scratch `Vec` here is not a hot path.
pub fn worldgen_fingerprint(source: &dyn PristineSource, dims: ChunkDims) -> u64 {
    let mut scratch = vec![Tile::VOID; dims.area() as usize];
    let mut h = Fnv64::new();
    for &(cx, cy) in &FINGERPRINT_CHUNKS {
        source.generate(ChunkCoord::new(cx, cy), &mut scratch);
        for tile in &scratch {
            h.write_u32(tile.0);
        }
    }
    h.finish()
}

/// Carried in world params, snapshots and log segment headers (0007 §9). A mismatch in either
/// field on load takes the `SaveIncompatible` path (M22/M24b own that check; this is just the
/// value and its `Codec`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorldgenStamp {
    pub version: u32,
    pub fingerprint: u64,
}

/// The `gen`-role wrapper (0008 §2 table): owns the seed and params, and turns `gen_chunk(cx, cy)`
/// into `dims.slab_bytes()` little-endian tile bytes. One scratch slab, reserved once in [`new`]
/// (not a fresh `Vec` per call), so `generate` itself allocates nothing (`abi::arena` proves it,
/// Tests added of docs/plan/08-worldgen-and-gen-worker.md).
///
/// [`new`]: GenCore::new
pub struct GenCore<W: Worldgen> {
    dims: ChunkDims,
    seed: u64,
    params: W::Params,
    scratch: RefCell<Vec<Tile>>,
    _marker: PhantomData<fn() -> W>,
}

impl<W: Worldgen> GenCore<W> {
    pub fn new(dims: ChunkDims, seed: u64, params: W::Params) -> Self {
        let scratch = vec![Tile::VOID; dims.area() as usize];
        GenCore {
            dims,
            seed,
            params,
            scratch: RefCell::new(scratch),
            _marker: PhantomData,
        }
    }

    /// Fills `out` (must be exactly `dims.slab_bytes()`, else [`Status::BadLength`]) with
    /// `W::generate`'s tiles, little-endian, row-major (0008 §1).
    pub fn gen_chunk(&self, cx: i32, cy: i32, out: &mut [u8]) -> Status {
        if out.len() != self.dims.slab_bytes() {
            return Status::BadLength;
        }
        let mut scratch = self.scratch.borrow_mut();
        W::generate(
            self.seed,
            &self.params,
            ChunkCoord::new(cx, cy),
            &mut scratch,
        );
        for (tile, dst) in scratch.iter().zip(out.chunks_exact_mut(4)) {
            dst.copy_from_slice(&tile.to_le_bytes());
        }
        Status::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pinned vectors (computed from this exact implementation; see docs/plan/08-worldgen-and-gen-
    // worker.md Deviations for how). A change here means `hash2` changed, which changes every
    // worldgen golden.
    #[test]
    fn hash2_vectors() {
        // Computed from this exact implementation (printed with `cargo test -p engine --lib
        // worldgen::tests::hash2_vectors -- --nocapture` and pinned here; see
        // docs/plan/08-worldgen-and-gen-worker.md Deviations).
        assert_eq!(hash2(0, 0, 0), 0x33fe_8bd4_f9c5_7863);
        assert_eq!(hash2(0x5EED_1234_ABCD_0042, 0, 0), 0xa352_cbaa_41c2_01a1);
        assert_eq!(hash2(0x5EED_1234_ABCD_0042, 1, 0), 0xa330_386c_218d_9e62);
        assert_eq!(hash2(0x5EED_1234_ABCD_0042, 0, 1), 0x2407_e004_f922_6c43);
        assert_eq!(hash2(0x5EED_1234_ABCD_0042, -1, -1), 0x348a_388b_afeb_876f);
        assert_eq!(
            hash2(0x5EED_1234_ABCD_0042, 250_000, -250_000),
            0xf646_4113_04b7_8cd2
        );
    }

    #[test]
    fn hash2_is_deterministic_and_sensitive_to_every_input() {
        let a = hash2(1, 2, 3);
        assert_eq!(a, hash2(1, 2, 3));
        assert_ne!(a, hash2(2, 2, 3));
        assert_ne!(a, hash2(1, 3, 3));
        assert_ne!(a, hash2(1, 2, 4));
    }

    struct DummyParams;
    impl serde::Serialize for DummyParams {
        fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            s.serialize_unit()
        }
    }
    impl<'de> serde::Deserialize<'de> for DummyParams {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            <()>::deserialize(d).map(|()| DummyParams)
        }
    }

    struct DummyGen;
    impl Worldgen for DummyGen {
        type Params = DummyParams;
        const WORLDGEN_VERSION: u32 = 1;
        fn generate(seed: u64, _params: &DummyParams, chunk: ChunkCoord, out: &mut [Tile]) {
            for (i, t) in out.iter_mut().enumerate() {
                let h = hash2(seed, chunk.x, chunk.y).wrapping_add(i as u64);
                *t = Tile::new(h as u8, (h >> 8) as u8, (h >> 16) as u16);
            }
        }
    }

    #[test]
    fn gen_core_wrong_len_is_bad_length() {
        let dims = ChunkDims::new(4);
        let core = GenCore::<DummyGen>::new(dims, 42, DummyParams);
        let mut right = vec![0u8; dims.slab_bytes()];
        assert_eq!(core.gen_chunk(0, 0, &mut right), Status::Ok);
        let mut wrong = vec![0u8; dims.slab_bytes() - 1];
        assert_eq!(core.gen_chunk(0, 0, &mut wrong), Status::BadLength);
        let mut too_long = vec![0u8; dims.slab_bytes() + 1];
        assert_eq!(core.gen_chunk(0, 0, &mut too_long), Status::BadLength);
    }

    #[test]
    fn gen_core_matches_worldgen_generate() {
        let dims = ChunkDims::new(4);
        let core = GenCore::<DummyGen>::new(dims, 7, DummyParams);
        let mut out = vec![0u8; dims.slab_bytes()];
        assert_eq!(core.gen_chunk(3, -3, &mut out), Status::Ok);

        let mut tiles = vec![Tile::VOID; dims.area() as usize];
        DummyGen::generate(7, &DummyParams, ChunkCoord::new(3, -3), &mut tiles);
        let mut expected = Vec::with_capacity(out.len());
        for t in &tiles {
            expected.extend_from_slice(&t.to_le_bytes());
        }
        assert_eq!(out, expected);
    }
}
