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

use super::regions::RegionLayout;

pub const ABI_VERSION: u32 = 1;

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

pub const REGION_COUNT: usize = 9;

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
    };
}

/// The one line of ABI a game writes (0014 §5). Forwards to [`export_instance!`] until M13
/// re-points it at the engine's generic host over the `Game` trait.
#[macro_export]
macro_rules! export_game {
    ($t:ty) => {
        $crate::export_instance!($t);
    };
}
