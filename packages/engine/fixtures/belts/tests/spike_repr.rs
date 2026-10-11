//! M40's item-representation spike (docs/decisions/0077, `docs/plan/40-item-representation-spike.md`):
//! the per-item list (A) against linked runs (B1) and contiguous runs (B2), one rule, one world.
//!
//! - `bench_world_*`: the standard world of `common/world.rs` is deterministic and has the stated
//!   size.
//! - `repr_rule_cases`: one table of hand-computed cases (0076 §2's rule) every candidate passes
//!   before it is timed. `repr_candidates_agree`: the three give identical lines tick by tick on the
//!   1/64 mixed and inserter-like worlds. `repr_no_alloc_small`: none allocates per tick.
//! - `slow_spike_item_representation`: the measurement (release, one `BENCH_SAMPLE` per candidate x
//!   regime). Its numbers are recorded in 0077's Amendment; M45 deletes this file.
//!
//! Own test binary: it installs the engine's counting allocator for `thread_live_bytes`.

mod common;

use common::repr::{Driver, Refused, Repr};
use common::repr_a::ReprA;
use common::repr_b::{ReprB1, ReprB2};
use common::world::{
    BenchWorld, Item, LineIdx, LineSpec, Out, Regime, SPACING, SPEED, TILE, bench_world,
    bench_world_scaled, update_order,
};
use engine::abi::Arena;
use engine::bytes::SliceSink;

#[global_allocator]
static ALLOCATOR: Arena = Arena;

const SEED: u64 = 7;
/// The fast tests' world: 1/64 of the standard one (~780 tiles, ~3,900 items).
const SMALL: u32 = 64;

// ---- the world ----

#[test]
fn bench_world_is_deterministic() {
    for regime in Regime::ALL {
        let a = bench_world(SEED, regime);
        let b = bench_world(SEED, regime);
        assert_eq!(a, b, "{regime:?}: two builds differ");
        assert_ne!(
            a.lines,
            bench_world(SEED + 1, regime).lines,
            "{regime:?}: the seed changes nothing"
        );
    }
}

fn check_world(w: &BenchWorld, tiles: u64, items: u64) {
    let name = w.regime.name();
    // Exact, against literals (0069 §2: never the constant under test): the tile loop stops at
    // the target and the item shares use cumulative rounding, so the builder is exact.
    assert_eq!(w.tiles(), tiles, "{name}: tiles");
    assert_eq!(w.items(), items, "{name}: items");
    let mut rank = vec![usize::MAX; w.lines.len()];
    for (i, &l) in w.order.iter().enumerate() {
        rank[l as usize] = i;
    }
    for (i, l) in w.lines.iter().enumerate() {
        assert_eq!(l.len % TILE, 0, "{name}: line {i} len {}", l.len);
        assert_eq!(l.speed, SPEED);
        for p in l.items_at_rest.windows(2) {
            assert!(p[1].1 - p[0].1 >= SPACING, "{name}: line {i} spacing");
        }
        if let Some(&(_, last)) = l.items_at_rest.last() {
            assert!(last < l.len, "{name}: line {i} item past the end");
        }
        if let Out::Next(t) = l.out {
            assert!(
                rank[i] > rank[t as usize],
                "{name}: line {i} before its target"
            );
            let t = &w.lines[t as usize];
            if let (Some(&(_, front)), Some(&(_, tail))) =
                (l.items_at_rest.first(), t.items_at_rest.last())
            {
                assert!(
                    front + t.len - tail >= SPACING,
                    "{name}: line {i} hand-off spacing"
                );
            }
        }
    }
}

#[test]
fn bench_world_counts() {
    for regime in Regime::ALL {
        let w = bench_world(SEED, regime);
        check_world(&w, 50_000, 250_000);
        let s = bench_world_scaled(SEED, regime, SMALL);
        check_world(&s, 781, 3_906);
    }
    let w = bench_world(SEED, Regime::InserterLike);
    assert_eq!(w.inserter_calls, 2_000);
    assert_eq!(w.lines, bench_world(SEED, Regime::Mixed).lines);
}

// ---- the rule ----

