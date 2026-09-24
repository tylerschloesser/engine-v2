//! `drawlist.fixture_hash_golden` (docs/plan/17-drawlist-and-sprites.md, Tests added; M17 cut-1
//! gate: "native-vs-`.wasm` equality, not self-consistency" -- `tests/golden/drawables_hash.hash`
//! is read by *both* this native test and `tests/wasm/drawlist.test.ts`'s own `drawlist_hash_
//! matches_native_golden`, exactly the `puts_idle_100`/`puts_script_a` shape: one committed golden
//! file, two runtimes). This test drives `GameInstance<Drawables>` directly -- the same generic
//! `Instance` dispatcher `export_game!(Drawables)` points the compiled `.wasm`'s exports at, not a
//! hand-assembled `FrameView` -- so a real bug in the *production* `frame()`/window-origin/visible-
//! rect path (not just `extract` in isolation) shows up here too.
//!
//! `drawlist_zoom_threshold_hides_only_the_small_entity`/`drawlist_fixture_hash_is_pure_function_
//! of_replica_and_camera` (below) keep the lighter `Loopback` + hand-built `FrameView` harness:
//! they only need *a* real replica, not byte-for-byte parity with `.wasm`.

use engine::abi::{Instance, RegionId, RegionLayout, Role, Status};
use engine::client::{CameraBlock, ClientSide, Clocks, DrawList, FrameView};
use engine::game::PlayerId;
use engine::game_instance::GameInstance;
use engine::testing::testkit::Loopback;
use engine::wire::CameraReport;
use engine::world::{CacheCapacity, ChunkDims, TilePos};
use fx_drawables::{Drawables, DrawablesClient, SMALL_ZOOM_THRESHOLD};

struct ZeroSource;
impl engine::world::PristineSource for ZeroSource {
    fn generate(&self, _chunk: engine::world::ChunkCoord, out: &mut [engine::world::Tile]) {
        out.fill(engine::world::Tile::VOID);
    }
}

/// Builds one connected client, wide enough camera to subscribe every fixed genesis entity, and
/// runs enough ticks for the resulting chunk snapshots to land in the replica.
fn connected_client() -> Loopback<Drawables> {
    let mut lb = Loopback::<Drawables>::new(engine::sim::WorldParams {
        seed: 0x1234_5678_9abc_def0,
        worldgen: (),
        max_entities: 64,
        max_modified_tiles: 64,
        max_action_growth: 0,
    });
    let (idx, _player) = lb.add_client(
        0,
        ChunkDims::new(5),
        Box::new(ZeroSource),
        CacheCapacity::Chunks(128),
    );
    lb.set_camera(
        idx,
        CameraReport {
            center_x: 0,
            center_y: 0,
            half_w: 40,
            half_h: 40,
            vel_x: 0,
            vel_y: 0,
        },
    );
    lb.run(10);
    lb
}

fn extract_and_sort(lb: &Loopback<Drawables>, zoom: f32) -> (u32, Vec<u8>) {
    let replica = lb.client(0).view();
    let clocks = Clocks {
        authoritative: replica.tick(),
        predicted: replica.tick(),
        tick_fraction: 0.0,
        ticks_per_second: 20,
    };
    let view = FrameView::new(
        replica as &dyn engine::game::WorldRead<Drawables>,
        clocks,
        PlayerId(1),
        replica.entities_map(),
        replica.registry(),
        engine::world::TileRect::new(TilePos::new(-42, -42), TilePos::new(42, 42)),
        zoom,
        0.0,
        None,
        TilePos::new(0, 0),
        0.0,
    );
    let mut dl = DrawList::new();
    dl.begin_frame(TilePos::new(0, 0));
    DrawablesClient.extract(&view, &mut dl);
    let mut out = vec![0u8; engine::client::drawlist::REGION_BYTES];
    let n = dl.sort_into(&mut out, 0.0, None);
    (n, out)
}

const GAME_CFG: &str = r#"{"seed":"0x1234567890abcdef","params":null}"#;

