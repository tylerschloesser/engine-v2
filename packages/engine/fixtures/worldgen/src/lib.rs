//! Fixture game `worldgen`: a `Worldgen` impl in the `gen` role only, benchmark-representative
//! (Planning decisions 5 of docs/plan/08-worldgen-and-gen-worker.md) -- five-octave height,
//! three-octave moisture, a scatter hash for resources -- the spike's shape
//! (`spikes/determinism-hash`), so `worldgen-bench`'s number is comparable with 0008 §6.
//!
//! Float bits reach the golden through the tile (Planning decisions 3): the low 16 mantissa bits
//! of the height sample are packed into `aux`, so last-bit drift changes tile bytes, not just a
//! threshold classification.

use engine::abi::config::HexU64;
use engine::abi::{Instance, RegionId, RegionLayout, Role, Status};
use engine::noise::fbm2;
use engine::world::{ChunkCoord, ChunkDims, Tile};
use engine::worldgen::{GenCore, hash2};

pub use engine::worldgen::Worldgen;

/// Chunk edge this fixture always generates at (0007 §3's default): fixed at compile time, like a
/// real game's `CHUNK_BITS` (Planning decisions 1 of docs/plan/07-world-model-core.md).
const EDGE: i32 = 32;
const FREQ: f64 = 1.0 / 128.0;

/// Nothing to configure yet: the fixture's shape (octaves, frequency, thresholds) is fixed so the
/// benchmark number is comparable across runs. A real game's `Worldgen::Params` is where this
/// would live.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FixtureParams {}

pub struct FixtureGen {
    core: GenCore<Self>,
}

impl Worldgen for FixtureGen {
    type Params = FixtureParams;
    const WORLDGEN_VERSION: u32 = 1;

    fn generate(seed: u64, _params: &FixtureParams, chunk: ChunkCoord, out: &mut [Tile]) {
        debug_assert_eq!(out.len(), (EDGE * EDGE) as usize);
        let s32 = (seed as u32) ^ ((seed >> 32) as u32);
        let bx = chunk.x.wrapping_mul(EDGE);
        let by = chunk.y.wrapping_mul(EDGE);
        for ty in 0..EDGE {
            let wy = by.wrapping_add(ty);
            for tx in 0..EDGE {
                let wx = bx.wrapping_add(tx);
                let x = wx as f64 * FREQ;
                let y = wy as f64 * FREQ;
                let h = fbm2(s32, x, y, 5);
                let m = fbm2(s32 ^ 0x5bd1_e995, x * 0.5, y * 0.5, 3);
                let terrain = classify(h, m);
                let r = hash2(seed, wx, wy);
                let density: u64 = match terrain {
                    0 | 1 => 0,
                    6 => 6000,
                    _ => 1500,
                };
                let resource = if (r & 0xffff) < density {
                    1 + ((r >> 16) % 3) as u8
                } else {
                    0
                };
                let i = (ty * EDGE + tx) as usize;
                out[i] = Tile::new(terrain, resource, height_aux_bits(h));
            }
        }
    }
}

#[inline]
fn classify(h: f64, m: f64) -> u8 {
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

/// Packs the low 16 mantissa bits of the height sample into `aux` (Planning decisions 3): raw
/// float bits reach the golden through the tile, so last-bit drift changes tile bytes.
#[allow(clippy::disallowed_methods)] // finite by construction: fbm2's inputs are bounded, never NaN.
fn height_aux_bits(h: f64) -> u16 {
    debug_assert!(h.is_finite());
    (h.to_bits() & 0xffff) as u16
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    seed: HexU64,
    #[serde(default)]
    params: FixtureParams,
}

impl Instance for FixtureGen {
    fn init(role: Role, game_cfg_json: &str, layout: &mut RegionLayout) -> Result<Self, Status> {
        if role != Role::Gen {
            return Err(Status::BadConfig);
        }
        let cfg: Config = serde_json::from_str(game_cfg_json).map_err(|_| Status::BadConfig)?;
        let dims = ChunkDims::new(5); // EDGE = 32
        layout.region(RegionId::GenOut, dims.slab_bytes() as u32);
        Ok(FixtureGen {
            core: GenCore::new(dims, cfg.seed.0, cfg.params),
        })
    }

    fn gen_chunk(&mut self, cx: i32, cy: i32, out: &mut [u8]) -> Status {
        self.core.gen_chunk(cx, cy, out)
    }
}

engine::export_instance!(FixtureGen);
