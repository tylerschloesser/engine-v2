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
use crate::client::{
    ActionError, CameraBlock, ClientCore, DirtyEvent, InputEvent, InputQueue, TerrainFeed, Uploader,
};
use crate::game::{Game, PlayerId};
use crate::host::Host;
use crate::sim::{Applied, Rejected};
use crate::world::{CacheCapacity, ChunkCoord, ChunkDims};
use crate::worldgen::{GenCore, Pristine, Worldgen};

/// `RegionId::Rx`'s size for input on the client role (mirrors `fixtures/terrain`'s own constant,
/// docs/plan/11-camera-and-input.md): whatever the client worker's input-drain pump might hand
/// `on_input` in one call is bounded by `InputQueue::CAPACITY` whole records.
const INPUT_RX_BYTES: usize = InputQueue::CAPACITY * InputEvent::BYTES;
/// One action-ring record's own worst case (docs/plan/16-action-round-trip.md Scope: `[seq u32
/// LE][len u32 LE][UTF-8 JSON]`): the 8-byte header plus generous headroom for the JSON. `on_input`
/// and `on_action` are different message kinds sharing one `Rx` region (the client role's single
/// receive buffer, `RegionId::region`'s own "one declaration per id" rule) -- declared at
/// whichever of the two is larger, so neither caller's record can ever overrun it.
const ACTION_RX_BYTES: usize = 1024;
/// `RegionId::Ui`'s size on the client role: at most `client::core::OUTBOX_CAPACITY` action-result
/// records can be outstanding between two `client_poll_ui` polls (one per dispatched action, 0012's
/// own pending-queue figure), each comfortably under 128 bytes of JSON
/// (`{"seq":4294967295,"result":{"Rejected":{"Game":<reject>}}}` plus a generous reject payload).
/// Provisional, like every other region size in this file: a real per-frame UI-ring budget is a
/// later milestone's (M16b's `onUi` shares this region as record kind 1). Not an enforced
/// per-record cap -- `client_poll_ui`'s own doc comment covers the one record that exceeds it.
const UI_BYTES: u32 = (crate::client::OUTBOX_CAPACITY * 128) as u32;
/// `RegionId::Downlink`'s size on the client role (docs/plan/
/// 15b-ring-connection-and-replica-rendering.md): must hold the largest frame `host::Host::
/// build_frame` can ever produce, matching `host::mod`'s own `SIM_TX_BYTES` -- duplicated here
/// (that constant is private to `host::mod`) rather than shared, since keeping the two in step is
/// already `host::mod`'s own Deviations to track, not a value either role's `Instance` reads from
/// the other at runtime.
const CLIENT_DOWNLINK_BYTES: u32 = 65536;
/// `RegionId::Tx`'s size on the client role (`client_poll_uplink`'s `out`): must hold the largest
/// uplink batch the client can ever build, matching `host::mod`'s own `SIM_RX_BYTES` for the same
/// reason as [`CLIENT_DOWNLINK_BYTES`].
const CLIENT_UPLINK_BYTES: u32 = 4096;
/// Matches `worker/client-upload.ts`'s own `UPLOAD_BATCH_MAX` (docs/plan/09-renderer-terrain.md
/// Planning decisions).
const MAX_STAGE_BATCH: u32 = 16;
/// 0007 §8's host/client cache budget default (1,024 chunks = 4 MiB at the default chunk size).
const DEFAULT_CACHE_CHUNKS: u32 = 1024;

/// Kind byte for a UI-ring `ActionResults` record (docs/plan/16-action-round-trip.md Scope:
/// "`[kind u8 = 2][len][JSON ...]`"). Kind 1 (`Ui`, `G::Ui` changed) is M16b's, sharing this same
/// region.
const UI_RECORD_KIND_ACTION_RESULT: u8 = 2;

