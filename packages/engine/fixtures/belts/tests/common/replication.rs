//! M48: replication robustness on `fx-belts` through real frames (`engine::testing::testkit::
//! Loopback`: `Host` -> `build_frame` -> `ClientCore::on_frame`). A module of `bench_belts.rs`
//! (`#[path]`), not a test binary of its own.
//!
//! - `region_hash_agrees_after_same_tick_spawn_despawn`: a request entity is spawned by `apply` and
//!   despawned by the same tick's `Belts::tick` (the request pattern); the host's chunk version must
//!   not move for it, since no replica ever sees it.
//! - `host_degraded_bundles_carry_forecasts`: a degraded connection's bundles of held frames carry
//!   every tick's forecasts, in order, on a saturated-view world.

use engine::game::{Game, WorldRead};
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::transport::TransportRead;
use engine::wire::CameraReport;
use engine::world::{CacheCapacity, ChunkCoord, ChunkDims, PristineSource};
use engine::worldgen::Pristine;
use fx_belts::{Action, Belts, BeltsParams, Dir, FlatWorldgen, Op, Pos};

fn params(max_lines: u32, max_items: u32) -> WorldParams<Belts> {
    WorldParams {
        seed: 1,
        worldgen: BeltsParams::default(),
        max_entities: 4_096,
        max_modified_tiles: 4_096,
        max_action_growth: 4_096,
        max_lines,
        max_items,
    }
}

fn source() -> Box<dyn PristineSource> {
    Box::new(Pristine::<FlatWorldgen>::new(1, BeltsParams::default()))
}

fn camera(x: i32, y: i32, half: u16) -> CameraReport {
    CameraReport {
        center_x: x,
        center_y: y,
        half_w: half,
        half_h: half,
        vel_x: 0,
        vel_y: 0,
    }
}

/// M48 (the chunk-version stamp): the netcode `belts/*` scenarios kept their lines 200 tiles from
/// the origin because every request entity is anchored at the origin chunk and is spawned and gone
/// in one tick, which moved the host's version of that chunk and not the replica's, so the region
/// hashes differed while the chunk hashes agreed (and a resume hint re-sent the chunk). A client
/// holds the origin chunk while lines are built, linked, fed and edited there through requests,
/// one or more a tick for 40 ticks: on every tick the host's region hash equals the replica's and
/// the origin chunk's version is the same on both sides (the resume hint's keep rule,
/// `session::resume::diff_resume_hint`, keeps a chunk iff the versions are equal). The spawner and
/// the tally the requests become stay at the origin, so the chunk's version does move (pinned).
#[test]
fn region_hash_agrees_after_same_tick_spawn_despawn() {
    let mut lb = Loopback::<Belts>::new(params(64, 1_024));
    let (c, who) = lb.add_client(
        0,
        ChunkDims::new(Belts::CHUNK_BITS),
        source(),
        CacheCapacity::Unlimited,
    );
    lb.set_camera(c, camera(8, 8, 24));
    lb.run(3);
    let origin = ChunkCoord { x: 0, y: 0 };
    let chain = |x: i32, y: i32| Op::Chain {
        from: Pos { x, y },
        dir: Dir::East,
        tiles: 6,
        speed: 24,
        items_at_rest: [(0, 0); 8],
    };
    let script: [&[Op]; 6] = [
        &[chain(2, 2), chain(2, 4)],
        &[Op::Link {
            from_line: 0,
            to_line: 1,
        }],
        &[Op::Sink { line: 1 }],
        &[Op::Spawner {
            line: 0,
            item: 3,
            period: 300,
        }],
        &[Op::Speed { line: 1, speed: 48 }],
        &[Op::Insert {
            line: 1,
            pos: 100,
            item: 2,
        }],
    ];
    let mut moved = 0u32;
    let mut last = lb.host.debug_version(origin);
    for t in 0..40 {
        if let Some(ops) = script.get(t / 2).filter(|_| t % 2 == 0) {
            for op in ops.iter() {
                lb.action(who, Action::Request(*op));
            }
        }
        lb.step();
        let conn = lb.conn(c);
        assert_eq!(
            lb.host.region_hash(conn),
            lb.client(c).region_hash(),
            "step {t}: region hashes differ (host version {}, replica {})",
            lb.host.debug_version(origin),
            lb.client(c).replica().debug_version(origin)
        );
        assert_eq!(
            lb.host.debug_version(origin),
            lb.client(c).replica().debug_version(origin),
            "step {t}: the origin chunk's version"
        );
        let v = lb.host.debug_version(origin);
        if v != last {
            moved += 1;
            last = v;
        }
    }
    let t = lb.host.sim().unwrap().authority().store().transport();
    assert_eq!(t.lines_len(), 2, "the requests built their lines");
    assert_eq!(moved, 17, "ticks the origin chunk's version moved");
}