#[derive(Clone)]
enum Op {
    Tick,
    Back(LineIdx, Item, Result<(), Refused>),
    At(LineIdx, u32, Item, Result<(), Refused>),
    Remove(LineIdx, u32, Option<Item>),
    Expect(LineIdx, &'static [(Item, u32)]),
    Sunk(u64),
}
use Op::*;

struct Case {
    name: &'static str,
    lines: Vec<LineSpec>,
    ops: Vec<Op>,
}

fn line(len: u32, speed: u16, out: Out, items: &[(Item, u32)]) -> LineSpec {
    LineSpec {
        len,
        speed,
        out,
        items_at_rest: items.to_vec(),
    }
}

const OK: Result<(), Refused> = Ok(());
const NO_ROOM: Result<(), Refused> = Err(Refused::NoRoom);

fn cases() -> Vec<Case> {
    use Out::{DeadEnd, Next, Sink};
    vec![
        Case {
            name: "free move",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 500)])],
            ops: vec![Tick, Expect(0, &[(1, 476)])],
        },
        Case {
            name: "dead end stops at 0",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 10)])],
            ops: vec![Tick, Expect(0, &[(1, 0)]), Tick, Expect(0, &[(1, 0)])],
        },
        Case {
            name: "squash against the leader's new position",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 10), (2, 80), (3, 200)])],
            ops: vec![
                Tick,
                Expect(0, &[(1, 0), (2, 64), (3, 176)]),
                Tick,
                Expect(0, &[(1, 0), (2, 64), (3, 152)]),
            ],
        },
        Case {
            // 12 §3c's observed advance of 6 at speed 8 (there from a squashed pair, which these
            // primitives cannot build: the leader stops 4 short, the follower closes 70 - 64).
            name: "squash advance min(speed, gap_after - 64) at speed 8",
            lines: vec![line(512, 8, DeadEnd, &[(1, 4), (2, 70)])],
            ops: vec![Tick, Expect(0, &[(1, 0), (2, 64)])],
        },
        Case {
            // 12 §3c's squashed pair ("however it arose"), across a hand-off: `insert_at` checks
            // its own line only, so an item inserted 54 behind the feeder's front item makes a
            // gap under 64 across the boundary. The rear holds while the gap stays under 64 and
            // then advances by exactly `gap_after_leader_move - 64` (6 here: §3c's own number).
            name: "squashed pair across a hand-off holds, then closes to 64",
            lines: vec![
                line(512, 8, DeadEnd, &[(1, 300)]),
                line(512, 8, Next(0), &[(2, 0)]),
            ],
            ops: vec![
                At(0, 458, 3, OK),
                Tick,
                Expect(0, &[(1, 292), (3, 450)]),
                Expect(1, &[(2, 0)]),
                Tick,
                Expect(0, &[(1, 284), (3, 442), (2, 506)]),
                Expect(1, &[]),
            ],
        },
        Case {
            // The same crossing as "speed 72: two items cross" with one kind, so B's front run has
            // `count > 1` and the two landed items merge into one run on the target.
            name: "speed 72: two items of one run cross and merge on landing",
            lines: vec![
                line(512, 72, DeadEnd, &[]),
                line(512, 72, Next(0), &[(1, 0), (1, 64), (1, 128)]),
            ],
            ops: vec![
                Tick,
                Expect(0, &[(1, 440), (1, 504)]),
                Expect(1, &[(1, 56)]),
                Tick,
                Expect(0, &[(1, 368), (1, 432), (1, 496)]),
                Expect(1, &[]),
            ],
        },
        Case {
            name: "insert_at refuses at 63, remove_at misses at 33",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 100)])],
            ops: vec![
                At(0, 163, 2, NO_ROOM),
                At(0, 37, 2, NO_ROOM),
                Remove(0, 133, None),
                Remove(0, 67, None),
                Expect(0, &[(1, 100)]),
            ],
        },
        Case {
            name: "hand-off into an empty line",
            lines: vec![
                line(512, 24, DeadEnd, &[]),
                line(512, 24, Next(0), &[(1, 10)]),
            ],
            ops: vec![Tick, Expect(0, &[(1, 498)]), Expect(1, &[])],
        },
        Case {
            name: "hand-off squashed against the target's tail",
            lines: vec![
                line(512, 24, DeadEnd, &[(1, 470)]),
                line(512, 24, Next(0), &[(2, 10)]),
            ],
            ops: vec![Tick, Expect(0, &[(1, 446), (2, 510)]), Expect(1, &[])],
        },
        Case {
            name: "hand-off blocked by a full target",
            lines: vec![
                line(256, 24, DeadEnd, &[(1, 0), (1, 64), (1, 128), (1, 192)]),
                line(512, 24, Next(0), &[(2, 0), (3, 64), (4, 300)]),
            ],
            ops: vec![
                Tick,
                Expect(0, &[(1, 0), (1, 64), (1, 128), (1, 192)]),
                Expect(1, &[(2, 0), (3, 64), (4, 276)]),
            ],
        },
        Case {
            name: "speed 72: two items cross in one tick",
            lines: vec![
                line(512, 72, DeadEnd, &[]),
                line(512, 72, Next(0), &[(1, 0), (2, 64), (3, 128)]),
            ],
            ops: vec![
                Tick,
                Expect(0, &[(1, 440), (2, 504)]),
                Expect(1, &[(3, 56)]),
                Tick,
                Expect(0, &[(1, 368), (2, 432), (3, 496)]),
                Expect(1, &[]),
            ],
        },
        Case {
            name: "speed 72: dead end",
            lines: vec![line(512, 72, DeadEnd, &[(1, 30), (2, 100)])],
            ops: vec![Tick, Expect(0, &[(1, 0), (2, 64)])],
        },
        Case {
            name: "sink deletes and counts",
            lines: vec![line(512, 24, Sink, &[(1, 10), (2, 74), (3, 200)])],
            ops: vec![Tick, Expect(0, &[(2, 50), (3, 176)]), Sunk(1)],
        },
        Case {
            name: "speed 72: sink takes two in one tick",
            lines: vec![line(512, 72, Sink, &[(1, 0), (2, 64), (3, 200)])],
            ops: vec![Tick, Expect(0, &[(3, 128)]), Sunk(2)],
        },
        Case {
            name: "insert_back lands at max(len - speed, tail + 64)",
            lines: vec![line(512, 24, DeadEnd, &[])],
            ops: vec![
                Back(0, 1, OK),
                Expect(0, &[(1, 488)]),
                Back(0, 2, NO_ROOM),
                Tick,
                Back(0, 2, NO_ROOM),
                Tick,
                Back(0, 2, OK),
                Expect(0, &[(1, 440), (2, 504)]),
            ],
        },
        Case {
            name: "a compression front packs a dead end",
            lines: vec![line(
                512,
                24,
                DeadEnd,
                &[(1, 100), (1, 200), (1, 300), (2, 400)],
            )],
            ops: [
                vec![Tick; 20],
                vec![
                    Expect(0, &[(1, 0), (1, 64), (1, 128), (2, 192)]),
                    Back(0, 3, OK),
                    Expect(0, &[(1, 0), (1, 64), (1, 128), (2, 192), (3, 488)]),
                ],
            ]
            .concat(),
        },
        Case {
            name: "a jam released from the front",
            lines: vec![
                line(256, 24, DeadEnd, &[(1, 0), (1, 64), (1, 128), (1, 192)]),
                line(256, 24, Next(0), &[(2, 0), (3, 64), (4, 128), (5, 192)]),
            ],
            ops: vec![
                Tick,
                Remove(0, 0, Some(1)),
                Tick,
                Expect(0, &[(1, 40), (1, 104), (1, 168), (2, 232)]),
                Expect(1, &[(3, 40), (4, 104), (5, 168)]),
            ],
        },
        Case {
            name: "insert_at needs 64 clear on both sides",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 100), (2, 300)])],
            ops: vec![
                At(0, 164, 3, OK),
                At(0, 200, 4, NO_ROOM),
                At(0, 236, 4, OK),
                At(0, 300, 6, NO_ROOM),
                At(0, 1024, 5, NO_ROOM),
                At(0, 1023, 5, OK),
                At(0, 50, 6, NO_ROOM),
                At(0, 36, 6, OK),
                Expect(
                    0,
                    &[(6, 36), (1, 100), (3, 164), (4, 236), (2, 300), (5, 1023)],
                ),
            ],
        },
        Case {
            name: "insert_at and remove_at inside a packed same-item stretch",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 0), (1, 128), (1, 192)])],
            ops: vec![
                At(0, 64, 1, OK),
                Expect(0, &[(1, 0), (1, 64), (1, 128), (1, 192)]),
                Remove(0, 100, Some(1)),
                Expect(0, &[(1, 0), (1, 64), (1, 192)]),
                Remove(0, 32, Some(1)),
                Expect(0, &[(1, 64), (1, 192)]),
                At(0, 128, 2, OK),
                At(0, 0, 1, OK),
                Expect(0, &[(1, 0), (1, 64), (2, 128), (1, 192)]),
                Tick,
                Expect(0, &[(1, 0), (1, 64), (2, 128), (1, 192)]),
            ],
        },
        Case {
            name: "remove_at takes the nearest within 32",
            lines: vec![line(1024, 24, DeadEnd, &[(1, 100), (2, 300)])],
            ops: vec![
                Remove(0, 310, Some(2)),
                Remove(0, 50, None),
                Remove(0, 132, Some(1)),
                Expect(0, &[]),
            ],
        },
    ]
}

