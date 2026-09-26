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
use crate::client::drawlist;
use crate::client::upload::RECORD_BYTES;
use crate::client::{
    ActionError, CameraBlock, ClientCore, ClientSide, DirtyEvent, DrawList, FrameCx, InputEvent,
    InputQueue, TerrainFeed, UiObserver, Uploader,
};
use crate::game::{Clocks, FrameView, Game, PlayerId};
use crate::host::Host;
use crate::sim::{Applied, Rejected};
use crate::view;
use crate::world::{CacheCapacity, ChunkCoord, ChunkDims, TILE_MAX, TILE_MIN, TilePos};
use crate::world_access::WorldRead;
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

/// `TILE_MIN as f64`/`TILE_MAX as f64`'s own floor/clamp, shared by `frame()`'s window-origin and
/// visible-rect maths below (`view::visible_rect`'s own private `clamp_tile_axis` is not `pub`, and
/// duplicating a two-line floor+clamp is cheaper than exporting it, docs/plan/
/// 17-drawlist-and-sprites.md Deviations).
fn clamp_floor_tile_axis(v: f64) -> i32 {
    v.floor().clamp(TILE_MIN as f64, TILE_MAX as f64) as i32
}

/// This frame's own camera-derived `FrameView` fields (docs/plan/17-drawlist-and-sprites.md),
/// cached on `ClientInstance` after every real `frame()` call so `on_frame`'s own `FrameView` (no
/// `CameraBlock` in scope there -- `Instance::on_frame`'s signature is `bytes` only) can reuse the
/// last real one instead of inventing a placeholder. `ui()` never reads these fields today (0003:
/// `Ui` is UI/global/player-state derived), so reusing a frame-old value here is harmless; a future
/// game that does read them from `ui()` gets the same one-wake-old staleness `frame`-before-
/// `on_frame` already accepts elsewhere in this file (M16b Deviations).
#[derive(Clone, Copy)]
struct CachedCameraView {
    visible: crate::world::TileRect,
    zoom: f32,
    px_per_tile: f32,
    cursor_tile: Option<TilePos>,
    window_origin: TilePos,
    time_ms: f64,
}

impl Default for CachedCameraView {
    fn default() -> Self {
        CachedCameraView {
            visible: crate::world::TileRect::new(TilePos::default(), TilePos::default()),
            zoom: 0.0,
            px_per_tile: 0.0,
            cursor_tile: None,
            window_origin: TilePos::default(),
            time_ms: 0.0,
        }
    }
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
    /// Scope): kind-2 (`ActionResults`) records from `on_frame`, and kind-1 (`Ui`) records from
    /// `frame`'s own `ui` call policy below (docs/plan/16b-ui-observation-and-clock.md). Copied
    /// out and cleared by `client_poll_ui`; each kind grows this only at its own event's rate
    /// (action result, or a real `Ui` change), never on a per-frame path with nothing to report.
    ui_buf: Vec<u8>,
    /// The game's own per-client-frame hooks (0003 `ClientSide<G>`): constructed once with
    /// `Default` and lives for the instance (docs/plan/16b-ui-observation-and-clock.md Scope: "`G
    /// ::Client` is constructed with `Default` at client init and lives for the instance"). `frame`
    /// (M18) and `extract` (M17) are still no-ops; `ui` is real as of this milestone.
    client: G::Client,
    /// The `ui` call policy's own state (docs/plan/16b-ui-observation-and-clock.md): the reused
    /// `G::Ui` pair, the client-side dirty flag and the "since the last call" mutation counter.
    ui: UiObserver<G>,
    /// The per-frame draw list `ClientSide::extract` fills (docs/plan/17-drawlist-and-sprites.md,
    /// 0018 §2): scratch list + header/body-write state. Boxed for the same reason `core`/
    /// `uploader`/`input_queue` are (large, `Vec::with_capacity(65_536)` alone).
    drawlist: Box<DrawList>,
    /// A raw pointer into this instance's own `RegionId::DrawList` region, taken once at `init`
    /// (mirrors `CameraBlock::ptr`'s own precedent and safety argument, `client/camera.rs`'s doc
    /// comment): the region is a separate heap allocation from every other field of
    /// `ClientInstance` that never moves or resizes after init, so `frame()` can take a `&mut
    /// [u8]` from it for the duration of one `sort_into` call while `core`/`client`/`ui`/`ui_buf`
    /// are borrowed elsewhere in that same call -- the pointer itself borrows nothing.
    drawlist_region: *mut u8,
    /// The last real `frame()` call's own camera-derived `FrameView` fields (see
    /// `CachedCameraView`'s own doc comment): `on_frame` reuses this since it has no `CameraBlock`
    /// of its own.
    camera_view: CachedCameraView,
    /// docs/plan/18-picking-and-overlay.md steps 4-6: the previous real `frame()` call's own
    /// `camera.frame_time_ms`, so `FrameCx::dt_ms()` (Provides: "difference of successive `frame_
    /// time_ms`, clamped to `0..100`") has something to difference against. `0.0` at `init` --
    /// the very first real frame's own `dt_ms` is whatever that clamps to, the same "first call has
    /// no history" shape `camera/camera.ts`'s own `prevTilesAcross` (`Number.NaN` sentinel) accepts
    /// on the TS side, just clamped instead of NaN-guarded since this value is never read before a
    /// subtraction.
    last_frame_time_ms: f64,
    /// docs/plan/19-presence-channel.md step 2: this game's own persistent presence sample, one per
    /// client frame (0001: "the game's client-side Rust writes `G::Presence` once per client frame
    /// ... the engine samples it"). Replaces M18's scratch value, which `frame()` built fresh and
    /// discarded every call (docs/plan/18-picking-and-overlay.md steps 4-6 Deviations) -- keeping it
    /// here instead means a game that only writes on change (the common case, e.g. a spring at
    /// rest) does not lose its last value between frames.
    presence: G::Presence,
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
        layout.region(RegionId::DrawList, drawlist::REGION_BYTES as u32);
        let drawlist_region = layout.ptr(RegionId::DrawList);
        // `ClientSide::on_init` (docs/plan/20b-reference-player-and-collect-ui.md, gate round 1
        // fix): built and called *before* `cfg.params` moves into `Pristine::new` below (`Worldgen
        // ::Params` is not required to be `Clone`, so this must borrow it while `cfg` still owns
        // it) -- the one place a client can ever learn the seed/params its own world was created
        // with, since `Default::default()` itself takes no arguments.
        let mut client = G::Client::default();
        client.on_init(cfg.seed.0, &cfg.params);
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
            client,
            ui: UiObserver::new(),
            drawlist: Box::new(DrawList::new()),
            drawlist_region,
            camera_view: CachedCameraView::default(),
            last_frame_time_ms: 0.0,
            presence: G::Presence::default(),
        })
    }
}

