//! `transport_tick_no_alloc` (M42 Budgets, 0016's Rust side): `engine::transport` allocates nothing
//! per tick. Own test binary: a `#[global_allocator]` only counts allocations made inside the binary
//! that installs it (`crates/engine/CLAUDE.md` "Tests").
//!
//! The world is the M40 bench world's shape at 1/64 scale (`fixtures/belts/tests/common/world.rs`
//! `bench_world_scaled(.., Mixed, 64)`: about 780 belt tiles, two lanes each), rebuilt here
//! because `fx-belts` is not a dependency of the engine crate: belt chains of 1-6 lines of 4-48
//! tiles, each line `Next` into the one ahead; lane 0 of every chain sinks a packed stream fed by a
//! full-rate spawner, lane 1 dead-ends with spread items and a slow spawner (a compression front
//! moving back through it); alternate chains carry one kind or cycle six. The test drives the
//! spawners (`insert_back`) and 30 inserter-like `insert_at`/`remove_at` calls per tick (M40's
//! 2,000 at full scale / 64), then `advance`, for 600 ticks. Inside the window too (M42 review):
//! every 50 ticks a line is created, linked into the graph and fed, and the previous one destroyed
//! (the order recompute and both free lists run measured), and one chain runs at speed 72 (several
//! items cross a front per tick).
//!
//! `thread_live_bytes` is net, so an allocation freed within the window is invisible to it; the
//! high-water mark sees it once live bytes sit exactly at the mark, which the padding arranges
//! (M40's `alloc_deltas`). Both deltas must be 0. `transport_tick_no_alloc_control` injects one
//! growing `Vec` push per tick and must see the live delta rise.

use engine::abi::Arena;
use engine::abi::arena::{thread_high_water_bytes, thread_live_bytes};
use engine::rng::SimRng;
use engine::transport::{Item, LineId, Output, SPACING, Transport, TransportRead, TransportWrite};

#[global_allocator]
static ALLOCATOR: Arena = Arena;

const TILE: u32 = 256;
const SPEED: u16 = 24;
const KINDS: u16 = 6;
const BELT_TILES: u32 = 780;
const INSERTER_CALLS: u32 = 30;
const TICKS: u32 = 600;

struct Spawner {
    line: LineId,
    rate256: u16,
    acc: u16,
    next: u16,
    cycle: bool,
}

struct World {
    t: Transport,
    lines: Vec<LineId>,
    /// Lines made and destroyed inside the measured window (the order recompute and the free
    /// lists run there too); reserved up front.
    churn: Vec<LineId>,
    ticks: u32,
    spawners: Vec<Spawner>,
    rng: SimRng,
    sunk_lines: Vec<LineId>,
}

fn build() -> World {
    let mut rng = SimRng::new(7);
    // Belt chains: segment lengths in tiles, front first.
    let mut belts: Vec<Vec<u32>> = Vec::new();
    let mut placed = 0;
    while placed < BELT_TILES {
        let n = 1 + rng.below(6);
        let mut segs = Vec::new();
        for _ in 0..n {
            if placed == BELT_TILES {
                break;
            }
            let t = (4 + rng.below(45)).min(BELT_TILES - placed);
            segs.push(t);
            placed += t;
        }
        belts.push(segs);
    }
    // One extra chain at speed 72 (several items cross a front per tick), plus room for churn.
    belts.push(vec![8, 12, 6]);
    let line_count: u32 = belts.iter().map(|b| 2 * b.len() as u32).sum();
    let mut t = Transport::new(line_count + 4, 8_192);
    let fast = belts.len() - 1;
    let mut lines = Vec::new();
    let mut spawners = Vec::new();
    let mut sunk_lines = Vec::new();
    for (b, segs) in belts.iter().enumerate() {
        let same_kind = b % 2 == 0;
        for lane in 0..2u16 {
            let kind0 = (2 * b as u16 + lane) % KINDS;
            let kind = |j: u32| -> Item {
                if same_kind {
                    Item(kind0 + 1)
                } else {
                    Item(((u32::from(kind0) + j) % u32::from(KINDS)) as u16 + 1)
                }
            };
            let mut chain = Vec::new();
            let speed = if b == fast { 72 } else { SPEED };
            for &tiles in segs {
                let l = t.create(tiles * TILE, speed).expect("under the line cap");
                if let Some(&ahead) = chain.last() {
                    t.set_out(l, Output::Next(ahead)).unwrap();
                }
                chain.push(l);
                lines.push(l);
            }
            let front = chain[0];
            let mut j = 0u32;
            if lane == 0 {
                // Packed full from the front, sinking.
                t.set_out(front, Output::Sink).unwrap();
                sunk_lines.push(front);
                for &l in &chain {
                    let len = t.len(l).unwrap();
                    for pos in (0..len).step_by(SPACING as usize) {
                        t.insert_at(l, pos, kind(j)).unwrap();
                        j += 1;
                    }
                }
            } else {
                // Spread (one item per 4 spacings), dead-ended.
                for &l in &chain {
                    let len = t.len(l).unwrap();
                    for pos in (SPACING..len).step_by(4 * SPACING as usize) {
                        t.insert_at(l, pos, kind(j)).unwrap();
                        j += 1;
                    }
                }
            }
            spawners.push(Spawner {
                line: *chain.last().unwrap(),
                rate256: if lane == 0 { 256 } else { 24 },
                acc: 0,
                next: kind(j).0,
                cycle: !same_kind,
            });
        }
    }
    World {
        t,
        lines,
        churn: Vec::with_capacity(4),
        ticks: 0,
        spawners,
        rng: SimRng::seed_seq(7, 0x1A5E),
        sunk_lines,
    }
}