fn run_case<R: Repr>(c: &Case) {
    let order = update_order(&c.lines);
    let mut r = R::build(&c.lines);
    let mut got = Vec::new();
    for (i, op) in c.ops.iter().enumerate() {
        let at = format!("{} '{}' op {i}", R::NAME, c.name);
        match *op {
            Tick => r.advance(&order),
            Back(l, item, want) => assert_eq!(r.insert_back(l, item), want, "{at}: insert_back"),
            At(l, pos, item, want) => {
                assert_eq!(r.insert_at(l, pos, item), want, "{at}: insert_at {pos}")
            }
            Remove(l, pos, want) => assert_eq!(r.remove_at(l, pos), want, "{at}: remove_at {pos}"),
            Expect(l, want) => {
                r.items(l, &mut got);
                assert_eq!(got, want, "{at}: line {l} (item, pos)");
            }
            Sunk(n) => assert_eq!(r.sunk(), n, "{at}: sunk"),
        }
    }
}

#[test]
fn repr_rule_cases() {
    for c in &cases() {
        run_case::<ReprA>(c);
        run_case::<ReprB1>(c);
        run_case::<ReprB2>(c);
    }
}

#[test]
fn repr_candidates_agree() {
    for regime in [Regime::Mixed, Regime::InserterLike] {
        let w = bench_world_scaled(SEED, regime, SMALL);
        let (mut a, mut b1, mut b2) = (
            ReprA::build(&w.lines),
            ReprB1::build(&w.lines),
            ReprB2::build(&w.lines),
        );
        let (mut da, mut d1, mut d2) = (Driver::new(&w), Driver::new(&w), Driver::new(&w));
        let (mut ia, mut i1, mut i2) = (Vec::new(), Vec::new(), Vec::new());
        let mut moved = 0u64;
        for tick in 0..200 {
            da.tick(&w, &mut a);
            d1.tick(&w, &mut b1);
            d2.tick(&w, &mut b2);
            for l in 0..w.lines.len() as LineIdx {
                a.items(l, &mut ia);
                b1.items(l, &mut i1);
                b2.items(l, &mut i2);
                assert_eq!(i1, ia, "{regime:?} tick {tick} line {l}: B1 vs A");
                assert_eq!(i2, ia, "{regime:?} tick {tick} line {l}: B2 vs A");
                moved += ia.len() as u64;
            }
            assert_eq!(
                (b1.sunk(), b2.sunk()),
                (a.sunk(), a.sunk()),
                "{regime:?} tick {tick}: sunk"
            );
            let counts = |d: &Driver| (d.spawned, d.inserted, d.removed);
            assert_eq!(counts(&d1), counts(&da), "{regime:?} tick {tick}: B1 calls");
            assert_eq!(counts(&d2), counts(&da), "{regime:?} tick {tick}: B2 calls");
        }
        // The world did something: items sank, spawned and (inserter-like) were inserted/removed.
        assert!(
            a.sunk() > 0 && da.spawned > 0 && moved > 0,
            "{regime:?}: idle world"
        );
        if regime == Regime::InserterLike {
            assert!(
                da.inserted > 0 && da.removed > 0,
                "no inserter call succeeded"
            );
        }
    }
}

