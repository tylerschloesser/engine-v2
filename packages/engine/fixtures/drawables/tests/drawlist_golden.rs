//! `drawlist.fixture_hash_golden` (docs/plan/17-drawlist-and-sprites.md, Tests added): a pure
//! function of replica + camera (0020 §6 layer a) -- build a real, connected `Replica<Drawables>`
//! through `engine::testing::testkit::Loopback` (real wire bytes end to end, the same tool
//! `fixtures/puts` uses for its own connected golden), then `extract` + `sort_into` by hand (no
//! `ClientInstance`/ABI needed for a native test: `client::drawlist`/`client::frame_view` are both
//! `pub`) and hash the result with `engine::testing::assert_golden_hash!`.
//!
//! Also proves `frameview.zoom_matches_camera_block`'s own coverage: crossing
//! [`fx_drawables::SMALL_ZOOM_THRESHOLD`] changes the record count and the hash, and nothing below
//! it does.

use engine::client::{ClientSide, Clocks, DrawList, FrameView};
use engine::game::PlayerId;
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
    let n = dl.sort_into(&mut out, 0.0);
    (n, out)
}

#[test]
fn drawlist_fixture_hash_golden() {
    let lb = connected_client();
    let (n, bytes) = extract_and_sort(&lb, 10.0);
    assert_eq!(
        n, 3,
        "every genesis entity visible below the zoom threshold"
    );
    engine::assert_golden_bytes!(
        "drawables_extract_below_threshold",
        &bytes[..1024 + n as usize * 32]
    );
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
