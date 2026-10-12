//! M49: items drawn on the item clock (docs/decisions/0078 A12), through `fx-belts`' client
//! (`src/client.rs`: `transport::draw::draw_items` with the fixture style).
//!
//! - `drawlist_belts_hash_golden`: a real `GameInstance<Belts>` pair (sim + client, the
//!   `fx-drawables` driver's shape: `frame`, `client_poll_uplink`, `sim_admit`, `sim_tick`,
//!   `sim_build_frame`, `on_frame`) on the 1/64 `SaturatedView { jam_pct: 20, period: 20 }` world for
//!   16 ticks, the frame time advanced 50 ms a tick, then one frame at 15 x 50 + 25 ms (the item
//!   clock half a tick past the follower's tick), the camera on the stream.
//!   `tests/golden/drawlist_belts_hash.hash` is read by this test and by `tests/wasm/drawlist.test.ts`'s
//!   `drawlist_belts_hash_matches_native_golden`, which drives the same steps through the raw ABI.
//! - `no_alloc_drawlist_belts_2000_items`: the same driver on the gc page's world (1/32
//!   `SaturatedView { 0, 0 }`, about 2,000 items in view): `frame` (extract with every item drawn,
//!   then the sort) allocates nothing, summed over 300 frames between ticks. This binary's
//!   allocator is `fx_belts`' own `Arena` (`export_game!` installs it), so `thread_live_bytes`
//!   counts (`no_alloc_*`'s instrument, net bytes).
//! - `slow_draw_items_time`: the native time of `draw_items` per 1,000 items drawn (M50), on the
//!   `Mixed` 1/64 world's centre view and on the gc page's world; reported, not gated.

use std::cell::Cell;

use engine::abi::{Instance, RegionId, RegionLayout, Role, Status};
use engine::client::CameraBlock;
use engine::game_instance::GameInstance;
use engine::transport::draw::DrawItemsStats;
use fx_belts::Belts;
use fx_belts::client::LAST_STATS;

/// The golden's world: `fx-belts`' 1/64 `SaturatedView` at (20 %, 20), the netcode arbiter's caps.
const GOLDEN_CFG: &str = r#"{"seed":"0x7","params":{"bench":{"seed":7,"scale":64,"regime":{"SaturatedView":{"jam_pct":20,"period":20}}}},"maxLines":4096,"maxItems":16384,"unpaced":true}"#;
/// The gc page's world (`gc-belts.ts`): 1/32 `SaturatedView` with no jam, 4 rows of 256 tiles.
const GC_CFG: &str = r#"{"seed":"0x7","params":{"bench":{"seed":7,"scale":32,"regime":{"SaturatedView":{"jam_pct":0,"period":0}}}},"maxLines":4096,"maxItems":16384,"unpaced":true}"#;

/// `buildAttachInput` (`src/host/handshake.ts`): player 1 (varint), epoch 1 (`u32` LE), joined,
/// connected logged, no presence, no Hello tail (no camera yet: the first uplink brings it).
const ATTACH: [u8; 8] = [1, 1, 0, 0, 0, 1, 0, 0];

/// The golden's camera (`drawlist.test.ts` writes the same): centre `(128, 1)` on the two rows,
/// half extent `(20, 8)`, 40 tiles across an 800 x 320 viewport (20 px a tile).
fn golden_camera() -> CameraBlock {
    let mut c = CameraBlock::for_test([128.0, 1.0], [0.0, 0.0], [20.0, 8.0]);
    c.tiles_across = 40.0;
    c.viewport_px = [800.0, 320.0];
    c
}

/// The gc page's view: 64 tiles across the four rows (20 px a tile).
fn gc_camera() -> CameraBlock {
    let mut c = CameraBlock::for_test([128.0, 2.0], [0.0, 0.0], [32.0, 4.0]);
    c.tiles_across = 64.0;
    c.viewport_px = [1280.0, 160.0];
    c
}

/// A sim and a client `GameInstance<Belts>` joined by direct byte hand-off (no ring), each buffer
/// the size of the `.wasm`'s region it stands for (`Tx`), so a frame is cut where the `.wasm`'s is.
struct Driver {
    sim: GameInstance<Belts>,
    client: GameInstance<Belts>,
    client_layout: RegionLayout,
    camera: CameraBlock,
    up: Vec<u8>,
    down: Vec<u8>,
}