/// `(live delta, high-water delta)` over `ticks`. `thread_live_bytes` is net, so an allocation
/// freed inside the same tick is invisible to it (`crates/engine/CLAUDE.md` "Tests"); the
/// high-water mark sees it once live bytes sit exactly at the mark, which the padding arranges.
fn alloc_deltas<R: Repr>(w: &BenchWorld, ticks: u32) -> (isize, isize) {
    use engine::abi::arena::{thread_high_water_bytes, thread_live_bytes};
    let mut r = R::build(&w.lines);
    let mut d = Driver::new(w);
    let pad = (thread_high_water_bytes() - thread_live_bytes()).max(0) as usize + 1;
    let _pad = vec![0u8; pad];
    let (live0, high0) = (thread_live_bytes(), thread_high_water_bytes());
    assert_eq!(live0, high0, "padding did not reach the high-water mark");
    for _ in 0..ticks {
        d.tick(w, &mut r);
    }
    (
        thread_live_bytes() - live0,
        thread_high_water_bytes() - high0,
    )
}

#[test]
fn repr_no_alloc_small() {
    for regime in [Regime::Mixed, Regime::InserterLike] {
        let w = bench_world_scaled(SEED, regime, SMALL);
        assert_eq!(alloc_deltas::<ReprA>(&w, 100), (0, 0), "A {regime:?}");
        assert_eq!(alloc_deltas::<ReprB1>(&w, 100), (0, 0), "B1 {regime:?}");
        assert_eq!(alloc_deltas::<ReprB2>(&w, 100), (0, 0), "B2 {regime:?}");
    }
}

