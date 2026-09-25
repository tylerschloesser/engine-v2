//! The JS↔WASM boundary (docs/decisions/0014): a fixed, numbers-only `extern "C"` ABI.
//!
//! `registry` owns what the ABI *is*. This file holds what the exports *do*: the generic
//! functions the externs of `export_instance!` forward to, so the macro stays a list.

pub mod arena;
pub mod boot;
pub mod config;
pub mod panic;
pub mod regions;
pub mod registry;

use core::cell::UnsafeCell;

use crate::client::CameraBlock;

pub use arena::Arena;
pub use regions::RegionLayout;
pub use registry::{
    ABI_VERSION, BOOT_BYTES, BOOT_TEXT_BYTES, Instance, LogLevel, RESULT_BYTES, RegionId, Role,
    Status,
};

/// One initialised instance: its role for life, its region table, and the implementor.
pub struct Runtime<T> {
    role: Role,
    layout: RegionLayout,
    inst: T,
}

/// The module's single instance slot. `export_instance!` puts one in a `static`.
pub struct Slot<T>(UnsafeCell<Option<Runtime<T>>>);

// SAFETY: a WASM instance is single-threaded (0015), and exports are not re-entered: the two
// imports are output-only and the host calls nothing from inside them.
unsafe impl<T> Sync for Slot<T> {}

impl<T> Slot<T> {
    pub const fn new() -> Self {
        Slot(UnsafeCell::new(None))
    }

    #[allow(clippy::mut_from_ref)]
    fn get(&self) -> &mut Option<Runtime<T>> {
        // SAFETY: see the `Sync` impl; one export runs at a time and takes this once.
        unsafe { &mut *self.0.get() }
    }

    fn sim(&self) -> Result<&mut Runtime<T>, Status> {
        let rt = self.get().as_mut().ok_or(Status::NotInitialised)?;
        if rt.role != Role::Sim {
            return Err(Status::WrongRole);
        }
        Ok(rt)
    }

    fn client(&self) -> Result<&mut Runtime<T>, Status> {
        let rt = self.get().as_mut().ok_or(Status::NotInitialised)?;
        if rt.role != Role::Client {
            return Err(Status::WrongRole);
        }
        Ok(rt)
    }

    fn gen_role(&self) -> Result<&mut Runtime<T>, Status> {
        let rt = self.get().as_mut().ok_or(Status::NotInitialised)?;
        if rt.role != Role::Gen {
            return Err(Status::WrongRole);
        }
        Ok(rt)
    }
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self::new()
    }
}

pub fn init<T: Instance>(slot: &Slot<T>, role: u32, cfg_len: u32) -> Status {
    panic::install_hook();
    match try_init(slot, role, cfg_len) {
        Ok(()) => Status::Ok,
        Err(status) => status,
    }
}

fn try_init<T: Instance>(slot: &Slot<T>, role: u32, cfg_len: u32) -> Result<(), Status> {
    let state = slot.get();
    if state.is_some() {
        return Err(Status::AlreadyInitialised);
    }
    let role = Role::from_u32(role).ok_or(Status::BadConfig)?;
    let cfg = config::parse(boot::config(cfg_len).ok_or(Status::BadLength)?)?;
    if !arena::reserve(cfg.arena_bytes) {
        return Err(Status::OutOfMemory);
    }
    let mut layout = RegionLayout::new();
    layout.region(RegionId::Result, RESULT_BYTES);
    if role == Role::Client {
        layout.region(RegionId::Camera, CameraBlock::BYTES as u32);
    }
    let inst = T::init(role, &cfg.game_json, &mut layout)?;
    *state = Some(Runtime { role, layout, inst });
    panic::log(LogLevel::Debug, "engine_init ok");
    Ok(())
}

pub fn region<T>(slot: &Slot<T>, id: u32) -> *mut u8 {
    match (slot.get(), RegionId::from_u32(id)) {
        (Some(rt), Some(id)) => rt.layout.ptr(id),
        _ => core::ptr::null_mut(),
    }
}

pub fn region_len<T>(slot: &Slot<T>, id: u32) -> u32 {
    match (slot.get(), RegionId::from_u32(id)) {
        (Some(rt), Some(id)) => rt.layout.len(id),
        _ => 0,
    }
}