/// The `Instance` `export_game!` points every real `Game` at. `Sim`'s payload is boxed: `Host<G>`
/// carries `host::warm::Warm`'s fixed 512-chunk scratch buffer (4 KiB), far larger than the other
/// two variants, and an unboxed enum would size every `GameInstance<G>` to its biggest member.
/// `Client`'s payload is boxed too (docs/plan/17-drawlist-and-sprites.md: `ClientInstance<G>` grew
/// past clippy's `large_enum_variant` threshold once `drawlist`/`camera_view` joined it), same
/// reasoning.
pub enum GameInstance<G: Game> {
    Sim(Box<Host<G>>),
    Gen(GenCore<G::Worldgen>),
    Client(Box<ClientInstance<G>>),
}

impl<G: Game> Instance for GameInstance<G>
where
    G::Global: Default,
{
    // docs/plan/19-presence-channel.md step 2 (Deviations, carrying forward docs/plan/
    // 18-picking-and-overlay.md steps 4-6's own note): M18 added a `G::Presence: Default`
    // where-clause here to construct `frame()`'s scratch value, since `Presence`'s own supertraits
    // (M12) did not include `Default` yet. 0024 §6 now puts `Default` directly on `Presence` itself
    // (`crate::presence::Presence: Codec + Copy + Default + 'static`), and `Game::type Presence:
    // Presence` carries that bound through automatically wherever `G: Game` is in scope -- this
    // where-clause would now only restate it, so it is gone (`G::Global` has no such supertrait and
    // still needs its own clause above).
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
            Role::Client => ClientInstance::<G>::init(game_cfg_json, layout)
                .map(|c| GameInstance::Client(Box::new(c))),
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

    fn sim_reattach(&mut self, conn: u32) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_reattach(conn),
            _ => Status::WrongRole,
        }
    }

    fn sim_fault_ack(&mut self, conn: u32, seq: u32) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_fault_ack(conn, seq),
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

    /// docs/plan/22-persistence-log-and-snapshots.md steps 4-6.
    fn sim_segment_header(
        &mut self,
        segment: u32,
        base_tick: u32,
        persist: &mut [u8],
    ) -> Result<u32, Status> {
        match self {
            GameInstance::Sim(h) => h.sim_segment_header(segment, base_tick, persist),
            _ => Err(Status::WrongRole),
        }
    }

    fn sim_snapshot_begin(&mut self, log_segment: u32, log_offset: u32) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_snapshot_begin(log_segment, log_offset),
            _ => Status::WrongRole,
        }
    }

    fn sim_snapshot_next(&mut self, persist: &mut [u8]) -> Result<u32, Status> {
        match self {
            GameInstance::Sim(h) => h.sim_snapshot_next(persist),
            _ => Err(Status::WrongRole),
        }
    }

    fn sim_dirty(&mut self) -> u32 {
        match self {
            GameInstance::Sim(h) => h.sim_dirty(),
            _ => 0,
        }
    }

    /// docs/plan/22b-persistence-load-and-fs.md.
    fn sim_restore_begin(&mut self, total_len: u32) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_restore_begin(total_len),
            _ => Status::WrongRole,
        }
    }

    fn sim_restore_push(&mut self, bytes: &[u8]) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_restore_push(bytes),
            _ => Status::WrongRole,
        }
    }

    fn sim_restore_end(&mut self, result: &mut [u8]) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_restore_end(result),
            _ => Status::WrongRole,
        }
    }

    /// docs/plan/24b-upgrade-and-migration.md step 4.
    fn sim_upgrade_begin(&mut self, total_len: u32) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_upgrade_begin(total_len),
            _ => Status::WrongRole,
        }
    }

    fn sim_upgrade_push(&mut self, bytes: &[u8]) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_upgrade_push(bytes),
            _ => Status::WrongRole,
        }
    }

    fn sim_upgrade_end(&mut self, result: &mut [u8]) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_upgrade_end(result),
            _ => Status::WrongRole,
        }
    }

    /// docs/plan/24-recovery-and-migration.md.
    fn sim_replay_scan_begin(&mut self, segment: u32) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_replay_scan_begin(segment),
            _ => Status::WrongRole,
        }
    }

    fn sim_replay_scan_push(&mut self, bytes: &[u8]) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_replay_scan_push(bytes),
            _ => Status::WrongRole,
        }
    }

    fn sim_replay_scan_end(&mut self, result: &mut [u8]) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_replay_scan_end(result),
            _ => Status::WrongRole,
        }
    }

    fn sim_replay_begin(&mut self, segment: u32, offset: u32) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_replay_begin(segment, offset),
            _ => Status::WrongRole,
        }
    }

    fn sim_replay_push(&mut self, bytes: &[u8]) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_replay_push(bytes),
            _ => Status::WrongRole,
        }
    }

    fn sim_replay_end(&mut self, result: &mut [u8]) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_replay_end(result),
            _ => Status::WrongRole,
        }
    }

    fn sim_replay_valid_end(&mut self) -> u32 {
        match self {
            GameInstance::Sim(h) => h.sim_replay_valid_end(),
            _ => 0,
        }
    }

    fn sim_tick_now(&mut self) -> u32 {
        match self {
            GameInstance::Sim(h) => h.sim_tick_now(),
            _ => 0,
        }
    }

    /// docs/plan/24-recovery-and-migration.md.
    fn sim_log_skip(
        &mut self,
        segment: u32,
        offset: u32,
        persist: &mut [u8],
    ) -> Result<u32, Status> {
        match self {
            GameInstance::Sim(h) => h.sim_log_skip(segment, offset, persist),
            _ => Err(Status::WrongRole),
        }
    }

    fn sim_test_trap(&mut self) -> Status {
        match self {
            GameInstance::Sim(h) => h.sim_test_trap(),
            _ => Status::WrongRole,
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

                // docs/plan/18-picking-and-overlay.md steps 4-6: `FrameCx::dt_ms()`'s own source --
                // computed (and this call's own `last_frame_time_ms` updated) before the destructure
                // below, since it needs only `camera` (already in scope) and one scalar field of `c`
                // itself, not any of the fields borrowed individually there.
                let dt_ms =
                    ((camera.frame_time_ms - c.last_frame_time_ms) as f32).clamp(0.0, 100.0);
                c.last_frame_time_ms = camera.frame_time_ms;

                // docs/plan/16b-ui-observation-and-clock.md Scope: "inside frame(t_ms) ... iff a
                // frame mutated the replica since the last call or the client-side dirty flag is
                // set". Gate fix ("Delivery order"): the mutation half of this policy now also
                // runs inside `on_frame` itself (see there), right when a frame's own mutation
                // lands -- so by the time this call runs, `ui.maybe_run` is normally a no-op
                // (`mutations` already matches what `on_frame` just recorded). This call still
                // exists for the dirty-flag-only case: client-side state changed (`FrameCx::
                // ui_dirty()`, steps 4-6) with no new host frame since the last check.
                // docs/plan/17-drawlist-and-sprites.md: this frame's own camera-derived `FrameView`
                // fields, cached for `on_frame`'s own reuse (`CachedCameraView`'s doc comment).
                // Window origin: the camera centre's tile, snapped to a multiple of 64 (Planning
                // decisions "Window origin").
                let centre_tile = TilePos::new(
                    clamp_floor_tile_axis(camera.centre[0]),
                    clamp_floor_tile_axis(camera.centre[1]),
                );
                c.camera_view = CachedCameraView {
                    visible: view::visible_tile_rect(
                        (camera.centre[0], camera.centre[1]),
                        (camera.half_extent_tiles[0], camera.half_extent_tiles[1]),
                        2.0,
                    ),
                    zoom: camera.tiles_across,
                    // Steps 4-6 Deviations "px_per_tile() wired for real": `camera/transform.ts`'s
                    // own `pxPerTile` formula (`max(viewportPxW, viewportPxH) / tilesAcross`), now
                    // that `CameraBlock::viewport_px` carries the real device-pixel viewport size.
                    // Guarded against `tiles_across <= 0` (every `CameraBlock::for_test` caller
                    // defaults it to `0.0`; `0.0` here matches this field's own old placeholder
                    // rather than an `inf`/`NaN` no downstream reader expects).
                    px_per_tile: if camera.tiles_across > 0.0 {
                        camera.viewport_px[0].max(camera.viewport_px[1]) / camera.tiles_across
                    } else {
                        0.0
                    },
                    cursor_tile: if camera.cursor_valid != 0 {
                        Some(TilePos::new(camera.cursor_tile[0], camera.cursor_tile[1]))
                    } else {
                        None
                    },
                    window_origin: drawlist::snap_window_origin(centre_tile),
                    time_ms: camera.frame_time_ms,
                };

                let ClientInstance {
                    core,
                    client,
                    ui,
                    ui_buf,
                    drawlist,
                    drawlist_region,
                    camera_view,
                    input_queue,
                    presence,
                    ..
                } = c.as_mut();
                let mutations = core.mutations();
                let replica = core.view();
                let clocks = Clocks {
                    authoritative: replica.tick(),
                    predicted: replica.tick(), // = authoritative until M26
                    tick_fraction: 0.0,        // a real lead is M26's
                    ticks_per_second: G::TICK_RATE.hz_value(),
                };
                let me = replica.own_player();
                // docs/plan/19-presence-channel.md steps 4-6: copied out *before* `client.frame`
                // (below) writes `*presence` -- `FrameView::own_presence()`'s own doc comment
                // explains why `FrameView` holds this by value rather than `&G::Presence`.
                let own_presence = *presence;
                let view = FrameView::new(
                    replica as &dyn WorldRead<G>,
                    clocks,
                    me,
                    replica.entities_map(),
                    replica.registry(),
                    camera_view.visible,
                    camera_view.zoom,
                    camera_view.px_per_tile,
                    camera_view.cursor_tile,
                    camera_view.window_origin,
                    camera_view.time_ms,
                    own_presence,
                    replica.remote_presences(),
                );

                // docs/plan/18-picking-and-overlay.md Scope, steps 4-6: "frame(t_ms) order becomes
                // build FrameView -> ClientSide::frame -> extract -> header (follow, anchors) ->
                // sort -> publish -> clear InputQueue". `cx` borrows `view` (the same value `extract`
                // receives below), `camera` and `input_queue`'s own events for exactly this call;
                // `presence` (docs/plan/19-presence-channel.md step 2) is this instance's own
                // persistent field now, not a fresh scratch value -- a game that writes it only on
                // change keeps its last value across frames the way the field's own doc comment
                // says.
                let follow = {
                    let mut cx = FrameCx::new(&view, camera, dt_ms, input_queue.events());
                    client.frame(&mut cx, presence);
                    if cx.took_ui_dirty() {
                        ui.mark_dirty();
                    }
                    cx.take_follow()
                };

                ui.maybe_run(client, &view, mutations, ui_buf);

                // docs/plan/17-drawlist-and-sprites.md Scope: "frame(t_ms) now runs: build
                // FrameView -> G::Client::extract -> sort". `drawlist_region`: see
                // `ClientInstance::drawlist_region`'s own doc comment for the safety argument.
                drawlist.begin_frame(camera_view.window_origin);
                client.extract(&view, drawlist.as_mut());

                // docs/plan/19-presence-channel.md step 2: samples this frame's (possibly
                // just-written) presence into the uplink sampler (0010 "Rates": "presence sample at
                // <= 10 Hz, on change") -- `core.poll_uplink` (a separate export, called right after
                // this one every wake, matching `set_camera`'s own precedent above) is what actually
                // paces and sends it. Deferred to here, past `view`'s own last use just above,
                // because `view` borrows `core` immutably (through `core.view()`'s `replica`) for the
                // whole span between the two, and `set_presence` needs `core` mutably.
                core.set_presence(presence);

                // SAFETY: see `ClientInstance::drawlist_region`'s doc comment.
                let region = unsafe {
                    core::slice::from_raw_parts_mut(*drawlist_region, drawlist::REGION_BYTES)
                };
                drawlist.sort_into(region, camera_view.time_ms, follow);

                // "... -> publish -> clear InputQueue": the JS side's own "publish" (`worker/
                // client-drawlist.ts`'s pump, run right after this ABI call returns) copies `region`
                // into the real triple-buffer SAB -- outside this function entirely, so "after
                // publish" collapses to "the last thing this call does" from here: every event
                // `cx.input()` exposed this frame has now been through `ClientSide::frame`, and
                // `extract`/`sort_into` never read the queue at all.
                input_queue.clear();

                Status::Ok
            }
            _ => Status::Unsupported,
        }
    }

    /// docs/plan/17-drawlist-and-sprites.md Provides: how many records the last `frame()` call's
    /// own `sort_into` wrote (`0` on a wrong role, same "always answer, cost nothing" shape as
    /// `sim_warm_one`/`tick_hz` -- no `Status` crosses here either).
    fn drawlist_len(&mut self) -> u32 {
        match self {
            GameInstance::Client(c) => c.drawlist.record_count(),
            _ => 0,
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
                    client,
                    ui,
                    ui_buf,
                    camera_view,
                    presence,
                    ..
                } = c.as_mut();
                match core.on_frame(bytes) {
                    Ok(_summary) => {
                        core.replica_mut().drain_dirty_for_upload(|e| match e {
                            DirtyEvent::Whole(chunk) => uploader.enqueue_chunk(chunk),
                            DirtyEvent::Tile(pos, tile) => uploader.patch_tile(pos, tile),
                        });
                        // docs/plan/16b-ui-observation-and-clock.md gate fix ("Delivery order"):
                        // the `ui` call policy runs *here*, right after this frame's own mutation
                        // has landed on the replica and *before* this same frame's own results are
                        // pushed below -- not in `frame(t_ms)` (a separate ABI export the client
                        // worker calls *before* draining the downlink, docs/plan/
                        // 15b-ring-connection-and-replica-rendering.md), which would only ever see
                        // this mutation on the *next* wake. This guarantees a kind-1 record for
                        // this frame's own state precedes this frame's own kind-2 result records in
                        // `ui_buf`, satisfying "a result handler sees current state" (M16 brief,
                        // M16b Planning decisions) with no extra latency. `frame(t_ms)`'s own call
                        // to `ui.maybe_run` (unchanged) still exists for the dirty-flag-only case
                        // (client-side state changed with no new host frame, M18); it is a no-op
                        // here since `mutations` already matches what this call just recorded.
                        let mutations = core.mutations();
                        let replica = core.view();
                        let clocks = Clocks {
                            authoritative: replica.tick(),
                            predicted: replica.tick(), // = authoritative until M26
                            tick_fraction: 0.0,        // a real lead is M26's
                            ticks_per_second: G::TICK_RATE.hz_value(),
                        };
                        let me = replica.own_player();
                        // docs/plan/17-drawlist-and-sprites.md: no `CameraBlock` is in scope here
                        // (`Instance::on_frame`'s own signature is `bytes` only) -- reuses the last
                        // real `frame()` call's own camera-derived fields (`CachedCameraView`'s doc
                        // comment); `ui()` never reads them today, so one-wake staleness is
                        // harmless.
                        let view = FrameView::new(
                            replica as &dyn WorldRead<G>,
                            clocks,
                            me,
                            replica.entities_map(),
                            replica.registry(),
                            camera_view.visible,
                            camera_view.zoom,
                            camera_view.px_per_tile,
                            camera_view.cursor_tile,
                            camera_view.window_origin,
                            camera_view.time_ms,
                            *presence,
                            replica.remote_presences(),
                        );
                        ui.maybe_run(client, &view, mutations, ui_buf);
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

    /// docs/plan/16-action-round-trip.md: `ClientCore::last_summary()`'s `tick`/`ack_seq`, two LE
    /// `u32` into `result` -- the client worker's own source for the clock block's
    /// `authoritative_tick`/`ack_seq` fields (`predicted_tick`, `ticks_per_second`, `session_state`
    /// and `seq_seed` are derived entirely in TS).
    fn client_clock_stats(&mut self, result: &mut [u8]) -> Status {
        match self {
            GameInstance::Client(c) => {
                let Some(out) = result.get_mut(..8) else {
                    return Status::BadLength;
                };
                let s = c.core.last_summary();
                out[0..4].copy_from_slice(&s.tick.0.to_le_bytes());
                out[4..8].copy_from_slice(&s.ack_seq.to_le_bytes());
                Status::Ok
            }
            _ => Status::Unsupported,
        }
    }

    /// docs/plan/16b-ui-observation-and-clock.md, `engine/test` only: `UiObserver::mark_dirty()`.
    /// No region crosses; the flag lives entirely on the WASM side.
    fn client_ui_mark_dirty(&mut self) -> Status {
        match self {
            GameInstance::Client(c) => {
                c.ui.mark_dirty();
                Status::Ok
            }
            _ => Status::Unsupported,
        }
    }

    /// docs/plan/16b-ui-observation-and-clock.md, `engine/test` only: `UiObserver::{calls,
    /// records}`, two LE `u32` into `result`.
    fn client_ui_stats(&mut self, result: &mut [u8]) -> Status {
        match self {
            GameInstance::Client(c) => {
                let Some(out) = result.get_mut(..8) else {
                    return Status::BadLength;
                };
                out[0..4].copy_from_slice(&c.ui.calls().to_le_bytes());
                out[4..8].copy_from_slice(&c.ui.records().to_le_bytes());
                Status::Ok
            }
            _ => Status::Unsupported,
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
    /// docs/plan/16-action-round-trip.md: `client_clock_stats` reports zero before any frame is
    /// applied, and the applied frame's own `tick`/`ack_seq` afterwards -- the two values the
    /// client worker mirrors into the clock block after each `on_frame`.
    #[test]
    fn client_clock_stats_reports_last_applied_tick_and_ack_seq() {
        let mut inst = client_instance();
        let mut out = [0u8; 8];
        assert_eq!(inst.client_clock_stats(&mut out), Status::Ok);
        assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(out[4..8].try_into().unwrap()), 0);

        let mut buf = [0u8; 512];
        let mut sink = crate::bytes::SliceSink::new(&mut buf);
        let mut fw = FrameWriter::new(
            &mut sink,
            FrameHeader {
                tick: 7,
                ack_seq: 3,
            },
        );
        fw.section(SectionId::ActionResults, |s| {
            ActionResultsWriter::write::<TestGame>(s, core::iter::empty());
        });
        let n = sink.finish().unwrap();
        assert_eq!(inst.on_frame(&buf[..n]), Status::Ok);

        assert_eq!(inst.client_clock_stats(&mut out), Status::Ok);
        assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 7);
        assert_eq!(u32::from_le_bytes(out[4..8].try_into().unwrap()), 3);
    }

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

    // Gate fix (docs/plan/16b-ui-observation-and-clock.md Deviations, "Delivery order"): a frame
    // that both mutates state `ui` reads and carries an action result must produce a kind-1 record
    // reflecting that same mutation *before* the kind-2 record for that result, in the same
    // `ui_buf`/`client_poll_ui` drain -- "a result handler sees current state" (M16 brief, M16b
    // Planning decisions). `OGame` is a separate, minimal `Game` from `TestGame` above so this
    // test's real `Ui` cannot perturb the other `client_poll_ui_*` tests' exact-JSON assertions.

    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct OAction;
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct OReject;
    impl From<Unknown> for OReject {
        fn from(_: Unknown) -> Self {
            OReject
        }
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct OEntity;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct OPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct OGlobal {
        counter: u32,
    }

    /// The one field `OClient::ui` mirrors from `Global`, so a real replica mutation is directly
    /// observable in the emitted JSON.
    #[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, ts_rs::TS)]
    struct OUi {
        counter: u32,
    }

    #[derive(Default)]
    struct OClient;
    impl crate::client::ClientSide<OGame> for OClient {
        fn ui(&self, view: &FrameView<'_, OGame>, out: &mut OUi) {
            out.counter = view.world().global().counter;
        }
    }

    struct OWorldgen;
    impl Worldgen for OWorldgen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    struct OGame;
    impl Game for OGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = OWorldgen;
        type Action = OAction;
        type Reject = OReject;
        type Entity = OEntity;
        type Player = OPlayer;
        type Global = OGlobal;
        type Presence = ();
        type Ui = OUi;
        type Client = OClient;
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &OEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &OEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(
            _w: &mut dyn WorldWrite<Self>,
            _who: PlayerId,
            _a: &OAction,
        ) -> Result<(), OReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn o_instance() -> GameInstance<OGame> {
        let mut layout = RegionLayout::new();
        GameInstance::<OGame>::init(
            Role::Client,
            r#"{"seed":"0x1","params":null,"genWorkers":1,"cacheChunks":1024}"#,
            &mut layout,
        )
        .unwrap()
    }

    /// One frame carrying both a `Global` mutation (`counter` -> `new_counter`, which `OClient::ui`
    /// reads) and an `ActionResults` section -- `ActionResults` is section id 1, `Global` is id 2,
    /// so the *writer* calls are in that order (`FrameWriter::section`'s own ascending-id rule);
    /// this is unrelated to which section `ClientCore::apply` finishes mutating state for first,
    /// since both are fully applied before `on_frame` returns either way.
    fn frame_with_global_and_results(new_counter: u32, outcomes: &[Outcome<OGame>]) -> Vec<u8> {
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
            ActionResultsWriter::write::<OGame>(s, outcomes.iter());
        });
        fw.section(SectionId::Global, |s| {
            crate::wire::write_global::<OGame>(
                s,
                None::<core::iter::Empty<(PlayerId, bool)>>,
                Some(&OGlobal {
                    counter: new_counter,
                }),
            );
        });
        let n = sink.finish().unwrap();
        buf[..n].to_vec()
    }

    #[test]
    fn ui_record_precedes_its_own_frames_action_result_and_reflects_the_mutation() {
        let mut inst = o_instance();
        let confirmed = vec![Outcome {
            seq: 1,
            result: Ok(Applied),
        }];
        let bytes = frame_with_global_and_results(7, &confirmed);
        assert_eq!(inst.on_frame(&bytes), Status::Ok);

        let mut out = [0u8; 256];
        let n = inst.client_poll_ui(&mut out);
        assert!(n > 0, "the frame must produce at least one UI record");
        let records = decode_ui_records(&out[..n]);
        assert_eq!(
            records.len(),
            2,
            "one Ui record (the counter changed from Default's 0 to 7) and one ActionResults \
             record, got: {records:?}"
        );
        assert_eq!(records[0].0, 1, "kind byte: Ui record must come first");
        assert_eq!(
            records[0].1, r#"{"counter":7}"#,
            "the Ui record must already reflect this same frame's Global mutation"
        );
        assert_eq!(records[1].0, 2, "kind byte: ActionResults record");
        assert_eq!(records[1].1, r#"{"seq":1,"result":"Confirmed"}"#);
    }

    // docs/plan/16b-ui-observation-and-clock.md, steps 3-5: `client_ui_mark_dirty` (the test-only
    // ABI export those steps add, `ABI_VERSION` 12 -> 13) reaches `ClientInstance::ui.mark_dirty()`
    // end to end. `MClient::ui` reads a `static` signal rather than anything in the replica
    // (mirroring `client::ui::tests::UClient`'s own "client-side state, not replica state" shape,
    // 0024 §7d) -- this test drives a `GameInstance` from the outside, with no handle on
    // `ClientInstance::client` itself, so a plain `AtomicU32` stands in for a real client-side
    // field the way `FrameCx::ui_dirty()` will drive one once M18 lands. Each native test gets its
    // own process (nextest: `client/texel.rs`'s own doc comment on `VISUAL_TABLES`), so this
    // `static` is never shared across tests.
    static M_SIGNAL: core::sync::atomic::AtomicU32 = core::sync::atomic::AtomicU32::new(0);
    /// docs/plan/18-picking-and-overlay.md steps 4-6: when set, `MClient::frame` calls `cx.
    /// ui_dirty()` -- the real production path `FrameCx::ui_dirty()` -- so `framecx_ui_dirty_
    /// reruns_ui` (below) exercises the actual `frame()` -> `FrameCx` -> `UiObserver::mark_dirty`
    /// wiring end to end, not only the `client_ui_mark_dirty` test hook `client_ui_mark_dirty_
    /// forces_a_rerun_with_no_new_frame` (above) uses. Defaults `false`, so that existing test's own
    /// `frame()` calls are unaffected by this addition.
    static M_WANT_DIRTY: core::sync::atomic::AtomicBool =
        core::sync::atomic::AtomicBool::new(false);
    /// M18 gate round 2 (review Finding 1: "nothing exercises `InputQueue::clear()`"):
    /// `MClient::frame` stores `cx.input().len()` here every call, so `input_queue_cleared_
    /// between_frames` (below) can observe, from outside `game_instance.rs`, whether the *previous*
    /// call's own event is still in the queue on this call -- the one thing `framecx_input_slice_
    /// order_and_clear` (`client/frame_cx.rs`) admits it cannot prove ("the 'clear' half of this
    /// test's name is `game_instance.rs`'s own responsibility").
    static M_LAST_INPUT_LEN: core::sync::atomic::AtomicU32 = core::sync::atomic::AtomicU32::new(0);

    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct MAction;
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct MReject;
    impl From<Unknown> for MReject {
        fn from(_: Unknown) -> Self {
            MReject
        }
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct MEntity;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct MPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct MGlobal;
    #[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, ts_rs::TS)]
    struct MUi {
        n: u32,
    }

    #[derive(Default)]
    struct MClient;
    impl crate::client::ClientSide<MGame> for MClient {
        fn frame(&mut self, cx: &mut FrameCx<'_, MGame>, _presence: &mut ()) {
            M_LAST_INPUT_LEN.store(
                cx.input().len() as u32,
                core::sync::atomic::Ordering::Relaxed,
            );
            if M_WANT_DIRTY.load(core::sync::atomic::Ordering::Relaxed) {
                cx.ui_dirty();
            }
        }
        fn ui(&self, _view: &FrameView<'_, MGame>, out: &mut MUi) {
            out.n = M_SIGNAL.load(core::sync::atomic::Ordering::Relaxed);
        }
    }

    struct MWorldgen;
    impl Worldgen for MWorldgen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    struct MGame;
    impl Game for MGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = MWorldgen;
        type Action = MAction;
        type Reject = MReject;
        type Entity = MEntity;
        type Player = MPlayer;
        type Global = MGlobal;
        type Presence = ();
        type Ui = MUi;
        type Client = MClient;
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &MEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &MEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(
            _w: &mut dyn WorldWrite<Self>,
            _who: PlayerId,
            _a: &MAction,
        ) -> Result<(), MReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    fn m_instance() -> GameInstance<MGame> {
        let mut layout = RegionLayout::new();
        GameInstance::<MGame>::init(
            Role::Client,
            r#"{"seed":"0x1","params":null,"genWorkers":1,"cacheChunks":1024}"#,
            &mut layout,
        )
        .unwrap()
    }

    /// A bare heartbeat frame (no sections): enough for `on_frame` to bump `ClientCore::
    /// mutations()` without any real replicated-state change (`no_alloc_ui.rs`'s own template).
    fn m_heartbeat(tick: u32) -> Vec<u8> {
        let mut buf = [0u8; 32];
        let mut sink = crate::bytes::SliceSink::new(&mut buf);
        FrameWriter::new(&mut sink, FrameHeader { tick, ack_seq: 0 });
        let n = sink.finish().unwrap();
        buf[..n].to_vec()
    }

    #[test]
    fn client_ui_mark_dirty_forces_a_rerun_with_no_new_frame() {
        let mut inst = m_instance();
        // A real replica mutation (tick 1) with the signal still at its `Default` value (0): `ui`
        // runs and matches `MUi::default()`, so no record is written yet.
        assert_eq!(inst.on_frame(&m_heartbeat(1)), Status::Ok);
        let mut out = [0u8; 64];
        assert_eq!(
            inst.client_poll_ui(&mut out),
            0,
            "no change yet: nothing to poll"
        );

        // The client-side signal changes with *no* new host frame -- `frame()` alone, unmarked,
        // must not notice (`mutations` is unchanged since the last check).
        M_SIGNAL.store(5, core::sync::atomic::Ordering::Relaxed);
        let camera = CameraBlock::for_test([0.0, 0.0], [0.0, 0.0], [4.0, 4.0]);
        assert_eq!(inst.frame(1.0, &camera, &mut []), Status::Ok);
        assert_eq!(
            inst.client_poll_ui(&mut out),
            0,
            "no dirty flag, no new mutation: still nothing to poll"
        );

        // `client_ui_mark_dirty` (this milestone's own test-only ABI export) forces the next
        // `frame()` call to rerun `ui` regardless -- the real production setter is M18's `FrameCx::
        // ui_dirty()`; this is `engine/test`'s own way to reach the same flag today.
        assert_eq!(inst.client_ui_mark_dirty(), Status::Ok);
        assert_eq!(inst.frame(2.0, &camera, &mut []), Status::Ok);
        let n = inst.client_poll_ui(&mut out);
        assert!(
            n > 0,
            "the dirty flag must force a rerun that finds a real change"
        );
        let records = decode_ui_records(&out[..n]);
        assert_eq!(records, vec![(1, r#"{"n":5}"#.to_string())]);
    }

    /// `framecx.ui_dirty_reruns_ui` (Tests added, docs/plan/18-picking-and-overlay.md steps 4-6):
    /// the real end-to-end path -- `ClientSide::frame` calls `cx.ui_dirty()` (not the `client_ui_
    /// mark_dirty` test-only ABI hook the test above uses) -- also forces `ui` to rerun this same
    /// `frame()` call with no new host mutation.
    #[test]
    fn framecx_ui_dirty_reruns_ui() {
        M_SIGNAL.store(0, core::sync::atomic::Ordering::Relaxed);
        M_WANT_DIRTY.store(false, core::sync::atomic::Ordering::Relaxed);
        let mut inst = m_instance();
        let camera = CameraBlock::for_test([0.0, 0.0], [0.0, 0.0], [4.0, 4.0]);
        let mut out = [0u8; 64];

        // No mutation, no dirty flag: `ui` must not run.
        assert_eq!(inst.frame(0.0, &camera, &mut []), Status::Ok);
        assert_eq!(inst.client_poll_ui(&mut out), 0);

        // `cx.ui_dirty()`, called from inside `MClient::frame` itself, forces a rerun this same
        // `frame()` call even though nothing mutated the replica -- the new signal value (9) differs
        // from the default previous one (0), so a record is written.
        M_SIGNAL.store(9, core::sync::atomic::Ordering::Relaxed);
        M_WANT_DIRTY.store(true, core::sync::atomic::Ordering::Relaxed);
        assert_eq!(inst.frame(1.0, &camera, &mut []), Status::Ok);
        let n = inst.client_poll_ui(&mut out);
        assert!(
            n > 0,
            "cx.ui_dirty() must force a rerun that finds a real change"
        );
        let records = decode_ui_records(&out[..n]);
        assert_eq!(records, vec![(1, r#"{"n":9}"#.to_string())]);
    }

    /// M18 gate round 2 (review Finding 1, "dead test"): `framecx_input_slice_order_and_clear`
    /// (`client/frame_cx.rs`) only proves `FrameCx::new` hands back the slice it was built with --
    /// its own doc comment admits "the 'clear' half of this test's name is `game_instance.rs`'s own
    /// responsibility, not by this type in isolation." Nothing else in the suite calls `frame()`
    /// twice and checks a first frame's own input is gone by the second. This does: one real event,
    /// pushed through the real `on_input` ABI path (the same decode `InputQueue::decode_and_push_
    /// all` exercises), is visible to `cx.input()` on the frame that follows it and gone on the
    /// frame after that, with no second `on_input` call in between -- proving `frame()`'s own
    /// trailing `input_queue.clear()` actually runs, not merely that nothing else emptied it.
    #[test]
    fn input_queue_cleared_between_frames() {
        M_WANT_DIRTY.store(false, core::sync::atomic::Ordering::Relaxed);
        let mut inst = m_instance();
        let camera = CameraBlock::for_test([0.0, 0.0], [0.0, 0.0], [4.0, 4.0]);

        let mut bytes = [0u8; InputEvent::BYTES];
        bytes[0] = crate::client::input::kind::TAP;
        let mut on_input_out = [0u8; 12];
        assert_eq!(inst.on_input(&bytes, &mut on_input_out), Status::Ok);

        // `frame()` #1: `cx.input()` sees the one event just queued.
        assert_eq!(inst.frame(0.0, &camera, &mut []), Status::Ok);
        assert_eq!(
            M_LAST_INPUT_LEN.load(core::sync::atomic::Ordering::Relaxed),
            1,
            "frame 1 must see the queued event"
        );

        // `frame()` #2, with no new `on_input` call in between: if `InputQueue::clear()` (`frame()`'s
        // own trailing statement) did not run after frame 1, the same event would still be here.
        assert_eq!(inst.frame(1.0, &camera, &mut []), Status::Ok);
        assert_eq!(
            M_LAST_INPUT_LEN.load(core::sync::atomic::Ordering::Relaxed),
            0,
            "frame 2 must not see frame 1's already-consumed event"
        );
    }
}