/// Appends one `[kind u8 = 2][len u32 LE][JSON]` record to `buf` for one decoded `ActionResults`
/// entry (docs/plan/16-action-round-trip.md Scope): `{"seq":n,"result":"Confirmed"}` or
/// `{"seq":n,"result":{"Rejected":{"Game":<G::Reject>}}}` /
/// `{"seq":n,"result":{"Rejected":{"Engine":<EngineReject>}}}` -- `Rejected<G>`'s two variants
/// (`Game`, `Engine`) keep their own tag (orchestrator ruling at the gate, not flattened away):
/// 0004's Decision defines `Rejected<G>` as exactly this two-variant enum
/// (`Rejected(Engine(StateBudgetFull))`), and dropping the tag would make a game's own reject
/// variant indistinguishable from the engine's by name alone once `EngineReject::RateLimited`
/// (M31) and `StateBudgetFull` (M21) are real -- a game also needs the distinction behaviourally
/// ("tell the player why" vs. "back off and retry"). Human-rate (called once per drained action
/// outcome): allocates a `String`, the same exemption `ClientCore::on_action` already relies on
/// (0016 §2).
fn push_result_record<G: Game>(buf: &mut Vec<u8>, seq: u32, result: &Result<Applied, Rejected<G>>) {
    let json = match result {
        Ok(Applied) => format!("{{\"seq\":{seq},\"result\":\"Confirmed\"}}"),
        Err(Rejected::Game(reject)) => {
            let reason = serde_json::to_string(reject)
                .expect("G::Reject is plain data (Codec): JSON encoding cannot fail");
            format!("{{\"seq\":{seq},\"result\":{{\"Rejected\":{{\"Game\":{reason}}}}}}}")
        }
        Err(Rejected::Engine(code)) => {
            let reason = serde_json::to_string(code)
                .expect("EngineReject is plain data: JSON encoding cannot fail");
            format!("{{\"seq\":{seq},\"result\":{{\"Rejected\":{{\"Engine\":{reason}}}}}}}")
        }
    };
    buf.push(UI_RECORD_KIND_ACTION_RESULT);
    buf.extend_from_slice(&(json.len() as u32).to_le_bytes());
    buf.extend_from_slice(json.as_bytes());
}

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

/// The client-role instance (docs/plan/13-sim-host-tick-loop.md Scope, extended by docs/plan/
/// 15b-ring-connection-and-replica-rendering.md): a [`ClientCore<G>`] (whose [`crate::client::
/// Replica<G>`] owns the one `TerrainStore` over `Pristine<G::Worldgen>` this instance has), the
/// `TerrainFeed` that turns cache misses into `genRequest`/`genResult` traffic (docs/plan/
/// 08b-gen-workers-and-queue.md), the `Uploader` that turns residency into upload-ring records
/// (docs/plan/09-renderer-terrain.md), and the `InputQueue` `on_input` decodes into (docs/plan/
/// 11-camera-and-input.md). Before 15b, this held its own standalone `TerrainStore` alongside a
/// nonexistent replica; 15b merges the two (Deviations: "one client-role terrain store, not two")
/// since `TerrainFeed`/`Uploader` only ever need `&TerrainStore`/`&mut TerrainStore`, which
/// `ClientCore::replica()`/`replica_mut()` now supply via `Replica::terrain()`/`terrain_mut()`.
///
/// Inherits `Uploader::new`'s own `CHUNK_BITS == 5` assertion (0024 §9 tracks generalising this):
/// a `G` with a non-default `CHUNK_BITS` panics building this, same as it always has for
/// `fixtures/terrain`.
pub struct ClientInstance<G: Game> {
    // Boxed (was already true of `terrain`/`uploader`/`input_queue` before 15b): `ClientCore<G>`
    // now carries what `terrain` used to (a `TerrainStore`) plus `Replica`'s own held-chunk/dirty
    // bookkeeping, large enough to keep tripping clippy's `large_enum_variant` against
    // `GameInstance::Sim`/`Gen`'s own size otherwise.
    core: Box<ClientCore<G>>,
    feed: TerrainFeed,
    uploader: Box<Uploader<G::Client, G>>,
    input_queue: Box<InputQueue>,
    /// UI-ring bytes staged since the last `client_poll_ui` (docs/plan/16-action-round-trip.md
    /// Scope): kind-2 (`ActionResults`) records only this milestone; M16b's `onUi` adds kind 1
    /// into the same buffer. Appended to by `on_frame` (one record per `ClientCore::drain_
    /// results` entry), copied out and cleared by `client_poll_ui`. Grows only on an action
    /// result (human rate, 0016 §2's exemption), never on a per-frame path.
    ui_buf: Vec<u8>,
}

