//! `GameInstance<G>` (docs/plan/13-sim-host-tick-loop.md Scope): the generic `Instance`
//! `export_game!` builds for a real `Game`, dispatching per role: `Role::Sim` ->
//! [`host::Host<G>`](crate::host::Host), `Role::Gen` -> `worldgen::GenCore<G::Worldgen>`,
//! `Role::Client` -> [`ClientInstance<G>`], the client-role instance M06b/M08b/M09/M11 each built
//! once per hand-written fixture (`fixtures/terrain`, `fixtures/worldgen`), made generic over `G`
//! here so a real game gets it for free from `export_game!` alone. Existing fixtures keep their
//! own hand-written `Instance` impls unchanged (`Instance` is still implemented directly by any
//! low-level fixture, docs/plan/13-sim-host-tick-loop.md Files touched: only `fixtures/puts`
//! switches to `export_game!` this milestone).

use crate::abi::config::HexU64;
use crate::abi::{Instance, RegionId, RegionLayout, Role, Status};
use crate::client::upload::RECORD_BYTES;
use crate::client::{CameraBlock, InputEvent, InputQueue, TerrainFeed, Uploader};
use crate::game::Game;
use crate::host::Host;
use crate::world::{CacheCapacity, ChunkCoord, ChunkDims, TerrainStore};
use crate::worldgen::{GenCore, Pristine, Worldgen};

/// `RegionId::Rx`'s size for input on the client role (mirrors `fixtures/terrain`'s own constant,
/// docs/plan/11-camera-and-input.md): whatever the client worker's input-drain pump might hand
/// `on_input` in one call is bounded by `InputQueue::CAPACITY` whole records.
const INPUT_RX_BYTES: usize = InputQueue::CAPACITY * InputEvent::BYTES;
/// Matches `worker/client-upload.ts`'s own `UPLOAD_BATCH_MAX` (docs/plan/09-renderer-terrain.md
/// Planning decisions).
const MAX_STAGE_BATCH: u32 = 16;
/// 0007 §8's host/client cache budget default (1,024 chunks = 4 MiB at the default chunk size).
const DEFAULT_CACHE_CHUNKS: u32 = 1024;

fn default_gen_workers() -> u32 {
    1
}
fn default_cache_chunks() -> u32 {
    DEFAULT_CACHE_CHUNKS
}

/// The `game` config shared by the `gen` and `client` roles of `GameInstance<G>` (0009's `seed`/
/// `worldgen` params, used unchanged by every role that touches terrain, 0008 §2's three-places
/// table). `Role::Sim` has its own, larger config (`host::SimConfig`), since it alone reads 0009's
/// state-budget fields; this type only ever parses the same JSON the sim role also sees, taking
/// what it needs and defaulting the rest.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerrainConfig<P> {
    seed: HexU64,
    params: P,
    /// Client role only: how many gen workers `TerrainFeed` sizes its in-flight bookkeeping for
    /// (docs/plan/08b-gen-workers-and-queue.md). Ignored by the `gen` role.
    #[serde(default = "default_gen_workers")]
    gen_workers: u32,
    /// Client role only: host dense-chunk cache size (0009 `WorldConfig.cacheChunks`).
    #[serde(default = "default_cache_chunks")]
    cache_chunks: u32,
}

/// The client-role instance (docs/plan/13-sim-host-tick-loop.md Scope): a `TerrainStore` over
/// `Pristine<G::Worldgen>`, the `TerrainFeed` that turns cache misses into `genRequest`/
/// `genResult` traffic (docs/plan/08b-gen-workers-and-queue.md), the `Uploader` that turns
/// residency into upload-ring records (docs/plan/09-renderer-terrain.md), and the `InputQueue`
/// `on_input` decodes into (docs/plan/11-camera-and-input.md). Exactly `fixtures/terrain`'s own
/// `FixtureRole::Client` arm, generalised over `G: Game` instead of a fixture-local `NoGame`.
///
/// Inherits `Uploader::new`'s own `CHUNK_BITS == 5` assertion (0024 §9 tracks generalising this):
/// a `G` with a non-default `CHUNK_BITS` panics building this, same as it always has for
/// `fixtures/terrain`.
pub struct ClientInstance<G: Game> {
    terrain: Box<TerrainStore>,
    feed: TerrainFeed,
    uploader: Box<Uploader<G::Client, G>>,
    // Boxed like `terrain`/`uploader`: `InputQueue`'s fixed 64-record array is large enough to
    // trip clippy's `large_enum_variant` against `GameInstance::Sim`/`Gen`'s own size.
    input_queue: Box<InputQueue>,
}