pub fn sim_admit<T: Instance>(slot: &Slot<T>, conn: u32, len: u32) -> Status {
    let rt = match slot.sim() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    match rt.layout.bytes(RegionId::Rx).get(..len as usize) {
        Some(rx) => rt.inst.sim_admit(conn, rx),
        None => Status::BadLength,
    }
}

pub fn sim_connect<T: Instance>(slot: &Slot<T>, conn: u32) -> Status {
    match slot.sim() {
        Ok(rt) => rt.inst.sim_connect(conn),
        Err(status) => status,
    }
}

pub fn sim_disconnect<T: Instance>(slot: &Slot<T>, conn: u32) -> Status {
    match slot.sim() {
        Ok(rt) => rt.inst.sim_disconnect(conn),
        Err(status) => status,
    }
}

pub fn sim_tick<T: Instance>(slot: &Slot<T>) -> Status {
    match slot.sim() {
        Ok(rt) => rt.inst.sim_tick(),
        Err(status) => status,
    }
}

/// Bytes written to `Tx`, or `-(status)`.
pub fn sim_build_frame<T: Instance>(slot: &Slot<T>, conn: u32) -> i32 {
    let built = slot.sim().and_then(|rt| {
        rt.inst
            .sim_build_frame(conn, rt.layout.bytes_mut(RegionId::Tx))
    });
    match built {
        Ok(len) => len as i32,
        Err(status) => -(status as i32),
    }
}

pub fn sim_hash<T: Instance>(slot: &Slot<T>) -> Status {
    let rt = match slot.sim() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    let hash = rt.inst.sim_hash();
    let out = rt.layout.bytes_mut(RegionId::Result);
    out[0..4].copy_from_slice(&(hash as u32).to_le_bytes());
    out[4..8].copy_from_slice(&((hash >> 32) as u32).to_le_bytes());
    Status::Ok
}

/// `sim_genesis()`: builds the world from the init config (`Sim::genesis` for a real `Game`).
pub fn sim_genesis<T: Instance>(slot: &Slot<T>) -> Status {
    match slot.sim() {
        Ok(rt) => rt.inst.sim_genesis(),
        Err(status) => status,
    }
}

/// `sim_seal_frame()`: bytes written to `Persist`, or `-(status)` -- the same shape as
/// `sim_build_frame`.
pub fn sim_seal_frame<T: Instance>(slot: &Slot<T>) -> i32 {
    let built = slot.sim().and_then(|rt| {
        rt.inst
            .sim_seal_frame(rt.layout.bytes_mut(RegionId::Persist))
    });
    match built {
        Ok(len) => len as i32,
        Err(status) => -(status as i32),
    }
}

/// `sim_segment_header(segment, base_tick)`: bytes written to `Persist`, or `-(status)` -- the same
/// shape as `sim_seal_frame`/`sim_build_frame`.
pub fn sim_segment_header<T: Instance>(slot: &Slot<T>, segment: u32, base_tick: u32) -> i32 {
    let built = slot.sim().and_then(|rt| {
        rt.inst
            .sim_segment_header(segment, base_tick, rt.layout.bytes_mut(RegionId::Persist))
    });
    match built {
        Ok(len) => len as i32,
        Err(status) => -(status as i32),
    }
}

/// `sim_snapshot_begin(segment, offset)`.
pub fn sim_snapshot_begin<T: Instance>(slot: &Slot<T>, segment: u32, offset: u32) -> Status {
    match slot.sim() {
        Ok(rt) => rt.inst.sim_snapshot_begin(segment, offset),
        Err(status) => status,
    }
}

/// `sim_snapshot_next()`: bytes copied to `Persist` (`0` = done), or `-(status)` -- the same shape
/// as `sim_seal_frame`.
pub fn sim_snapshot_next<T: Instance>(slot: &Slot<T>) -> i32 {
    let built = slot.sim().and_then(|rt| {
        rt.inst
            .sim_snapshot_next(rt.layout.bytes_mut(RegionId::Persist))
    });
    match built {
        Ok(len) => len as i32,
        Err(status) => -(status as i32),
    }
}

/// `sim_dirty() -> u32`: same "always answer, cost nothing on a wrong role" shape as
/// `sim_warm_one`/`drawlist_len` -- no `Status` crosses here either.
pub fn sim_dirty<T: Instance>(slot: &Slot<T>) -> u32 {
    match slot.sim() {
        Ok(rt) => rt.inst.sim_dirty(),
        Err(_) => 0,
    }
}

