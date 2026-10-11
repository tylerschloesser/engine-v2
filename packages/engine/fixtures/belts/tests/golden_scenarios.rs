//! The `fx-belts` goldens (M42b): each `golden/scenario*.json` is replayed natively through
//! `Sim<Belts>` (the call sequence `Host<Belts>`'s `sim_genesis`/`sim_tick` make; the scenario file
//! itself is parsed, so the native script cannot drift from the one `pnpm golden belts` runs under
//! Node) and compared with the `.wasm`-written hash. Each test also asserts its scenario's property
//! after every tick (0069 §3: a hash alone cannot catch a self-consistent error).
//!
//! `transport_request_is_deferred_to_tick` pins that `apply` only spawns the request and
//! `Belts::tick` executes it.

use engine::game::{PlayerEvent, PlayerId, WorldRead, WorldWrite};
use engine::sim::{Record, Sim, WorldParams};
use engine::time::Tick;
use engine::transport::{Item, LineId, SPACING};
use fx_belts::{Action, Belts, Dir, Op, Pos, Thing};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameCfg {
    seed: String,
    max_entities: u32,
    max_modified_tiles: u32,
    max_action_growth: u32,
    max_lines: u32,
    max_items: u32,
}

#[derive(serde::Deserialize)]
struct Config {
    game: GameCfg,
}

#[derive(serde::Deserialize)]
struct Scripted {
    seq: u32,
    action: Action,
}

#[derive(serde::Deserialize)]
struct Entry {
    tick: u32,
    #[serde(default)]
    connect: bool,
    #[serde(default)]
    actions: Vec<Scripted>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    config: Config,
    checkpoint_at: u32,
    script: Vec<Entry>,
}

const WHO: PlayerId = PlayerId(1);

