//! The `fx-belts` goldens (M42b): each `golden/scenario*.json` is replayed natively through
//! `Sim<Belts>` (the call sequence `Host<Belts>`'s `sim_genesis`/`sim_tick` make; the scenario file
//! itself is parsed, so the native script cannot drift from the one `pnpm golden belts` runs under
//! Node) and compared with the `.wasm`-written hash. Each test also asserts its scenario's property
//! after every tick (0069 §3: a hash alone cannot catch a self-consistent error).
//!
//! `transport_request_is_deferred_to_tick` pins that `apply` only spawns the request and
//! `Belts::tick` executes it; the `belts_op_*` smoke tests run each M43b op once.
//!
//! A script scenario holds at most 32 actions: `runScriptScenario` feeds them through an encoder
//! client whose pending queue (0012, capacity 32) is never acked, so the 33rd `on_action` fails
//! `OutOfMemory` under Node (why `inserter-like` runs 14 ticks).

use engine::game::{PlayerEvent, PlayerId, WorldRead, WorldWrite};
use engine::sim::{Record, Sim, WorldParams};
use engine::time::Tick;
use engine::transport::{Item, LineId, Output, SPACING};
use engine::world::{ChunkCoord, ChunkDims, TilePos, WorldPos};
use fx_belts::{Action, Belts, Dir, Op, Pos, Seg, Tally, Thing, WPos};

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
    census_without(sim, LineId::NONE)
}

