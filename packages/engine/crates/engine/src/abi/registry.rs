//! The single owner of the ABI (docs/decisions/0014): version, roles, statuses, region ids, the
//! [`Instance`] trait and the extern list inside [`export_instance!`](crate::export_instance).
//! `packages/engine/src/abi.ts` mirrors it and `tests/wasm/abi-registry.test.ts` compares the two.
//!
//! Adding to the ABI is one commit that (1) adds the extern to `export_instance!` and a defaulted
//! `Instance` method here, (2) adds the row to `ABI_EXPORTS` (or the constant) in `src/abi.ts`,
//! (3) bumps `ABI_VERSION` in both. Numbers are appended, never reused or renumbered. A new
//! *import* is an amendment to 0014 §3, not this rule.
//!
//! The registry test parses this file: keep constants as `pub const NAME: u32 = N;` and enum
//! variants one per line as `Name = N,`.

use crate::client::CameraBlock;

use super::regions::RegionLayout;

pub const ABI_VERSION: u32 = 39;

/// Size of the static boot region: config JSON in at offset 0, panic text out in the tail.
pub const BOOT_BYTES: u32 = 65536;
/// Bytes at the end of the boot region that the panic hook formats into. The config may use
/// everything before them.
pub const BOOT_TEXT_BYTES: u32 = 4096;
/// Capacity of the `Result` region that every role has.
pub const RESULT_BYTES: u32 = 64;

/// What an instance is for; fixed for its life by `engine_init`.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Sim = 0,
    Client = 1,
    Gen = 2,
}

/// Returned by every export whose result is `status`; an export whose result is `len` returns
/// `-(status)` on failure.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Ok = 0,
    WrongRole = 1,
    NotInitialised = 2,
    AlreadyInitialised = 3,
    BadConfig = 4,
    BadLength = 5,
    Decode = 6,
    OutOfMemory = 7,
    Unsupported = 8,
    /// `client_chunk_hash` (M08b: the chunk is not resident in
    /// the client's cache. Appended, never inserted (0014's numbering rule).
    NotCached = 9,
    /// `engine_init` (M21, M21: the sim role's computed 0007 §8
    /// memory split (state budget + cache) exceeds the instance's configured arena -- a clean
    /// startup error instead of an allocator failure partway through the first tick. Appended,
    /// never inserted (0014's numbering rule).
    BudgetExceedsArena = 10,
    /// `sim_restore_end` (M22b: the decoded snapshot's own
    /// `Identity::build_hash` differs from this running build's (0005 "Sim identity" hash). Reported,
    /// not handled -- no migrate path exists here (M24b's own job); `Persistence.open` turns this
    /// into a thrown `WorldLoadError` of kind `'identity'` and touches no storage.
    IdentityMismatch = 11,
    /// `sim_restore_begin`/`sim_restore_push`/`sim_restore_end`: the pushed bytes did not decode as
    /// a valid snapshot (a bad CRC, or a `SnapshotReader` still `NeedMore` when `sim_restore_end`
    /// was called -- a torn snapshot). `Persistence.open` treats this as "this candidate snapshot is
    /// unusable" and falls back to the next older one (0005 Recovery: "newest snapshot whose CRC
    /// verifies").
    Corrupt = 12,
    /// `sim_restore_begin`/`sim_restore_push`: the pushed bytes' `container_version` does not match
    /// this build's own (`persist::snapshot::CONTAINER_VERSION`) -- distinct from `Corrupt` so a
    /// caller could in principle tell "garbled" from "a newer/older format" apart, though nothing
    /// yet acts on that distinction (no format migration exists, docs/decisions/0038).
    ContainerVersion = 13,
    /// `sim_replay_push`/`sim_replay_end`: a pushed block failed to decode as a whole, CRC-valid
    /// frame (malformed or a bad CRC) -- 0005 Recovery's "re-apply frames until the first truncated
    /// or CRC-failing frame". **Not an error for the last (currently open) segment**: that is simply
    /// how recovery finds the torn tail to truncate. `sim_replay_valid_end()` reports where.
    TornTail = 14,
    /// `sim_upgrade_end` (M24b: the load takes the `Game::migrate`
    /// path (`persist::Comparison::NeedsMigrate`) and either `Game::migrate` itself declined
    /// (`IncompatReason::MigrateDeclined`, its default `Err(SaveIncompatible)`) or the old-schema
    /// bytes failed to decode (`IncompatReason::Decode`) -- the reason is written to byte 0 of
    /// `Result` (`IncompatReason as u8`). Every stored byte stays untouched on this path (0005
    /// Upgrades; Planning decisions 7): the caller must not write anything after seeing this status.
    SaveIncompatible = 15,
    /// `client_on_welcome` (M33f: this client took
    /// its world from an earlier `Welcome` and this one carries another seed or other params (one
    /// world per server, 0013). Nothing was applied; the page's policy is a reload. Appended,
    /// never inserted (0014's numbering rule).
    WorldMismatch = 16,
}

/// `sim_upgrade_end`'s own `Status::SaveIncompatible` detail, written as one byte at `Result[0]`
/// (M24b Seams). `Schema`/`TickRate`/`Worldgen` mirror `persist::
/// MismatchReason` 1:1 (kept as separate, wire-stable discriminants here rather than reusing that
/// type directly, since this enum crosses the ABI boundary and that one does not); `Container` is
/// reserved for a future container-version-driven incompatibility (never constructed by this
/// milestone -- `Status::ContainerVersion` already covers a snapshot candidate's own envelope
/// mismatch, which falls back to an older candidate rather than failing the whole load, this
/// milestone's own Deviations has the reasoning) and `ChunkSize` is never constructed by Rust at all
/// (raised by the TS host from the manifest, before any ABI call: Scope).
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IncompatReason {
    Schema = 0,
    TickRate = 1,
    Worldgen = 2,
    MigrateDeclined = 3,
    Container = 4,
    Decode = 5,
    ChunkSize = 6,
}

/// Fixed regions in linear memory. Ids 3–8 are reserved so parallel milestones share names; each
/// is sized by the milestone that first uses it.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegionId {
    Rx = 0,
    Tx = 1,
    Result = 2,
    DrawList = 3,
    ChunkTexels = 4,
    Ui = 5,
    Persist = 6,
    Camera = 7,
    GenOut = 8,
    /// `genResult` record staging (M08b: `16 + slab_bytes`,
    /// sized by client-role `init` alongside its `TerrainFeed`, same as `GenOut` on the gen role.
    GenIn = 9,
    /// M15b: the client role's own inbound
    /// buffer for one whole host frame (`on_frame`'s `len` bytes) -- distinct from `Rx`, which the
    /// client role already uses for input records (`on_input`, M11): both are "receive" buffers
    /// for the same role but for unrelated message kinds, and `RegionLayout::region` allows only
    /// one declaration per id. The client's own outbound uplink batch (`client_poll_uplink`'s
    /// `out`) reuses `Tx`, unclaimed by the client role until now -- the same Rx-in/Tx-out
    /// convention the sim role already has, just declared by a different role.
    Downlink = 10,
    /// M24: `ProgressCursor` (`crate::persist::Phase`/`tick`/
    /// `record`, 12 B, sim role) -- written by `Host<G>` before starting risky work, readable from
    /// a *dead* instance with no export call at all (0014 §6: `inst.region(id).u8`/`inst.mem`).
    /// Not sim state (never hashed, snapshotted or logged).
    Progress = 11,
}

/// Levels of `engine.log`. Release builds compile out everything below `Warn` (0014 §3).
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Error = 0,
    Warn = 1,
    Info = 2,
    Debug = 3,
}