fn read_scenario(file: &str) -> Scenario {
    let path = format!("{}/golden/{file}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn new_sim(cfg: &GameCfg) -> Sim<Belts> {
    let seed = u64::from_str_radix(cfg.seed.trim_start_matches("0x"), 16).expect("hex seed");
    Sim::genesis(WorldParams {
        seed,
        worldgen: (),
        max_entities: cfg.max_entities,
        max_modified_tiles: cfg.max_modified_tiles,
        max_action_growth: cfg.max_action_growth,
        max_lines: cfg.max_lines,
        max_items: cfg.max_items,
    })
}

/// Runs `file` tick by tick (`runScriptScenario`'s contract: an entry's `tick` is the step that
/// applies it; `connect` is `Host::connect`'s `Joined` then `Connected`), calling `check(sim)` after every step,
/// and returns the hash at `checkpointAt`.
fn run(file: &str, check: &mut dyn FnMut(&Sim<Belts>)) -> u64 {
    let sc = read_scenario(file);
    let mut sim = new_sim(&sc.config.game);
    let mut out = Vec::new();
    let mut next = 0;
    for t in 1..=sc.checkpoint_at {
        let mut batch: Vec<Record<Belts>> = Vec::new();
        while next < sc.script.len() && sc.script[next].tick == t {
            let e = &sc.script[next];
            if e.connect {
                batch.push(Record::Player {
                    who: WHO,
                    ev: PlayerEvent::Joined,
                });
                batch.push(Record::Player {
                    who: WHO,
                    ev: PlayerEvent::Connected,
                });
            }
            for a in &e.actions {
                batch.push(Record::Action {
                    who: WHO,
                    seq: a.seq,
                    action: a.action,
                });
            }
            next += 1;
        }
        sim.step(&batch, &mut out);
        assert!(
            out.iter().all(|o| o.result.is_ok()),
            "{file} tick {t}: every scripted action applies"
        );
        assert_eq!(sim.tick(), Tick(t));
        check(&sim);
    }
    assert_eq!(next, sc.script.len(), "{file}: script past checkpointAt");
    sim.state_hash()
}

/// Chain `i`'s line (the fixture's table, `Global::lines`).
fn line(sim: &Sim<Belts>, i: u32) -> LineId {
    sim.authority().global().line(i)
}

fn items(sim: &Sim<Belts>, l: LineId) -> Vec<(u16, u32)> {
    let mut v = Vec::new();
    sim.authority()
        .transport()
        .items_in(l, &mut |item: Item, pos| v.push((item.0, pos)))
        .expect("line exists");
    v
}

/// Live, sunk and spawned items in the whole world (`spawned == live + sunk`).
fn census(sim: &Sim<Belts>) -> (u64, u64, u64) {
    let a = sim.authority();
    let g = a.global();
    let (mut live, mut sunk) = (0, 0);
    for i in 0..g.chains {
        let l = g.line(i);
        live += u64::from(a.transport().count(l).expect("line exists"));
        sunk += a.transport().sunk(l).expect("line exists");
    }
    let mut spawned = 0;
    for (_, e) in a.store().entities() {
        if let Thing::Spawner(s) = e {
            spawned += u64::from(s.spawned);
        }
    }
    (live, sunk, spawned)
}

/// `straight-chain` (`golden/scenario.json`, the canonical pair): chain 0 (4 tiles, speed 24)
/// hands off to chain 1 (4 tiles, `Sink`); a `period = 256` spawner saturates chain 0 from tick 1.
/// Along the path (`d = pos + 1024` on chain 0, `pos` on chain 1) every item is exactly `SPACING`
/// behind the one ahead, across the hand-off too, and every item's phase is the first item's:
/// inserted at `1024 - 24` before tick 1's move, so `d = 2048 - 48 - 24 (t - 1)` (mod 64) at the end
/// of tick `t`. That pins speed, spacing and the hand-off landing `target.len - overshoot`.
#[test]
fn belts_golden_straight_chain() {
    let mut saw_handoff = false;
    let hash = run("scenario.json", &mut |sim| {
        let t = sim.tick().0;
        let (a, b) = (line(sim, 0), line(sim, 1));
        let mut d: Vec<u32> = items(sim, b).iter().map(|&(_, p)| p).collect();
        let on_b = d.len();
        d.extend(items(sim, a).iter().map(|&(_, p)| p + 1024));
        assert!(!d.is_empty(), "tick {t}: the spawner fed chain 0");
        let phase = (2000 - 24 * (i64::from(t) - 1)).rem_euclid(i64::from(SPACING)) as u32;
        for (k, &x) in d.iter().enumerate() {
            assert_eq!(
                x % SPACING,
                phase,
                "tick {t}: item {k} at path distance {x}"
            );
            if k > 0 {
                assert_eq!(
                    x - d[k - 1],
                    SPACING,
                    "tick {t}: spacing behind item {}",
                    k - 1
                );
            }
        }
        saw_handoff |= on_b > 0 && on_b < d.len();
        let (live, sunk, spawned) = census(sim);
        assert_eq!(spawned, live + sunk, "tick {t}: conservation");
    });
    assert!(saw_handoff, "items were on both lines at once");
    engine::testing::assert_golden(env!("CARGO_MANIFEST_DIR"), &[hash]);
}

/// `deadend-backup`: a belt (two lanes, each chain 3 tiles -> chain 2 tiles, speed 24), both lanes
/// sinking until tick 60 and dead-ended after; spawners at `period` 1000 and 1500 (sparse, so the
/// items squash up behind the dead end rather than stopping all at once). While the backup
/// forms, every gap on a line and across each `Next` boundary stays at least `SPACING` after every
/// tick, and tick [`SQUASH_TICK`]'s positions (mid-squash: the front packed, the back still moving)
/// are pinned in [`SQUASH`]. At the checkpoint (tick 300) every line holds exactly 4 items per tile
/// at rest at `0, 64, 128, 192` per tile and nothing moved in the last tick.
#[test]
fn belts_golden_deadend_backup() {
    let mut prev: Vec<Vec<(u16, u32)>> = Vec::new();
    let mut at_rest = Vec::new();
    let hash = run("scenario-deadend-backup.json", &mut |sim| {
        let t = sim.tick().0;
        let now: Vec<_> = (0..4).map(|i| items(sim, line(sim, i))).collect();
        let (live, sunk, spawned) = census(sim);
        assert_eq!(spawned, live + sunk, "tick {t}: conservation");
        for (feeder, target) in [(0usize, 1usize), (2, 3)] {
            // The lane as one path, front first: target positions, then feeder + target length.
            let tlen = sim
                .authority()
                .transport()
                .len(line(sim, target as u32))
                .expect("line");
            let path: Vec<u32> = now[target]
                .iter()
                .map(|&(_, p)| p)
                .chain(now[feeder].iter().map(|&(_, p)| p + tlen))
                .collect();
            for k in 1..path.len() {
                assert!(
                    path[k] - path[k - 1] >= SPACING,
                    "tick {t}: lane {feeder}->{target}: gap {} behind item {}",
                    path[k] - path[k - 1],
                    k - 1
                );
            }
        }
        if t == SQUASH_TICK {
            let got: Vec<Vec<u32>> = now
                .iter()
                .map(|l| l.iter().map(|&(_, p)| p).collect())
                .collect();
            assert_eq!(got, SQUASH, "tick {t}: positions mid-squash, chains 0-3");
        }
        at_rest = now.clone();
        if t == 300 {
            assert_eq!(now, prev, "nothing moved in the last tick: at rest");
        }
        prev = now;
    });
    for (i, tiles) in [(0, 3), (1, 2), (2, 3), (3, 2)] {
        let want: Vec<u32> = (0..tiles * 4).map(|k| k * SPACING).collect();
        let got: Vec<u32> = at_rest[i].iter().map(|&(_, p)| p).collect();
        assert_eq!(got, want, "chain {i}: 4 items per tile at 0, 64, 128, 192");
    }
    engine::testing::assert_golden_named(
        env!("CARGO_MANIFEST_DIR"),
        "golden-deadend-backup.json",
        &[hash],
    );
}

/// `deadend-backup`'s positions at the end of tick [`SQUASH_TICK`], chains 0-3, front to back.
const SQUASH_TICK: u32 = 75;
const SQUASH: [&[u32]; 4] = [
    &[0, 64, 128, 192, 256, 336, 432, 528, 624, 720],
    &[0, 64, 128, 192, 256, 320, 384, 448],
    &[48, 192, 336, 480, 624],
    &[0, 64, 128, 192, 296, 440],
];

/// `spawn-to-sink`: two lanes (3 tiles -> 2 tiles `Sink`, speed 24) fed by spawners at `period`
/// 700 and 1500, and a third spawner (2000) on lane 0's sink line itself. After every tick the
/// spawners' accepted inserts equal the items on lines plus the items sunk (`count`, `sunk`), and by
/// the checkpoint both sinks have deleted items.
#[test]
fn belts_golden_spawn_to_sink() {
    let mut last = (0, 0, 0);
    let hash = run("scenario-spawn-to-sink.json", &mut |sim| {
        let c = census(sim);
        assert_eq!(
            c.2,
            c.0 + c.1,
            "tick {}: spawned == live + sunk",
            sim.tick().0
        );
        last = c;
    });
    assert!(
        last.1 > 0 && last.0 > 0,
        "items both sank and are live: {last:?}"
    );
    engine::testing::assert_golden_named(
        env!("CARGO_MANIFEST_DIR"),
        "golden-spawn-to-sink.json",
        &[hash],
    );
}

/// `big-step` (speed 72 > `SPACING`): chain 1 (2 tiles) holds two items at rest at 0 and 64
/// (`DeadEnd`) until tick 5 links it to chain 0 (2 tiles, `Sink`); in tick 5 both cross in one
/// tick, landing at `512 - 72 = 440` and `512 - 8 = 504`. The spawner made at tick 10 inserts at
/// `512 - 72` before that tick's move, so its first item ends tick 10 at `512 - 2 x 72 = 368`.
#[test]
fn belts_golden_big_step() {
    let hash = run("scenario-big-step.json", &mut |sim| {
        let t = sim.tick().0;
        let (b, a) = (line(sim, 0), line(sim, 1));
        match t {
            1..=4 => {
                assert_eq!(items(sim, a), [(1, 0), (2, 64)], "tick {t}: at rest");
                assert_eq!(items(sim, b), [], "tick {t}");
            }
            5 => {
                assert_eq!(items(sim, a), [], "tick 5: both left chain 1");
                assert_eq!(items(sim, b), [(1, 440), (2, 504)], "tick 5: both landed");
            }
            10 => assert_eq!(items(sim, a), [(3, 368)], "tick 10: the first spawned item"),
            _ => {}
        }
        let (live, sunk, spawned) = census(sim);
        assert_eq!(spawned + 2, live + sunk, "tick {t}: conservation");
    });
    engine::testing::assert_golden_named(
        env!("CARGO_MANIFEST_DIR"),
        "golden-big-step.json",
        &[hash],
    );
}

/// 0076 §6 on the fixture's side: `apply` spawns the request and touches no line (an `apply`-time
/// `transport_mut()` trips `Authority`'s debug assertion, which fails this test); the next tick
/// executes it. `Belts::apply` runs here on the host `Authority` between steps, the phase `Sim::step`
/// gives it (neither genesis nor tick), for every op kind. The debug assertion is what fails this
/// test, in the dev profile the `rust` suite builds; a release build would answer `Err(Unknown)`
/// silently and only an `apply` that propagates it with `?` would still fail `.expect("applies")`.
#[test]
fn transport_request_is_deferred_to_tick() {
    let sc = read_scenario("scenario.json");
    let mut sim = new_sim(&sc.config.game);
    let mut out = Vec::new();
    sim.step(&[], &mut out);
    let ops = [
        Op::Chain {
            from: Pos { x: 0, y: 0 },
            dir: Dir::East,
            tiles: 2,
            speed: 24,
            items_at_rest: [
                (1, 0),
                (0, 0),
                (0, 0),
                (0, 0),
                (0, 0),
                (0, 0),
                (0, 0),
                (0, 0),
            ],
        },
        Op::Chain {
            from: Pos { x: 2, y: 0 },
            dir: Dir::East,
            tiles: 2,
            speed: 24,
            items_at_rest: [(0, 0); 8],
        },
        Op::Link {
            from_line: 0,
            to_line: 1,
        },
        Op::Sink { line: 1 },
        Op::DeadEnd { line: 1 },
        Op::Spawner {
            line: 0,
            item: 2,
            period: 256,
        },
    ];
    for op in ops {
        let w: &mut dyn WorldWrite<Belts> = sim.authority_mut();
        <Belts as engine::game::Game>::apply(w, WHO, &Action::Request(op)).expect("applies");
    }
    let a = sim.authority();
    assert_eq!(a.transport().lines_len(), 0, "apply created no line");
    assert_eq!(
        a.store().entity_count(),
        6,
        "apply spawned one request per op"
    );

    sim.step(&[], &mut out);
    let a = sim.authority();
    let (l0, l1) = (line(&sim, 0), line(&sim, 1));
    assert_eq!(
        a.transport().lines_len(),
        2,
        "the next tick executed both chains"
    );
    assert_eq!(
        a.transport().out(l0),
        Ok(engine::transport::Output::Next(l1))
    );
    assert_eq!(
        a.transport().out(l1),
        Ok(engine::transport::Output::DeadEnd)
    );
    assert_eq!(
        a.store().entity_count(),
        1,
        "requests despawned; the spawner lives on"
    );
}