/// [`census`] skipping `dead`, a line `Join` destroyed (its table slot keeps the id, and it held
/// no `Sink`); every other line must exist.
fn census_without(sim: &Sim<Belts>, dead: LineId) -> (u64, u64, u64) {
    let a = sim.authority();
    let g = a.global();
    let (mut live, mut sunk) = (0, 0);
    for i in 0..g.chains {
        let l = g.line(i);
        if dead != LineId::NONE && l == dead {
            continue;
        }
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
    assert_eq!(a.transport().out(l0), Ok(Output::Next(l1)));
    assert_eq!(a.transport().out(l1), Ok(Output::DeadEnd));
    assert_eq!(
        a.store().entity_count(),
        1,
        "requests despawned; the spawner lives on"
    );
}

/// The tally of accepted `Insert`/`Remove`/`TakeFront` requests (zero before the first).
fn tally(sim: &Sim<Belts>) -> Tally {
    let mut t = Tally::default();
    for (_, e) in sim.authority().store().entities() {
        if let Thing::Tally(c) = e {
            t = *c;
        }
    }
    t
}

/// Every place two items are closer than `SPACING`: on a live line, and across each `Next`
/// boundary (the target's rearmost item to the feeder's front item along the path).
fn short_gaps(sim: &Sim<Belts>) -> Vec<String> {
    let tr = sim.authority().transport();
    let g = sim.authority().global();
    let mut v = Vec::new();
    for i in 0..g.chains {
        let l = g.line(i);
        let Ok(out) = tr.out(l) else { continue };
        let p: Vec<u32> = items(sim, l).iter().map(|&(_, p)| p).collect();
        for k in 1..p.len() {
            if p[k] - p[k - 1] < SPACING {
                v.push(format!("chain {i}: {} -> {}", p[k - 1], p[k]));
            }
        }
        if let (Output::Next(to), Some(&front)) = (out, p.first()) {
            let tail = items(sim, to).last().map(|&(_, p)| p);
            let tlen = tr.len(to).expect("target");
            if let Some(tail) = tail
                && front + tlen - tail < SPACING
            {
                v.push(format!("chain {i} front {front} -> target tail {tail}"));
            }
        }
    }
    v
}

fn positions(sim: &Sim<Belts>, chain: u32) -> Vec<u32> {
    items(sim, line(sim, chain))
        .iter()
        .map(|&(_, p)| p)
        .collect()
}

/// `edit-while-running`: chain 0 (4 tiles) `Next` chain 1 (4 tiles, `Sink`), speed 24, a
/// saturating spawner on chain 0; edits while items flow: tick 60 `Cut` chain 1 at 512 (chain 2 is
/// its back half), tick 100 `Join` 1 + 2, tick 130 `Extend` chain 0 at the front and chain 1 at
/// the back by 256, tick 170 `Rescale` chain 0 1280 -> 1200 (every packed pair 64 -> 60 apart:
/// squashed). After every tick: `spawned == live + sunk`, and every gap on a line and across each
/// `Next` boundary is at least `SPACING` except in ticks 170-172, while the squash rule resolves
/// the rescaled pairs (an item inside its bound waits: `d = clamp(gap + d_ahead, 0, speed)`).
#[test]
fn belts_golden_edit_while_running() {
    let mut prev: Vec<Vec<u32>> = Vec::new();
    let mut squashed = Vec::new();
    let mut last = (0, 0, 0);
    let hash = run("scenario-edit-while-running.json", &mut |sim| {
        let t = sim.tick().0;
        let tr = sim.authority().transport();
        let now: Vec<Vec<u32>> = (0..3).map(|i| positions_or_empty(sim, i)).collect();
        // Chain 2 is the back half `Join` destroyed in tick 100.
        let dead = if t >= 100 { line(sim, 2) } else { LineId::NONE };
        let (live, sunk, spawned) = census_without(sim, dead);
        assert_eq!(spawned, live + sunk, "tick {t}: conservation");
        last = (live, sunk, spawned);
        if !short_gaps(sim).is_empty() {
            squashed.push(t);
        }
        let moved = |v: &[u32], by: i64| -> Vec<u32> {
            v.iter().map(|&p| (i64::from(p) + by) as u32).collect()
        };
        match t {
            60 => {
                // The cut: chain 1 keeps [0, 512) (empty), chain 2 has the rest, then moves 24.
                assert_eq!(tr.len(line(sim, 1)), Ok(512), "tick 60: front part");
                assert_eq!(tr.len(line(sim, 2)), Ok(512), "tick 60: back part");
                assert_eq!(tr.out(line(sim, 2)), Ok(Output::Next(line(sim, 1))));
                assert_eq!(tr.out(line(sim, 0)), Ok(Output::Next(line(sim, 2))));
                assert!(
                    now[1].is_empty(),
                    "tick 60: chain 1 below the cut was empty"
                );
                assert_eq!(now[2], moved(&prev[1], -512 - 24), "tick 60: cut at 512");
            }
            100 => {
                assert_eq!(tr.len(line(sim, 2)), Err(engine::game::Unknown), "joined");
                assert_eq!(tr.len(line(sim, 1)), Ok(1024), "tick 100: joined length");
                assert_eq!(tr.out(line(sim, 0)), Ok(Output::Next(line(sim, 1))));
                let joined: Vec<u32> = prev[1]
                    .iter()
                    .copied()
                    .chain(prev[2].iter().map(|&p| p + 512))
                    .collect();
                assert_eq!(
                    now[1],
                    moved(&joined, -24),
                    "tick 100: back appended at 512"
                );
            }
            130 => {
                assert_eq!(tr.len(line(sim, 0)), Ok(1280), "tick 130: chain 0 extended");
                assert_eq!(tr.len(line(sim, 1)), Ok(1280), "tick 130: chain 1 extended");
                assert_eq!(
                    now[0][..16],
                    moved(&prev[0], 256 - 24),
                    "tick 130: front +256"
                );
                // `extend_back` leaves positions alone (only the item at 16 sank), where
                // `extend_front` would have moved them by 256.
                let back: Vec<u32> = prev[1]
                    .iter()
                    .filter(|&&p| p >= 24)
                    .map(|&p| p - 24)
                    .collect();
                assert_eq!(now[1], back, "tick 130: chain 1 extended at the back");
            }
            170 => assert_eq!(
                now[0], RESCALED[0],
                "tick 170: rescaled, then the squash rule"
            ),
            171 => assert_eq!(now[0], RESCALED[1], "tick 171: the squash rule"),
            _ => {}
        }
        prev = now;
    });
    assert_eq!(squashed, [170, 171, 172], "ticks with a gap under SPACING");
    assert_eq!(last, (39, 58, 97), "final (live, sunk, spawned)");
    engine::testing::assert_golden_named(
        env!("CARGO_MANIFEST_DIR"),
        "golden-edit-while-running.json",
        &[hash],
    );
}

/// Chain 0 at the end of ticks 170 and 171. Before tick 170 it held `16 + 64k` (k = 0..19); the
/// rescale put them at `floor((16 + 64k) x 1200 / 1280) = 15 + 60k`. Tick 170: the front item hands
/// off but lands `SPACING` behind chain 1's tail (moves 23); then each moves
/// `clamp(-4 + d_ahead, 0, 24)`: 19, 15, 11, 7, 3, 0, ... Tick 171: 24 for the items ahead of
/// 375, 23 for it (`gap -1 + 24`), 19, 15, 11, 7, 3 for the five behind it, then 0 from the
/// still-squashed pair at 735 back.
const RESCALED: [&[u32]; 2] = [
    &[
        56, 120, 184, 248, 312, 375, 435, 495, 555, 615, 675, 735, 795, 855, 915, 975, 1035, 1095,
        1155,
    ],
    &[
        32, 96, 160, 224, 288, 352, 416, 480, 544, 608, 672, 735, 795, 855, 915, 975, 1035, 1095,
        1155,
    ],
];

/// Chain `i`'s positions, empty for a destroyed or absent line.
fn positions_or_empty(sim: &Sim<Belts>, i: u32) -> Vec<u32> {
    if sim.authority().transport().len(line(sim, i)).is_ok() {
        positions(sim, i)
    } else {
        Vec::new()
    }
}

/// `inserter-like`: one 8-tile line (2048, speed 24, `Sink`) saturated by a `period` 256
/// spawner, so a packed stream (items exactly `SPACING` apart) moves over it; its front reaches 0
/// near tick 84. Ticks 100-113 each carry `Remove { pos: 800 }` then `Insert { pos: 800, item: 7 }`
/// (spawn order is execution order), the inserter's swap. After every tick
/// `inserted + spawned == live + removed + sunk` (the tally and the spawner), and every accepted
/// insert ends the tick as an item 7 at exactly `800 - 24` (landed at `pos`, then one free move)
/// with both neighbours at least `SPACING` away. In tick 100 the stream's phase (`2000 - 24 (t - 1)`
/// mod 64) puts an item exactly at 800: the swap lands in the removed item's slot inside the packed
/// stretch, so the line is the previous tick's moved 24 with only that item's kind changed (`7` at
/// 776 between 712 and 840). The other accepted inserts land in holes earlier removes made (a
/// remove within `SPACING / 2` of 800 also takes the previous tick's item 7).
#[test]
fn belts_golden_inserter_like() {
    let mut was = Tally::default();
    let mut accepted = Vec::new();
    let mut prev: Vec<(u16, u32)> = Vec::new();
    let hash = run("scenario-inserter-like.json", &mut |sim| {
        let t = sim.tick().0;
        let now = items(sim, line(sim, 0));
        let (live, sunk, spawned) = census(sim);
        let c = tally(sim);
        assert_eq!(c.taken, 0);
        assert_eq!(
            u64::from(c.inserted) + spawned,
            live + u64::from(c.removed) + sunk,
            "tick {t}: inserted + spawned == live + removed + sunk"
        );
        if c.inserted > was.inserted {
            assert_eq!(
                c.inserted,
                was.inserted + 1,
                "tick {t}: one insert per tick"
            );
            accepted.push(t);
            let k = now
                .iter()
                .position(|&x| x == (7, 800 - 24))
                .unwrap_or_else(|| panic!("tick {t}: the insert landed at 800: {now:?}"));
            assert!(
                (k == 0 || now[k].1 - now[k - 1].1 >= SPACING)
                    && (k + 1 == now.len() || now[k + 1].1 - now[k].1 >= SPACING),
                "tick {t}: neighbours of the insert: {now:?}"
            );
        }
        if t == 100 {
            let want: Vec<(u16, u32)> = prev
                .iter()
                .filter(|&&(_, p)| p >= 24)
                .map(|&(i, p)| if p == 800 { (7, 776) } else { (i, p - 24) })
                .collect();
            assert!(
                prev.contains(&(1, 800)),
                "tick 99: an item at 800: {prev:?}"
            );
            assert_eq!(now, want, "tick 100: a swap inside the packed stretch");
        }
        prev = now;
        was = c;
    });
    assert_eq!(
        accepted,
        [100, 102, 104, 105, 107, 108, 110, 112, 113],
        "ticks whose insert was accepted"
    );
    assert_eq!((was.inserted, was.removed), (9, 14), "final tally");
    engine::testing::assert_golden_named(
        env!("CARGO_MANIFEST_DIR"),
        "golden-inserter-like.json",
        &[hash],
    );
}

/// `geometry-arc`: a belt turning right, two lanes registered by `Segments` in tick 1 (each a
/// 4-tile `Chain` extended at the back by its curve lane first). The curve tile is (31, 32); its
/// inside corner, the arcs' centre, is world (8192, 8192). Front to back: a straight north-south
/// piece of 512 positions in column 31 (front point on the north edge of tile row 30), a quarter
/// arc from angle 128 (west of the centre) sweeping -64 (to south of it), a straight piece of 512
/// in row 32 going east. Inner lane: radius 67, arc 106 (len 1130); outer: radius 188, arc 295
/// (len 1319) (0.263 and 0.736 tiles; `games/reference/README.md`'s curve lane lengths). After
/// every tick `pos_to_world` at the segment boundaries is the hand-computed points below, and at
/// the checkpoint the chunk set, the anchor and `lines_at` of the curve tile are as stated.
#[test]
fn belts_golden_geometry_arc() {
    // (chain, pos, point). Straight: `from + (to - from) x o / len`; arc offset 0 is angle 128/256
    // (`(-r, 0)` from the centre, exact); inner offset 53 of 106 is angle 96/256 = 3/8 turn, the
    // table's diagonal entry 46341: `8192 + floor(67 x -46341 / 65536) = 8192 - 48`,
    // `8192 + floor(67 x 46341 / 65536) = 8192 + 47`.
    const POINTS: [(u32, u32, (i32, i32)); 10] = [
        (0, 0, (8125, 7680)),
        (0, 511, (8125, 8191)),
        (0, 512, (8125, 8192)),
        (0, 565, (8144, 8239)),
        (0, 618, (8192, 8259)),
        (0, 1129, (8703, 8259)),
        (1, 0, (8004, 7680)),
        (1, 512, (8004, 8192)),
        (1, 807, (8192, 8380)),
        (1, 1318, (8703, 8380)),
    ];
    let hash = run("scenario-geometry-arc.json", &mut |sim| {
        let t = sim.tick().0;
        let tr = sim.authority().transport();
        assert_eq!(tr.len(line(sim, 0)), Ok(1130));
        assert_eq!(tr.len(line(sim, 1)), Ok(1319));
        for (c, pos, (x, y)) in POINTS {
            assert_eq!(
                tr.pos_to_world(line(sim, c), pos),
                Ok(Some(WorldPos { x, y })),
                "tick {t}: chain {c} position {pos}"
            );
        }
        assert_eq!(
            tr.pos_to_world(line(sim, 0), 1130),
            Ok(None),
            "past the back"
        );
        let (live, sunk, spawned) = census(sim);
        assert_eq!(spawned, live + sunk, "tick {t}: conservation");
    });
    // The checkpoint's derived geometry (`Sim` keeps the world after `run`: rerun to read it).
    let sc = read_scenario("scenario-geometry-arc.json");
    let mut sim = new_sim(&sc.config.game);
    let mut out = Vec::new();
    let batch: Vec<Record<Belts>> = [PlayerEvent::Joined, PlayerEvent::Connected]
        .into_iter()
        .map(|ev| Record::Player { who: WHO, ev })
        .chain(sc.script[0].actions.iter().map(|a| Record::Action {
            who: WHO,
            seq: a.seq,
            action: a.action,
        }))
        .collect();
    sim.step(&batch, &mut out);
    let tr = sim.authority().transport();
    let dims = ChunkDims::new(5);
    for c in 0..2 {
        let l = line(&sim, c);
        let mut chunks = Vec::new();
        tr.chunks_of(l, dims, &mut |k| chunks.push(k))
            .expect("line");
        assert_eq!(
            chunks,
            [
                ChunkCoord::new(0, 0),
                ChunkCoord::new(0, 1),
                ChunkCoord::new(1, 1)
            ],
            "chain {c}: column 31 rows 30-31, the curve (31, 32), row 32 columns 32-33"
        );
        assert_eq!(
            tr.anchor(l, dims),
            Ok(Some(ChunkCoord::new(0, 0))),
            "chain {c}: anchor"
        );
        let mut n = 0;
        tr.segments(l, &mut |_| n += 1).expect("line");
        assert_eq!(n, 3, "chain {c}: three segments");
    }
    let mut at = Vec::new();
    tr.lines_at(TilePos::new(31, 32), &mut |l, o| at.push((l, o)))
        .expect("reserved");
    assert_eq!(
        at,
        [(line(&sim, 0), 512), (line(&sim, 1), 512)],
        "the curve tile names both lanes, each from its arc's first position"
    );
    engine::testing::assert_golden_named(
        env!("CARGO_MANIFEST_DIR"),
        "golden-geometry-arc.json",
        &[hash],
    );
}

/// Runs each slice of ops as one tick's requests (the first tick also connects the player).
fn smoke(ticks: &[&[Op]]) -> Sim<Belts> {
    let sc = read_scenario("scenario.json");
    let mut sim = new_sim(&sc.config.game);
    let mut out = Vec::new();
    let mut seq = 0;
    for (k, ops) in ticks.iter().enumerate() {
        let mut batch: Vec<Record<Belts>> = Vec::new();
        if k == 0 {
            for ev in [PlayerEvent::Joined, PlayerEvent::Connected] {
                batch.push(Record::Player { who: WHO, ev });
            }
        }
        for op in *ops {
            seq += 1;
            batch.push(Record::Action {
                who: WHO,
                seq,
                action: Action::Request(*op),
            });
        }
        sim.step(&batch, &mut out);
        assert!(out.iter().all(|o| o.result.is_ok()), "tick {k}: applies");
    }
    sim
}

/// A `DeadEnd` chain of `tiles` with items at rest at `pos` (item `k + 1` at the `k`-th).
fn rest_chain(tiles: u16, pos: &[u32]) -> Op {
    let mut items_at_rest = [(0, 0); 8];
    for (k, &p) in pos.iter().enumerate() {
        items_at_rest[k] = (k as u16 + 1, p);
    }
    Op::Chain {
        from: Pos { x: 0, y: 0 },
        dir: Dir::East,
        tiles,
        speed: 24,
        items_at_rest,
    }
}

const PACKED: [u32; 8] = [0, 64, 128, 192, 256, 320, 384, 448];

#[test]
fn belts_op_cut_and_join() {
    let mut sim = smoke(&[&[rest_chain(2, &PACKED), Op::Cut { line: 0, at: 256 }]]);
    let tr = sim.authority().transport();
    let (a, b) = (line(&sim, 0), line(&sim, 1));
    assert_eq!((tr.len(a), tr.len(b)), (Ok(256), Ok(256)));
    assert_eq!(
        tr.out(b),
        Ok(Output::Next(a)),
        "the back part feeds the front part"
    );
    assert_eq!(positions(&sim, 0), [0, 64, 128, 192]);
    assert_eq!(
        positions(&sim, 1),
        [0, 64, 128, 192],
        "blocked by the front part's tail"
    );
    let mut out = Vec::new();
    sim.step(
        &[Record::Action {
            who: WHO,
            seq: 9,
            action: Action::Request(Op::Join { front: 0, back: 1 }),
        }],
        &mut out,
    );
    assert!(out[0].result.is_ok());
    let tr = sim.authority().transport();
    assert_eq!(tr.len(line(&sim, 0)), Ok(512));
    assert_eq!(
        tr.len(line(&sim, 1)),
        Err(engine::game::Unknown),
        "back destroyed"
    );
    assert_eq!(positions(&sim, 0), PACKED);
}

#[test]
fn belts_op_extend_and_shrink() {
    let sim = smoke(&[&[
        rest_chain(2, &[0, 64]),
        Op::Extend {
            line: 0,
            front: true,
            by: 100,
        },
        Op::Extend {
            line: 0,
            front: false,
            by: 50,
        },
    ]]);
    assert_eq!(sim.authority().transport().len(line(&sim, 0)), Ok(662));
    // +100, then one tick's free move (24) for the front item, the bound for the second.
    assert_eq!(positions(&sim, 0), [76, 140]);
    let sim = smoke(&[&[
        rest_chain(2, &[0, 64]),
        Op::Shrink {
            line: 0,
            front: false,
            by: 256,
        },
        Op::Shrink {
            line: 0,
            front: true,
            by: 1,
        },
    ]]);
    assert_eq!(sim.authority().transport().len(line(&sim, 0)), Ok(256));
    assert_eq!(
        positions(&sim, 0),
        [0, 64],
        "the front shrink is refused: NotEmpty"
    );
}

#[test]
fn belts_op_rescale_keeps_squashed_pairs() {
    let sim = smoke(&[&[
        rest_chain(4, &PACKED),
        Op::Rescale {
            line: 0,
            new_len: 512,
        },
    ]]);
    assert_eq!(sim.authority().transport().len(line(&sim, 0)), Ok(512));
    assert_eq!(positions(&sim, 0), [0, 32, 64, 96, 128, 160, 192, 224]);
}

#[test]
fn belts_op_insert_remove_take_front() {
    let sim = smoke(&[&[
        rest_chain(2, &[0, 64, 256]),
        Op::Insert {
            line: 0,
            pos: 400,
            item: 9,
        },
        Op::Insert {
            line: 0,
            pos: 420,
            item: 9,
        },
        Op::Remove { line: 0, pos: 270 },
        Op::Remove { line: 0, pos: 300 },
        Op::TakeFront { line: 0 },
    ]]);
    let c = tally(&sim);
    assert_eq!((c.inserted, c.removed, c.taken), (1, 1, 1));
    // Left: 64 (item 2) and 400 (item 9), then one tick's move: 40 and 376.
    assert_eq!(items(&sim, line(&sim, 0)), [(2, 40), (9, 376)]);
    let tallies = sim
        .authority()
        .store()
        .entities()
        .filter(|(_, e)| matches!(e, Thing::Tally(_)))
        .count();
    assert_eq!(tallies, 1, "one tally; the other requests despawned");
    assert_eq!(sim.authority().store().entity_count(), 1);
}

#[test]
fn belts_op_segments() {
    let straight = Seg::Straight {
        len: 512,
        from: WPos { x: 0, y: 128 },
        to: WPos { x: 512, y: 128 },
    };
    let sim = smoke(&[&[
        rest_chain(2, &[]),
        Op::Segments {
            line: 0,
            segments: [straight, Seg::None, Seg::None, Seg::None],
        },
    ]]);
    let tr = sim.authority().transport();
    let l = line(&sim, 0);
    assert_eq!(
        tr.pos_to_world(l, 100),
        Ok(Some(WorldPos { x: 100, y: 128 }))
    );
    let sim = smoke(&[&[
        rest_chain(2, &[]),
        Op::Segments {
            line: 0,
            segments: [straight, Seg::None, Seg::None, Seg::None],
        },
        Op::Extend {
            line: 0,
            front: false,
            by: 1,
        },
    ]]);
    let tr = sim.authority().transport();
    assert_eq!(
        tr.pos_to_world(line(&sim, 0), 100),
        Ok(None),
        "a surgery changing len clears the segments"
    );
}