impl<G: Game> ClientInstance<G> {
    fn init(game_cfg_json: &str, layout: &mut RegionLayout) -> Result<Self, Status> {
        let cfg: TerrainConfig<<G::Worldgen as Worldgen>::Params> =
            serde_json::from_str(game_cfg_json).map_err(|_| Status::BadConfig)?;
        let dims = ChunkDims::new(G::CHUNK_BITS);
        layout.region(RegionId::GenIn, TerrainFeed::gen_in_bytes(dims) as u32);
        layout.region(RegionId::ChunkTexels, MAX_STAGE_BATCH * RECORD_BYTES as u32);
        layout.region(RegionId::Rx, INPUT_RX_BYTES as u32);
        let source = Pristine::<G::Worldgen>::new(cfg.seed.0, cfg.params);
        let terrain = TerrainStore::new(
            dims,
            Box::new(source),
            CacheCapacity::Chunks(cfg.cache_chunks),
        );
        let feed = TerrainFeed::new(dims, cfg.gen_workers);
        let uploader = Box::new(Uploader::<G::Client, G>::new(dims));
        Ok(ClientInstance {
            terrain: Box::new(terrain),
            feed,
            uploader,
            input_queue: Box::new(InputQueue::new()),
        })
    }
}

/// The `Instance` `export_game!` points every real `Game` at. `Sim`'s payload is boxed: `Host<G>`
/// carries `host::warm::Warm`'s fixed 512-chunk scratch buffer (4 KiB), far larger than the other
/// two variants, and an unboxed enum would size every `GameInstance<G>` to its biggest member.
pub enum GameInstance<G: Game> {
    Sim(Box<Host<G>>),
    Gen(GenCore<G::Worldgen>),
    Client(ClientInstance<G>),
}