/// The exact camera `tests/wasm/drawlist.test.ts`'s own `simConfig`/`CameraState` build: centre
/// `(0, 0)`, `tilesAcross` 10 (below `SMALL_ZOOM_THRESHOLD`), half extent `(40, 40)`, no cursor.
/// Any divergence here (a different centre, a different `tilesAcross`) would change `window_origin`
/// or `visible()` on one side only -- exactly the class of bug this pairing exists to catch.
fn shared_camera() -> CameraBlock {
    let mut camera = CameraBlock::for_test([0.0, 0.0], [0.0, 0.0], [40.0, 40.0]);
    camera.tiles_across = 10.0;
    camera
}

/// Drives `GameInstance<Drawables>` (sim + client) through the *real* `Instance` methods
/// `export_game!`'s `.wasm` exports also call -- `frame`/`on_frame`/`client_poll_uplink`/
/// `sim_admit`/`sim_tick`/`sim_build_frame` -- with no ring/SAB plumbing (direct byte hand-off,
/// same simplification `tests/wasm/drawlist.test.ts` makes; nothing about a ring is under test
/// here either). Returns the client's own `RegionLayout` (alive for the caller to read
/// `RegionId::DrawList` out of) and the record count `frame()` last produced.
fn drive_real_game_instance() -> (RegionLayout, u32) {
    let mut sim_layout = RegionLayout::new();
    let mut sim = GameInstance::<Drawables>::init(Role::Sim, GAME_CFG, &mut sim_layout).unwrap();
    assert_eq!(sim.sim_genesis(), Status::Ok);
    assert_eq!(sim.sim_connect(0), Status::Ok);

    let mut client_layout = RegionLayout::new();
    let mut client =
        GameInstance::<Drawables>::init(Role::Client, GAME_CFG, &mut client_layout).unwrap();
    let camera = shared_camera();

    let mut uplink_buf = [0u8; 4096];
    let mut downlink_buf = [0u8; 65536];
    for _ in 0..8 {
        assert_eq!(client.frame(0.0, &camera, &mut []), Status::Ok);
        let up_len = client.client_poll_uplink(0, &mut uplink_buf);
        if up_len > 0 {
            assert_eq!(sim.sim_admit(0, &uplink_buf[..up_len]), Status::Ok);
        }
        assert_eq!(sim.sim_tick(), Status::Ok);
        if let Ok(down_len) = sim.sim_build_frame(0, &mut downlink_buf)
            && down_len > 0
        {
            assert_eq!(
                client.on_frame(&downlink_buf[..down_len as usize]),
                Status::Ok
            );
        }
    }
    // The real frame this test asserts over: `extract` must see every genesis entity by now.
    assert_eq!(client.frame(0.0, &camera, &mut []), Status::Ok);
    let record_count = client.drawlist_len();
    (client_layout, record_count)
}

#[test]
fn drawlist_fixture_hash_golden() {
    let (client_layout, n) = drive_real_game_instance();
    assert_eq!(
        n, 3,
        "every genesis entity visible below the zoom threshold"
    );
    let region = client_layout.bytes(RegionId::DrawList);
    let hash = engine::client::drawlist::hash_region(region, n);
    engine::assert_golden_hash!("drawables_hash", hash);
}

#[test]
fn drawlist_zoom_threshold_hides_only_the_small_entity() {
    let lb = connected_client();
    let (below, _) = extract_and_sort(&lb, SMALL_ZOOM_THRESHOLD - 1.0);
    let (at, _) = extract_and_sort(&lb, SMALL_ZOOM_THRESHOLD);
    let (above, _) = extract_and_sort(&lb, SMALL_ZOOM_THRESHOLD + 1.0);
    assert_eq!(below, 3);
    assert_eq!(at, 3, "the threshold itself is inclusive (`>`, not `>=`)");
    assert_eq!(above, 2, "only the one small entity is skipped");
}

#[test]
fn drawlist_fixture_hash_is_pure_function_of_replica_and_camera() {
    let lb_a = connected_client();
    let lb_b = connected_client();
    let (na, bytes_a) = extract_and_sort(&lb_a, 10.0);
    let (nb, bytes_b) = extract_and_sort(&lb_b, 10.0);
    assert_eq!(na, nb);
    assert_eq!(
        bytes_a, bytes_b,
        "same replica-building script + same camera => byte-identical"
    );
}