/// `sim_warm_one() -> u32`: same "always answer, cost nothing on a wrong role" shape as
/// `gen_take`/`upload_stage` -- no `Status` crosses here either.
pub fn sim_warm_one<T: Instance>(slot: &Slot<T>) -> u32 {
    match slot.sim() {
        Ok(rt) => rt.inst.sim_warm_one(),
        Err(_) => 0,
    }
}

/// `tick_hz()`: the sim role's own tick rate ("20 Hz is hardcoded" gap, docs/plan/
/// 13-sim-host-tick-loop.md). Same "always answer, cost nothing on a wrong role" shape as
/// `sim_warm_one`: the trait default (`20`) on anything but `Role::Sim`, not an error.
/// docs/plan/16-action-round-trip.md: broadened from `slot.sim()` to "any initialised role"
/// (Deviations) -- `Instance::tick_hz`'s own doc comment already established the answer is
/// role-independent (`GameInstance::tick_hz` ignores `self`'s variant), and the client worker now
/// needs its own instance's tick rate for the clock block (`ticks_per_second`) the same way
/// `SimHost` already reads it at construction. No `ABI_VERSION` bump: the export's params/result
/// shape is unchanged, only which role may call it (`ABI_EXPORTS`'s `role` field is documentation,
/// not itself checked by the registry test).
pub fn tick_hz<T: Instance>(slot: &Slot<T>) -> u32 {
    match slot.get().as_mut() {
        Some(rt) => rt.inst.tick_hz(),
        None => 20,
    }
}

/// The raw export argument is **unused** (hence `_raw_t_ms`), and the `t_ms` an `Instance::frame`
/// receives is `camera.frame_time_ms`, read out of this role's own `Camera` region -- decision A of
/// fix round 3 (docs/plan/06b-workers-and-spawn.md, Deviations). The JS side stopped computing the
/// argument in fix round 2 (a `Float64Array` element read boxed a fresh `HeapNumber` on every real
/// frame: `worker/client.ts` passes a constant instead), and a parameter that is silently always
/// zero would be a trap for every brief that cites `frame(t_ms)`. Both channels carry the same
/// value by construction: JS writes the whole `CameraBlock`, `frame_time_ms` included, in the same
/// pass that raises `CB_FRAME_REQ`. The export keeps its shape, so `ABI_VERSION` stays 2.
pub fn frame<T: Instance>(slot: &Slot<T>, _raw_t_ms: f64) -> Status {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    let Some(camera_ptr) = CameraBlock::ptr(&rt.layout) else {
        return Status::NotInitialised;
    };
    let result = rt.layout.bytes_mut(RegionId::Result);
    // SAFETY: `camera_ptr` addresses the `Camera` region, a separate heap allocation from
    // `Result` (`RegionLayout::region`) that never moves or resizes after init (0014 §4); the
    // instance is single-threaded and not re-entered, so nothing else touches it during this call.
    let camera = unsafe { &*camera_ptr };
    rt.inst.frame(camera.frame_time_ms, camera, result)
}

/// `gen_chunk(cx, cy)` (0008 §1, §2 table): the whole `GenOut` region is handed to the instance as
/// `out`, its length whatever the gen-role `init` declared (`dims.slab_bytes()`, Seams of
/// docs/plan/08-worldgen-and-gen-worker.md -- never a literal).
pub fn gen_chunk<T: Instance>(slot: &Slot<T>, cx: i32, cy: i32) -> Status {
    let rt = match slot.gen_role() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    let out = rt.layout.bytes_mut(RegionId::GenOut);
    rt.inst.gen_chunk(cx, cy, out)
}

/// `gen_take(worker) -> u32`: `1` when a 16-byte `genRequest` record now sits at offset 0 of
/// `Result`, `0` otherwise -- including a wrong role or an instance with no `client::TerrainFeed`
/// (docs/plan/08b-gen-workers-and-queue.md, orchestrator decisions: this must cost nothing and
/// return 0 on a page whose client role has none, so no `Status` crosses here).
pub fn gen_take<T: Instance>(slot: &Slot<T>, worker: u32) -> u32 {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(_) => return 0,
    };
    let result = rt.layout.bytes_mut(RegionId::Result);
    let Some(out) = result.get_mut(..16) else {
        return 0;
    };
    // SAFETY-free: a 16-byte sub-slice always converts to `&mut [u8; 16]`.
    let out: &mut [u8; 16] = out.try_into().expect("checked length above");
    u32::from(rt.inst.gen_take(worker, out))
}

