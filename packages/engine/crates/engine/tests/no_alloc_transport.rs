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
//!
//! `transport_surgery_no_alloc` (M43) runs the same world with surgery inside the window: every
//! 100 ticks a line is cut in half and joined back (the run relink, a new line slot and id, the
//! feeder redirects, the slot freed again), one line is extended at the front and shrunk back,
//! another rescaled to 7/8 and back (squashed pairs and their resolution included), and a line
//! gets a straight segment (the segment pool and the tile index's in-place merge); the per-tick
//! `insert_at`/`remove_at` calls stay. Surgery allocates only from the arenas `set_caps` reserved.

use engine::abi::Arena;
use engine::abi::arena::{thread_high_water_bytes, thread_live_bytes};
use engine::rng::SimRng;
use engine::transport::{
    Geometry, Item, LineId, Output, SPACING, Segment, Transport, TransportRead, TransportWrite,
};
use engine::world::WorldPos;

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
    /// M43: run surgery every 100 ticks; how many cuts, joins, rescales and segment sets ran.
    surgery: bool,
    done: [u32; 4],
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
        surgery: false,
        done: [0; 4],
    }
}

/// M43's surgery step (module doc): a cut and a join, an extend and a shrink, a rescale there and
/// back, and one line's segments, on lines picked by the world's own stream.
fn surgery(w: &mut World) {
    let n = w.lines.len() as u32;
    let l = w.lines[w.rng.below(n) as usize];
    let len = w.t.len(l).unwrap();
    if let Ok(back) = w.t.split(l, len / 2) {
        w.t.join(l, back).expect("a split line joins back");
        w.done[0] += 1;
    }
    let l = w.lines[w.rng.below(n) as usize];
    w.t.extend_front(l, 256).unwrap();
    w.t.shrink_front(l, 256).expect("nothing moved in between");
    let l = w.lines[w.rng.below(n) as usize];
    let len = w.t.len(l).unwrap();
    if w.t.rescale(l, len / 8 * 7).is_ok() {
        w.t.rescale(l, len).unwrap();
        w.done[1] += 1;
    }
    let l = w.lines[w.rng.below(n) as usize];
    let len = w.t.len(l).unwrap();
    let y = (w.ticks * 256) as i32;
    let seg = Segment {
        len,
        geometry: Geometry::Straight {
            from: WorldPos { x: 0, y },
            to: WorldPos { x: len as i32, y },
        },
    };
    if w.t.set_segments(l, &[seg]).is_ok() {
        w.done[2] += 1;
    }
    w.done[3] += 1;
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
    if w.surgery && w.ticks.is_multiple_of(100) {
        surgery(w);
    }
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
    run_with(leak, false).0
}

/// [`run`], optionally with M43's surgery; also returns the surgery counts.
fn run_with(leak: bool, with_surgery: bool) -> ((isize, isize, u64, u32), [u32; 4]) {
    let mut w = build();
    w.surgery = with_surgery;
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
    ((deltas.0, deltas.1, sunk, w.t.items_len()), w.done)
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

/// M43: surgery inside the measured window allocates nothing (module doc). The counts prove each
/// kind ran: six surgery steps, every cut joined back, the rescales applied, the segments set.
#[test]
fn transport_surgery_no_alloc() {
    let ((live, high, sunk, items), done) = run_with(false, true);
    assert_eq!(done, [6, 6, 6, 6], "cuts, rescales, segment sets, steps");
    assert!(sunk > 1_000 && items > 1_000, "sunk {sunk}, items {items}");
    assert_eq!(
        (live, high),
        (0, 0),
        "surgery allocated (live, high-water bytes over {TICKS} ticks)"
    );
}

/// Line `l`'s path along row `row`: 16 tiles in `k` straight segments (`k - 1` of one tile, the
/// last covering the rest), written into `out` (no allocation).
fn row_path(row: i32, k: usize, out: &mut [Segment; 16]) -> usize {
    for (j, s) in out.iter_mut().enumerate().take(k) {
        let x0 = 256 * j as i32;
        let x1 = if j + 1 == k { 16 * 256 } else { x0 + 256 };
        *s = Segment {
            len: (x1 - x0) as u32,
            geometry: Geometry::Straight {
                from: WorldPos {
                    x: x0,
                    y: row * 256,
                },
                to: WorldPos {
                    x: x1,
                    y: row * 256,
                },
            },
        };
    }
    k
}

/// M43 review (finding 6): the segment pool's in-place compaction. Caps `(4, 0)` give a pool of
/// 16 records and a tile index of 32 entries; two lines of 16 tiles share them, re-registered 300
/// times with 1..=15 and the complementary count of segments (`b` cleared first, so `a`'s new
/// records meet a pool tail full of dead ones and compaction runs nearly every time). After
/// each round `segments()` reads back exactly what was registered and `lines_at` finds each
/// line at every tile at offset `256 x tile`; all inside the measured window (live and
/// high-water 0: the pool never grows past its reservation). Afterwards the index equals a
/// rebuild from scratch.
#[test]
fn transport_segment_pool_compacts_no_alloc() {
    let mut t = Transport::new(4, 0);
    let a = t.create(16 * 256, 8).unwrap();
    let b = t.create(16 * 256, 8).unwrap();
    let mut buf = [Segment {
        len: 1,
        geometry: Geometry::Straight {
            from: WorldPos::default(),
            to: WorldPos::default(),
        },
    }; 16];
    let pad = (thread_high_water_bytes() - thread_live_bytes()).max(0) as usize + 1;
    let _pad = vec![0u8; pad];
    let (live0, high0) = (thread_live_bytes(), thread_high_water_bytes());
    let mut checked = 0u32;
    for i in 0..300usize {
        let k = 1 + i % 15;
        t.set_segments(b, &[]).unwrap();
        for (line, row, n) in [(a, 0, k), (b, 1, 16 - k)] {
            let n = row_path(row, n, &mut buf);
            t.set_segments(line, &buf[..n]).unwrap();
            let mut j = 0;
            t.segments(line, &mut |s| {
                assert_eq!(s, buf[j], "round {i}: segment {j}");
                j += 1;
            })
            .unwrap();
            assert_eq!(j, n, "round {i}: segment count");
        }
        for x in 0..16 {
            for (line, row) in [(a, 0), (b, 1)] {
                let mut hits = 0;
                t.lines_at(engine::world::TilePos::new(x, row), &mut |l, o| {
                    assert_eq!(
                        (l, o),
                        (line, 256 * x as u32),
                        "round {i}: tile ({x}, {row})"
                    );
                    hits += 1;
                })
                .unwrap();
                assert_eq!(hits, 1, "round {i}: tile ({x}, {row})");
                checked += 1;
            }
        }
    }
    let (live, high) = (
        thread_live_bytes() - live0,
        thread_high_water_bytes() - high0,
    );
    assert_eq!(checked, 300 * 32);
    assert_eq!((live, high), (0, 0), "segment pool compaction allocated");
    let mut incremental = Vec::new();
    t.tile_index_into(&mut incremental);
    t.rebuild_index();
    let mut rebuilt = Vec::new();
    t.tile_index_into(&mut rebuilt);
    assert_eq!(incremental, rebuilt);
}