/// Fix round 1 (docs/plan/17-drawlist-and-sprites.md, coordinator review): the version of this test
/// that used to live in `crates/engine/src/client/frame_view.rs` built a `FrameView` by hand and
/// read `zoom()` straight back -- it proved the accessor exists, never the *wiring*
/// (`game_instance.rs`'s `camera_view.zoom = camera.tiles_across`, `px_per_tile` derived from
/// `camera.viewport_px`). This version drives a real `GameInstance<Drawables>` (sim + client)
/// through the actual `Instance::frame` ABI method, with a real `CameraBlock` whose `tiles_across`
/// crosses `SMALL_ZOOM_THRESHOLD` -- `drawlist_len()` (fx-drawables' own zoom-skip logic in
/// `extract`) is the observable proxy for `zoom()`'s wiring, and `LAST_PX_PER_TILE` (a thread-local
/// `extract` records every call, module doc comment there) is the observable proxy for
/// `px_per_tile()`'s. Self-contained rather than reusing `drive_real_game_instance` (deliberately
/// not refactored: that function's own `RegionLayout`/`GameInstance` lifetime shape is exactly
/// right for the golden test and not worth risking for this one).
#[test]
fn frameview_zoom_matches_camera_block() {
    use fx_drawables::LAST_PX_PER_TILE;

    let mut sim_layout = RegionLayout::new();
    let mut sim = GameInstance::<Drawables>::init(Role::Sim, GAME_CFG, &mut sim_layout).unwrap();
    assert_eq!(sim.sim_genesis(), Status::Ok);
    assert_eq!(sim.sim_connect(0), Status::Ok);

    let mut client_layout = RegionLayout::new();
    let mut client =
        GameInstance::<Drawables>::init(Role::Client, GAME_CFG, &mut client_layout).unwrap();

    // Warm-up camera: only `centre`/`half_extent_tiles` matter for subscription (0010), so
    // `tiles_across`/`viewport_px` here are irrelevant to which entities land in the replica --
    // varied for real only in the loop below, after every genesis entity is already resident.
    let warmup_camera = shared_camera();
    let mut uplink_buf = [0u8; 4096];
    let mut downlink_buf = [0u8; 65536];
    for _ in 0..8 {
        assert_eq!(client.frame(0.0, &warmup_camera, &mut []), Status::Ok);
        let up_len = client.client_poll_uplink(0, &mut uplink_buf);
        if up_len > 0 {
            assert_eq!(sim.sim_admit(0, &uplink_buf[..up_len]), Status::Ok);
        }
        assert_eq!(sim.sim_tick(), Status::Ok);
        if let Ok(down_len) = sim.sim_build_frame(0, &mut downlink_buf)
            && down_len > 0
        {
            assert_eq!(
                client.on_frame(&downlink_buf[..down_len as usize]),
                Status::Ok
            );
        }
    }

    // The real device-pixel viewport (`CameraBlock::viewport_px`, steps 4-6 Deviations
    // "`px_per_tile()` wired for real"): fixed across every zoom level below, matching a page that
    // never resizes mid-check.
    // Taller than wide, deliberately: `viewport_px[1]` (not `[0]`) is the max, so a formula that
    // drops the `.max()` and reads only `viewport_px[0]` disagrees with the real one.
    const VIEWPORT_PX: [f32; 2] = [450.0, 800.0];
    let mut camera = warmup_camera;
    camera.viewport_px = VIEWPORT_PX;

    for (tiles_across, want_count, label) in [
        (SMALL_ZOOM_THRESHOLD - 1.0, 3u32, "below"),
        (SMALL_ZOOM_THRESHOLD, 3u32, "at (inclusive: `>`, not `>=`)"),
        (SMALL_ZOOM_THRESHOLD + 1.0, 2u32, "above"),
    ] {
        camera.tiles_across = tiles_across;
        assert_eq!(client.frame(0.0, &camera, &mut []), Status::Ok);
        assert_eq!(
            client.drawlist_len(),
            want_count,
            "record count at tiles_across={tiles_across} ({label})"
        );
        let want_px_per_tile = VIEWPORT_PX[0].max(VIEWPORT_PX[1]) / tiles_across;
        assert_eq!(
            LAST_PX_PER_TILE.with(|c| c.get()),
            want_px_per_tile,
            "px_per_tile() at tiles_across={tiles_across}"
        );
    }
}