/// One tick: spawners (fractional rate, a refusal holds the accumulator), inserter-like calls,
/// then `advance`. `leak`: the negative control's injected per-tick growth.
fn tick(w: &mut World, leak: Option<&mut Vec<u64>>) {
    for s in &mut w.spawners {
        s.acc += s.rate256;
        if s.acc < 256 {
            continue;
        }
        if w.t.insert_back(s.line, Item(s.next)).is_ok() {
            s.acc -= 256;
            if s.cycle {
                s.next = s.next % KINDS + 1;
            }
        } else {
            s.acc = 256;
        }
    }
    let n = w.lines.len() as u32;
    for _ in 0..INSERTER_CALLS {
        let line = w.lines[w.rng.below(n) as usize];
        let pos = w.rng.below(w.t.len(line).unwrap());
        let item = Item(w.rng.below(u32::from(KINDS)) as u16 + 1);
        if w.rng.below(2) == 0 {
            let _ = w.t.insert_at(line, pos, item);
        } else {
            let _ = w.t.remove_at(line, pos);
        }
    }
    // Every 50 ticks: a new line fed one item and handing off into the graph, and the previous
    // one destroyed (graph changes inside the window).
    w.ticks += 1;
    if w.ticks.is_multiple_of(50) {
        let into = w.lines[w.rng.below(n) as usize];
        let l = w.t.create(8 * TILE, SPEED).expect("room for churn");
        w.t.set_out(l, Output::Next(into)).unwrap();
        let _ = w.t.insert_back(l, Item(1));
        if let Some(old) = w.churn.pop() {
            w.t.destroy(old, &mut |_| {}).unwrap();
        }
        w.churn.push(l);
    }
    w.t.advance();
    if let Some(v) = leak {
        v.push(u64::from(w.t.items_len()));
    }
}

/// `(live delta, high-water delta, sunk, items at the end)` over [`TICKS`].
fn run(leak: bool) -> (isize, isize, u64, u32) {
    let mut w = build();
    let mut leaked: Vec<u64> = Vec::new();
    let pad = (thread_high_water_bytes() - thread_live_bytes()).max(0) as usize + 1;
    let _pad = vec![0u8; pad];
    let (live0, high0) = (thread_live_bytes(), thread_high_water_bytes());
    assert_eq!(live0, high0, "padding did not reach the high-water mark");
    for _ in 0..TICKS {
        tick(&mut w, leak.then_some(&mut leaked));
    }
    let deltas = (
        thread_live_bytes() - live0,
        thread_high_water_bytes() - high0,
    );
    let sunk = w.sunk_lines.iter().map(|&l| w.t.sunk(l).unwrap()).sum();
    (deltas.0, deltas.1, sunk, w.t.items_len())
}

#[test]
fn transport_tick_no_alloc() {
    let (live, high, sunk, items) = run(false);
    // The world did something: items sank and the lines still carry a population.
    assert!(sunk > 1_000, "only {sunk} items sank in {TICKS} ticks");
    assert!(items > 1_000, "only {items} items left");
    assert_eq!(
        (live, high),
        (0, 0),
        "transport allocated per tick (live, high-water bytes over {TICKS} ticks)"
    );
}

/// Negative control: one `Vec` push per tick must show up as live growth, so a zero above means
/// the instrument works, not that it is blind.
#[test]
fn transport_tick_no_alloc_control() {
    let (live, high, _, _) = run(true);
    assert!(
        live > 0 && high > 0,
        "the injected per-tick growth was not seen: live {live}, high-water {high}"
    );
}
