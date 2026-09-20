//! Fixture game `fx-terrain` (docs/plan/09-renderer-terrain.md, step 5): the whole worker -> ring
//! -> drain data path, real gen workers included, instead of steps 2-4's hand-filled renderer
//! textures. `Gen` role: a trivial, deterministic `Worldgen` (not real worldgen -- this fixture
//! exists to prove the data path, not to generate interesting terrain). `Client` role: a
//! `TerrainStore` over `Pristine<FixtureTerrain>`, the `TerrainFeed` that turns cache misses into
//! `genRequest`/`genResult` traffic (docs/plan/08b-gen-workers-and-queue.md), and the `Uploader`
//! that turns residency into upload-ring records (this milestone).
//!
//! Base/resource layer ids are used directly as visual ids: `ClientSide`'s default identity table
//! (`crates/engine/src/client/texel.rs`) needs no `Registry::set_base_visual`/
//! `install_visual_tables` call, since chunk (0, 0)'s base id 1 and chunk (1, 0)'s base id 2 are
//! already `VISUAL_GRASS`/`VISUAL_WATER` in `tests/browser/pages/public/terrain/tiles.json`, the
//! same sheet `terrain-readback.spec.ts`'s pre-existing hand-filled scenes already probe (grass 1,
//! water 2, ore resource 5) -- reused here rather than duplicated, so both the hand-filled and the
//! real-client scenes render identical pixels for identical visual ids.

use engine::abi::{Instance, RegionId, RegionLayout, Role, Status};
use engine::client::upload::RECORD_BYTES;
use engine::client::{CameraBlock, ClientSide, TerrainFeed, Uploader};
use engine::world::{CacheCapacity, ChunkCoord, ChunkDims, TerrainStore, Tile};
use engine::worldgen::{GenCore, Pristine, Worldgen};

/// Matches `worker/client-upload.ts`'s own `UPLOAD_BATCH_MAX` (docs/plan/09-renderer-terrain.md
/// Planning decisions: "`upload_stage` is called with `min(ring free slots, 16)`") -- the
/// `ChunkTexels` region must hold whatever the worker might ever request in one call.
const MAX_STAGE_BATCH: u32 = 16;
const CLIENT_CACHE_CHUNKS: u32 = 1024;
const EDGE: i32 = 32;

const VISUAL_GRASS: u8 = 1;
const VISUAL_WATER: u8 = 2;
const VISUAL_ORE: u8 = 5;
/// Local tile index (row-major within a 32x32 chunk) carrying the ore resource in chunk (0, 0):
/// matches `terrain-readback.spec.ts`'s own hand-filled scene (`writePageTexel(0, 5, ...)`).
const ORE_LOCAL_INDEX: usize = 5;

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FixtureParams {}

pub struct FixtureTerrain {
    role: FixtureRole,
}

/// Gen-role: `GenCore` wraps `Worldgen::generate` (0008). Client-role: a `TerrainStore` over the
/// same generator (cache miss), `TerrainFeed` (the gen queue) and `Uploader` (upload-ring staging).
enum FixtureRole {
    Gen(GenCore<FixtureTerrain>),
    Client {
        terrain: Box<TerrainStore>,
        feed: TerrainFeed,
        uploader: Box<Uploader<FixtureTerrain>>,
    },
}

impl Worldgen for FixtureTerrain {
    type Params = FixtureParams;
    const WORLDGEN_VERSION: u32 = 1;

    /// Deterministic, not real worldgen (docs/plan/09-renderer-terrain.md Deviations "Steps 5-7"):
    /// chunk (0, 0) is grass with one ore tile at local index 5; chunk (1, 0) is water; every other
    /// chunk is void (`Tile::VOID`, never probed by a pixel assertion).
    fn generate(_seed: u64, _params: &FixtureParams, chunk: ChunkCoord, out: &mut [Tile]) {
        debug_assert_eq!(out.len(), (EDGE * EDGE) as usize);
        if chunk == ChunkCoord::new(0, 0) {
            for (i, t) in out.iter_mut().enumerate() {
                *t = if i == ORE_LOCAL_INDEX {
                    Tile::new(VISUAL_GRASS, VISUAL_ORE, 0)
                } else {
                    Tile::new(VISUAL_GRASS, 0, 0)
                };
            }
        } else if chunk == ChunkCoord::new(1, 0) {
            out.fill(Tile::new(VISUAL_WATER, 0, 0));
        } else {
            out.fill(Tile::VOID);
        }
    }
}

impl ClientSide for FixtureTerrain {}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    #[serde(default = "default_gen_workers")]
    gen_workers: u32,
}

fn default_gen_workers() -> u32 {
    1
}

fn parse_config(game_cfg_json: &str) -> Result<Config, Status> {
    if game_cfg_json.is_empty() || game_cfg_json == "null" {
        return Ok(Config {
            gen_workers: default_gen_workers(),
        });
    }
    serde_json::from_str(game_cfg_json).map_err(|_| Status::BadConfig)
}

impl Instance for FixtureTerrain {
    fn init(role: Role, game_cfg_json: &str, layout: &mut RegionLayout) -> Result<Self, Status> {
        let cfg = parse_config(game_cfg_json)?;
        let dims = ChunkDims::new(5); // EDGE = 32 (Planning decisions "CHUNK_BITS is 5 here")
        match role {
            Role::Gen => {
                layout.region(RegionId::GenOut, dims.slab_bytes() as u32);
                Ok(FixtureTerrain {
                    role: FixtureRole::Gen(GenCore::new(dims, 0, FixtureParams {})),
                })
            }
            Role::Client => {
                layout.region(RegionId::GenIn, TerrainFeed::gen_in_bytes(dims) as u32);
                layout.region(RegionId::ChunkTexels, MAX_STAGE_BATCH * RECORD_BYTES as u32);
                let source = Pristine::<FixtureTerrain>::new(0, FixtureParams {});
                let terrain = TerrainStore::new(
                    dims,
                    Box::new(source),
                    CacheCapacity::Chunks(CLIENT_CACHE_CHUNKS),
                );
                let feed = TerrainFeed::new(dims, cfg.gen_workers);
                let uploader = Box::new(Uploader::<FixtureTerrain>::new(dims));
                Ok(FixtureTerrain {
                    role: FixtureRole::Client {
                        terrain: Box::new(terrain),
                        feed,
                        uploader,
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
            FixtureRole::Client {
                terrain,
                feed,
                uploader,
            } => {
                feed.on_frame(camera, terrain);
                uploader.on_frame(camera, terrain);
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
            FixtureRole::Client { terrain, feed, .. } => feed.deliver(worker, record, terrain),
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
            FixtureRole::Client { terrain, feed, .. } => {
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

    fn upload_stage(&mut self, max_records: u32, out: &mut [u8]) -> u32 {
        match &mut self.role {
            FixtureRole::Client {
                terrain, uploader, ..
            } => uploader.stage(max_records, terrain, out),
            FixtureRole::Gen(_) => 0,
        }
    }
}

engine::export_instance!(FixtureTerrain);
