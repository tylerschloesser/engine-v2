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
use engine::client::{CameraBlock, ClientSide, InputEvent, InputQueue, TerrainFeed, Uploader};
use engine::game::{Game, PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
use engine::world::{
    CacheCapacity, ChunkCoord, ChunkDims, PrototypeId, Registry, TerrainStore, Tile, TilePos,
};
use engine::worldgen::{GenCore, Pristine, Worldgen};

/// Matches `worker/client-upload.ts`'s own `UPLOAD_BATCH_MAX` (docs/plan/09-renderer-terrain.md
/// Planning decisions: "`upload_stage` is called with `min(ring free slots, 16)`") -- the
/// `ChunkTexels` region must hold whatever the worker might ever request in one call.
const MAX_STAGE_BATCH: u32 = 16;
const CLIENT_CACHE_CHUNKS: u32 = 1024;
const EDGE: i32 = 32;

/// `RegionId::Rx`'s size for input (docs/plan/11-camera-and-input.md, Order of work 5): whatever
/// the client worker's own input-drain pump might hand `on_input` in one call is bounded by
/// `InputQueue::CAPACITY` whole records (`worker/client-input.ts`'s own per-wake batch is bounded
/// by this region's length), so that is exactly what `Rx` needs to hold.
const INPUT_RX_BYTES: usize = InputQueue::CAPACITY * InputEvent::BYTES;

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
        uploader: Box<Uploader<Vis, NoGame>>,
        // Boxed like `terrain`/`uploader` above: `InputQueue`'s fixed 64-record array is large
        // enough to trip clippy's `large_enum_variant` against `FixtureRole::Gen`'s own size.
        input_queue: Box<InputQueue>,
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

/// A trivial `Game`, named only so `Vis: ClientSide<G>` below has a concrete `G: Game` to satisfy
/// `Uploader`'s bound (docs/plan/12-store-and-game-trait.md Scope: `ClientSide<G: Game>` replaces
/// M09's unbounded, defaulted `G`). This fixture implements no `Sim` role (`Role::Sim` is rejected
/// in `Instance::init` below), so none of `NoGame`'s required methods is ever called; `Worldgen`
/// reuses `FixtureTerrain`'s own impl above rather than duplicating it.
struct NoGame;

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
struct NoReject;
impl From<Unknown> for NoReject {
    fn from(_: Unknown) -> Self {
        NoReject
    }
}

impl Game for NoGame {
    const SCHEMA_VERSION: u32 = 0;
    type Worldgen = FixtureTerrain;
    type Action = ();
    type Reject = NoReject;
    type Entity = ();
    type Player = ();
    type Global = ();
    type Presence = ();
    type Ui = ();
    type Client = ();

    fn register(_r: &mut Registry) {}
    fn prototype(_e: &()) -> PrototypeId {
        unimplemented!("NoGame has no entities")
    }
    fn anchor(_e: &()) -> TilePos {
        unimplemented!("NoGame has no entities")
    }
    fn genesis(_w: &mut dyn WorldWrite<Self>) {}
    fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
    fn apply(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _a: &()) -> Result<(), NoReject> {
        Ok(())
    }
    fn tick(_cx: &mut TickCx<'_, Self>) {}
}

/// The `ClientSide<NoGame>` implementor `Uploader` calls `tile_visual` through: kept separate from
/// `FixtureTerrain` because `ClientSide<G>: Default` (0003) and `FixtureTerrain` has no sensible
/// default (its `Gen`/`Client` roles are built from `Instance::init`'s arguments). Uses the
/// inherited default `tile_visual` (identity table): see the module doc comment.
#[derive(Default)]
struct Vis;
impl ClientSide<NoGame> for Vis {}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    #[serde(default = "default_gen_workers")]
    gen_workers: u32,
    /// Open gate failures items 3/4, gate round 1 (docs/plan/09-renderer-terrain.md Deviations
    /// "Gate fix round 1"): overrides `CLIENT_CACHE_CHUNKS` through `ClientOptions.test.game`
    /// (`{ clientCacheChunks: N }`) so a caller can force continuous eviction/slot-reuse with a
    /// small pan, without shrinking the default every other real-client test relies on.
    #[serde(default)]
    client_cache_chunks: Option<u32>,
}

fn default_gen_workers() -> u32 {
    1
}

fn parse_config(game_cfg_json: &str) -> Result<Config, Status> {
    if game_cfg_json.is_empty() || game_cfg_json == "null" {
        return Ok(Config {
            gen_workers: default_gen_workers(),
            client_cache_chunks: None,
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
                layout.region(RegionId::Rx, INPUT_RX_BYTES as u32);
                let source = Pristine::<FixtureTerrain>::new(0, FixtureParams {});
                let terrain = TerrainStore::new(
                    dims,
                    Box::new(source),
                    CacheCapacity::Chunks(cfg.client_cache_chunks.unwrap_or(CLIENT_CACHE_CHUNKS)),
                );
                // Paired with an `Uploader`, which drains cache events: opt in, exactly as the
                // real `ClientInstance` does (`game_instance.rs`).
                terrain.enable_cache_events();
                let feed = TerrainFeed::new(dims, cfg.gen_workers);
                let uploader = Box::new(Uploader::<Vis, NoGame>::new(dims));
                Ok(FixtureTerrain {
                    role: FixtureRole::Client {
                        terrain: Box::new(terrain),
                        feed,
                        uploader,
                        input_queue: Box::new(InputQueue::new()),
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
                input_queue,
            } => {
                feed.on_frame(camera, terrain);
                uploader.on_frame(camera, terrain);
                // docs/plan/11-camera-and-input.md Seams: `InputQueue` is "cleared at the end of
                // each `frame`" -- nothing in this milestone reads it for game logic yet
                // (`FrameCx::input` is M18, Non-scope), so this only proves the contract, not a
                // consumer of it.
                input_queue.clear();
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

    /// This range's own test export (docs/plan/11-camera-and-input.md, browser `input: events
    /// reach wasm`): decodes `rx` into the queue, then writes the queue's own length (`u32`) and
    /// its last event's tile (`i32` x2) into `result[0..12)` -- whatever `on_input` ran last owns
    /// `Result`'s content, same idiom as `gen_take`/`client_gen_stats`.
    fn on_input(&mut self, rx: &[u8], result: &mut [u8]) -> Status {
        match &mut self.role {
            FixtureRole::Client { input_queue, .. } => {
                input_queue.decode_and_push_all(rx);
                let Some(out) = result.get_mut(..12) else {
                    return Status::BadLength;
                };
                out[0..4].copy_from_slice(&(input_queue.len() as u32).to_le_bytes());
                let (tile_x, tile_y) = match input_queue.last() {
                    Some(e) => (e.tile[0], e.tile[1]),
                    None => (0, 0),
                };
                out[4..8].copy_from_slice(&tile_x.to_le_bytes());
                out[8..12].copy_from_slice(&tile_y.to_le_bytes());
                Status::Ok
            }
            FixtureRole::Gen(_) => Status::Unsupported,
        }
    }
}

engine::export_instance!(FixtureTerrain);
