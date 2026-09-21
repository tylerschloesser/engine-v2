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

pub const ABI_VERSION: u32 = 8;

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
    /// `client_chunk_hash` (docs/plan/08b-gen-workers-and-queue.md): the chunk is not resident in
    /// the client's cache. Appended, never inserted (0014's numbering rule).
    NotCached = 9,
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
    /// `genResult` record staging (docs/plan/08b-gen-workers-and-queue.md): `16 + slab_bytes`,
    /// sized by client-role `init` alongside its `TerrainFeed`, same as `GenOut` on the gen role.
    GenIn = 9,
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

pub const REGION_COUNT: usize = 10;

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

    /// docs/plan/13-sim-host-tick-loop.md: creates the world from the init config (`Sim::genesis`
    /// for a real `Game`); M22b adds the load-from-storage path. Called once per instance; a
    /// second call is `Status::AlreadyInitialised`.
    fn sim_genesis(&mut self) -> Status {
        Status::Unsupported
    }

    /// docs/plan/13-sim-host-tick-loop.md: write-ahead log bytes for the frame about to be
    /// applied (0024 §1's export boundary), written into `persist` (the whole `Persist` region --
    /// empty until a role declares it, which none does yet: Non-scope here, M22 gives this real
    /// content and sizes the region). Returns the byte count, or `-(status)` on failure at the
    /// export boundary, the same shape as `sim_build_frame`.
    fn sim_seal_frame(&mut self, _persist: &mut [u8]) -> Result<u32, Status> {
        Err(Status::Unsupported)
    }

    /// docs/plan/13-sim-host-tick-loop.md: generates at most one uncached chunk from the warm
    /// list (`host::warm`), nearest-to-view-centre first. `1` if it generated one, `0` if nothing
    /// is cold -- the "always answer, cost nothing" shape of `gen_take`/`upload_stage`: no
    /// `Status` crosses here either.
    fn sim_warm_one(&mut self) -> u32 {
        0
    }

    /// docs/plan/13-sim-host-tick-loop.md ("20 Hz is hardcoded" gap): the sim role's own tick
    /// rate, read once by `SimHost` at construction instead of assuming 20 unconditionally. A
    /// game exposes its real rate by overriding this to return `G::TICK_RATE.hz_value()`
    /// (`host::Host<G>`, `game_instance::GameInstance<G>`); the default (`20`, `TickRate::HZ_20`'s
    /// own value, 0006) is what every game that never overrides `TICK_RATE` already paces at, so
    /// a low-level fixture with no `Sim` role at all still answers safely. Same "always answer,
    /// cost nothing" shape as `sim_warm_one`/`gen_take`: no `Status` crosses.
    fn tick_hz(&mut self) -> u32 {
        20
    }

    /// Called only when the client worker saw `CB_FRAME_REQ` advance (docs/plan/06b-workers-and-
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

    /// `docs/plan/08b-gen-workers-and-queue.md`, ABI role `client`: writes a 16-byte `genRequest`
    /// record into `out` (the first 16 bytes of `Result`) if there is a job to dispatch to
    /// `worker`. `false` when there is nothing (the default, and every fixture with no
    /// `client::TerrainFeed`): `gen_take` must cost nothing and always return 0 on a page whose
    /// client role has none (`docs/plan/08b-gen-workers-and-queue.md`, orchestrator decisions).
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

    /// `docs/plan/09-renderer-terrain.md`: stages up to `max_records` upload-ring records (chunk
    /// conversions, tile patches, indirection updates -- `client::Uploader::stage`) into `out`
    /// (the whole `ChunkTexels` region), returns the count actually written. `0` on every fixture
    /// with no `Uploader` (a client role that renders no terrain), same "always answer, cost
    /// nothing on a page without one" shape as `gen_take`.
    fn upload_stage(&mut self, _max_records: u32, _out: &mut [u8]) -> u32 {
        0
    }

    /// `docs/plan/11-camera-and-input.md`: decodes whole `client::input::InputEvent` records
    /// (32 bytes each) from `rx` (the first `len` bytes of `Rx`, `abi::on_input`) into whatever
    /// `InputQueue` this instance owns, and may write back anything it wants observable in
    /// `result` (the whole `Result` region) -- this milestone's own fixture writes queue length
    /// plus the last event's tile there, its own test export. `Status::Unsupported` by default,
    /// same "answers something, does nothing" shape as every other role/feature an instance
    /// doesn't implement.
    fn on_input(&mut self, _rx: &[u8], _result: &mut [u8]) -> Status {
        Status::Unsupported
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

        // gen
        #[unsafe(no_mangle)]
        pub extern "C" fn gen_chunk(cx: i32, cy: i32) -> u32 {
            $crate::abi::gen_chunk(&__ENGINE_SLOT, cx, cy) as u32
        }
    };
}

/// The one line of ABI a game writes (0014 §5). Re-points at
/// [`GameInstance<G>`](crate::game_instance::GameInstance), the engine's generic dispatcher over
/// the `Game` trait (docs/plan/13-sim-host-tick-loop.md Scope): `Role::Sim` ->
/// [`host::Host<G>`](crate::host::Host), `Role::Gen` -> `worldgen::GenCore<G::Worldgen>`,
/// `Role::Client` -> [`ClientInstance<G>`](crate::game_instance::ClientInstance). A low-level
/// fixture that implements `Instance` directly still calls `export_instance!` itself.
#[macro_export]
macro_rules! export_game {
    ($t:ty) => {
        $crate::export_instance!($crate::game_instance::GameInstance<$t>);
    };
}