impl<G: Game> Instance for GameInstance<G>
where
    G::Global: Default,
{
    fn init(role: Role, game_cfg_json: &str, layout: &mut RegionLayout) -> Result<Self, Status> {
        match role {
            Role::Sim => {
                Host::<G>::init(role, game_cfg_json, layout).map(|h| GameInstance::Sim(Box::new(h)))
            }
            Role::Gen => {
                let cfg: TerrainConfig<<G::Worldgen as Worldgen>::Params> =
                    serde_json::from_str(game_cfg_json).map_err(|_| Status::BadConfig)?;
                let dims = ChunkDims::new(G::CHUNK_BITS);
                layout.region(RegionId::GenOut, dims.slab_bytes() as u32);
                Ok(GameInstance::Gen(GenCore::new(
                    dims, cfg.seed.0, cfg.params,
                )))
            }
            Role::Client => {
                ClientInstance::<G>::init(game_cfg_json, layout).map(GameInstance::Client)
            }
        }
    }

    fn sim_admit(&mut self, conn: u32, rx: &[u8]) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_admit(conn, rx),
            _ => Status::WrongRole,
        }
    }

    fn sim_tick(&mut self) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_tick(),
            _ => Status::WrongRole,
        }
    }

    fn sim_build_frame(&mut self, conn: u32, tx: &mut [u8]) -> Result<u32, Status> {
        match self {
            GameInstance::Sim(h) => h.sim_build_frame(conn, tx),
            _ => Err(Status::WrongRole),
        }
    }

    fn sim_hash(&mut self) -> u64 {
        match self {
            GameInstance::Sim(h) => h.sim_hash(),
            _ => 0,
        }
    }

    fn sim_genesis(&mut self) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_genesis(),
            _ => Status::WrongRole,
        }
    }

    fn sim_seal_frame(&mut self, persist: &mut [u8]) -> Result<u32, Status> {
        match self {
            GameInstance::Sim(h) => h.sim_seal_frame(persist),
            _ => Err(Status::WrongRole),
        }
    }

    fn sim_warm_one(&mut self) -> u32 {
        match self {
            GameInstance::Sim(h) => h.sim_warm_one(),
            _ => 0,
        }
    }

    /// "20 Hz is hardcoded" gap (docs/plan/13-sim-host-tick-loop.md): `G::TICK_RATE`'s own value,
    /// the same for every variant (a game-level constant, not role-specific) -- `abi::tick_hz`
    /// only ever calls this while `role == Role::Sim` (its own "wrong role" branch never reaches
    /// an instance method at all), but the answer would be identical from any variant.
    fn tick_hz(&mut self) -> u32 {
        G::TICK_RATE.hz_value()
    }

    fn gen_chunk(&mut self, cx: i32, cy: i32, out: &mut [u8]) -> Status {
        match self {
            GameInstance::Gen(core) => core.gen_chunk(cx, cy, out),
            _ => Status::Unsupported,
        }
    }

    fn frame(&mut self, _t_ms: f64, camera: &CameraBlock, _result: &mut [u8]) -> Status {
        match self {
            GameInstance::Client(c) => {
                c.feed.on_frame(camera, &c.terrain);
                c.uploader.on_frame(camera, &c.terrain);
                c.input_queue.clear();
                Status::Ok
            }
            _ => Status::Unsupported,
        }
    }

    fn gen_take(&mut self, worker: u32, out: &mut [u8; 16]) -> bool {
        match self {
            GameInstance::Client(c) => c.feed.take(worker, out),
            _ => false,
        }
    }

    fn gen_deliver(&mut self, worker: u32, record: &[u8]) -> Status {
        match self {
            GameInstance::Client(c) => c.feed.deliver(worker, record, &mut c.terrain),
            _ => Status::Unsupported,
        }
    }

    fn client_gen_stats(&mut self, result: &mut [u8]) -> Status {
        match self {
            GameInstance::Client(c) => {
                let s = c.feed.stats();
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
            _ => Status::Unsupported,
        }
    }

    fn client_chunk_hash(&mut self, cx: i32, cy: i32, result: &mut [u8]) -> Status {
        match self {
            GameInstance::Client(c) => match c.feed.chunk_hash(&c.terrain, ChunkCoord::new(cx, cy))
            {
                Some(h) => {
                    let Some(out) = result.get_mut(..8) else {
                        return Status::BadLength;
                    };
                    out[0..4].copy_from_slice(&(h as u32).to_le_bytes());
                    out[4..8].copy_from_slice(&((h >> 32) as u32).to_le_bytes());
                    Status::Ok
                }
                None => Status::NotCached,
            },
            _ => Status::Unsupported,
        }
    }

    fn upload_stage(&mut self, max_records: u32, out: &mut [u8]) -> u32 {
        match self {
            GameInstance::Client(c) => c.uploader.stage(max_records, &c.terrain, out),
            _ => 0,
        }
    }

    fn on_input(&mut self, rx: &[u8], result: &mut [u8]) -> Status {
        match self {
            GameInstance::Client(c) => {
                c.input_queue.decode_and_push_all(rx);
                let Some(out) = result.get_mut(..12) else {
                    return Status::BadLength;
                };
                out[0..4].copy_from_slice(&(c.input_queue.len() as u32).to_le_bytes());
                let (tile_x, tile_y) = match c.input_queue.last() {
                    Some(e) => (e.tile[0], e.tile[1]),
                    None => (0, 0),
                };
                out[4..8].copy_from_slice(&tile_x.to_le_bytes());
                out[8..12].copy_from_slice(&tile_y.to_le_bytes());
                Status::Ok
            }
            _ => Status::Unsupported,
        }
    }
}