impl Driver {
    fn new(cfg: &str, camera: CameraBlock) -> Self {
        let mut sim_layout = RegionLayout::new();
        let mut sim = GameInstance::<Belts>::init(Role::Sim, cfg, &mut sim_layout).unwrap();
        assert_eq!(sim.sim_genesis(), Status::Ok);
        let mut client_layout = RegionLayout::new();
        let mut client =
            GameInstance::<Belts>::init(Role::Client, cfg, &mut client_layout).unwrap();
        let mut down = vec![0u8; sim_layout.bytes(RegionId::Tx).len()];
        let up = vec![0u8; client_layout.bytes(RegionId::Tx).len()];
        // The handshake, as the server's: the attach input names the player, and the client takes
        // the `Welcome` (the replica reserves the world's transport caps there).
        let n = sim.sim_attach(0, &ATTACH, &mut down).unwrap() as usize;
        let mut result = [0u8; 64];
        assert_eq!(
            client.client_on_welcome(&down[..n], 0.0, &mut result),
            Status::Ok
        );
        Driver {
            sim,
            client,
            client_layout,
            camera,
            up,
            down,
        }
    }

    /// One client frame at frame time `t_ms`.
    fn frame(&mut self, t_ms: f64) {
        self.camera.frame_time_ms = t_ms;
        assert_eq!(self.client.frame(t_ms, &self.camera, &mut []), Status::Ok);
    }

    /// A client frame at `t_ms`, then one sim tick (the frame's uplink admitted first) and its frame
    /// to the client.
    fn tick(&mut self, t_ms: f64) {
        self.frame(t_ms);
        let up_len = self.client.client_poll_uplink(0, &mut self.up);
        if up_len > 0 {
            assert_eq!(self.sim.sim_admit(0, &self.up[..up_len]), Status::Ok);
        }
        assert_eq!(self.sim.sim_tick(), Status::Ok);
        if let Ok(n) = self.sim.sim_build_frame(0, &mut self.down)
            && n > 0
        {
            assert_eq!(self.client.on_frame(&self.down[..n as usize]), Status::Ok);
        }
    }
}

fn last_stats() -> DrawItemsStats {
    LAST_STATS.with(Cell::get)
}

/// The golden (module doc): 16 ticks, 50 ms apart, then the frame it pins at 775 ms.
#[test]
fn drawlist_belts_hash_golden() {
    let mut d = Driver::new(GOLDEN_CFG, golden_camera());
    for k in 0..16 {
        d.tick(50.0 * f64::from(k));
    }
    d.frame(15.0 * 50.0 + 25.0);
    let n = d.client.drawlist_len();
    assert_eq!(
        last_stats(),
        DrawItemsStats {
            lines: 18,
            items: 720,
            culled: 384,
            too_small: false
        },
        "the golden frame's stats"
    );
    assert_eq!(n, 720, "one record per item drawn");
    let hash = engine::client::drawlist::hash_region(d.client_layout.bytes(RegionId::DrawList), n);
    engine::assert_golden_hash!("drawlist_belts_hash", hash);
}

/// The no-alloc case (module doc): about 2,000 items in view, `frame` net zero bytes.
#[test]
fn no_alloc_drawlist_belts_2000_items() {
    let live = engine::abi::arena::thread_live_bytes;
    let mut d = Driver::new(GC_CFG, gc_camera());
    // The join, then a warm frame loop: four 12.5 ms frames a tick, as the page drives.
    let mut t = 0.0;
    for _ in 0..30 {
        d.tick(t);
        for _ in 0..3 {
            t += 12.5;
            d.frame(t);
        }
        t += 12.5;
    }
    let mut frame_bytes = 0isize;
    let mut frames = 0u32;
    for _ in 0..75 {
        d.tick(t);
        for _ in 0..4 {
            t += 12.5;
            let before = live();
            d.frame(t);
            frame_bytes += live() - before;
            frames += 1;
        }
    }
    assert_eq!(frames, 300);
    assert_eq!(
        last_stats(),
        DrawItemsStats {
            lines: 34,
            items: 2_200,
            culled: 894,
            too_small: false
        },
        "the last measured frame's stats"
    );
    assert_eq!(
        frame_bytes, 0,
        "frame (extract + sort) with items in view allocates: {frame_bytes} B over 300 frames"
    );
}

/// One view of a bench world for the extract time: the world, the camera (centre, half extent).
struct TimedView {
    label: &'static str,
    spec: fx_belts::BenchSpec,
    centre: (i32, i32),
    half: (u16, u16),
}

