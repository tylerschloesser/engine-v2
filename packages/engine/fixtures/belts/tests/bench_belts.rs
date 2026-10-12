//! M45: the transport at Tyler's scale. M40's standard `Mixed` world (seed 7: 3,810 lines, 50,000
//! belt tiles, 250,000 items, `speed = 24`) built at genesis by `fx_belts::bench`, at 0076 §8's
//! recommended caps (32,768 lines, 262,144 items).
//!
//! - `slow_tick_belts_large` (gated, `baselines/belts-tick.json`, limit 5 ms median: Tyler,
//!   2026-10-11): a `Host<Belts>` with eight connections holding maximum views
//!   (`common/bench_host.rs`, M36's shape), 200 warm-up then 1,200 measured ticks; a tick is admit
//!   (no actions) + `seal` + `tick` + `build_frame` x 8. `advanceMedianMs` is the transport
//!   advance alone, read from `engine::bench_phase` (the `Transport` mark; the dev-dependency on
//!   `engine` turns `bench-phases` on for this binary).
//! - `slow_snapshot_belts_large` (reported): the whole store's snapshot encode and decode, time
//!   and bytes, and the transport section's share, against M36's `SNAPSHOT_PROXY_MS`.
//! - Fast: `bench_world_at_genesis_is_deterministic` (1/64 scale), `transport_phone_caps_fit_split`
//!   (M57's phone candidates), `transport_budget_exceeds_arena_is_clean`; M48's
//!   `belts_restore_keeps_spawner_schedules` (1/64, saved and restored through `sim_restore_*`)
//!   and the `replication` module's `Loopback` tests (`common/replication.rs`:
//!   `region_hash_agrees_after_same_tick_spawn_despawn`, `host_degraded_bundles_carry_forecasts`).
//!
//! The slow nextest profile builds the dev profile, so each slow test re-runs itself in release
//! (`engine::testing::bench::run_in_release`, one `BENCH_SAMPLE <json>` line) and the outer run
//! hands the sample to `scripts/lib/bench-gate.mjs` (`gate`): the 25 % rule and the limit apply
//! only on the baseline machine; every run is recorded to `test-results/rust/bench/`.

#[path = "common/bench_host.rs"]
mod bench_host;
#[path = "common/props.rs"]
mod props_world;
/// M48's `Loopback` replication tests (a module here, not a binary of its own).
#[path = "common/replication.rs"]
mod replication;

use bench_host::{BenchHost, PLAYERS, SEED, params, world_of};
use engine::abi::Instance;
use engine::game::Game;
use engine::sim::Sim;
use engine::testing::bench::{gate, run_in_release};
use engine::transport::{LineId, Transport, TransportRead};
use fx_belts::{Belts, BenchRegime, BenchSpec, Dir, Op, Pos, Thing};