pub const REGION_COUNT: usize = 12;

impl Role {
    pub const fn from_u32(n: u32) -> Option<Role> {
        match n {
            0 => Some(Role::Sim),
            1 => Some(Role::Client),
            2 => Some(Role::Gen),
            _ => None,
        }
    }
}

impl RegionId {
    pub const fn from_u32(n: u32) -> Option<RegionId> {
        match n {
            0 => Some(RegionId::Rx),
            1 => Some(RegionId::Tx),
            2 => Some(RegionId::Result),
            3 => Some(RegionId::DrawList),
            4 => Some(RegionId::ChunkTexels),
            5 => Some(RegionId::Ui),
            6 => Some(RegionId::Persist),
            7 => Some(RegionId::Camera),
            8 => Some(RegionId::GenOut),
            9 => Some(RegionId::GenIn),
            10 => Some(RegionId::Downlink),
            11 => Some(RegionId::Progress),
            _ => None,
        }
    }
}

/// What sits behind the exports of one module. Low-level fixtures implement it directly; games
/// implement the `Game` trait and the engine's generic host implements this for them (M13).
///
/// Every hot export has one defaulted method, so a new export never breaks an old implementor.
/// The role check happens before the call: a method only runs on an instance of its role.
pub trait Instance: Sized + 'static {
    /// Build the instance from the `game` value of the config (as JSON text) and declare the
    /// regions this role needs. `Result` is already declared.
    fn init(role: Role, game_cfg_json: &str, layout: &mut RegionLayout) -> Result<Self, Status>;

    /// `rx` is the first `len` bytes of the `Rx` region.
    fn sim_admit(&mut self, _conn: u32, _rx: &[u8]) -> Status {
        Status::Unsupported
    }

    /// M15b: admits `conn` into the sim role's
    /// connection table (`host::Host::connect`). The caller (`SimHost.accept`, TS) picks `conn`;
    /// this export does no allocation of its own. Connecting an already-connected `conn` is left to
    /// the implementor -- `Host<G>` treats it as a fresh join, since Scope names no dedicated error
    /// for that case.
    fn sim_connect(&mut self, _conn: u32) -> Status {
        Status::Unsupported
    }

    /// M24, Traps ("Connections stay open across recovery"):
    /// re-attaches `conn` to the sim role's connection table with the same deterministic `PlayerId`
    /// a live `connect` would assign, but queues no `Record::Player` event and touches no game
    /// state (`host::Host::reattach`'s own doc comment has the full reasoning) -- distinct from
    /// `sim_connect` so recovery's own re-attach call site can never be confused with a real,
    /// logged (re)connect.
    fn sim_reattach(&mut self, _conn: u32) -> Status {
        Status::Unsupported
    }

    /// M24 fix round 1 (Planning decisions 2: an `Admit`-phase
    /// trap "recovers and answers that action `Rejected(Engine(EngineFault))`"): queues that ack
    /// directly on `conn`'s own (already-reattached) `ConnSlot` and raises its `highest_admitted_seq`
    /// floor to at least `seq`, so a resend of the exact `seq` that trapped is dropped at admission
    /// instead of re-admitted (and, for a deterministically-panicking action, re-trapped).
    /// `host::Host::fault_ack`'s own doc comment has the full reasoning; tolerates an unknown `conn`.
    fn sim_fault_ack(&mut self, _conn: u32, _seq: u32) -> Status {
        Status::Unsupported
    }

    /// M15b: frees `conn`'s slot (`host::Host::
    /// disconnect`). A `conn` that was never connected, or already disconnected, is a no-op, not an
    /// error (untrusted host input never panics, matching `sim_admit`'s own tolerance of a bad
    /// connection id).
    fn sim_disconnect(&mut self, _conn: u32) -> Status {
        Status::Unsupported
    }

    /// M28b step 4 (`ABI_VERSION` 30 -> 31): `host::Host::
    /// log_disconnected` -- queues `Record::Player { Disconnected }` for `player`, delivered at the
    /// next `tick()`. The host-side grace timer's own signal (`host/lifecycle.ts`), independent of
    /// any live `ConnSlot`: by the time this fires the connection is already gone (either the 10 s
    /// grace expired, or an explicit `Bye{Leave}` skipped it).
    fn sim_log_disconnected(&mut self, _player: u32) -> Status {
        Status::Unsupported
    }

    /// M28 (`ABI_VERSION` 25 -> 26): the real handshake join/
    /// reconnect path, replacing `sim_connect`'s implicit accept for every connection the host's
    /// own TS handshake (`host/handshake.ts`) drives. `input` is the whole `Rx` region view, first
    /// `len` bytes meaningful (mirrors `sim_admit`): `player_id varint · epoch u32 · joined u8 ·
    /// presence (has u8 + len varint + bytes)? · hello_tail` (`host::Host::attach`'s own doc
    /// comment has the exact layout). `tx` is the whole `Tx` region (same crossing shape as
    /// `sim_build_frame`): on success, `Welcome` bytes are written there and their length returned.
    fn sim_attach(&mut self, _conn: u32, _input: &[u8], _tx: &mut [u8]) -> Result<u32, Status> {
        Err(Status::Unsupported)
    }

    /// M28b step 2 (`ABI_VERSION` 29 -> 30): sends a fresh
    /// `Welcome` on an already-open connection (`host::Host::resync`), carrying `epoch` (the
    /// host's own new epoch after `SimHost.bumpEpoch()`) -- the resync signal for a live
    /// connection after panic recovery or an upgrade bump (Planning decisions "A second `Welcome`
    /// is the resync signal"). `tx` is the whole `Tx` region, same crossing shape as `sim_attach`;
    /// on success `Welcome` bytes are written there and their length returned.
    fn sim_resync(&mut self, _conn: u32, _epoch: u32, _tx: &mut [u8]) -> Result<u32, Status> {
        Err(Status::Unsupported)
    }

    /// M28: frees `conn`'s slot, the same as `sim_disconnect`
    /// (`host::Host::disconnect`) -- a distinct export name so the handshake path (`sim_attach`)
    /// and its own teardown pair cleanly, without retiring `sim_disconnect` (still real, still used
    /// by every existing `sim_connect`-based caller: native tests, `testkit::Loopback`, recovery).
    fn sim_detach(&mut self, _conn: u32) -> Status {
        Status::Unsupported
    }

    /// M28: `host::Host::has_player` -- `1`/`0`, whether this
    /// world's own `Store` already has a player slot for `player` (0013 Planning decisions: "Joined
    /// vs Connected is decided by the sim, not the table"). The caller (TS handshake) asks this
    /// before `sim_attach`, both to fill that call's own `joined` byte and to find the next free
    /// `PlayerId` for an unknown secret (probing upward from the session table's own max until this
    /// returns `0`).
    fn sim_has_player(&mut self, _player: u32) -> u32 {
        0
    }

    /// M28 steps 3-5 (`ABI_VERSION` 27 -> 28): the `ConnId` the
    /// most recent successful `sim_attach` call silently freed because the same `PlayerId` was
    /// already attached elsewhere (0013 "the old connection gets `Bye{Superseded}`"), `u32::MAX`
    /// for "nothing was freed". `abi::mod::sim_attach` reads this right after a successful call
    /// and writes it into `Result` (one LE `u32` at offset 0) -- `sim_attach`'s own contract
    /// widened, not a new wire shape, the same way `client_clock_stats` widened in place.
    fn sim_last_superseded(&self) -> u32 {
        u32::MAX
    }

    /// M34 (`ABI_VERSION` 37 -> 38): the presence sample the most
    /// recent `sim_detach` removed with its connection, `G::Presence`'s own codec bytes, copied into
    /// `out`; returns their length, `0` for "none" (no sample, or nothing detached). `abi::mod::
    /// sim_detach` reads it right after a successful call and writes it into `Result` (a LE `u32`
    /// length, then the bytes): the host keeps it in the session table (0013: "the last presence
    /// sample is kept ... so a returning player resumes where they were"), which nothing wrote before.
    fn sim_last_detached_presence(&self, _out: &mut [u8]) -> usize {
        0
    }

    fn sim_tick(&mut self) -> Status {
        Status::Unsupported
    }

    /// `tx` is the whole `Tx` region; returns the number of bytes written.
    fn sim_build_frame(&mut self, _conn: u32, _tx: &mut [u8]) -> Result<u32, Status> {
        Err(Status::Unsupported)
    }

    /// Crosses as two LE `u32` at offset 0 of `Result` (numbers only: 0014 §2).
    fn sim_hash(&mut self) -> u64 {
        0
    }

    /// M13: creates the world from the init config (`Sim::genesis`
    /// for a real `Game`); M22b adds the load-from-storage path. Called once per instance; a
    /// second call is `Status::AlreadyInitialised`.
    fn sim_genesis(&mut self) -> Status {
        Status::Unsupported
    }

    /// M13: write-ahead log bytes for the frame about to be
    /// applied (0024 §1's export boundary), written into `persist` (the whole `Persist` region --
    /// empty until a role declares it, which none does yet: Non-scope here, M22 gives this real
    /// content and sizes the region). Returns the byte count, or `-(status)` on failure at the
    /// export boundary, the same shape as `sim_build_frame`.
    fn sim_seal_frame(&mut self, _persist: &mut [u8]) -> Result<u32, Status> {
        Err(Status::Unsupported)
    }

    /// M13: generates at most one uncached chunk from the warm
    /// list (`host::warm`), nearest-to-view-centre first. `1` if it generated one, `0` if nothing
    /// is cold -- the "always answer, cost nothing" shape of `gen_take`/`upload_stage`: no
    /// `Status` crosses here either.
    fn sim_warm_one(&mut self) -> u32 {
        0
    }

    /// M13 ("20 Hz is hardcoded" gap): the sim role's own tick
    /// rate, read once by `SimHost` at construction instead of assuming 20 unconditionally. A
    /// game exposes its real rate by overriding this to return `G::TICK_RATE.hz_value()`
    /// (`host::Host<G>`, `game_instance::GameInstance<G>`); the default (`20`, `TickRate::HZ_20`'s
    /// own value, 0006) is what every game that never overrides `TICK_RATE` already paces at, so
    /// a low-level fixture with no `Sim` role at all still answers safely. Same "always answer,
    /// cost nothing" shape as `sim_warm_one`/`gen_take`: no `Status` crosses.
    fn tick_hz(&mut self) -> u32 {
        20
    }

    /// M24b Scope ("Chunk size recorded in the world params"):
    /// `G::CHUNK_BITS`, read by `Persistence.create`/`Persistence.open` (TS) to stamp/compare
    /// `ManifestV1.params.chunkBits` -- the running build's own value, never derived from stored
    /// data. Same "always answer, cost nothing, role-independent" shape as `tick_hz`: the default
    /// (`5`, `Game::CHUNK_BITS`'s own default) is what every game that never overrides it already
    /// uses, so a low-level fixture with no `Sim` role at all still answers safely.
    fn chunk_bits(&mut self) -> u32 {
        5
    }

    /// Called only when the client worker saw `CB_FRAME_REQ` advance (M06b
    /// spawn.md, Planning decisions "Worker frame clock"): `t_ms` is that frame's `frame_time_ms`,
    /// taken from `camera` by the shim in `abi::frame` rather than from the export's own raw
    /// argument (decision A of fix round 3; see that function).
    /// `camera` is this role's `Camera` region, already decoded; `result` is the whole `Result`
    /// region, for a role that wants to report something back (this milestone's own
    /// `workers.camera_block_reaches_wasm` test writes `camera.centre` there, proving
    /// `CameraBlock`'s layout agrees with `packages/engine/src/camera/block.ts` byte for byte).
    fn frame(&mut self, _t_ms: f64, _camera: &CameraBlock, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// `out` is the whole `GenOut` region for this role (docs/decisions/0008-chunk-generation.md
    /// §1, §6): must write every element, tiles as little-endian bytes, row-major. A game
    /// implementing `Worldgen` forwards to a `worldgen::GenCore` it owns (M08).
    fn gen_chunk(&mut self, _cx: i32, _cy: i32, _out: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// `M08b`, ABI role `client`: writes a 16-byte `genRequest`
    /// record into `out` (the first 16 bytes of `Result`) if there is a job to dispatch to
    /// `worker`. `false` when there is nothing (the default, and every fixture with no
    /// `client::TerrainFeed`): `gen_take` must cost nothing and always return 0 on a page whose
    /// client role has none (`M08b`, orchestrator decisions).
    fn gen_take(&mut self, _worker: u32, _out: &mut [u8; 16]) -> bool {
        false
    }

    /// `record` is the whole `GenIn` region for this role: a `genResult` record, `16 +
    /// slab_bytes()` (the request header followed by `GenOut`'s tile bytes). A game implementing
    /// `client::TerrainFeed` forwards to `TerrainFeed::deliver`.
    fn gen_deliver(&mut self, _worker: u32, _record: &[u8]) -> Status {
        Status::Unsupported
    }

    /// Seven `u32`s (`gen_queue::GenStats`' fields, declaration order: `requested`, `dispatched`,
    /// `delivered`, `cancelled`, `requeued`, `pending`, `in_flight`) written little-endian into
    /// `result` (the whole `Result` region).
    fn client_gen_stats(&mut self, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// FNV of the cached effective slab of `(cx, cy)` as lo, hi `u32` into `result`;
    /// `Status::NotCached` when the chunk is not resident (`client::TerrainFeed::chunk_hash`).
    fn client_chunk_hash(&mut self, _cx: i32, _cy: i32, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// `M09`: stages up to `max_records` upload-ring records (chunk
    /// conversions, tile patches, indirection updates -- `client::Uploader::stage`) into `out`
    /// (the whole `ChunkTexels` region), returns the count actually written. `0` on every fixture
    /// with no `Uploader` (a client role that renders no terrain), same "always answer, cost
    /// nothing on a page without one" shape as `gen_take`.
    fn upload_stage(&mut self, _max_records: u32, _out: &mut [u8]) -> u32 {
        0
    }

    /// `M11`: decodes whole `client::input::InputEvent` records
    /// (32 bytes each) from `rx` (the first `len` bytes of `Rx`, `abi::on_input`) into whatever
    /// `InputQueue` this instance owns, and may write back anything it wants observable in
    /// `result` (the whole `Result` region) -- this milestone's own fixture writes queue length
    /// plus the last event's tile there, its own test export. `Status::Unsupported` by default,
    /// same "answers something, does nothing" shape as every other role/feature an instance
    /// doesn't implement.
    fn on_input(&mut self, _rx: &[u8], _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M15b: applies one whole host frame
    /// (0011) -- the first `len` bytes of `RegionId::Downlink` -- atomically into the client
    /// role's own replica (`client::ClientCore::on_frame`). A malformed frame is `Status::Decode`
    /// and leaves the replica untouched (`ClientCore::on_frame`'s own "validate first" contract);
    /// nothing else about a bad frame is reported here (Non-scope: resync/reconnect is M13/M28).
    fn on_frame(&mut self, _bytes: &[u8]) -> Status {
        Status::Unsupported
    }

    /// M15b: writes at most one uplink batch
    /// (`client::ClientCore::poll_uplink`) into `out` (the whole `Tx` region for the client role),
    /// returning its length, or `0` when nothing is due yet (0010 "Rates"). `t_ms` is already
    /// milliseconds, read by the caller from the just-copied `CameraBlock::frame_time_ms`
    /// (`abi::client_poll_uplink`'s own doc comment says why the raw export argument is ignored,
    /// the same shape `frame`'s own `t_ms` already uses).
    fn client_poll_uplink(&mut self, _t_ms: u32, _out: &mut [u8]) -> usize {
        0
    }

    /// M28 (`ABI_VERSION` 25 -> 26): builds `Hello` from the
    /// client role's own config (`secret`/`joinKey`/`buildHash`, `TerrainConfig`'s own doc
    /// comment) into `tx` (the whole `Tx` region, same crossing shape as `client_poll_uplink`),
    /// returning its length. Config -> `Hello`, not a wire decode of anything: this export takes
    /// no other input, and a caller may call it more than once (idempotent; every real caller
    /// calls it exactly once, before attaching the connection's normal byte pump).
    fn client_hello(&mut self, _tx: &mut [u8]) -> usize {
        0
    }

    /// M33f: a first `Welcome` configures a client
    /// that has no world (seed and params were absent from `engine_init`): terrain source, `on_init`.
    /// `result` is widened from 16 to 20 bytes: a fifth LE `u32`, `1` when *this* call configured
    /// the client (exactly once per instance), else `0`. `Status::WorldMismatch` when a client that
    /// took its world from an earlier `Welcome` gets another world's; nothing is applied.
    /// M28: applies one `Welcome` message (`bytes`, the first
    /// `len` bytes of `RegionId::Downlink` -- same region `on_frame` reads, since both are
    /// host-to-client messages) into the client role's own state: `Replica::set_own_player`,
    /// `ClientCore::seed_presence` when `Welcome` carried a sample, and `ClientCore::
    /// seed_lead_rtt_ms` (M26) from `rtt_ms` -- the caller's own measured `Hello` -> `Welcome`
    /// elapsed time (a plain `f64` argument, not read from any region: this call has no `CameraBlock`
    /// in scope the way `client_poll_uplink`'s own `t_ms` trick relies on, and the measurement is a
    /// one-off, not a per-frame value). `session_state`/`seq_seed` stay TS-derived (`worker/
    /// client-net.ts`'s own doc comment: "session_state/seq_seed bookkeeping lives here"), seeded
    /// from this call's own `result` output -- `player_id`/`last_processed_action_seq`, two LE
    /// `u32` (the only two `Welcome` fields a caller cannot otherwise recover: everything else in
    /// `Welcome` is either opaque to TS, `Codec`-encoded worldgen params, or not yet consumed this
    /// milestone). `Status::Decode` on a malformed message, leaving the client's session state
    /// untouched (mirrors `on_frame`'s own "validate first" contract).
    fn client_on_welcome(&mut self, _bytes: &[u8], _rtt_ms: f64, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M33f (`ABI_VERSION` 36 -> 37): the client
    /// role's world as JSON, `{"seed":"0x<16 hex>","params":<params JSON>}` -- the shape of the
    /// `game` config's own `seed`/`params` fields, so the caller passes it through unchanged (a gen
    /// worker's setup message, an `engine_init` config) -- into `tx` (the whole `Tx` region, same
    /// crossing shape as `client_hello`), returning the byte count. `0` means the client is not
    /// configured yet (no seed and params at `engine_init` and no `Welcome` seen).
    fn client_world_config(&mut self, _tx: &mut [u8]) -> Result<u32, Status> {
        Err(Status::Unsupported)
    }

    /// M15b, `engine/test`'s `hostRegionHash`:
    /// `host::Host::region_hash(conn)`, crossing as two LE `u32` into `Result` (`sim_hash`'s own
    /// shape). Test/diagnostic only -- no production caller needs this on the wire (0011's own
    /// `Hashes` section is M31b's).
    fn sim_region_hash(&mut self, _conn: u32, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M15b, `engine/test`'s `replicaHash`:
    /// `client::Replica::region_hash()`, same crossing shape as `sim_region_hash`.
    fn client_region_hash(&mut self, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M15b, `engine/test`'s `netCounters`:
    /// `host::ConnCounters` for `conn`, little-endian into `Result` in field-declaration order
    /// (`bytes_down: u64`, `frames: u64`, `chunk_enters_pristine: u64`, `chunk_snapshots: u64`,
    /// `chunk_leaves: u64`, `bytes_up: u64` -- 48 bytes). `Status::NotCached` reused here for "no
    /// such connection" would be misleading (that status is chunk-cache-specific); an unknown
    /// `conn` instead writes every field as 0 and still returns `Status::Ok`, since "never
    /// connected" and "connected with zero traffic so far" cross the wire identically anyway.
    /// M19 steps 4-6: widened to 56 bytes, a 7th `u64`
    /// (`presence_bytes_up`) -- `engine/test`'s `netCounters`' own `uplinkPresenceBytes`.
    fn sim_conn_counters(&mut self, _conn: u32, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M31 (`ABI_VERSION` 33 -> 34), `engine/test` only: `host::
    /// PacingCounters` for `conn`, sixteen little-endian `u32`s (64 bytes) into `Result`, in the
    /// order `Host::sim_pacing_counters` documents. An unknown `conn` writes zeros and returns `Ok`.
    fn sim_pacing_counters(&mut self, _conn: u32, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M31b (`ABI_VERSION` 34 -> 35), `engine/test` only: the sim role's
    /// desync report ring, one report per call. `Result` gets 40 little-endian bytes,
    /// `integrity::DesyncLog::write_result`'s layout: `count u32 (total ever) · retained u32 ·`
    /// then the `index`th retained report (oldest first) `tick u32 · scope u32 (0 Chunk, 1 Global,
    /// 2 OwnPlayer) · cx i32 · cy i32 · host_hash u64 · client_hash u64` (zero when out of range).
    fn sim_desync(&mut self, _index: u32, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M31b (`ABI_VERSION` 34 -> 35), `engine/test` only: the client
    /// role's desync report ring, same 40-byte layout as `sim_desync`.
    fn client_desync(&mut self, _index: u32, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M31b (`ABI_VERSION` 35 -> 36), `engine/test` only: the dump files
    /// of hash-all mode, into `Tx`, returning the byte count (`0` = no completed dump, or `Tx` too
    /// small). `part` 0: the oldest dump's header `tick u32 · cx i32 · cy i32 · client_len u32`;
    /// 1: the client's encoding of the chunk when its hash mismatched; 2: the host's encoding (the
    /// replica's after the resync snapshot replaced it); 3: drop that dump (returns 0).
    fn client_desync_dump(&mut self, _part: u32, _tx: &mut [u8]) -> usize {
        0
    }

    /// M31b (`ABI_VERSION` 34 -> 35), `engine/test` only, fault
    /// injection: the next frame built for `conn` drops one delta of the chunk packed in `coord`
    /// (`(cx as i16 as u16) | ((cy as i16 as u16) << 16)`: two chunk coordinates in one `u32`,
    /// because the loader has no three-argument call); `0x8000_8000` names the reserved scope
    /// coordinate instead: every `Global` value update is dropped until a frame carries the `Global`
    /// hash.
    fn sim_skip_delta(&mut self, _conn: u32, _coord: u32) -> Status {
        Status::Unsupported
    }

    /// M31b (`ABI_VERSION` 34 -> 35), `engine/test` only, fault
    /// injection: flips one replica byte of the held chunk `(cx as i32, cy as i32)`;
    /// `Status::NotCached` when the client does not hold it.
    fn client_corrupt_chunk(&mut self, _cx: u32, _cy: u32) -> Status {
        Status::Unsupported
    }

    /// M16: parses one action-ring record (`[seq u32 LE][len u32
    /// LE][UTF-8 JSON]`) out of `rx` -- the first `len` bytes of `Rx`, shared with `on_input`'s
    /// own, differently-shaped records (a different message kind on the same client-role receive
    /// buffer) -- into `G::Action` (`serde_json`), re-encodes it with `Codec` and queues it for
    /// the next uplink batch (`client::ClientCore::on_action`). `Status::Decode` on a malformed
    /// record; `Status::OutOfMemory` when the outbox is already full (0012's pending-queue
    /// figure) -- a backstop only, since the caller's own ring/seq bookkeeping is expected to
    /// prevent that before ever calling this.
    fn on_action(&mut self, _rx: &[u8]) -> Status {
        Status::Unsupported
    }

    /// M16: copies as many whole UI-ring records as fit into `out`
    /// (the whole `Ui` region) -- kind 2, `ActionResults` turned into JSON by `client::ClientCore
    /// ::drain_results` -- returning the byte count. Never splits a record across two calls: what
    /// doesn't fit waits for the next poll (`game_instance::GameInstance::client_poll_ui`'s own
    /// doc comment has the exact contract, including the one pathological drop case). `0` when
    /// there is nothing new: the same "always answer, cost nothing" shape as `client_poll_uplink`/
    /// `upload_stage`/`gen_take`, no `Status` crosses here either.
    fn client_poll_ui(&mut self, _out: &mut [u8]) -> usize {
        0
    }

    /// M16 (`ABI_VERSION` 11 -> 12): the values only Rust knows for
    /// the client-role clock block the client worker mirrors into `SabSet.clockBlock` after each
    /// `on_frame` (0015 §2 "clocks") -- `authoritative_tick` and `ack_seq` from `ClientCore::
    /// last_summary()`, two LE `u32` into `result` (the whole `Result` region), the same crossing
    /// shape as `sim_region_hash`/`client_region_hash`. `ticks_per_second` (already `tick_hz()`,
    /// read once at worker setup, not re-plumbed per frame) and `session_state`/`seq_seed`
    /// (learned from the first frame's own `ack_seq`) are derived entirely on the TS
    /// side.
    ///
    /// M26 steps 4-6 (`ABI_VERSION` 23 -> 24): widened
    /// from 8 to 16 bytes, same call signature (`params: 0`, no new argument): `predicted_tick`
    /// (`ClientCore::predicted_tick`, real from this milestone on -- 0012 "Two clocks") as a third
    /// LE `u32`, then `ClientCore::last_tick_fraction`'s `f32` bits (its own doc comment: cached
    /// from the same wake's own `frame(t_ms)` call, since this export has no `t_ms` of its own to
    /// feed `HostClock` directly) as a fourth. An old caller reading only the first 8 bytes is
    /// unaffected; there is no old caller in this monorepo (the TS and WASM halves ship together).
    fn client_clock_stats(&mut self, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M16b (`ABI_VERSION` 12 -> 13), `engine/test` only:
    /// forces the client role's `UiObserver::mark_dirty()` (that milestone's own Deviations,
    /// steps 1-2: "the only setter that exists after this cut ... not yet reachable from
    /// TypeScript or a browser test"). No production caller exists yet -- M18's `FrameCx::
    /// ui_dirty()` is the real one -- so this is reached only through `engine/test`'s
    /// `markUiDirty`, the same "test-only ABI export, reached by name through `callParked`" shape
    /// as `sim_region_hash`/`client_region_hash`/`sim_conn_counters`. No region crosses either
    /// way: the flag lives entirely on the WASM side.
    fn client_ui_mark_dirty(&mut self) -> Status {
        Status::Unsupported
    }

    /// M16b (`ABI_VERSION` 13 -> 14), `engine/test` only:
    /// `UiObserver::{calls, records}` as two LE `u32` into `result` (the whole `Result` region) --
    /// coordinator gate, M16b cut 2: proves "ui ran" (`calls > 0`) and "zero records written"
    /// (`records == 0`) as an assertion, not only a claim in a `budgets.json` `formula` string.
    /// Same crossing shape as `sim_region_hash`/`client_region_hash`/`client_clock_stats`.
    fn client_ui_stats(&mut self, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M26, Open gate failures item 3, gate round 1
    /// (`ABI_VERSION` 24 -> 25), `engine/test` only: `ClientCore::predict_applied_ever` as one LE
    /// `u32` into `result` (the whole `Result` region) -- proves "a dispatched action was actually
    /// predicted `Applied`" as a real assertion, the same "coordinator gate" shape `client_ui_
    /// stats` already set for "ui ran". Same crossing shape as `sim_region_hash`/`client_region_
    /// hash`/`client_clock_stats`/`client_ui_stats`.
    fn client_predict_stats(&mut self, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M30 (`ABI_VERSION` 31 -> 32), `engine/test` only
    /// (`samplePresences`, `interpCounters`): the interpolation view of remote players as of the
    /// last `frame()`. Writes into `Result`, 52 LE bytes: `visible: u32` (remotes visible),
    /// `rendered: u32` and `extrapolated: u32` (cumulative per-frame counters), `delay_ms: f32`,
    /// then the `index`th visible remote (ascending `PlayerId`): `who: u32`, `x: i32`, `y: i32`
    /// (`WorldPos`), `alpha: f32`, `mode: u32` (0 interp, 1 extrap, 2 hold), then `render_t: f64` and `host_now: f64` (the render
    /// time and the `HostClock` estimate, host ticks, at the last `frame()`). When `index >= visible` the
    /// sample fields are zero (`who == 0`, never a real `PlayerId`).
    fn client_presence_sample_at(&mut self, _index: u32, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M30 (`ABI_VERSION` 32 -> 33): tab return (0018 section 8), called
    /// by the client worker when main set `FLAG_REBASE`. Snaps the host clock and interpolation
    /// delay to their initial state and drops every remote's samples (`ClientCore::rebase_interp`).
    fn client_rebase(&mut self) -> Status {
        Status::Unsupported
    }

    /// M37b (`ABI_VERSION` 38 -> 39): WebGPU device loss (0018 section 8),
    /// called by the client worker when main set `FLAG_RENDERER_RESET`. Marks every resident chunk
    /// and the indirection window for re-upload (`Uploader::requeue_all`); the upload ring's byte
    /// budget paces the refill like a join. `Unsupported` on a wrong role.
    fn upload_requeue_all(&mut self) -> Status {
        Status::Unsupported
    }

    /// M17 (`ABI_VERSION` 14 -> 15): how many `Draw` records the
    /// last `frame()` call's own counting sort wrote into `RegionId::DrawList` (`DrawList::
    /// record_count`) -- `0` on a wrong role or before the first `frame()` call, same "always
    /// answer, cost nothing" shape as `sim_warm_one`/`gen_take`/`upload_stage`: no `Status`
    /// crosses here either. The client worker reads this every wake it calls `frame()`, to know
    /// how many `RegionId::DrawList` body blocks to copy into the `drawList` triple buffer
    /// (`worker/client-drawlist.ts`).
    fn drawlist_len(&mut self) -> u32 {
        0
    }

    /// M22 (`ABI_VERSION` 15 -> 16), sim role: encodes a
    /// `persist::SegmentHeader` (identity + base) into `persist` (the whole `Persist` region).
    /// `_segment` is unused by the default/`Host<G>` implementation -- a segment's own index lives
    /// in its storage key (Planning decisions 3, 4), never inside the header bytes themselves
    /// (0005 Formats: `identity | base` only) -- kept as a named parameter because the ABI seam
    /// this brief fixes names it. `base_tick = 0xFFFF_FFFF` means `SegmentBase::Genesis`; any other
    /// value is `SegmentBase::Snapshot(Tick(base_tick))`. Same `len`/`-(status)` crossing shape as
    /// `sim_build_frame`/`sim_seal_frame`.
    fn sim_segment_header(
        &mut self,
        _segment: u32,
        _base_tick: u32,
        _persist: &mut [u8],
    ) -> Result<u32, Status> {
        Err(Status::Unsupported)
    }

    /// M22 (`ABI_VERSION` 15 -> 16), sim role: begins a
    /// streaming snapshot (`persist::SnapshotWriter::begin`) of the current state at `(log_segment,
    /// log_offset)` (Planning decisions 4: "the host owns the log position"). [`Instance::
    /// sim_snapshot_next`] drains it afterward. `Status::Ok` starts a fresh writer, discarding any
    /// previous one never fully drained.
    fn sim_snapshot_begin(&mut self, _log_segment: u32, _log_offset: u32) -> Status {
        Status::Unsupported
    }

    /// M22 (`ABI_VERSION` 15 -> 16), sim role: copies the
    /// next block of the snapshot [`Instance::sim_snapshot_begin`] started into `persist` (the whole
    /// `Persist` region), `0` meaning fully drained (`persist::SnapshotWriter::next`'s own "0 = done"
    /// shape). Same `len`/`-(status)` crossing shape as `sim_seal_frame`.
    fn sim_snapshot_next(&mut self, _persist: &mut [u8]) -> Result<u32, Status> {
        Err(Status::Unsupported)
    }

    /// M22 (`ABI_VERSION` 15 -> 16), sim role: `1` if any
    /// put or logged record has happened since the last snapshot began draining (Planning decisions
    /// 7), `0` otherwise -- including a wrong role or an instance with no such state, same "always
    /// answer, cost nothing" shape as `sim_warm_one`/`drawlist_len`: no `Status` crosses here either.
    fn sim_dirty(&mut self) -> u32 {
        0
    }

    /// M22b (`ABI_VERSION` 16 -> 17), sim role: begins decoding
    /// a snapshot of `total_len` bytes (the whole container, magic through the trailing crc32) fed
    /// in blocks by [`Instance::sim_restore_push`]. Must not require [`Instance::sim_genesis`] to
    /// have run (the whole point: this replaces it for a loaded world). `total_len` is advisory
    /// (buffer-sizing hint); nothing about correctness depends on it being exact.
    fn sim_restore_begin(&mut self, _total_len: u32) -> Status {
        Status::Unsupported
    }

    /// M22b: feeds the next block of the snapshot
    /// [`Instance::sim_restore_begin`] started (`bytes`, the first `len` bytes of `Persist`, reused
    /// here as a receive region -- the same region [`Instance::sim_snapshot_next`] writes *out*
    /// through on the save side). `Status::Corrupt`/`Status::ContainerVersion` on a bad block;
    /// `Status::Ok` otherwise, whether or not the snapshot is fully buffered yet.
    fn sim_restore_push(&mut self, _bytes: &[u8]) -> Status {
        Status::Unsupported
    }

    /// M22b: finishes a restore. `Status::Ok` on success --
    /// builds the live `Sim` from the decoded snapshot and writes `log_segment`, `log_offset` (two
    /// LE `u32`, in that order) into `result` (the whole `Result` region), the position
    /// `Instance::sim_replay_begin` resumes from. `Status::Corrupt` if the snapshot never finished
    /// decoding (still `NeedMore`) or its CRC failed; `Status::IdentityMismatch` if its identity's
    /// `build_hash` differs from this running build's own.
    fn sim_restore_end(&mut self, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M24b step 4: begins the 0005 Upgrades sequence -- the same
    /// block protocol as [`Instance::sim_restore_begin`] (a fresh instance, `pending` still holding
    /// the world's own params), but unlike a plain restore this may finish through `Game::migrate`
    /// rather than a direct `Store<G>` decode: which one it is is not yet known when the first byte
    /// arrives, only once [`Instance::sim_upgrade_end`] has the whole envelope's own `Identity` to
    /// run [`crate::persist::Identity::compare`] against.
    fn sim_upgrade_begin(&mut self, _total_len: u32) -> Status {
        Status::Unsupported
    }

    /// Feeds the next block of the snapshot [`Instance::sim_upgrade_begin`] started (same
    /// in-region-as-receive-buffer shape as [`Instance::sim_restore_push`]).
    fn sim_upgrade_push(&mut self, _bytes: &[u8]) -> Status {
        Status::Unsupported
    }

    /// Finishes the upgrade sequence. `Status::Ok` writes, into `result` (the whole `Result`
    /// region): byte 0 (`0` = direct/same-schema load, tail replay follows; `1` = migrated, no tail
    /// replay -- decision 6), then `log_segment`/`log_offset` (two LE `u32` at `result[1..9]`, the
    /// *old* segment's own position, always present regardless of outcome) -- the position a caller
    /// on the direct/same outcome resumes tail replay from, and the position a caller on the
    /// migrated outcome uses only to know which log bytes were abandoned (for its own record count,
    /// via a fresh [`Instance::sim_replay_scan_begin`]/`push`/`end` over them -- never replayed).
    /// `Status::Corrupt` if the envelope never finished decoding (still `NeedMore`) or its CRC
    /// failed; `Status::SaveIncompatible` (`IncompatReason` at `result[0]`) when `Game::migrate`
    /// itself declines or the old-schema bytes fail to decode -- every stored byte must stay
    /// untouched by the caller on that status (Planning decisions 7).
    fn sim_upgrade_end(&mut self, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// Gate fix round 2 (M24b: `persist::Identity::compare` for
    /// the genesis-replay fallback, which has no snapshot container to feed
    /// [`Instance::sim_upgrade_begin`]/`push`/`end` at all (no snapshot has ever been written yet,
    /// so there is no 0005-Formats envelope to decode) -- the *only* way that path can reach the
    /// real comparison rather than a second, TS-side copy of its decision matrix (round 1's own
    /// mistake, per this milestone's Deviations). `stored` is exactly `Identity::write`'s own wire
    /// shape (no envelope -- the same "raw bytes, no container" convention
    /// [`Instance::sim_segment_header`] itself already writes out): decoded and compared against
    /// this build's own identity. Writes the verdict to `result`: `[0]` `0` = `Same`, `1` =
    /// `Direct`, `2` = `NeedsMigrate` (`[1]` then holds `MismatchReason as u8`: `Schema=0`/
    /// `TickRate=1`/`Worldgen=2`, the same numbering `IncompatReason` already mirrors 1:1).
    /// `Status::Decode` if `stored` fails to parse as an `Identity` at all (a non-empty but
    /// corrupted header must reject, never silently fall back -- the caller's own contract).
    fn sim_identity_compare(&mut self, _stored: &[u8], _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M22b, sim role: begins replaying a segment's log tail
    /// from byte `offset` (a `Sim` must already exist -- from [`Instance::sim_restore_end`] or
    /// [`Instance::sim_genesis`]). `segment` is accepted but unused by the default/`Host<G>`
    /// implementation, the same "named because the seam names it, not read" shape as
    /// `sim_segment_header`'s own `_segment`.
    fn sim_replay_begin(&mut self, _segment: u32, _offset: u32) -> Status {
        Status::Unsupported
    }

    /// M22b: feeds the next block of log bytes (`bytes`, the
    /// first `len` bytes of `Persist`, reused as a receive region exactly like
    /// [`Instance::sim_restore_push`]): decodes as many whole frames as are buffered, applying each
    /// through the same tick procedure a live host uses (idle ticks implied by `tick_delta` included,
    /// no logged record). `Status::Ok` normally; `Status::TornTail` once a block fails to decode
    /// (malformed or a bad CRC) -- not fatal, "not an error for the last segment"; further pushes are
    /// then ignored until [`Instance::sim_replay_end`].
    fn sim_replay_push(&mut self, _bytes: &[u8]) -> Status {
        Status::Unsupported
    }

    /// M22b: finishes a replay. `Status::Ok` if every pushed
    /// block decoded cleanly (including a genuinely empty tail); `Status::TornTail` if
    /// [`Instance::sim_replay_push`] ever hit a bad block. Either way the `Sim` is left at whatever
    /// tick the last successfully applied frame reached ([`Instance::sim_tick_now`]).
    ///
    /// M24b decision 6 (amending 0024 §3b): also writes, as one LE
    /// `u32` at `result[0..4]`, how many `Action` records [`Instance::sim_replay_push`]'s apply pass
    /// dropped because they failed to decode under this build (`persist::FrameRecord::Undecodable`,
    /// warned at the point each is dropped) -- `0` when nothing was dropped, including on every
    /// pre-M24b caller that never reads `result` at all.
    fn sim_replay_end(&mut self, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M22b: the byte offset, within the segment
    /// [`Instance::sim_replay_begin`] named, just after the last frame whose CRC verified --
    /// `offset` (the starting point) when nothing at all decoded. `0` on a wrong role or no replay
    /// ever begun, same "always answer, cost nothing" shape as `sim_dirty`/`drawlist_len`.
    fn sim_replay_valid_end(&mut self) -> u32 {
        0
    }

    /// M22b: the sim's current tick (`Sim::tick`), read after a
    /// restore/replay (or a live `sim_genesis`) to learn the resume tick (0005 Loss windows:
    /// "resumes at max(latest snapshot tick, last logged frame tick)"). `0` on a wrong role or before
    /// any world exists, same "always answer, cost nothing" shape as `sim_dirty`.
    fn sim_tick_now(&mut self) -> u32 {
        0
    }

    /// M24: begins the **scan pass** -- decodes a segment tail
    /// purely to collect `Skip { segment, offset }` targets, before `sim_replay_begin`/`push`/`end`
    /// (the real apply pass) ever runs. Needs a live `Sim` (like `sim_replay_begin`) even though it
    /// never touches it, so a caller cannot scan before a world exists.
    fn sim_replay_scan_begin(&mut self, _segment: u32) -> Status {
        Status::Unsupported
    }

    /// Feeds the next block to the scan pass (same in-region-as-receive-buffer shape as
    /// `sim_replay_push`).
    fn sim_replay_scan_push(&mut self, _bytes: &[u8]) -> Status {
        Status::Unsupported
    }

    /// Finishes the scan pass; its own targets stay collected for the `sim_replay_*` calls that
    /// follow.
    ///
    /// M24b decision 6: also writes, as one LE `u32` at
    /// `result[0..4]`, the total record count seen across every frame the scan pass decoded (any
    /// kind, `Skip` included) -- the `migrate` path's own "how many records this abandoned tail
    /// held" report (0005 Upgrades: the tail is dropped whole, never replayed, so this is the only
    /// count taken of it). `0` on every pre-M24b caller that never reads `result`.
    fn sim_replay_scan_end(&mut self, _result: &mut [u8]) -> Status {
        Status::Unsupported
    }

    /// M24: appends one frame holding a single `Skip { segment,
    /// offset }` record (`tick_delta = 0`, never a real elapsed tick) into `Persist` -- the same
    /// "bytes written, or `-(status)`" shape as `sim_seal_frame`. Needs no live `Sim` (like
    /// `sim_segment_header`): recovery calls this on whatever fresh instance is at hand, purely to
    /// encode the frame; the caller (TS) appends the bytes to storage itself.
    fn sim_log_skip(
        &mut self,
        _segment: u32,
        _offset: u32,
        _persist: &mut [u8],
    ) -> Result<u32, Status> {
        Err(Status::Unsupported)
    }

    /// M24: panics in whatever `Phase` the previous,
    /// successfully-completed export left the `Progress` region in (`Phase::Idle` after any
    /// ordinary call, since this writes nothing of its own before panicking). Test-only by
    /// convention: reached only through `engine/test`'s `trapSim`. The default is a safe no-op
    /// (`Status::Ok`, never reached in practice) so a fixture that never overrides it still links.
    fn sim_test_trap(&mut self) -> Status {
        Status::Ok
    }
}

/// Emits every export for every role, the `#[global_allocator]`, and the single-threaded instance
/// slot, for any `T: Instance`. The panic hook is installed by `engine_init`.
#[macro_export]
macro_rules! export_instance {
    ($t:ty) => {
        #[global_allocator]
        static __ENGINE_ARENA: $crate::abi::Arena = $crate::abi::Arena;
        static __ENGINE_SLOT: $crate::abi::Slot<$t> = $crate::abi::Slot::new();

        // every role
        #[unsafe(no_mangle)]
        pub extern "C" fn engine_abi_version() -> u32 {
            $crate::abi::ABI_VERSION
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn engine_boot() -> *mut u8 {
            $crate::abi::boot::ptr()
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn engine_init(role: u32, cfg_len: u32) -> u32 {
            $crate::abi::init(&__ENGINE_SLOT, role, cfg_len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn engine_region(id: u32) -> *mut u8 {
            $crate::abi::region(&__ENGINE_SLOT, id)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn engine_region_len(id: u32) -> u32 {
            $crate::abi::region_len(&__ENGINE_SLOT, id)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn engine_mem_grows() -> u32 {
            $crate::abi::arena::mem_grows()
        }

        // sim
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_admit(conn: u32, len: u32) -> u32 {
            $crate::abi::sim_admit(&__ENGINE_SLOT, conn, len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_connect(conn: u32) -> u32 {
            $crate::abi::sim_connect(&__ENGINE_SLOT, conn) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_reattach(conn: u32) -> u32 {
            $crate::abi::sim_reattach(&__ENGINE_SLOT, conn) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_fault_ack(conn: u32, seq: u32) -> u32 {
            $crate::abi::sim_fault_ack(&__ENGINE_SLOT, conn, seq) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_disconnect(conn: u32) -> u32 {
            $crate::abi::sim_disconnect(&__ENGINE_SLOT, conn) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_log_disconnected(player: u32) -> u32 {
            $crate::abi::sim_log_disconnected(&__ENGINE_SLOT, player) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_attach(conn: u32, len: u32) -> i32 {
            $crate::abi::sim_attach(&__ENGINE_SLOT, conn, len)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_resync(conn: u32, epoch: u32) -> i32 {
            $crate::abi::sim_resync(&__ENGINE_SLOT, conn, epoch)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_detach(conn: u32) -> u32 {
            $crate::abi::sim_detach(&__ENGINE_SLOT, conn) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_has_player(player: u32) -> u32 {
            $crate::abi::sim_has_player(&__ENGINE_SLOT, player)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_tick() -> u32 {
            $crate::abi::sim_tick(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_build_frame(conn: u32) -> i32 {
            $crate::abi::sim_build_frame(&__ENGINE_SLOT, conn)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_hash() -> u32 {
            $crate::abi::sim_hash(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_genesis() -> u32 {
            $crate::abi::sim_genesis(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_seal_frame() -> i32 {
            $crate::abi::sim_seal_frame(&__ENGINE_SLOT)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_warm_one() -> u32 {
            $crate::abi::sim_warm_one(&__ENGINE_SLOT)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn tick_hz() -> u32 {
            $crate::abi::tick_hz(&__ENGINE_SLOT)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn chunk_bits() -> u32 {
            $crate::abi::chunk_bits(&__ENGINE_SLOT)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_segment_header(segment: u32, base_tick: u32) -> i32 {
            $crate::abi::sim_segment_header(&__ENGINE_SLOT, segment, base_tick)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_snapshot_begin(segment: u32, offset: u32) -> u32 {
            $crate::abi::sim_snapshot_begin(&__ENGINE_SLOT, segment, offset) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_snapshot_next() -> i32 {
            $crate::abi::sim_snapshot_next(&__ENGINE_SLOT)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_dirty() -> u32 {
            $crate::abi::sim_dirty(&__ENGINE_SLOT)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_restore_begin(total_len: u32) -> u32 {
            $crate::abi::sim_restore_begin(&__ENGINE_SLOT, total_len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_restore_push(len: u32) -> u32 {
            $crate::abi::sim_restore_push(&__ENGINE_SLOT, len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_restore_end() -> u32 {
            $crate::abi::sim_restore_end(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_upgrade_begin(total_len: u32) -> u32 {
            $crate::abi::sim_upgrade_begin(&__ENGINE_SLOT, total_len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_upgrade_push(len: u32) -> u32 {
            $crate::abi::sim_upgrade_push(&__ENGINE_SLOT, len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_upgrade_end() -> u32 {
            $crate::abi::sim_upgrade_end(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_identity_compare(len: u32) -> u32 {
            $crate::abi::sim_identity_compare(&__ENGINE_SLOT, len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_replay_scan_begin(segment: u32) -> u32 {
            $crate::abi::sim_replay_scan_begin(&__ENGINE_SLOT, segment) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_replay_scan_push(len: u32) -> u32 {
            $crate::abi::sim_replay_scan_push(&__ENGINE_SLOT, len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_replay_scan_end() -> u32 {
            $crate::abi::sim_replay_scan_end(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_replay_begin(segment: u32, offset: u32) -> u32 {
            $crate::abi::sim_replay_begin(&__ENGINE_SLOT, segment, offset) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_replay_push(len: u32) -> u32 {
            $crate::abi::sim_replay_push(&__ENGINE_SLOT, len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_replay_end() -> u32 {
            $crate::abi::sim_replay_end(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_replay_valid_end() -> u32 {
            $crate::abi::sim_replay_valid_end(&__ENGINE_SLOT)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_tick_now() -> u32 {
            $crate::abi::sim_tick_now(&__ENGINE_SLOT)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_log_skip(segment: u32, offset: u32) -> i32 {
            $crate::abi::sim_log_skip(&__ENGINE_SLOT, segment, offset)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_test_trap() -> u32 {
            $crate::abi::sim_test_trap(&__ENGINE_SLOT) as u32
        }

        // client
        #[unsafe(no_mangle)]
        pub extern "C" fn frame(t_ms: f64) -> u32 {
            $crate::abi::frame(&__ENGINE_SLOT, t_ms) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn gen_take(worker: u32) -> u32 {
            $crate::abi::gen_take(&__ENGINE_SLOT, worker)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn gen_deliver(worker: u32, len: u32) -> u32 {
            $crate::abi::gen_deliver(&__ENGINE_SLOT, worker, len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_gen_stats() -> u32 {
            $crate::abi::client_gen_stats(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_chunk_hash(cx: i32, cy: i32) -> u32 {
            $crate::abi::client_chunk_hash(&__ENGINE_SLOT, cx, cy) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn upload_stage(max_records: u32) -> u32 {
            $crate::abi::upload_stage(&__ENGINE_SLOT, max_records)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn on_input(len: u32) -> u32 {
            $crate::abi::on_input(&__ENGINE_SLOT, len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn on_frame(len: u32) -> u32 {
            $crate::abi::on_frame(&__ENGINE_SLOT, len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_poll_uplink(t_ms: f64) -> i32 {
            $crate::abi::client_poll_uplink(&__ENGINE_SLOT, t_ms)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_hello() -> i32 {
            $crate::abi::client_hello(&__ENGINE_SLOT)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_on_welcome(len: u32, rtt_ms: f64) -> u32 {
            $crate::abi::client_on_welcome(&__ENGINE_SLOT, len, rtt_ms) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_world_config() -> i32 {
            $crate::abi::client_world_config(&__ENGINE_SLOT)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_region_hash(conn: u32) -> u32 {
            $crate::abi::sim_region_hash(&__ENGINE_SLOT, conn) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_region_hash() -> u32 {
            $crate::abi::client_region_hash(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_conn_counters(conn: u32) -> u32 {
            $crate::abi::sim_conn_counters(&__ENGINE_SLOT, conn) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_pacing_counters(conn: u32) -> u32 {
            $crate::abi::sim_pacing_counters(&__ENGINE_SLOT, conn) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_desync(index: u32) -> u32 {
            $crate::abi::sim_desync(&__ENGINE_SLOT, index) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_desync(index: u32) -> u32 {
            $crate::abi::client_desync(&__ENGINE_SLOT, index) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_desync_dump(part: u32) -> i32 {
            $crate::abi::client_desync_dump(&__ENGINE_SLOT, part)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn sim_skip_delta(conn: u32, coord: u32) -> u32 {
            $crate::abi::sim_skip_delta(&__ENGINE_SLOT, conn, coord) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_corrupt_chunk(cx: u32, cy: u32) -> u32 {
            $crate::abi::client_corrupt_chunk(&__ENGINE_SLOT, cx, cy) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn on_action(len: u32) -> u32 {
            $crate::abi::on_action(&__ENGINE_SLOT, len) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_poll_ui() -> u32 {
            $crate::abi::client_poll_ui(&__ENGINE_SLOT)
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_clock_stats() -> u32 {
            $crate::abi::client_clock_stats(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_ui_mark_dirty() -> u32 {
            $crate::abi::client_ui_mark_dirty(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_ui_stats() -> u32 {
            $crate::abi::client_ui_stats(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_predict_stats() -> u32 {
            $crate::abi::client_predict_stats(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_rebase() -> u32 {
            $crate::abi::client_rebase(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn upload_requeue_all() -> u32 {
            $crate::abi::upload_requeue_all(&__ENGINE_SLOT) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn client_presence_sample_at(index: u32) -> u32 {
            $crate::abi::client_presence_sample_at(&__ENGINE_SLOT, index) as u32
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn drawlist_len() -> u32 {
            $crate::abi::drawlist_len(&__ENGINE_SLOT)
        }

        // gen
        #[unsafe(no_mangle)]
        pub extern "C" fn gen_chunk(cx: i32, cy: i32) -> u32 {
            $crate::abi::gen_chunk(&__ENGINE_SLOT, cx, cy) as u32
        }
    };
}

/// The one line of ABI a game writes (0014 §5). Re-points at
/// [`GameInstance<G>`](crate::game_instance::GameInstance), the engine's generic dispatcher over
/// the `Game` trait (M13 Scope): `Role::Sim` ->
/// [`host::Host<G>`](crate::host::Host), `Role::Gen` -> `worldgen::GenCore<G::Worldgen>`,
/// `Role::Client` -> [`ClientInstance<G>`](crate::game_instance::ClientInstance). A low-level
/// fixture that implements `Instance` directly still calls `export_instance!` itself.
#[macro_export]
macro_rules! export_game {
    ($t:ty) => {
        $crate::export_instance!($crate::game_instance::GameInstance<$t>);
    };
}