/// The median over 5 batches of `draw_items` (200 calls each) on `v`'s replica after 40 ticks, in
/// ns per call, and the items one call draws.
#[allow(clippy::disallowed_types)] // a bench's own timer never reaches state (0002 section 2)
fn time_draw_items(v: &TimedView) -> (f64, u32) {
    use engine::client::{Clocks, DrawList, FrameView};
    use engine::game::{Game, PlayerId, WorldRead};
    use engine::sim::WorldParams;
    use engine::testing::testkit::Loopback;
    use engine::transport::draw::draw_items;
    use engine::wire::CameraReport;
    use engine::world::{CacheCapacity, ChunkDims, TilePos, TileRect};
    use engine::worldgen::Pristine;
    use fx_belts::client::FixtureStyle;
    use fx_belts::{BeltsParams, FlatWorldgen};

    let worldgen = BeltsParams {
        bench: Some(v.spec),
    };
    let mut lb = Loopback::<Belts>::new(WorldParams {
        seed: 7,
        worldgen,
        max_entities: 65_536,
        max_modified_tiles: 4_096,
        max_action_growth: 4_096,
        max_lines: engine::transport::DEFAULT_MAX_LINES,
        max_items: 393_216,
    });
    let (c, _) = lb.add_client(
        0,
        ChunkDims::new(Belts::CHUNK_BITS),
        Box::new(Pristine::<FlatWorldgen>::new(7, worldgen)),
        CacheCapacity::Unlimited,
    );
    lb.set_camera(
        c,
        CameraReport {
            center_x: v.centre.0,
            center_y: v.centre.1,
            half_w: v.half.0,
            half_h: v.half.1,
            vel_x: 0,
            vel_y: 0,
        },
    );
    lb.run(40);
    let replica = lb.client(c).view();
    let t = replica.forecast_transport();
    let tick = f64::from(t.forecast_tick().expect("a forecast frame"));
    let clocks = Clocks {
        authoritative: replica.tick(),
        predicted: replica.tick(),
        tick_fraction: 0.0,
        ticks_per_second: 20,
        lead: engine::time::Ticks(0),
        correction: 0.0,
    };
    let (hw, hh) = (i32::from(v.half.0) + 2, i32::from(v.half.1) + 2);
    let view = FrameView::new(
        replica as &dyn WorldRead<Belts>,
        clocks,
        PlayerId(1),
        replica.entities_map(),
        replica.registry(),
        TileRect::new(
            TilePos::new(v.centre.0 - hw, v.centre.1 - hh),
            TilePos::new(v.centre.0 + hw, v.centre.1 + hh),
        ),
        64.0,
        20.0,
        None,
        TilePos::new(0, 0),
        0.0,
        (),
        replica.remote_presences(),
    )
    .with_transport(t, tick + 0.5);
    let mut dl = DrawList::new();
    let mut batches = [0f64; 5];
    let mut items = 0;
    for b in &mut batches {
        let start = std::time::Instant::now();
        for _ in 0..200 {
            dl.begin_frame(TilePos::new(0, 0));
            items = std::hint::black_box(draw_items(&view, &FixtureStyle, &mut dl)).items;
        }
        *b = start.elapsed().as_nanos() as f64 / 200.0;
    }
    batches.sort_by(|a, b| a.partial_cmp(b).expect("finite times"));
    println!("{}: {:?} ns per call", v.label, batches);
    (batches[2], items)
}

/// M50's input (module doc): `draw_items` per 1,000 items drawn, release build, reported, not gated
/// (the `BENCH_SAMPLE` is empty). Each view prints `draw_items <label>: <ns per 1,000 items>`.
#[test]
fn slow_draw_items_time() {
    if cfg!(debug_assertions) {
        let _ = engine::testing::bench::run_in_release(
            "fx-belts",
            "drawlist_belts",
            "slow_draw_items_time",
        );
        return;
    }
    use fx_belts::{BenchRegime, BenchSpec};
    let views = [
        // The `Mixed` world's centre view at 1/64 (M41's 256 x 144 viewport around its centre).
        TimedView {
            label: "Mixed 1/64 centre",
            spec: BenchSpec {
                seed: 7,
                scale: 64,
                regime: BenchRegime::Mixed,
            },
            centre: {
                let w = fx_belts::bench::world_of(BenchSpec {
                    seed: 7,
                    scale: 64,
                    regime: BenchRegime::Mixed,
                });
                ((w.width / 2) as i32, (w.height / 2) as i32)
            },
            half: (128, 72),
        },
        // The gc page's world and view (`gc-belts.ts`).
        TimedView {
            label: "SaturatedView 1/32 (gc page)",
            spec: BenchSpec {
                seed: 7,
                scale: 32,
                regime: BenchRegime::SaturatedView {
                    jam_pct: 0,
                    period: 0,
                    speed: 0,
                },
            },
            centre: (128, 2),
            half: (30, 8),
        },
    ];
    for v in &views {
        let (ns, items) = time_draw_items(v);
        println!(
            "draw_items {}: {:.0} ns per 1,000 items ({} items, {:.0} ns per call)",
            v.label,
            ns * 1000.0 / f64::from(items.max(1)),
            items,
            ns
        );
    }
    println!("BENCH_SAMPLE {{}}");
}