/// `gen_deliver(worker, len)`: `len` bytes of the `GenIn` region are the `genResult` record.
pub fn gen_deliver<T: Instance>(slot: &Slot<T>, worker: u32, len: u32) -> Status {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    match rt.layout.bytes(RegionId::GenIn).get(..len as usize) {
        Some(record) => rt.inst.gen_deliver(worker, record),
        None => Status::BadLength,
    }
}

/// `client_gen_stats()`: seven `u32`s into `Result` (`Instance::client_gen_stats`'s own doc names
/// the field order).
pub fn client_gen_stats<T: Instance>(slot: &Slot<T>) -> Status {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    let result = rt.layout.bytes_mut(RegionId::Result);
    rt.inst.client_gen_stats(result)
}

/// `client_chunk_hash(cx, cy)`: lo, hi `u32` of an FNV hash into `Result`, or `Status::NotCached`.
pub fn client_chunk_hash<T: Instance>(slot: &Slot<T>, cx: i32, cy: i32) -> Status {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    let result = rt.layout.bytes_mut(RegionId::Result);
    rt.inst.client_chunk_hash(cx, cy, result)
}

/// `upload_stage(max_records) -> u32`: records staged into `ChunkTexels`, `0` on a wrong role or an
/// instance with no `client::Uploader` (docs/plan/09-renderer-terrain.md, same "always answer, cost
/// nothing" shape as `gen_take`, so no `Status` crosses here either).
pub fn upload_stage<T: Instance>(slot: &Slot<T>, max_records: u32) -> u32 {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(_) => return 0,
    };
    let out = rt.layout.bytes_mut(RegionId::ChunkTexels);
    rt.inst.upload_stage(max_records, out)
}

/// `on_input(len) -> status`: decodes `len` bytes of `Rx` as whole `client::input::InputEvent`
/// records (docs/plan/11-camera-and-input.md). `Rx` is read through a raw pointer taken before
/// `Result` is borrowed mutably -- the same deferred-borrow shape `CameraBlock::ptr` uses
/// (`client/camera.rs`'s own doc comment): `Rx` and `Result` are separate allocations
/// (`RegionLayout::region`) that never move or resize after init, so reading one immutably while
/// writing the other is sound even though `RegionLayout` has no API to split its own borrow that
/// way.
pub fn on_input<T: Instance>(slot: &Slot<T>, len: u32) -> Status {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    let rx_ptr = rt.layout.ptr(RegionId::Rx);
    let rx_cap = rt.layout.len(RegionId::Rx);
    if rx_ptr.is_null() || len > rx_cap {
        return Status::BadLength;
    }
    // SAFETY: `rx_ptr` addresses the `Rx` region (a separate heap allocation from `Result`) that
    // never moves or resizes after init; the instance is single-threaded and not re-entered, so
    // nothing else touches it during this call.
    let rx = unsafe { core::slice::from_raw_parts(rx_ptr, len as usize) };
    let result = rt.layout.bytes_mut(RegionId::Result);
    rt.inst.on_input(rx, result)
}

/// `on_frame(len) -> status`: `len` bytes of `Downlink` are one whole host frame (0011), applied
/// atomically into the client role's own replica (`Instance::on_frame`). `Downlink` is read
/// through a raw pointer taken before `Result` would be borrowed -- unlike `on_input`, `on_frame`
/// writes no `Result` of its own today, but the same deferred-borrow reasoning applies should a
/// future milestone add one.
pub fn on_frame<T: Instance>(slot: &Slot<T>, len: u32) -> Status {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    match rt.layout.bytes(RegionId::Downlink).get(..len as usize) {
        Some(bytes) => rt.inst.on_frame(bytes),
        None => Status::BadLength,
    }
}