impl<G: Game> ClientInstance<G> {
    fn init(game_cfg_json: &str, layout: &mut RegionLayout) -> Result<Self, Status>
    where
        G::Global: Default,
    {
        let cfg: TerrainConfig<<G::Worldgen as Worldgen>::Params> =
            serde_json::from_str(game_cfg_json).map_err(|_| Status::BadConfig)?;
        let dims = ChunkDims::new(G::CHUNK_BITS);
        layout.region(RegionId::GenIn, TerrainFeed::gen_in_bytes(dims) as u32);
        layout.region(RegionId::ChunkTexels, MAX_STAGE_BATCH * RECORD_BYTES as u32);
        layout.region(RegionId::Rx, INPUT_RX_BYTES.max(ACTION_RX_BYTES) as u32);
        layout.region(RegionId::Downlink, CLIENT_DOWNLINK_BYTES);
        layout.region(RegionId::Tx, CLIENT_UPLINK_BYTES);
        layout.region(RegionId::Ui, UI_BYTES);
        let source = Pristine::<G::Worldgen>::new(cfg.seed.0, cfg.params);
        // Single-connection assumption (docs/plan/15b-ring-connection-and-replica-rendering.md,
        // Planning decisions "PlayerId = conn + 1, not conn"): this milestone's own topology never
        // gives one client instance more than one host link, and it is always `conn == 0`, so
        // `own_player` is `PlayerId(1)` unconditionally rather than learned out of band (`Replica`'s
        // own doc comment on `own_player` names this as a real connection's usual path; a real
        // multi-connection handshake is M28's, Non-scope here).
        let mut replica = crate::client::Replica::<G>::new(
            dims,
            Box::new(source),
            CacheCapacity::Chunks(cfg.cache_chunks),
            PlayerId(1),
        );
        // The silent trap (docs/plan/15b-ring-connection-and-replica-rendering.md, Planning
        // decisions): a store paired with an `Uploader` -- the one consumer of cache events,
        // `Uploader::on_frame`'s drain -- must opt into recording them, or that drain silently
        // sees nothing and the renderer never updates. This replica's own `TerrainStore` is that
        // store now (it replaces the standalone one this instance used to build directly).
        replica.terrain_mut().enable_cache_events();
        let core = Box::new(ClientCore::new(replica));
        let feed = TerrainFeed::new(dims, cfg.gen_workers);
        let uploader = Box::new(Uploader::<G::Client, G>::new(dims));
        Ok(ClientInstance {
            core,
            feed,
            uploader,
            input_queue: Box::new(InputQueue::new()),
            ui_buf: Vec::new(),
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

    fn sim_connect(&mut self, conn: u32) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_connect(conn),
            _ => Status::WrongRole,
        }
    }

    fn sim_disconnect(&mut self, conn: u32) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_disconnect(conn),
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
                // docs/plan/15b-ring-connection-and-replica-rendering.md, Planning decisions "The
                // camera report is built in Rust from the camera-block copy, not in TS": every
                // real frame's camera state feeds `ClientCore::set_camera`, which queues an
                // uplink send only on change (0010 "Rates") -- `client_poll_uplink` (a separate
                // export, called right after this one every wake) is what actually drains it.
                c.core
                    .set_camera(camera.to_report(), camera.frame_time_ms as u32);
                let terrain = c.core.replica().terrain();
                c.feed.on_frame(camera, terrain);
                c.uploader.on_frame(camera, terrain);
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
            GameInstance::Client(c) => {
                c.feed
                    .deliver(worker, record, c.core.replica_mut().terrain_mut())
            }
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
            GameInstance::Client(c) => match c
                .feed
                .chunk_hash(c.core.replica().terrain(), ChunkCoord::new(cx, cy))
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
            GameInstance::Client(c) => {
                c.uploader
                    .stage(max_records, c.core.replica().terrain(), out)
            }
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

    /// docs/plan/15b-ring-connection-and-replica-rendering.md: applies one whole host frame
    /// (`ClientCore::on_frame`), then drains the two finer-grained halves of the replica's own
    /// dirty tracking straight into the `Uploader` this instance already owns -- Scope's "a tile
    /// delta becomes `patch_tile`... a snapshot or a leave becomes `enqueue_chunk`". A malformed
    /// frame is `Status::Decode` and leaves the replica untouched (`ClientCore::on_frame`'s own
    /// validate-first contract): nothing is drained in that case either, since nothing changed.
    fn on_frame(&mut self, bytes: &[u8]) -> Status {
        match self {
            GameInstance::Client(c) => {
                let ClientInstance {
                    core,
                    uploader,
                    ui_buf,
                    ..
                } = c;
                match core.on_frame(bytes) {
                    Ok(_summary) => {
                        core.replica_mut().drain_dirty_for_upload(|e| match e {
                            DirtyEvent::Whole(chunk) => uploader.enqueue_chunk(chunk),
                            DirtyEvent::Tile(pos, tile) => uploader.patch_tile(pos, tile),
                        });
                        // docs/plan/16-action-round-trip.md Scope: "on_frame reads ActionResults
                        // and writes one result record per entry to RegionId::Ui".
                        core.drain_results(|seq, result| {
                            push_result_record::<G>(ui_buf, seq, result);
                        });
                        Status::Ok
                    }
                    Err(_e) => Status::Decode,
                }
            }
            _ => Status::Unsupported,
        }
    }

    /// docs/plan/15b-ring-connection-and-replica-rendering.md: `ClientCore::poll_uplink`.
    fn client_poll_uplink(&mut self, t_ms: u32, out: &mut [u8]) -> usize {
        match self {
            GameInstance::Client(c) => c.core.poll_uplink(t_ms, out),
            _ => 0,
        }
    }

    /// docs/plan/16-action-round-trip.md: `ClientCore::on_action`. `Status::Decode` on a
    /// malformed ring record; `Status::OutOfMemory` when the outbox is already at capacity
    /// (`client::ActionError`'s two variants -- untrusted/backstop cases only, since the ring
    /// producer on main is expected to enforce both before ever writing a record here).
    fn on_action(&mut self, rx: &[u8]) -> Status {
        match self {
            GameInstance::Client(c) => match c.core.on_action(rx) {
                Ok(()) => Status::Ok,
                Err(ActionError::Malformed) => Status::Decode,
                Err(ActionError::Full) => Status::OutOfMemory,
            },
            _ => Status::Unsupported,
        }
    }

    /// docs/plan/16-action-round-trip.md: copies as many *whole* records as fit out of `ui_buf`
    /// (staged by `on_frame`) into `out` -- the "always answer, cost nothing" shape `upload_stage`/
    /// `gen_take` already use, no `Status`. `out` is `RegionId::Ui`'s whole capacity (`UI_BYTES`).
    ///
    /// **Never splits a record across two polls** (gate ruling, replacing an earlier draft that
    /// copied a raw byte prefix and discarded the tail): a record cut mid-`[kind][len][json]`
    /// leaves a garbage `len` for the TS ring parser downstream to choke on. Copied records are
    /// removed from `ui_buf`; whatever doesn't fit this call waits for the next one. The one
    /// pathological case -- a single record whose own `5 + len` exceeds `out.len()` in its
    /// entirety, so it can never fit *any* poll -- is dropped (consumed from `ui_buf`, never
    /// copied) rather than stalling every later record behind it forever; `UI_BYTES`'s own sizing
    /// (`OUTBOX_CAPACITY` results at a nominal 128 B) is provisional headroom, not an enforced
    /// per-record cap, so a game whose `G::Reject` carries a long string can still hit this.
    fn client_poll_ui(&mut self, out: &mut [u8]) -> usize {
        match self {
            GameInstance::Client(c) => {
                let mut consumed = 0usize;
                let mut copied = 0usize;
                while consumed + 5 <= c.ui_buf.len() {
                    let len = u32::from_le_bytes(
                        c.ui_buf[consumed + 1..consumed + 5]
                            .try_into()
                            .expect("checked length"),
                    ) as usize;
                    let record_len = 5 + len;
                    if consumed + record_len > c.ui_buf.len() {
                        // An incomplete record: `push_result_record` always appends one whole
                        // record atomically, so this should not happen -- treated the same as
                        // "wait for the rest" rather than panicking on untrusted-shaped state.
                        break;
                    }
                    if record_len > out.len() {
                        // Can never fit any poll buffer at all: drop it, don't stall.
                        consumed += record_len;
                        continue;
                    }
                    if copied + record_len > out.len() {
                        break; // doesn't fit *this* poll; try again next poll
                    }
                    out[copied..copied + record_len]
                        .copy_from_slice(&c.ui_buf[consumed..consumed + record_len]);
                    copied += record_len;
                    consumed += record_len;
                }
                c.ui_buf.drain(..consumed);
                copied
            }
            _ => 0,
        }
    }

    fn sim_region_hash(&mut self, conn: u32, result: &mut [u8]) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_region_hash(conn, result),
            _ => Status::WrongRole,
        }
    }

    fn client_region_hash(&mut self, result: &mut [u8]) -> Status {
        match self {
            GameInstance::Client(c) => {
                let Some(out) = result.get_mut(..8) else {
                    return Status::BadLength;
                };
                let hash = c.core.region_hash();
                out[0..4].copy_from_slice(&(hash as u32).to_le_bytes());
                out[4..8].copy_from_slice(&((hash >> 32) as u32).to_le_bytes());
                Status::Ok
            }
            _ => Status::Unsupported,
        }
    }

    fn sim_conn_counters(&mut self, conn: u32, result: &mut [u8]) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_conn_counters(conn, result),
            _ => Status::WrongRole,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::RegionLayout;
    use crate::game::{PlayerEvent, TickCx, Unknown, WorldWrite};
    use crate::sim::Outcome;
    use crate::wire::{ActionResultsWriter, FrameHeader, FrameWriter, SectionId};
    use crate::world::{PrototypeId, Registry, Tile, TilePos};

    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct GAction {
        n: u32,
    }
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    enum GReject {
        NotFound,
    }
    impl From<Unknown> for GReject {
        fn from(_: Unknown) -> Self {
            GReject::NotFound
        }
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct GEntity;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct GPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct GGlobal;

    struct GWorldgen;
    impl Worldgen for GWorldgen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    struct TestGame;
    impl Game for TestGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = GWorldgen;
        type Action = GAction;
        type Reject = GReject;
        type Entity = GEntity;
        type Player = GPlayer;
        type Global = GGlobal;
        type Presence = ();
        type Ui = ();
        type Client = ();
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &GEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &GEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(
            _w: &mut dyn WorldWrite<Self>,
            _who: PlayerId,
            _a: &GAction,
        ) -> Result<(), GReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn client_instance() -> GameInstance<TestGame> {
        let mut layout = RegionLayout::new();
        GameInstance::<TestGame>::init(
            Role::Client,
            r#"{"seed":"0x1","params":null,"genWorkers":1,"cacheChunks":1024}"#,
            &mut layout,
        )
        .unwrap()
    }

    fn frame_with_results(outcomes: &[Outcome<TestGame>]) -> Vec<u8> {
        let mut buf = [0u8; 512];
        let mut sink = crate::bytes::SliceSink::new(&mut buf);
        let mut fw = FrameWriter::new(
            &mut sink,
            FrameHeader {
                tick: 1,
                ack_seq: 1,
            },
        );
        fw.section(SectionId::ActionResults, |s| {
            ActionResultsWriter::write::<TestGame>(s, outcomes.iter());
        });
        let n = sink.finish().unwrap();
        buf[..n].to_vec()
    }

    /// docs/plan/16-action-round-trip.md: the exact `client_poll_ui` JSON for a `Confirmed` and a
    /// `Rejected` outcome, byte for byte -- `[kind u8 = 2][len u32 LE][JSON]`.
    #[test]
    fn client_poll_ui_produces_confirmed_and_rejected_json() {
        let mut inst = client_instance();

        let confirmed = vec![Outcome {
            seq: 1,
            result: Ok(Applied),
        }];
        assert_eq!(inst.on_frame(&frame_with_results(&confirmed)), Status::Ok);
        let mut ui_out = [0u8; 256];
        let n = inst.client_poll_ui(&mut ui_out);
        assert!(n > 0, "a Confirmed result must produce a UI record");
        assert_eq!(ui_out[0], 2, "kind byte: ActionResults record");
        let len = u32::from_le_bytes(ui_out[1..5].try_into().unwrap()) as usize;
        let json = std::str::from_utf8(&ui_out[5..5 + len]).unwrap();
        assert_eq!(json, r#"{"seq":1,"result":"Confirmed"}"#);

        let rejected = vec![Outcome {
            seq: 2,
            result: Err(Rejected::Game(GReject::NotFound)),
        }];
        assert_eq!(inst.on_frame(&frame_with_results(&rejected)), Status::Ok);
        let n2 = inst.client_poll_ui(&mut ui_out);
        assert!(n2 > 0, "a Rejected result must produce a UI record");
        let len2 = u32::from_le_bytes(ui_out[1..5].try_into().unwrap()) as usize;
        let json2 = std::str::from_utf8(&ui_out[5..5 + len2]).unwrap();
        assert_eq!(
            json2,
            r#"{"seq":2,"result":{"Rejected":{"Game":"NotFound"}}}"#
        );

        // The engine's own half of `Rejected<G>` keeps the same tag, not the game's.
        let rejected_engine = vec![Outcome {
            seq: 3,
            result: Err(Rejected::Engine(crate::sim::EngineReject::RateLimited)),
        }];
        assert_eq!(
            inst.on_frame(&frame_with_results(&rejected_engine)),
            Status::Ok
        );
        let n3 = inst.client_poll_ui(&mut ui_out);
        assert!(n3 > 0, "a Rejected(Engine) result must produce a UI record");
        let len3 = u32::from_le_bytes(ui_out[1..5].try_into().unwrap()) as usize;
        let json3 = std::str::from_utf8(&ui_out[5..5 + len3]).unwrap();
        assert_eq!(
            json3,
            r#"{"seq":3,"result":{"Rejected":{"Engine":"RateLimited"}}}"#
        );

        // Drained: nothing left to poll once no new frame has been applied.
        let n4 = inst.client_poll_ui(&mut ui_out);
        assert_eq!(n4, 0);
    }

    #[test]
    fn on_action_parses_a_valid_record_and_rejects_a_malformed_one() {
        let mut inst = client_instance();
        let mut record = Vec::new();
        record.extend_from_slice(&1u32.to_le_bytes());
        let json = r#"{"n":7}"#;
        record.extend_from_slice(&(json.len() as u32).to_le_bytes());
        record.extend_from_slice(json.as_bytes());
        assert_eq!(inst.on_action(&record), Status::Ok);

        assert_eq!(inst.on_action(&[1, 2, 3]), Status::Decode);
    }

    /// Decodes every `[kind u8][len u32 LE][json]` record in `bytes`, asserting each one's own
    /// `len` is honoured exactly (a split record would show up here as a bad UTF-8 slice or a
    /// `len` reaching past `bytes`'s own end -- `str::from_utf8`/slicing panics, which is exactly
    /// what a real TS ring parser would choke on too).
    fn decode_ui_records(bytes: &[u8]) -> Vec<(u8, String)> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            assert!(i + 5 <= bytes.len(), "a record header must never be split");
            let kind = bytes[i];
            let len = u32::from_le_bytes(bytes[i + 1..i + 5].try_into().unwrap()) as usize;
            assert!(
                i + 5 + len <= bytes.len(),
                "a record body must never be split"
            );
            let json = std::str::from_utf8(&bytes[i + 5..i + 5 + len])
                .expect("a record's own bytes must be whole, valid UTF-8")
                .to_string();
            out.push((kind, json));
            i += 5 + len;
        }
        out
    }

    /// docs/plan/16-action-round-trip.md (gate ruling): `client_poll_ui` must never split a
    /// record across two polls. Ten `Confirmed` results are staged (bigger than a handful of
    /// polls' worth of `out`); a deliberately small `out` forces several polls to drain them all,
    /// and every record the caller ever sees must parse whole, none lost, none duplicated.
    #[test]
    fn client_poll_ui_never_splits_a_record_across_polls() {
        let mut inst = client_instance();
        for seq in 1..=10u32 {
            let one = vec![Outcome {
                seq,
                result: Ok(Applied),
            }];
            assert_eq!(inst.on_frame(&frame_with_results(&one)), Status::Ok);
        }
        // One record (`{"seq":N,"result":"Confirmed"}`) is 5 + ~30 = ~35 B; 64 B fits at most one
        // whole record per poll, forcing genuine multi-poll draining.
        let mut out = [0u8; 64];
        let mut seen = Vec::new();
        loop {
            let n = inst.client_poll_ui(&mut out);
            if n == 0 {
                break;
            }
            for (kind, json) in decode_ui_records(&out[..n]) {
                assert_eq!(kind, 2);
                seen.push(json);
            }
        }
        let expected: Vec<String> = (1..=10)
            .map(|seq| format!("{{\"seq\":{seq},\"result\":\"Confirmed\"}}"))
            .collect();
        assert_eq!(
            seen, expected,
            "every record must arrive exactly once, in order"
        );
    }

    /// A record whose own length exceeds `out`'s entire capacity can never fit any poll: it must
    /// be dropped (consumed, never copied), not stall every record queued behind it forever.
    #[test]
    fn client_poll_ui_drops_a_record_too_big_for_any_poll_and_keeps_going() {
        let mut inst = client_instance();
        {
            let GameInstance::Client(c) = &mut inst else {
                unreachable!()
            };
            // A hand-built oversized record: kind 2, a 100-byte body, no real `Reject` type
            // needed -- `client_poll_ui`'s own walk only ever looks at `[kind][len]`, never the
            // payload shape.
            c.ui_buf.push(2);
            c.ui_buf.extend_from_slice(&100u32.to_le_bytes());
            c.ui_buf.extend_from_slice(&[b'x'; 100]);
        }
        // A normal record right behind it, which must still get through.
        let normal = vec![Outcome {
            seq: 1,
            result: Ok(Applied),
        }];
        assert_eq!(inst.on_frame(&frame_with_results(&normal)), Status::Ok);

        let mut out = [0u8; 64]; // smaller than the 105-byte oversized record
        let n = inst.client_poll_ui(&mut out);
        assert!(
            n > 0,
            "the oversized record must not block the one behind it"
        );
        let records = decode_ui_records(&out[..n]);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].1, r#"{"seq":1,"result":"Confirmed"}"#);

        // Drained: the oversized record was dropped, not left stuck at the front forever.
        let n2 = inst.client_poll_ui(&mut out);
        assert_eq!(n2, 0);
    }
}