// ---- the measurement ----

const WARMUP: u32 = 200;
const MEASURED: usize = 1_200;

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let idx = ((p * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[idx]
}

#[allow(clippy::disallowed_types)] // the harness's own timer never reaches the measured state (0002 §2)
fn measure<R: Repr>(w: &BenchWorld, encode_buf: &mut [u8]) -> String {
    use std::time::Instant;
    let mut r = R::build(&w.lines);
    let mut d = Driver::new(w);
    for _ in 0..WARMUP {
        d.tick(w, &mut r);
    }
    // `SPIKE_PROFILE_REPEAT=n`: after the measurement, re-run the measured window n more times from
    // a copy of the warmed state (untimed), so a sampling profiler sees mostly this cell's ticks.
    let repeat: u32 = std::env::var("SPIKE_PROFILE_REPEAT")
        .ok()
        .map_or(0, |v| v.parse().expect("SPIKE_PROFILE_REPEAT is a count"));
    let warmed = (repeat > 0).then(|| (r.clone(), d.clone()));
    let mut tick_us = Vec::with_capacity(MEASURED);
    let mut adv_us = Vec::with_capacity(MEASURED);
    let live0 = engine::abi::arena::thread_live_bytes();
    for _ in 0..MEASURED {
        let t0 = Instant::now();
        d.game_phase(w, &mut r);
        let t1 = Instant::now();
        r.advance(&w.order);
        let t2 = Instant::now();
        tick_us.push((t2 - t0).as_secs_f64() * 1e6);
        adv_us.push((t2 - t1).as_secs_f64() * 1e6);
    }
    let alloc = engine::abi::arena::thread_live_bytes() - live0;
    if let Some((r0, d0)) = &warmed {
        for _ in 0..repeat {
            let (mut r1, mut d1) = (r0.clone(), d0.clone());
            for _ in 0..MEASURED {
                d1.tick(w, &mut r1);
            }
        }
    }
    let mut enc_us = Vec::new();
    let mut bytes = 0;
    for _ in 0..5 {
        let t0 = Instant::now();
        let mut sink = SliceSink::new(encode_buf);
        r.encode(&mut sink);
        bytes = sink.finish().expect("encode buffer large enough");
        enc_us.push(t0.elapsed().as_secs_f64() * 1e6);
    }
    let sort = |v: &mut Vec<f64>| v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    sort(&mut tick_us);
    sort(&mut adv_us);
    sort(&mut enc_us);
    let items: u64 = (0..w.lines.len() as LineIdx)
        .map(|l| {
            let mut v = Vec::new();
            r.items(l, &mut v);
            v.len() as u64
        })
        .sum();
    println!(
        "{} {}: tick median {:.1} us p99 {:.1} max {:.1}; advance median {:.1} us; encode {} B in \
         {:.1} us; alloc {} B; end state {} items, {} sunk, {} spawned, {} inserter calls ({} inserted, \
         {} removed)",
        R::NAME,
        w.regime.name(),
        percentile(&tick_us, 0.5),
        percentile(&tick_us, 0.99),
        tick_us[MEASURED - 1],
        percentile(&adv_us, 0.5),
        bytes,
        percentile(&enc_us, 0.5),
        alloc,
        items,
        r.sunk(),
        d.spawned,
        d.calls,
        d.inserted,
        d.removed,
    );
    format!(
        "{{\"candidate\":\"{}\",\"regime\":\"{}\",\"medianUs\":{:.1},\"p99Us\":{:.1},\"maxUs\":{:.1},\
         \"encodeBytes\":{bytes},\"encodeUs\":{:.1},\"allocDeltaBytes\":{alloc},\"advanceMedianUs\":{:.1}}}",
        R::NAME,
        w.regime.name(),
        percentile(&tick_us, 0.5),
        percentile(&tick_us, 0.99),
        tick_us[MEASURED - 1],
        percentile(&enc_us, 0.5),
        percentile(&adv_us, 0.5),
    )
}

/// The spike's measurement: 3 candidates x 4 regimes, 200 warm-up ticks then 1,200 measured
/// (spawners, inserter-like calls and advance; `advanceMedianUs` is the advance alone). Release
/// only: the dev-profile run re-runs itself with `cargo test --release` and echoes the cells.
/// `SPIKE_ONLY=<candidate>/<regime>` (e.g. `B1/mixed`) measures one cell; with
/// `SPIKE_PROFILE_REPEAT=<n>` it re-runs that window n times untimed, for a profiler.
#[test]
fn slow_spike_item_representation() {
    if cfg!(debug_assertions) {
        let samples = common::bench_run::run_in_release_samples(
            "spike_repr",
            "slow_spike_item_representation",
        );
        assert_eq!(samples.len(), 12, "one cell per candidate x regime");
        for s in &samples {
            println!("BENCH_SAMPLE {s}");
        }
        // nextest hides a passing test's stdout: the cells are also recorded beside the gated
        // benchmarks' records (a spike records, it does not gate).
        let dir = common::bench_run::repo_root().join("test-results/rust/bench");
        std::fs::create_dir_all(&dir).expect("test-results/rust/bench");
        let path = dir.join("spike-item-representation.json");
        std::fs::write(&path, format!("[\n{}\n]\n", samples.join(",\n")))
            .expect("writing the spike's record");
        println!("recorded {}", path.display());
        return;
    }
    let only = std::env::var("SPIKE_ONLY").ok();
    let mut buf = vec![0u8; 16 << 20];
    for regime in Regime::ALL {
        let w = bench_world(SEED, regime);
        let want = |c: &str| {
            only.as_deref()
                .is_none_or(|o| o == format!("{c}/{}", regime.name()))
        };
        if want("A") {
            println!("BENCH_SAMPLE {}", measure::<ReprA>(&w, &mut buf));
        }
        if want("B1") {
            println!("BENCH_SAMPLE {}", measure::<ReprB1>(&w, &mut buf));
        }
        if want("B2") {
            println!("BENCH_SAMPLE {}", measure::<ReprB2>(&w, &mut buf));
        }
    }
}