/// `client_poll_uplink(t_ms) -> len`, or `-(status)` -- the same shape as `sim_build_frame`. The
/// raw `t_ms` argument is ignored (same reasoning as `frame`'s own `_raw_t_ms`, above): the real
/// value is `camera.frame_time_ms`, already copied into this role's `Camera` region by the same
/// worker pass that calls `frame` right before this (`worker/client.ts`'s own per-wake order),
/// truncated to whole milliseconds (`Instance::client_poll_uplink`'s own `u32` parameter).
pub fn client_poll_uplink<T: Instance>(slot: &Slot<T>, _raw_t_ms: f64) -> i32 {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(status) => return -(status as i32),
    };
    let Some(camera_ptr) = CameraBlock::ptr(&rt.layout) else {
        return -(Status::NotInitialised as i32);
    };
    // SAFETY: see `frame`, above -- same region, same single-threaded, non-re-entrant instance.
    let camera = unsafe { &*camera_ptr };
    let t_ms = camera.frame_time_ms as u32;
    let out = rt.layout.bytes_mut(RegionId::Tx);
    rt.inst.client_poll_uplink(t_ms, out) as i32
}

/// `sim_region_hash(conn) -> status`: `host::Host::region_hash(conn)`, two LE `u32` into `Result`
/// (`sim_hash`'s own crossing shape). `engine/test`-only (`hostRegionHash`).
pub fn sim_region_hash<T: Instance>(slot: &Slot<T>, conn: u32) -> Status {
    let rt = match slot.sim() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    let result = rt.layout.bytes_mut(RegionId::Result);
    rt.inst.sim_region_hash(conn, result)
}

/// `client_region_hash() -> status`: `client::Replica::region_hash()`, same crossing shape as
/// `sim_region_hash`. `engine/test`-only (`replicaHash`).
pub fn client_region_hash<T: Instance>(slot: &Slot<T>) -> Status {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    let result = rt.layout.bytes_mut(RegionId::Result);
    rt.inst.client_region_hash(result)
}

/// `on_action(len) -> status`: `len` bytes of `Rx` are one action-ring record (docs/plan/
/// 16-action-round-trip.md; `Instance::on_action`'s own doc comment has the exact shape). `Rx` is
/// read through a raw pointer taken before `Instance::on_action` runs, the same deferred-borrow
/// shape `on_input`/`on_frame` already use for their own receive regions.
pub fn on_action<T: Instance>(slot: &Slot<T>, len: u32) -> Status {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    match rt.layout.bytes(RegionId::Rx).get(..len as usize) {
        Some(rx) => rt.inst.on_action(rx),
        None => Status::BadLength,
    }
}

/// `client_poll_ui() -> len`: copies at most one batch of UI-ring records into the whole `Ui`
/// region, same "always answer, cost nothing" shape as `upload_stage` -- no `Status` crosses here
/// either (docs/plan/16-action-round-trip.md).
pub fn client_poll_ui<T: Instance>(slot: &Slot<T>) -> u32 {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(_) => return 0,
    };
    let out = rt.layout.bytes_mut(RegionId::Ui);
    rt.inst.client_poll_ui(out) as u32
}

/// `client_clock_stats() -> status`: `authoritative_tick`, `ack_seq` as two LE `u32` into
/// `Result` (docs/plan/16-action-round-trip.md; `Instance::client_clock_stats`'s own doc comment
/// has the exact shape and why only these two values cross here).
pub fn client_clock_stats<T: Instance>(slot: &Slot<T>) -> Status {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    let result = rt.layout.bytes_mut(RegionId::Result);
    rt.inst.client_clock_stats(result)
}

/// `client_ui_mark_dirty() -> status`: forces `UiObserver::mark_dirty()` (docs/plan/
/// 16b-ui-observation-and-clock.md; `Instance::client_ui_mark_dirty`'s own doc comment). No
/// region crosses. `engine/test`-only (`markUiDirty`).
pub fn client_ui_mark_dirty<T: Instance>(slot: &Slot<T>) -> Status {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    rt.inst.client_ui_mark_dirty()
}

/// `client_ui_stats() -> status`: `UiObserver::{calls, records}` as two LE `u32` into `Result`
/// (docs/plan/16b-ui-observation-and-clock.md; `Instance::client_ui_stats`'s own doc comment).
/// `engine/test`-only (`uiObserverStats`).
pub fn client_ui_stats<T: Instance>(slot: &Slot<T>) -> Status {
    let rt = match slot.client() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    let result = rt.layout.bytes_mut(RegionId::Result);
    rt.inst.client_ui_stats(result)
}

