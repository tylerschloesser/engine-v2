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
use engine::client::CameraBlock;
use engine::client::TerrainFeed;
use engine::noise::fbm2;
use engine::world::{CacheCapacity, ChunkCoord, ChunkDims, TerrainStore, Tile};
use engine::worldgen::{GenCore, Pristine, hash2};

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
    role: FixtureRole,
}

/// Gen-role: `GenCore` wraps `Worldgen::generate` (M08). Client-role (docs/plan/
/// 08b-gen-workers-and-queue.md): a `TerrainStore` over `Pristine<FixtureGen>` plus the
/// `TerrainFeed` that drives its generation queue -- the worldgen fixture for gen workers and the
/// client pristine-cache feed (CLAUDE.md).
enum FixtureRole {
    Gen(GenCore<FixtureGen>),
    Client {
        terrain: Box<TerrainStore>,
        feed: TerrainFeed,
    },
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
    /// Client role only: how many gen workers `TerrainFeed` sizes its in-flight bookkeeping for
    /// (docs/plan/08b-gen-workers-and-queue.md, `gen: one and two workers give equal chunk hashes`
    /// drives this with 1 and 2). Ignored by the gen role.
    #[serde(default = "default_gen_workers")]
    gen_workers: u32,
}

fn default_gen_workers() -> u32 {
    1
}

/// Client-role cache capacity (0007 §8's own default client cache size; 0008 §5's worst case at
/// the view bound, 225 retained, fits comfortably inside it).
const CLIENT_CACHE_CHUNKS: u32 = 1024;

impl Instance for FixtureGen {
    fn init(role: Role, game_cfg_json: &str, layout: &mut RegionLayout) -> Result<Self, Status> {
        let cfg: Config = serde_json::from_str(game_cfg_json).map_err(|_| Status::BadConfig)?;
        let dims = ChunkDims::new(5); // EDGE = 32
        match role {
            Role::Gen => {
                layout.region(RegionId::GenOut, dims.slab_bytes() as u32);
                Ok(FixtureGen {
                    role: FixtureRole::Gen(GenCore::new(dims, cfg.seed.0, cfg.params)),
                })
            }
            Role::Client => {
                layout.region(RegionId::GenIn, TerrainFeed::gen_in_bytes(dims) as u32);
                let source = Pristine::<FixtureGen>::new(cfg.seed.0, cfg.params);
                let terrain = TerrainStore::new(
                    dims,
                    Box::new(source),
                    CacheCapacity::Chunks(CLIENT_CACHE_CHUNKS),
                );
                let feed = TerrainFeed::new(dims, cfg.gen_workers);
                Ok(FixtureGen {
                    role: FixtureRole::Client {
                        terrain: Box::new(terrain),
                        feed,
                    },
                })
            }
            Role::Sim => Err(Status::BadConfig),
        }
    }

    fn gen_chunk(&mut self, cx: i32, cy: i32, out: &mut [u8]) -> Status {
        match &self.role {
            FixtureRole::Gen(core) => core.gen_chunk(cx, cy, out),
            FixtureRole::Client { .. } => Status::Unsupported,
        }
    }

    fn frame(&mut self, _t_ms: f64, camera: &CameraBlock, _result: &mut [u8]) -> Status {
        match &mut self.role {
            FixtureRole::Client { terrain, feed } => {
                feed.on_frame(camera, terrain);
                Status::Ok
            }
            FixtureRole::Gen(_) => Status::Unsupported,
        }
    }

    fn gen_take(&mut self, worker: u32, out: &mut [u8; 16]) -> bool {
        match &mut self.role {
            FixtureRole::Client { feed, .. } => feed.take(worker, out),
            FixtureRole::Gen(_) => false,
        }
    }

    fn gen_deliver(&mut self, worker: u32, record: &[u8]) -> Status {
        match &mut self.role {
            FixtureRole::Client { terrain, feed } => feed.deliver(worker, record, terrain),
            FixtureRole::Gen(_) => Status::Unsupported,
        }
    }

    fn client_gen_stats(&mut self, result: &mut [u8]) -> Status {
        match &self.role {
            FixtureRole::Client { feed, .. } => {
                let s = feed.stats();
                let Some(out) = result.get_mut(..28) else {
                    return Status::BadLength;
                };
                out[0..4].copy_from_slice(&s.requested.to_le_bytes());
                out[4..8].copy_from_slice(&s.dispatched.to_le_bytes());
                out[8..12].copy_from_slice(&s.delivered.to_le_bytes());
                out[12..16].copy_from_slice(&s.cancelled.to_le_bytes());
                out[16..20].copy_from_slice(&s.requeued.to_le_bytes());
                out[20..24].copy_from_slice(&s.pending.to_le_bytes());
                out[24..28].copy_from_slice(&s.in_flight.to_le_bytes());
                Status::Ok
            }
            FixtureRole::Gen(_) => Status::Unsupported,
        }
    }

    fn client_chunk_hash(&mut self, cx: i32, cy: i32, result: &mut [u8]) -> Status {
        match &self.role {
            FixtureRole::Client { terrain, feed } => {
                match feed.chunk_hash(terrain, ChunkCoord::new(cx, cy)) {
                    Some(h) => {
                        let Some(out) = result.get_mut(..8) else {
                            return Status::BadLength;
                        };
                        out[0..4].copy_from_slice(&(h as u32).to_le_bytes());
                        out[4..8].copy_from_slice(&((h >> 32) as u32).to_le_bytes());
                        Status::Ok
                    }
                    None => Status::NotCached,
                }
            }
            FixtureRole::Gen(_) => Status::Unsupported,
        }
    }
}

engine::export_instance!(FixtureGen);