type Items = Vec<(u16, u32)>;

/// Every line's items on the host now, by id.
fn host_lines(lb: &Loopback<Belts>) -> std::collections::BTreeMap<u32, Items> {
    let t = lb.host.sim().unwrap().authority().store().transport();
    let mut m = std::collections::BTreeMap::new();
    for id in 1..t.next_id() {
        let mut v = Vec::new();
        if t.items_in(engine::transport::LineId(id), &mut |i, p| v.push((i.0, p)))
            .is_ok()
        {
            m.insert(id, v);
        }
    }
    m
}

/// The frames of one message (a lone frame or a `FrameBundle`), in wire order.
fn frames_of(msg: &[u8]) -> Vec<Vec<u8>> {
    use engine::wire::{BundleReader, MsgType};
    if msg[0] == MsgType::FrameBundle as u8 {
        let mut b = BundleReader::new(msg).unwrap();
        let mut v = Vec::new();
        while let Some(f) = b.next_frame().unwrap() {
            v.push(f.to_vec());
        }
        v
    } else {
        vec![msg.to_vec()]
    }
}

fn frame_tick(frame: &[u8]) -> u32 {
    engine::wire::FrameReader::new(frame).unwrap().header().tick
}

/// M48 (0010 degrade, 0078 A8): a degraded connection gets every tick's frame, held whole and sent
/// late in a `FrameBundle` (never dropped or coalesced), so forecasts survive degrade if the
/// bundles apply in order and the follower steps the ticks no frame came for. M44b's
/// `SaturatedView` world at 1/64 (every sink of a fifth of the lanes toggling every 20 ticks), one
/// client seeing all of it, chunk pacing on; the soft cap is cut to 200 B/s for 200 ticks
/// (degrade: level 2, then 4 after 2 s over the cap) and then lifted (recovery: 4, 2, 1 after 2 s
/// of calm each). Every delivered message's frames are tick-ascending; each frame is applied
/// (`ClientCore::on_frame`, which steps the follower to the frame's tick first), and after each
/// one every line the client holds has the host's items of that tick exactly; no desync.
#[test]
fn host_degraded_bundles_carry_forecasts() {
    use engine::host::pacing::BandwidthConfig;
    use fx_belts::{BenchRegime, BenchSpec};
    const RUN: u32 = 600;
    let spec = BenchSpec {
        seed: 7,
        scale: 64,
        regime: BenchRegime::SaturatedView {
            jam_pct: 20,
            period: 20,
            speed: 0,
        },
    };
    let world = fx_belts::bench::world_of(spec);
    let mut lb = Loopback::<Belts>::new(WorldParams {
        worldgen: BeltsParams { bench: Some(spec) },
        ..params(engine::transport::DEFAULT_MAX_LINES, 393_216)
    });
    let (c, _who) = lb.add_client(
        0,
        ChunkDims::new(Belts::CHUNK_BITS),
        Box::new(Pristine::<FlatWorldgen>::new(
            1,
            BeltsParams { bench: Some(spec) },
        )),
        CacheCapacity::Unlimited,
    );
    let (w, h) = (world.width as i32, world.height as i32);
    lb.set_camera(c, camera(w / 2, h / 2, 128));
    let conn = lb.conn(c);
    let mut buf = vec![0u8; 64 * 1024];
    let mut history: std::collections::VecDeque<(u32, std::collections::BTreeMap<u32, Items>)> =
        std::collections::VecDeque::new();
    let (mut levels, mut bundles, mut frames_in_bundles) = (0u32, 0u64, 0u64);
    let (mut compared, mut items, mut unknown) = (0u64, 0u64, 0u64);
    let mut last_tick = 0u32;
    let mut total_bytes = 0u64;
    for step in 0..RUN {
        if step == 100 {
            lb.host.set_conn_bandwidth(
                conn,
                BandwidthConfig {
                    soft_cap_bytes_per_s: 200,
                    ..BandwidthConfig::default()
                },
            );
        }
        if step == 300 {
            lb.host.set_conn_bandwidth(conn, BandwidthConfig::default());
        }
        lb.host.tick();
        let tick = lb.host.sim().unwrap().tick().0 - 1;
        history.push_back((tick, host_lines(&lb)));
        if history.len() > 8 {
            history.pop_front();
        }
        let n = lb.host.build_frame(conn, &mut buf);
        lb.host.seal();
        levels |= 1 << lb.host.pacing_counters(conn).unwrap().degrade_level;
        if n == 0 {
            continue;
        }
        total_bytes += n as u64;
        let frames = frames_of(&buf[..n]);
        if frames.len() > 1 {
            bundles += 1;
            frames_in_bundles += frames.len() as u64;
        }
        for f in &frames {
            let t = frame_tick(f);
            assert!(
                t > last_tick || last_tick == 0,
                "step {step}: frame {t} after {last_tick}"
            );
            last_tick = t;
            lb.client_mut(c).on_frame(f).expect("a host frame applies");
            let r = lb.client(c).replica();
            assert_eq!(
                r.forecast_tick(),
                Some(t),
                "step {step}: the follower's tick"
            );
            let (_, host) = history
                .iter()
                .find(|(ht, _)| *ht == t)
                .expect("the frame's tick is recent");
            let mut held = Vec::new();
            r.structures(|p| held.push(p.id));
            for l in held {
                if r.forecast_unknown(l) {
                    unknown += 1;
                    continue;
                }
                let mut v = Vec::new();
                r.transport()
                    .items_in(l, &mut |i, p| v.push((i.0, p)))
                    .unwrap();
                assert_eq!(
                    Some(&v),
                    host.get(&l.0),
                    "step {step}: tick {t}: line {l:?}: client vs host"
                );
                compared += 1;
                items += v.len() as u64;
            }
        }
    }
    let end_level = lb.host.pacing_counters(conn).unwrap().degrade_level;
    if std::env::var_os("MEASURE").is_some() {
        println!(
            "degraded: levels {levels:#b}, end level {end_level}, {bundles} bundles of \
             {frames_in_bundles} frames, {compared} line-ticks compared ({items} items), {unknown} unknown, {total_bytes} B, desyncs {}",
            lb.client(c).desyncs().count()
        );
    }
    assert_eq!(levels, 0b10110, "degrade levels seen (1, 2, 4)");
    assert_eq!(end_level, 1, "recovered");
    // M49 (0078 A12 revised): a line holder gets a frame every tick (header-only when nothing
    // changed), so more ticks bring a frame to hold and compare: (72, 204) and (24,341, 1,844,315)
    // before; and a hold keeps the latest header-only frame instead of dropping it (fix round 2), (82,
    // 244) and (30,875, 2,338,827) before that.
    assert_eq!(
        (bundles, frames_in_bundles),
        (90, 280),
        "bundles and their frames"
    );
    assert_eq!(
        (compared, items),
        (32_387, 2_453_298),
        "line-ticks and items compared"
    );
    assert_eq!(unknown, 0, "line-ticks skipped as `forecast_unknown`");
    assert_eq!(lb.client(c).desyncs().count(), 0, "client desyncs");
}