/// `sim_conn_counters(conn) -> status`: `host::ConnCounters` for `conn`, little-endian into
/// `Result` (`Instance::sim_conn_counters`'s own doc comment names the field order and byte
/// count). `engine/test`-only (`netCounters`).
pub fn sim_conn_counters<T: Instance>(slot: &Slot<T>, conn: u32) -> Status {
    let rt = match slot.sim() {
        Ok(rt) => rt,
        Err(status) => return status,
    };
    let result = rt.layout.bytes_mut(RegionId::Result);
    rt.inst.sim_conn_counters(conn, result)
}

/// `drawlist_len() -> u32`: `Instance::drawlist_len`'s own "always answer, cost nothing" shape --
/// `0` on a wrong role (docs/plan/17-drawlist-and-sprites.md), not an error.
pub fn drawlist_len<T: Instance>(slot: &Slot<T>) -> u32 {
    match slot.client() {
        Ok(rt) => rt.inst.drawlist_len(),
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Probe {
        admitted: usize,
    }

    impl Instance for Probe {
        fn init(_: Role, game: &str, layout: &mut RegionLayout) -> Result<Self, Status> {
            if game == "null" {
                return Err(Status::BadConfig);
            }
            layout.region(RegionId::Rx, 8);
            Ok(Probe { admitted: 0 })
        }
        fn sim_admit(&mut self, _conn: u32, rx: &[u8]) -> Status {
            self.admitted += rx.len();
            Status::Ok
        }
        fn sim_hash(&mut self) -> u64 {
            0x0102_0304_0506_0708
        }
    }

    fn slot_with(role: Role) -> Slot<Probe> {
        let slot = Slot::new();
        let mut layout = RegionLayout::new();
        layout.region(RegionId::Result, RESULT_BYTES);
        let inst = Probe::init(role, "{}", &mut layout).unwrap();
        *slot.get() = Some(Runtime { role, layout, inst });
        slot
    }

    #[test]
    fn abi_exports_need_init_and_the_right_role() {
        let empty: Slot<Probe> = Slot::new();
        assert_eq!(sim_tick(&empty), Status::NotInitialised);
        assert_eq!(sim_build_frame(&empty, 0), -(Status::NotInitialised as i32));
        assert!(region(&empty, RegionId::Result as u32).is_null());

        let client = slot_with(Role::Client);
        assert_eq!(sim_tick(&client), Status::WrongRole);
        assert_eq!(sim_hash(&client), Status::WrongRole);
        assert_eq!(region_len(&client, RegionId::Result as u32), RESULT_BYTES);
    }

    #[test]
    fn abi_defaults_are_unsupported_and_lengths_are_checked() {
        let sim = slot_with(Role::Sim);
        assert_eq!(sim_tick(&sim), Status::Unsupported);
        assert_eq!(sim_build_frame(&sim, 0), -(Status::Unsupported as i32));
        assert_eq!(sim_admit(&sim, 0, 8), Status::Ok);
        assert_eq!(sim_admit(&sim, 0, 9), Status::BadLength);
        assert_eq!(sim.get().as_ref().unwrap().inst.admitted, 8);
        assert_eq!(region_len(&sim, 99), 0);
    }

    #[test]
    fn abi_gen_chunk_checks_role_before_the_default() {
        let empty: Slot<Probe> = Slot::new();
        assert_eq!(gen_chunk(&empty, 0, 0), Status::NotInitialised);

        let sim = slot_with(Role::Sim);
        assert_eq!(gen_chunk(&sim, 0, 0), Status::WrongRole);

        let gen_slot = slot_with(Role::Gen);
        assert_eq!(gen_chunk(&gen_slot, 0, 0), Status::Unsupported);
    }

    #[test]
    fn abi_hash_crosses_as_two_le_u32() {
        let sim = slot_with(Role::Sim);
        assert_eq!(sim_hash(&sim), Status::Ok);
        let rt = sim.get().as_ref().unwrap();
        assert_eq!(
            rt.layout.bytes(RegionId::Result)[..8],
            [8, 7, 6, 5, 4, 3, 2, 1]
        );
    }
}