/// 0020 section 9: 1,200 ticks after 200 warm-up ticks.
const WARMUP: u32 = 200;
const MEASURED: u32 = 1_200;
/// M36 (`bench_large_save.rs`): 0005 "Idle pause" five ticks per wakeup, a third of that window
/// for the desktop (0018 section 9's phone factor).
const SNAPSHOT_PROXY_MS: f64 = 5.0 * 50.0 / 3.0;
const FULL: BenchSpec = BenchSpec {
    seed: SEED,
    scale: 1,
    regime: BenchRegime::Mixed,
};
const MIB: u64 = 1024 * 1024;

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let idx = ((p * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[idx]
}

fn sorted(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v
}

/// `(lines, items, spawner entities)` of a host's world.
fn counts(sim: &Sim<Belts>) -> (u32, u64, u32) {
    let store = sim.authority().store();
    let t = store.transport();
    let mut items = 0u64;
    for id in 1..t.next_id() {
        items += u64::from(t.count(LineId(id)).unwrap_or(0));
    }
    let spawners = store
        .entities()
        .filter(|(_, e)| matches!(e, Thing::Spawner(_) | Thing::Cycling(_)))
        .count() as u32;
    (t.lines_len(), items, spawners)
}

/// Per `LineId` (index), whether the line's chain ends in a `Sink` (else a `DeadEnd`): the bench
/// world's two lanes (`Mixed`: lane 0 sinks a packed stream, lane 1 dead-ends).
fn sinks_by_line(sim: &Sim<Belts>) -> Vec<bool> {
    use engine::transport::Output;
    let t = sim.authority().store().transport();
    (0..t.next_id())
        .map(|id| {
            let mut l = LineId(id);
            loop {
                match t.out(l) {
                    Ok(Output::Next(n)) => l = n,
                    Ok(Output::Sink) => return true,
                    _ => return false,
                }
            }
        })
        .collect()
}

/// Every spawner by id (both kinds), for the stationarity readout.
fn spawners_of(sim: &Sim<Belts>) -> Vec<fx_belts::Spawner> {
    sim.authority()
        .store()
        .entities()
        .filter_map(|(_, e)| match e {
            Thing::Spawner(s) | Thing::Cycling(s) => Some(*s),
            _ => None,
        })
        .collect()
}

/// `(items on sink lanes, items on dead-end lanes)`.
fn lane_items(sim: &Sim<Belts>, sink: &[bool]) -> (u64, u64) {
    let t = sim.authority().store().transport();
    let (mut a, mut b) = (0, 0);
    for id in 1..t.next_id() {
        let n = u64::from(t.count(LineId(id)).unwrap_or(0));
        if sink[id as usize] {
            a += n;
        } else {
            b += n;
        }
    }
    (a, b)
}

/// Refused `insert_back` attempts between two readings of the spawners (an attempt is due when
/// `acc + 256 >= period`; it was accepted iff `spawned` grew), `(sink lanes, dead-end lanes)`.
fn refusals(
    before: &[fx_belts::Spawner],
    after: &[fx_belts::Spawner],
    sink: &[bool],
) -> (u32, u32) {
    let (mut a, mut b) = (0, 0);
    for (x, y) in before.iter().zip(after) {
        if x.acc + 256 >= x.period && y.spawned == x.spawned {
            if sink[x.line as usize] {
                a += 1;
            } else {
                b += 1;
            }
        }
    }
    (a, b)
}

/// Two geneses of the same spec hash equal, and the world holds exactly the spec's lines and
/// items (every line, `set_out`, item and segment landed: `build` stops at the first refusal),
/// plus one spawner per world spawner, active from tick 1. 1/64 scale (78 lines, 3,906 items, 22 spawners) for
/// the fast tier; the full world is the slow tests'.
#[test]
fn bench_world_at_genesis_is_deterministic() {
    let spec = BenchSpec {
        seed: SEED,
        scale: 64,
        regime: BenchRegime::Mixed,
    };
    let world = world_of(spec);
    let a = Sim::<Belts>::genesis(params(spec));
    let b = Sim::<Belts>::genesis(params(spec));
    assert_eq!(a.state_hash(), b.state_hash(), "two geneses differ");
    let (lines, items, spawners) = counts(&a);
    assert_eq!(lines as usize, world.lines.len());
    assert_eq!(items, world.items());
    assert_eq!(spawners as usize, world.spawners.len());
    assert!(
        lines > 0 && items > 0 && spawners > 0,
        "an empty bench world"
    );
    let t = a.authority().store().transport();
    let mut segs = 0;
    for id in 1..t.next_id() {
        t.segments(LineId(id), &mut |_| segs += 1).unwrap();
    }
    assert_eq!(segs, lines, "one straight segment per line");
    // The empty world is not the bench world: `None` builds nothing.
    let empty = Sim::<Belts>::genesis(engine::sim::WorldParams {
        worldgen: fx_belts::BeltsParams::default(),
        ..params(spec)
    });
    assert_eq!(empty.authority().store().transport().lines_len(), 0);
    // The spawners run from tick 1 (a genesis spawn is woken and activated) and items flow.
    let mut a = a;
    let mut out = Vec::new();
    for _ in 0..40 {
        a.step(&[], &mut out);
    }
    let spawned: u32 = a
        .authority()
        .store()
        .entities()
        .map(|(_, e)| match e {
            Thing::Spawner(s) | Thing::Cycling(s) => s.spawned,
            _ => 0,
        })
        .sum();
    let t = a.authority().store().transport();
    let sunk: u64 = (1..t.next_id())
        .map(|id| t.sunk(LineId(id)).unwrap_or(0))
        .sum();
    assert!(spawned > 0 && sunk > 0, "spawned {spawned}, sunk {sunk}");
}

/// The bench world's cycling spawners (`Thing::Cycling`, M40's mixed-kind chains) cycle: after 600
/// ticks (a stream crosses the longest rear line, 48 tiles, in 512) the rear line of every cycling
/// sink lane holds only items it spawned, every one a kind in `1..=6`, more than one kind per line.
#[test]
fn bench_cycling_spawners_cycle_kinds() {
    let spec = BenchSpec {
        seed: SEED,
        scale: 64,
        regime: BenchRegime::Mixed,
    };
    let mut sim = Sim::<Belts>::genesis(params(spec));
    let mut out = Vec::new();
    for _ in 0..600 {
        sim.step(&[], &mut out);
    }
    let sink = sinks_by_line(&sim);
    let t = sim.authority().store().transport();
    let mut lines = 0;
    for (_, e) in sim.authority().store().entities() {
        let Thing::Cycling(s) = e else { continue };
        if !sink[s.line as usize] {
            continue;
        }
        let mut kinds = [0u32; 7];
        t.items_in(LineId(s.line), &mut |item, _| {
            assert!(
                (1..=6).contains(&item.0),
                "kind {} on line {}",
                item.0,
                s.line
            );
            kinds[item.0 as usize] += 1;
        })
        .unwrap();
        let distinct = kinds.iter().filter(|&&n| n > 0).count();
        assert!(
            distinct > 1,
            "line {} holds {distinct} kind(s): {kinds:?}",
            s.line
        );
        lines += 1;
    }
    assert!(lines > 0, "no cycling sink lane at 1/64 scale");
}

/// M47b (0078 A8): every bench spawner declares the rule it runs (`set_spawner` on the tick it
/// joins the list), and the host's forecast tracker replays it exactly: over 600 ticks on each
/// 1/64 regime the netcode scenarios use, no outcome differs from the declared schedule
/// (`spawner_mismatches` 0), no declaration is dropped, and after tick 1 no spawner insert reaches
/// clients as an arrival (an undeclared insert is a `ROUTE_INSERT` crossing; M47 measured about 330
/// a tick on the full world before the fixture declared). The spawners do insert, and the
/// saturated view's toggles and the inserter's edits do happen.
#[test]
fn belts_spawner_declares_schedule() {
    use engine::transport::ROUTE_INSERT;
    // `(regime, spawned, states, invalidations)`: pinned exactly (seed 7); a moved pin is a finding.
    let pins: [(BenchRegime, u64, u64, u64); 5] = [
        (BenchRegime::Mixed, 3_091, 0, 0),
        (BenchRegime::MixedEmpty, 3_091, 3, 0),
        (BenchRegime::InserterLike, 3_101, 23, 6_776),
        (
            BenchRegime::SaturatedView {
                jam_pct: 20,
                period: 20,
                speed: 0,
            },
            3_285,
            420,
            0,
        ),
        (
            BenchRegime::SaturatedView {
                jam_pct: 50,
                period: 30,
                speed: 72,
            },
            7_507,
            1_120,
            0,
        ),
    ];
    for (regime, want_spawned, want_states, want_invalidations) in pins {
        let spec = BenchSpec {
            seed: SEED,
            scale: 64,
            regime,
        };
        let mut bench = BenchHost::new(spec);
        let mut undeclared = 0u64;
        for _ in 0..600 {
            bench.step(false);
            let t = bench.host.sim().unwrap().authority().store().transport();
            if bench.tick > 1 {
                undeclared += t
                    .forecast_crossings()
                    .iter()
                    .filter(|c| c.route() == ROUTE_INSERT)
                    .count() as u64;
            }
        }
        let sim = bench.host.sim().unwrap();
        let c = sim.authority().store().transport().forecast_host_counters();
        let spawned: u64 = sim
            .authority()
            .store()
            .entities()
            .map(|(_, e)| match e {
                Thing::Spawner(s) | Thing::Cycling(s) => u64::from(s.spawned),
                _ => 0,
            })
            .sum();
        if std::env::var_os("MEASURE").is_some() {
            println!("{regime:?}: spawned {spawned}, {c:?}");
        }
        assert_eq!(spawned, want_spawned, "{regime:?}: inserts ({c:?})");
        assert_eq!(c.states, want_states, "{regime:?}: states ({c:?})");
        assert_eq!(
            c.invalidations, want_invalidations,
            "{regime:?}: invalidations ({c:?})"
        );
        assert_eq!(c.spawner_mismatches, 0, "{regime:?}: spawner_mismatches");
        assert_eq!(
            c.spawner_declarations_dropped, 0,
            "{regime:?}: spawner_declarations_dropped"
        );
        assert_eq!(undeclared, 0, "{regime:?}: undeclared inserts after tick 1");
    }
}

/// M47b: a spawner made by a request mid-game (`Op::Spawner`: `execute` turns the request into the
/// spawner and activates it, so it joins the list on its request's tick) declares too. A native
/// `Sim<Belts>` (the store tracks forecasts without a host): a sink lane and a dead-end lane, each
/// fed from tick 20 by a request spawner (the dead end fills, so later attempts are refused for
/// room, which the schedule predicts); over 400 ticks no outcome differs from the declared schedule,
/// nothing is dropped, and after the spawners' first tick no insert is a `ROUTE_INSERT` crossing.
#[test]
fn belts_request_spawner_declares_schedule() {
    use engine::transport::ROUTE_INSERT;
    let mut w = props_world::World::new(3, 64, 1_024);
    let chain = |speed| Op::Chain {
        from: Pos { x: 4, y: 4 },
        dir: Dir::East,
        tiles: 8,
        speed,
        items_at_rest: [(0, 0); 8],
    };
    w.step(&[chain(24), chain(24), Op::Sink { line: 0 }]);
    for _ in 0..18 {
        w.step(&[]);
    }
    w.step(&[
        Op::Spawner {
            line: 0,
            item: 3,
            period: 300,
        },
        Op::Spawner {
            line: 1,
            item: 5,
            period: 256,
        },
    ]);
    let mut undeclared = 0u64;
    for _ in 0..400 {
        w.step(&[]);
        undeclared += w
            .sim
            .authority()
            .store()
            .transport()
            .forecast_crossings()
            .iter()
            .filter(|c| c.route() == ROUTE_INSERT)
            .count() as u64;
    }
    let c = w
        .sim
        .authority()
        .store()
        .transport()
        .forecast_host_counters();
    let spawned: u64 = w
        .sim
        .authority()
        .store()
        .entities()
        .map(|(_, e)| match e {
            Thing::Spawner(s) => u64::from(s.spawned),
            _ => 0,
        })
        .sum();
    if std::env::var_os("MEASURE").is_some() {
        println!("request spawners: spawned {spawned}, {c:?}");
    }
    assert_eq!(spawned, SPAWNED_BY_REQUEST, "inserts ({c:?})");
    assert_eq!(c.spawner_mismatches, 0, "spawner_mismatches ({c:?})");
    assert_eq!(
        c.spawner_declarations_dropped, 0,
        "spawner_declarations_dropped"
    );
    assert_eq!(
        undeclared, 0,
        "undeclared inserts after the spawners' first tick"
    );
}

/// What the request spawners insert in 400 ticks (pinned).
const SPAWNED_BY_REQUEST: u64 = 182;

/// Every line's items `(line, [(item, pos)])` of a host's world, ascending id.
fn items_of(host: &engine::host::Host<Belts>) -> Vec<(u32, Vec<(u16, u32)>)> {
    let t = host.sim().expect("live").authority().store().transport();
    (1..t.next_id())
        .filter_map(|id| {
            let mut v = Vec::new();
            t.items_in(LineId(id), &mut |item, pos| v.push((item.0, pos)))
                .ok()?;
            Some((id, v))
        })
        .collect()
}

/// M48: a spawner's declaration is derived and not saved, so a restored host has none until the
/// game declares again (`Game::declare_spawners`, called once after the restore). The 1/64 `Mixed`
/// bench world is saved at tick 300 and restored into a fresh `Host` (the sim worker's
/// `sim_restore_*` path), which then runs 60 ticks beside a host that never stopped: the restored
/// tracker's declarations replay exactly (`spawner_mismatches` 0, none dropped), no spawner insert
/// reaches clients as an arrival on any restored tick (an undeclared insert is a `ROUTE_INSERT`
/// crossing; without the hook every insert of the window is one), and every line's items equal the
/// never-restored host's on every tick.
#[test]
fn belts_restore_keeps_spawner_schedules() {
    use engine::abi::{RegionLayout, Role, Status};
    use engine::host::Host;
    use engine::transport::ROUTE_INSERT;
    const SAVED_AT: u32 = 300;
    const RUN: u32 = 60;
    let spec = BenchSpec {
        seed: SEED,
        scale: 64,
        regime: BenchRegime::Mixed,
    };
    let mut never = BenchHost::new(spec);
    for _ in 0..SAVED_AT {
        never.step(false);
    }
    let mut saved = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    assert_eq!(
        Instance::sim_snapshot_begin(&mut never.host, 0, 0),
        Status::Ok
    );
    loop {
        let n = Instance::sim_snapshot_next(&mut never.host, &mut buf).expect("next") as usize;
        if n == 0 {
            break;
        }
        saved.extend_from_slice(&buf[..n]);
    }
    // The same world params as `params(spec)`, through the sim worker's JSON config.
    let p = params(spec);
    let cfg = format!(
        r#"{{"seed":"0x{:x}","params":{{"bench":{{"seed":{},"scale":{}}}}},"maxEntities":{},"maxModifiedTiles":{},"maxActionGrowth":{},"maxLines":{},"maxItems":{}}}"#,
        p.seed,
        spec.seed,
        spec.scale,
        p.max_entities,
        p.max_modified_tiles,
        p.max_action_growth,
        p.max_lines,
        p.max_items
    );
    let mut layout = RegionLayout::new();
    let mut host = Host::<Belts>::init(Role::Sim, &cfg, &mut layout).expect("init");
    assert_eq!(host.sim_restore_begin(saved.len() as u32), Status::Ok);
    assert_eq!(host.sim_restore_push(&saved), Status::Ok);
    let mut result = [0u8; 8];
    assert_eq!(host.sim_restore_end(&mut result), Status::Ok);
    let mut restored = BenchHost::with_host(host, spec, SAVED_AT);
    assert_eq!(
        restored.host.sim().unwrap().state_hash(),
        never.host.sim().unwrap().state_hash(),
        "the restored world is the saved one"
    );
    let spawned = |h: &Host<Belts>| -> u64 {
        h.sim()
            .unwrap()
            .authority()
            .store()
            .entities()
            .map(|(_, e)| match e {
                Thing::Spawner(s) | Thing::Cycling(s) => u64::from(s.spawned),
                _ => 0,
            })
            .sum()
    };
    let before = spawned(&restored.host);
    let mut undeclared = 0u64;
    for _ in 0..RUN {
        never.step(false);
        restored.step(false);
        let t = restored.host.sim().unwrap().authority().store().transport();
        undeclared += t
            .forecast_crossings()
            .iter()
            .filter(|c| c.route() == ROUTE_INSERT)
            .count() as u64;
        assert_eq!(
            items_of(&restored.host),
            items_of(&never.host),
            "tick {}: items differ from the never-restored host's",
            restored.tick
        );
    }
    let inserts = spawned(&restored.host) - before;
    let c = restored
        .host
        .sim()
        .unwrap()
        .authority()
        .store()
        .transport()
        .forecast_host_counters();
    if std::env::var_os("MEASURE").is_some() {
        println!("restored: spawned {inserts}, undeclared {undeclared}, {c:?}");
    }
    assert_eq!(inserts, RESTORE_SPAWNED, "inserts in the restored window");
    assert_eq!(undeclared, 0, "undeclared inserts after the restore");
    // One list per declared spawner, built by `forecast_close_restored` at the restore (the first
    // restored tick clears them; no connection held a line then), and none during the window.
    assert_eq!(c.run_lists, 22, "run_lists ({c:?})");
    assert_eq!(c.spawner_mismatches, 0, "spawner_mismatches ({c:?})");
    assert_eq!(
        c.spawner_declarations_dropped, 0,
        "spawner_declarations_dropped ({c:?})"
    );
}

/// The inserts of the 1/64 `Mixed` world's 22 spawners over ticks 301-360 (pinned: the window's
/// spawners do insert).
const RESTORE_SPAWNED: u64 = 297;

/// 0079 §16: the recommended caps reserve 16.5 MiB, over 0007 §8's 8 MiB slack, so they do not fit
/// a phone's split. The largest caps of the form `(lines, 8 x lines)`, `lines` a multiple of 1,024,
/// whose arena fits the slack in the larger of a host's and a replica's reserve (a phone may host
/// or join) are pinned here as literals with their bytes (a record growth moves them): milestone
/// 57's phone candidates, and an upper bound, not a usable cap: 0007 §8's 8 MiB line is "lists,
/// timers, players, and slack", which this pair leaves 409,568 B of (the host's 7,979,040; a
/// replica reserves 6,602,768). M47's forecast tracker (106 B a line and 4 B an item at these
/// caps) moved the pair from (16,384, 131,072), which reserved 8,355,856 B before it and would now
/// reserve 10,616,864 B on a host and 8,781,840 B on a replica.
#[test]
fn transport_phone_caps_fit_split() {
    const SLACK: u64 = 8 * MIB;
    const LINES: u32 = 12_288;
    const BYTES: u64 = 7_979_040;
    let mut found = None;
    let mut lines = engine::transport::DEFAULT_MAX_LINES;
    while lines > 0 {
        if Transport::max_role_bytes(lines, 8 * lines) <= SLACK {
            found = Some(lines);
            break;
        }
        lines -= 1_024;
    }
    let lines = found.expect("some caps fit the slack");
    println!(
        "phone caps: ({lines}, {}) reserve {} B",
        8 * lines,
        Transport::reserved_bytes(lines, 8 * lines)
    );
    assert_eq!((lines, 8 * lines), (LINES, 8 * LINES));
    assert_eq!(Transport::max_role_bytes(LINES, 8 * LINES), BYTES);
    assert_eq!(
        Transport::reserved_bytes(LINES, 8 * LINES),
        BYTES,
        "the host is the larger"
    );
    assert_eq!(
        Transport::replica_reserved_bytes(LINES, 8 * LINES),
        6_602_768
    );
    assert!(Transport::max_role_bytes(LINES + 1_024, 8 * (LINES + 1_024)) > SLACK);
    assert_eq!(
        Transport::reserved_bytes(
            engine::transport::DEFAULT_MAX_LINES,
            engine::transport::DEFAULT_MAX_ITEMS
        ),
        21_168_160,
        "0079 §16's figure at the recommended caps, plus M46's 5 B a line and M47's tracker"
    );
    assert_eq!(
        Transport::reserved_bytes(16_384, 131_072),
        10_616_864,
        "M46's phone pair"
    );
    assert_eq!(
        Transport::replica_reserved_bytes(16_384, 131_072),
        8_781_840
    );
}

/// 0079 §5: a belt world whose caps push the memory split past `worldBudgetBytes` fails
/// `Host::init` with `BudgetExceedsArena`, cleanly: the check runs before anything is reserved, so
/// the thread's allocation high-water during the refused init stays far below the arena it
/// would have reserved, and nothing is left allocated. The same budget plus one byte is accepted.
/// (The engine-side status at a pre-M42 split: `init_counts_the_transport_arena`,
/// `crates/engine/tests/main/state_budget.rs`.)
#[test]
fn transport_budget_exceeds_arena_is_clean() {
    use engine::abi::arena::{thread_high_water_bytes, thread_live_bytes};
    use engine::abi::{RegionLayout, Role, Status};
    let (lines, items) = (
        engine::transport::DEFAULT_MAX_LINES,
        engine::transport::DEFAULT_MAX_ITEMS,
    );
    let arena = Transport::reserved_bytes(lines, items);
    // 0007 §8's split as `Host::init` computes it: the cache (1,024 chunks of 32 x 32 tiles x 4 B),
    // entities at their real size, 12 B per modified tile, 8 MiB index, 8 MiB slack, the arena.
    let split = 1024 * 4096
        + 4_096 * core::mem::size_of::<<Belts as Game>::Entity>() as u64
        + 4_096 * 12
        + 16 * MIB
        + arena;
    let cfg = move |budget: u64| {
        format!(
            r#"{{"seed":"0x1","params":null,"maxEntities":4096,"maxModifiedTiles":4096,"maxLines":{lines},"maxItems":{items},"worldBudgetBytes":{budget}}}"#
        )
    };
    // A fresh thread: its high-water mark starts at zero.
    let (status, high, left) = std::thread::spawn(move || {
        let before = thread_live_bytes();
        let r =
            engine::host::Host::<Belts>::init(Role::Sim, &cfg(split - 1), &mut RegionLayout::new())
                .err();
        (
            r,
            thread_high_water_bytes() - before,
            thread_live_bytes() - before,
        )
    })
    .join()
    .unwrap();
    assert_eq!(status, Some(Status::BudgetExceedsArena));
    assert!(
        (high as u64) < arena / 16,
        "the refused init allocated {high} B against a {arena} B arena"
    );
    assert_eq!(left, 0, "the refused init left {left} B allocated");
    assert!(
        engine::host::Host::<Belts>::init(Role::Sim, &cfg(split), &mut RegionLayout::new()).is_ok(),
        "the exact split is accepted"
    );
}

#[allow(clippy::disallowed_types)] // a bench's own timer never reaches state (0002 section 2)
fn measure_tick() -> String {
    let t0 = std::time::Instant::now();
    let mut bench = BenchHost::new(FULL);
    let sim = bench.host.sim().expect("genesis ran");
    let (lines, items0, spawners) = counts(sim);
    let world = world_of(FULL);
    assert_eq!(
        (lines as usize, items0),
        (world.lines.len(), world.items()),
        "the bench world is short: its caps refused something"
    );
    let genesis_ms = t0.elapsed().as_secs_f64() * 1e3;
    for _ in 0..WARMUP {
        bench.step(false);
    }
    // Stationarity (M45 review, finding 1), read outside the timed sections: lane items at the
    // start and end of the window, refusals over its first and last ten ticks, and the spawners
    // that never inserted during it.
    let sink = sinks_by_line(bench.host.sim().expect("live"));
    let lanes0 = lane_items(bench.host.sim().expect("live"), &sink);
    let start = spawners_of(bench.host.sim().expect("live"));
    let mut prev = start.clone();
    let (mut refused_first, mut refused_last) = ((0, 0), (0, 0));
    engine::bench_phase::take();
    let (mut total, mut tick, mut frames, mut advance) = (vec![], vec![], vec![], vec![]);
    let mut bytes = 0usize;
    for i in 0..MEASURED {
        let (a, t, f) = bench.step(true);
        let phases = engine::bench_phase::take();
        total.push(a + t + f);
        tick.push(t);
        frames.push(f);
        advance.push(phases[engine::bench_phase::Phase::Transport as usize] as f64 / 1e6);
        bytes += bench.last_frame_bytes;
        if !(10..MEASURED - 10).contains(&i) {
            let now = spawners_of(bench.host.sim().expect("live"));
            let r = refusals(&prev, &now, &sink);
            let acc = if i < 10 {
                &mut refused_first
            } else {
                &mut refused_last
            };
            acc.0 += r.0;
            acc.1 += r.1;
            prev = now;
        } else if i == MEASURED - 11 {
            prev = spawners_of(bench.host.sim().expect("live"));
        }
    }
    let end = spawners_of(bench.host.sim().expect("live"));
    let lanes1 = lane_items(bench.host.sim().expect("live"), &sink);
    let idle: Vec<bool> = start
        .iter()
        .zip(&end)
        .filter(|(a, b)| a.spawned == b.spawned)
        .map(|(a, _)| sink[a.line as usize])
        .collect();
    let idle_sink = idle.iter().filter(|&&s| s).count();
    let (items_a, items_b) = (lanes0.0 + lanes0.1, lanes1.0 + lanes1.1);
    println!(
        "slow_tick_belts_large stationarity: items at tick {WARMUP} {items_a} (sink lanes {}, \
         dead-end lanes {}), at tick {} {items_b} (sink {}, dead-end {}), {:+.1} %; refused \
         insert_back per tick over the first ten ticks {:.1} sink / {:.1} dead-end, last ten {:.1} \
         / {:.1}; spawners that never inserted in the window: {} on sink lanes, {} on dead-end lanes",
        lanes0.0,
        lanes0.1,
        WARMUP + MEASURED,
        lanes1.0,
        lanes1.1,
        100.0 * (items_b as f64 / items_a as f64 - 1.0),
        f64::from(refused_first.0) / 10.0,
        f64::from(refused_first.1) / 10.0,
        f64::from(refused_last.0) / 10.0,
        f64::from(refused_last.1) / 10.0,
        idle_sink,
        idle.len() - idle_sink,
    );
    // What stationarity means for `Mixed` (M40's regime, unchanged): the sink lanes are a packed
    // stream fed at saturation (a `rate256 = 256` spawner tries every tick and is refused `NoRoom`
    // on the ~5 ticks in 8 the back is occupied: that is the feed, not starvation), so their items
    // are constant; the dead-end lanes fill by design (a compression front moving back), so the
    // world's total grows. No refusal is `Full`: the item cap is never met.
    let drift = (lanes1.0 as f64 / lanes0.0 as f64 - 1.0).abs();
    assert!(
        drift < 0.05,
        "sink-lane items drifted {:.1} %",
        drift * 100.0
    );
    assert_eq!(
        idle_sink, 0,
        "a sink-lane spawner starved during the window"
    );
    assert!(
        items_b < u64::from(bench_host::BENCH_MAX_ITEMS),
        "the item cap was met: refusals were `Full`"
    );
    let items1 = items_b;
    let (total, tick, frames, advance) =
        (sorted(total), sorted(tick), sorted(frames), sorted(advance));
    let median = percentile(&total, 0.5);
    let p99 = percentile(&total, 0.99);
    println!(
        "slow_tick_belts_large: {lines} lines, {items0} items at genesis ({items1} at the end), \
         {spawners} spawners, {PLAYERS} max views; genesis {genesis_ms:.0} ms; {MEASURED} ticks \
         after {WARMUP}: median {median:.3} ms, p99 {p99:.3} ms, max {:.3} ms; split of the median: \
         tick {:.3} (advance {:.3}), frames {:.3} ms; {} B of frames per tick",
        total[total.len() - 1],
        percentile(&tick, 0.5),
        percentile(&advance, 0.5),
        percentile(&frames, 0.5),
        bytes / MEASURED as usize,
    );
    format!(
        "{{\"medianMs\":{median:.4},\"p99Ms\":{p99:.4},\"maxMs\":{:.4},\"tickMedianMs\":{:.4},\
         \"advanceMedianMs\":{:.4},\"framesMedianMs\":{:.4},\"frameBytesPerTick\":{}}}",
        total[total.len() - 1],
        percentile(&tick, 0.5),
        percentile(&advance, 0.5),
        percentile(&frames, 0.5),
        bytes / MEASURED as usize,
    )
}

#[test]
fn slow_tick_belts_large() {
    if cfg!(debug_assertions) {
        let sample = run_in_release("fx-belts", "bench_belts", "slow_tick_belts_large");
        gate("belts-tick", &sample);
    } else {
        println!("BENCH_SAMPLE {}", measure_tick());
    }
}

#[allow(clippy::disallowed_types)] // a bench's own timer never reaches state (0002 section 2)
fn measure_snapshot() -> String {
    use engine::bytes::{ByteReader, CountSink, SliceSink};
    use engine::persist::{SnapshotProgress, SnapshotReader};
    use engine::store::Store;
    use engine::world::{CacheCapacity, ChunkDims, PristineSource, TerrainStore};
    use engine::worldgen::Pristine;
    use std::time::Instant;
    let mut bench = BenchHost::new(FULL);
    for _ in 0..60 {
        bench.step(false);
    }
    // The whole store, as the sim worker writes a save (`sim_snapshot_begin` encodes it all).
    let mut persist = vec![0u8; 256 * 1024];
    let t0 = Instant::now();
    assert_eq!(
        Instance::sim_snapshot_begin(&mut bench.host, 0, 0),
        engine::abi::Status::Ok
    );
    let begin_ms = t0.elapsed().as_secs_f64() * 1e3;
    let mut snapshot = Vec::new();
    loop {
        let n = Instance::sim_snapshot_next(&mut bench.host, &mut persist).expect("next") as usize;
        if n == 0 {
            break;
        }
        snapshot.extend_from_slice(&persist[..n]);
    }
    let encode_ms = t0.elapsed().as_secs_f64() * 1e3;
    // Decode it into a fresh store (the load path of `RefScenario::save_and_load`).
    let p = params(FULL);
    let source: Box<dyn PristineSource> =
        Box::new(Pristine::<fx_belts::FlatWorldgen>::new(p.seed, p.worldgen));
    let terrain = TerrainStore::new(
        ChunkDims::new(Belts::CHUNK_BITS),
        source,
        CacheCapacity::Chunks(1024),
    );
    let mut reader: SnapshotReader<Belts> =
        SnapshotReader::new(Store::new(terrain, Default::default()));
    let t1 = Instant::now();
    let done = matches!(reader.push(&snapshot), Ok(SnapshotProgress::Done(_)));
    let decode_ms = t1.elapsed().as_secs_f64() * 1e3;
    assert!(done, "the snapshot this process just wrote must decode");
    let live = bench.host.sim().expect("live").authority().store();
    assert_eq!(reader.into_store().state_hash(), live.state_hash());
    // The transport section alone (`Store::encode` writes it last).
    let t = live.transport();
    let mut count = CountSink(0);
    t.write_canonical(&mut count);
    let mut section = vec![0u8; count.0];
    let t2 = Instant::now();
    let mut sink = SliceSink::new(&mut section);
    t.write_canonical(&mut sink);
    let n = sink.finish().expect("the section fits its counted size");
    let section_encode_ms = t2.elapsed().as_secs_f64() * 1e3;
    assert_eq!(n, section.len());
    let mut copy = Transport::empty();
    let t3 = Instant::now();
    copy.read_canonical(&mut ByteReader::new(&section))
        .expect("the section decodes");
    let section_decode_ms = t3.elapsed().as_secs_f64() * 1e3;
    let share = 100.0 * section.len() as f64 / snapshot.len() as f64;
    let verdict = if encode_ms <= SNAPSHOT_PROXY_MS {
        "inside"
    } else {
        "OUTSIDE"
    };
    println!(
        "slow_snapshot_belts_large: encode {encode_ms:.1} ms (begin {begin_ms:.1}) to {} B, decode \
         {decode_ms:.1} ms; transport section {} B ({share:.1} % of the bytes), encode \
         {section_encode_ms:.1} ms, decode {section_decode_ms:.1} ms; encode {verdict} the desktop \
         proxy of {SNAPSHOT_PROXY_MS:.1} ms (M36's SNAPSHOT_PROXY_MS)",
        snapshot.len(),
        section.len(),
    );
    if encode_ms > SNAPSHOT_PROXY_MS {
        println!(
            "warn: snapshot of the belt world takes {encode_ms:.1} ms, over {SNAPSHOT_PROXY_MS:.1} ms"
        );
    }
    format!(
        "{{\"encodeMs\":{encode_ms:.3},\"decodeMs\":{decode_ms:.3},\"bytes\":{},\
         \"transportBytes\":{},\"transportEncodeMs\":{section_encode_ms:.3},\
         \"transportDecodeMs\":{section_decode_ms:.3}}}",
        snapshot.len(),
        section.len(),
    )
}

#[test]
fn slow_snapshot_belts_large() {
    if cfg!(debug_assertions) {
        let sample = run_in_release("fx-belts", "bench_belts", "slow_snapshot_belts_large");
        // Recorded, never gated: no baseline (the answer is the proxy line above).
        gate("belts-snapshot", &sample);
    } else {
        println!("BENCH_SAMPLE {}", measure_snapshot());
    }
}
