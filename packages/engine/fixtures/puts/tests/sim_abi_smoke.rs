//! Native "through the C ABI" smoke test for M15b step 1 (docs/plan/
//! 15b-ring-connection-and-replica-rendering.md): drives the real, macro-generated ABI surface
//! (`engine::abi`'s generic functions -- the same bodies `export_instance!`'s `extern "C"`
//! wrappers each forward to, one line -- see `abi::registry::export_instance!`) against
//! `GameInstance<Puts>`, proving a whole connection lifecycle round-trips: `sim_connect` ->
//! `sim_admit` (a real uplink batch, camera report included) -> `sim_tick` -> `sim_build_frame`
//! (once per connection) -> `sim_disconnect`, with `sim_hash()` readable throughout. Not a `.wasm`
//! test (that is step 3's `host_accepts_ring_connection_and_hashes_match`, under Node): this
//! proves the Rust-side ABI plumbing alone, natively, without a wasm32 build.
//!
//! One `#[test]` only, deliberately: `engine::abi::boot`'s config buffer and
//! `engine::abi::arena`'s reservation counters are process-wide statics (docs/decisions/0014 §4),
//! so two tests in this file racing `engine_init` on the same boot bytes would corrupt each
//! other's config. A second scenario belongs in a second `tests/*.rs` file (each is its own
//! process), not a second `#[test]` here.

use engine::abi::{self, RegionId, Role, Slot, Status};
use engine::bytes::SliceSink;
use engine::game_instance::GameInstance;
use engine::wire::{CameraReport, UplinkWriter};
use fx_puts::Puts;

/// Matches `fixtures/puts/golden/scenario.json`'s own config exactly (same seed, same budgets),
/// so this test's own genesis is directly comparable to that golden's -- not compared here (this
/// is a smoke test, not a golden), but kept consistent on principle.
const CONFIG: &str = concat!(
    r#"{"arenaBytes":100663296,"game":{"#,
    r#""seed":"0x1","params":null,"maxEntities":262144,"#,
    r#""maxModifiedTiles":1048576,"maxActionGrowth":4096,"cacheChunks":1024}}"#
);

/// Writes `CONFIG` into the boot region and calls `engine_init` through the generic `abi::init`
/// (what every role's `extern "C" fn engine_init` forwards to).
fn init_instance() -> Slot<GameInstance<Puts>> {
    let slot: Slot<GameInstance<Puts>> = Slot::new();
    let ptr = abi::boot::ptr();
    let bytes = CONFIG.as_bytes();
    // SAFETY: the boot region is `BOOT_BYTES` (64 KiB) minus nothing yet reserved, far larger than
    // `CONFIG`; this file's single `#[test]` is the only thing that ever touches it.
    unsafe {
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
    }
    assert_eq!(
        abi::init(&slot, Role::Sim as u32, bytes.len() as u32),
        Status::Ok
    );
    slot
}

/// Encodes a real `UplinkBatch` (no actions, no presence, one camera report) and writes it into
/// the `Rx` region through the same pointer the loader would (`abi::region`), returning its byte
/// length for `sim_admit`.
fn write_uplink_camera_report(slot: &Slot<GameInstance<Puts>>, report: CameraReport) -> u32 {
    let mut buf = [0u8; 64];
    let mut sink = SliceSink::new(&mut buf);
    UplinkWriter::write(&mut sink, 0, core::iter::empty(), Some(report), None);
    let n = sink.finish().unwrap();

    let rx_ptr = abi::region(slot, RegionId::Rx as u32);
    let rx_len = abi::region_len(slot, RegionId::Rx as u32);
    assert!(
        !rx_ptr.is_null(),
        "Rx region must be declared by Host::init"
    );
    assert!(n as u32 <= rx_len, "uplink batch must fit SIM_RX_BYTES");
    // SAFETY: `rx_ptr` addresses the `Rx` region, `n <= rx_len` just asserted, and no other code
    // touches this region between export calls (single-threaded instance, 0015).
    unsafe {
        core::ptr::copy_nonoverlapping(buf.as_ptr(), rx_ptr, n);
    }
    n as u32
}

#[test]
fn sim_abi_round_trips_a_connection_lifecycle() {
    let slot = init_instance();

    assert_eq!(abi::sim_genesis(&slot), Status::Ok);
    // A second genesis is rejected, not a silent no-op (Host::sim_genesis's own contract).
    assert_eq!(abi::sim_genesis(&slot), Status::AlreadyInitialised);

    // Before any connection: ticking runs fine, and building a frame for a connection that does
    // not exist writes nothing (never a negative/error return).
    assert_eq!(abi::sim_tick(&slot), Status::Ok);
    assert_eq!(abi::sim_build_frame(&slot, 0), 0);

    assert_eq!(abi::sim_connect(&slot, 0), Status::Ok);

    // The connect is queued, delivered at the next tick; that connection's first frame is a full
    // baseline (Global + OwnPlayer), never empty (`first_frame_pending`).
    assert_eq!(abi::sim_tick(&slot), Status::Ok);
    let first_len = abi::sim_build_frame(&slot, 0);
    assert!(first_len > 0, "first frame after connect must not be empty");

    // A real uplink batch (camera report only) through `Rx`, admitted, then ticked: the
    // subscription set now has a view, so `sim_build_frame` keeps producing real bytes.
    let report = CameraReport {
        center_x: 0,
        center_y: 0,
        half_w: 64,
        half_h: 64,
        vel_x: 0,
        vel_y: 0,
    };
    let n = write_uplink_camera_report(&slot, report);
    assert_eq!(abi::sim_admit(&slot, 0, n), Status::Ok);

    for _ in 0..10 {
        assert_eq!(abi::sim_tick(&slot), Status::Ok);
        let n = abi::sim_build_frame(&slot, 0);
        assert!(n >= 0);
    }

    // `sim_hash` is readable at any point once genesis has run (`Result` region, two LE `u32`s).
    assert_eq!(abi::sim_hash(&slot), Status::Ok);

    assert_eq!(abi::sim_disconnect(&slot, 0), Status::Ok);
    // Once disconnected, building a frame for that connection is "wrote nothing" again, and a
    // second disconnect is a tolerated no-op (never a panic on an already-freed slot).
    assert_eq!(abi::sim_tick(&slot), Status::Ok);
    assert_eq!(abi::sim_build_frame(&slot, 0), 0);
    assert_eq!(abi::sim_disconnect(&slot, 0), Status::Ok);

    // An unknown/out-of-range connection is tolerated by `sim_admit` too (BadLength only past
    // `Rx`'s own capacity, never a range check on `conn` -- untrusted host input never panics).
    assert_eq!(abi::sim_admit(&slot, 999, 0), Status::Ok);
}
