//! M41's forecast spike (docs/decisions/0078, `docs/plan/41-forecast-spike.md`): how often the
//! cheap forecast of M40's winner (B1, linked runs) is invalidated, what the resulting forecasts
//! cost in bytes per second for one client seeing a saturated viewport, and what the tracking costs
//! the tick. The tracker and the forecast are `common/forecast.rs`.
//!
//! - `saturated_view_world_is_deterministic`: the `SaturatedView` regime's world.
//! - `forecast_events_match_rule`: each dirty event provoked once on a hand-built world.
//! - `forecast_is_followable`: after a rebuild, a client-side follower that knows only 0078 §2's
//!   formula puts every item exactly where the advance does, for 50 ticks.
//! - `forecast_tracker_matches_oracle`: the cheap detection (front items and segment dues) finds
//!   exactly the lines where a per-item check of every prediction finds a deviation; the toggled
//!   jams leave A and B1 in agreement. `forecast_no_alloc_small`: the tracker allocates nothing.
//! - `slow_spike_forecast_cells`: the measurement (release, one `BENCH_SAMPLE` per cell).
//!
//! Own test binary: it installs the engine's counting allocator for `thread_live_bytes`.

mod common;

use common::forecast::{
    ARRIVAL_BYTES, Ev, Forecast, HZ, Jams, Msg, N_FULL, Tracker, Variant, tick_plain, tick_tracked,
};
use common::repr::{Driver, NONE, Repr, SP};
use common::repr_a::ReprA;
use common::repr_b::{Linked, ReprB, ReprB1};
use common::world::{
    BenchWorld, Item, LineIdx, LineSpec, Out, Regime, VIEW_H, VIEW_W, bench_world,
    bench_world_scaled, update_order, visible_at_centre, visible_in,
};
use engine::abi::Arena;

#[global_allocator]
static ALLOCATOR: Arena = Arena;

const SEED: u64 = 7;
const SMALL: u32 = 64;

type Tracked = ReprB<Linked, Tracker>;

fn sv(jam_pct: u8, period: u16) -> Regime {
    Regime::SaturatedView { jam_pct, period }
}

// ---- the world ----

#[test]
fn saturated_view_world_is_deterministic() {
    let a = bench_world(SEED, sv(20, 20));
    assert_eq!(a, bench_world(SEED, sv(20, 20)), "two builds differ");
    assert_ne!(
        a.lines,
        bench_world(SEED + 1, sv(20, 20)).lines,
        "the seed changes nothing"
    );
    // Literals (0069 §2): 256 x 144 tiles, every lane-tile packed (4 items), two lanes.
    assert_eq!(a.tiles(), 36_864, "tiles");
    assert_eq!(a.items(), 294_912, "items");
    assert_eq!((a.width, a.height), (256, 144));
    let mut row = vec![0u32; 144];
    for (l, s) in a.spans.iter().enumerate() {
        assert_eq!(s.w * 256, a.lines[l].len, "line {l}: span width");
        row[s.y as usize] += s.w;
    }
    // Two lanes per tile.
    assert!(row.iter().all(|&t| t == 2 * 256), "a row is not 256 tiles");
    assert!(
        visible_at_centre(&a).iter().all(|&v| v),
        "the view is the world"
    );
    let sinks = a.lines.iter().filter(|l| l.out == Out::Sink).count();
    assert_eq!(sinks, a.spawners.len());
    assert_eq!(
        (a.lines.len(), sinks, a.toggles.len()),
        (2_974, 982, 196),
        "lines, sinks, toggles"
    );
    assert!(bench_world(SEED, sv(0, 0)).toggles.is_empty());
    assert_eq!(bench_world(SEED, sv(5, 100)).toggles.len(), 49);
    // The standard world's spans: the visible set of `Mixed`.
    let m = bench_world(SEED, Regime::Mixed);
    let vis = visible_at_centre(&m);
    assert_eq!(
        (
            m.lines.len(),
            vis.iter().filter(|&&v| v).count(),
            m.width,
            m.height
        ),
        (3_810, 1_010, 220, 545),
        "Mixed: lines, visible lines, extent"
    );
}

// ---- hand-built worlds ----

fn line(len: u32, out: Out, items: &[(Item, u32)]) -> LineSpec {
    LineSpec {
        len,
        speed: 24,
        out,
        items_at_rest: items.to_vec(),
    }
}

struct Hand {
    order: Vec<LineIdx>,
    r: Tracked,
}

impl Hand {
    fn new(lines: &[LineSpec], depth: usize, variant: Variant) -> Self {
        let tracker = Tracker::new(lines, vec![true; lines.len()], depth, variant);
        let mut r = ReprB::build_with(lines, tracker);
        let (o, v) = r.split();
        o.rebuild_all(&v);
        Hand {
            order: update_order(lines),
            r,
        }
    }

    /// One tick: `pre` is the game's part (edits before the advance). Returns the tick's events,
    /// sorted.
    fn step(&mut self, tick: u32, pre: impl FnOnce(&mut Tracked)) -> Vec<(Ev, LineIdx)> {
        self.r.obs_mut().begin_tick(tick);
        pre(&mut self.r);
        self.r.advance(&self.order);
        let (o, v) = self.r.split();
        o.end_tick(&v);
        let mut e = self.r.obs().events.clone();
        e.sort();
        e
    }
}

#[test]
fn forecast_events_match_rule() {
    use Ev::*;
    use Out::{DeadEnd, Next, Sink as SinkOut};
    let none: Vec<(Ev, LineIdx)> = Vec::new();

    // (a) A jam beyond the path: with depth 1, line 2 sees line 1 only, so its item has no stop
    // and is blocked on line 0 behind the jam (item at 500 on line 0 at tick 26, blocked at 128 on
    // tick 42). Ticks 1-41 are free-flowing ticks with nothing new: they mark nothing.
    let w = [
        line(512, DeadEnd, &[(1, 0), (1, 64)]),
        line(512, Next(0), &[]),
        line(512, Next(1), &[(2, 100)]),
    ];
    let mut h = Hand::new(&w, 1, Variant::Baseline);
    for t in 1..=41 {
        assert_eq!(h.step(t, |_| {}), none, "(a) depth 1: tick {t}");
    }
    assert_eq!(h.step(42, |_| {}), [(Blocked, 0)], "(a) depth 1: tick 42");
    assert_eq!(h.step(43, |_| {}), none, "(a) depth 1: tick 43");
    // Depth 2 sees the dead end: the same item never deviates.
    let mut h = Hand::new(&w, 2, Variant::Baseline);
    for t in 1..=60 {
        assert_eq!(h.step(t, |_| {}), none, "(a) depth 2: tick {t}");
    }

    // (b), (e), (f): a jam clearing. Line 0's dead end becomes a sink: its front item leaves
    // (b, e on line 0) and line 1's front item moves although its stop said halted (b on line 1).
    let w = [
        line(256, DeadEnd, &[(1, 0), (1, 64), (1, 128), (1, 192)]),
        line(512, Next(0), &[(2, 0), (3, 64)]),
    ];
    let mut h = Hand::new(&w, 1, Variant::Baseline);
    assert_eq!(h.step(1, |_| {}), none, "(b): a jam stays a jam");
    assert_eq!(
        h.step(2, |r| r.set_out(0, SinkOut)),
        [(Moved, 0), (Moved, 1), (Sink, 0), (Structure, 0)],
        "(b): the jam clears"
    );
    assert_eq!(h.step(3, |_| {}), none, "(b): rebuilt, free flow");
    assert_eq!(h.step(4, |_| {}), [(Sink, 0)], "(e): a sink exit");

    // (c), (f): a line's output moves to another line; the item crossing that tick lands off the
    // forecast's path.
    let w = [
        line(512, DeadEnd, &[]),
        line(512, DeadEnd, &[]),
        line(512, Next(0), &[(1, 10)]),
    ];
    let mut h = Hand::new(&w, 1, Variant::Baseline);
    assert_eq!(
        h.step(1, |r| r.set_out(2, Next(1))),
        [(OffPath, 1), (Structure, 2)],
        "(c): off the path"
    );

    // (d): an insert; the next tick, the inserted item follows its forecast.
    let w = [line(1024, DeadEnd, &[])];
    let mut h = Hand::new(&w, 1, Variant::Baseline);
    assert_eq!(
        h.step(1, |r| r.insert_back(0, 1).expect("room")),
        [(Insert, 0)],
        "(d): an insert"
    );
    assert_eq!(h.step(2, |_| {}), none, "(d): rebuilt");

    // (d') A jam reaching a spawner: the second refusal in a row with an unmoved tail, once.
    let w = [line(256, DeadEnd, &[(1, 0), (1, 64), (1, 128), (1, 192)])];
    let mut h = Hand::new(&w, 1, Variant::PeriodicSpawner);
    let refuse = |r: &mut Tracked| assert!(r.insert_back(0, 1).is_err());
    assert_eq!(h.step(1, refuse), none, "(d'): first refusal");
    assert_eq!(
        h.step(2, refuse),
        [(Refused, 0)],
        "(d'): the jam reached it"
    );
    assert_eq!(h.step(3, refuse), none, "(d'): once per jam");
}

// ---- the follower: 0078 §2's formula and nothing else ----

/// A line's structure as the client holds it (replicated whole-value, 0078 §1).
#[derive(Clone, Copy)]
struct Structure {
    len: i32,
    speed: i32,
    out: Out,
}

/// Where the client draws every item at tick `t`, from the latest forecast of each line: item `k`
/// of a run at `max(pos + k*SP - speed*(t - T), stop + k*SP)`, moved onto the next line of `path`
/// (past it: the next plain `Next` line) while below 0, gone past a `Sink`.
fn follow(fs: &[Forecast], st: &[Structure], t: u32) -> Vec<(LineIdx, i32, Item)> {
    let mut out = Vec::new();
    for f in fs {
        let v = st[f.line as usize].speed;
        for r in &f.runs {
            for k in 0..i32::from(r.count) {
                let mut x = r.pos + k * SP - v * (t - f.tick) as i32;
                if let Some(s) = r.stop {
                    x = x.max(s + k * SP);
                }
                let mut l = f.line;
                let mut i = 0;
                let gone = loop {
                    if x >= 0 {
                        break false;
                    }
                    let next = match st[l as usize].out {
                        Out::Sink => break true,
                        Out::DeadEnd => panic!("line {}: a forecast past a dead end", f.line),
                        Out::Next(n) => f.path.get(i).copied().unwrap_or(n),
                    };
                    i += 1;
                    l = next;
                    x += st[l as usize].len;
                };
                if !gone {
                    out.push((l, x, r.item));
                }
            }
        }
    }
    out.sort_unstable();
    out
}

fn actual<R: Repr>(r: &R, n: u32) -> Vec<(LineIdx, i32, Item)> {
    let mut out = Vec::new();
    let mut buf = Vec::new();
    for l in 0..n {
        r.items(l, &mut buf);
        out.extend(buf.iter().map(|&(item, pos)| (l, pos as i32, item)));
    }
    out.sort_unstable();
    out
}

#[test]
fn forecast_is_followable() {
    use Out::{DeadEnd, Next, Sink};
    let w = [
        // A dead-end jam forming: spread items compress against the front.
        line(
            2048,
            DeadEnd,
            &[(1, 100), (2, 300), (2, 364), (3, 900), (1, 1000)],
        ),
        // A stopped run at a dead end; the runs behind it halt behind it, some on line 2 (a stop
        // on the next line) and some after two hand-offs from line 3 (a stop two lines ahead).
        line(512, DeadEnd, &[(4, 0), (4, 64), (4, 128)]),
        line(1024, Next(1), &[(5, 50), (6, 600), (6, 664)]),
        line(512, Next(2), &[(1, 200), (2, 400)]),
        // A sink exit: line 5's items cross onto line 4 and leave.
        line(512, Sink, &[(1, 30), (2, 200)]),
        line(768, Next(4), &[(3, 100), (3, 164), (4, 500)]),
    ];
    let st: Vec<Structure> = w
        .iter()
        .map(|s| Structure {
            len: s.len as i32,
            speed: i32::from(s.speed),
            out: s.out,
        })
        .collect();
    let n = w.len() as u32;
    let mut followed = 0u64;
    for depth in [2, 4] {
        // Rebuilt at the start, and again at tick 10 (a jam half formed, items mid hand-off).
        for start in [0, 10] {
            let at = format!("depth {depth}, rebuilt at tick {start}");
            let mut h = Hand::new(&w, depth, Variant::SinkPredicted);
            for t in 1..=start {
                h.step(t, |_| {});
            }
            let (o, v) = h.r.split();
            o.rebuild_all(&v);
            let fs: Vec<Forecast> = (0..n).map(|l| o.forecast(&v, l)).collect();
            for t in start + 1..=start + 50 {
                let ev = h.step(t, |_| {});
                let a = actual(&h.r, n);
                assert_eq!(
                    follow(&fs, &st, t),
                    a,
                    "{at}: tick {t}: follower vs advance"
                );
                assert!(
                    ev.iter().all(|&(k, _)| k == Ev::Sink),
                    "{at}: tick {t}: a correction {ev:?}"
                );
                followed += a.len() as u64;
            }
            // The scenario did what it is for: everything on line 3 left it, items sank.
            let mut buf = Vec::new();
            h.r.items(3, &mut buf);
            assert!(buf.is_empty(), "{at}: line 3 still holds items");
            assert!(h.r.sunk() >= 4, "{at}: nothing sank");
        }
    }
    assert!(followed > 0);
}

// ---- LineState: the client of the messages ----

/// One item's trajectory on the client: at tick `t0` at `x0` on `line`, stop `stop` (cumulative,
/// `line`'s coordinates), plain `Next` links past the line; it exists from tick `born`.
#[derive(Clone, Copy)]
struct Traj {
    line: LineIdx,
    t0: u32,
    x0: i32,
    stop: Option<i32>,
    item: Item,
    born: u32,
}

/// Where a trajectory puts its item at `t` (`None`: not born yet, or gone through a sink; held at
/// a dead end's front).
fn locate(tr: &Traj, st: &[Structure], t: u32) -> Option<(LineIdx, i32)> {
    if t < tr.born {
        return None;
    }
    let v = st[tr.line as usize].speed;
    let mut x = tr.x0 - v * (t as i32 - tr.t0 as i32);
    if let Some(s) = tr.stop {
        x = x.max(s);
    }
    let mut l = tr.line;
    while x < 0 {
        match st[l as usize].out {
            Out::Sink => return None,
            // 0078 §2: past the path a run "stops at the front of anything else".
            Out::DeadEnd => x = 0,
            Out::Next(n) => {
                l = n;
                x += st[n as usize].len;
            }
        }
    }
    Some((l, x))
}

/// A trajectory's stop in `line`'s coordinates (`line` is on its path).
fn stop_on(tr: &Traj, st: &[Structure], line: LineIdx) -> Option<i32> {
    let mut s = tr.stop?;
    let mut l = tr.line;
    while l != line {
        match st[l as usize].out {
            Out::Next(n) => {
                s += st[n as usize].len;
                l = n;
            }
            _ => panic!("line {line} is not on line {}'s path", tr.line),
        }
    }
    Some(s)
}

/// The client's replay of a spawner (the periodic-spawner forecast: `rate256`, accumulator,
/// cycling flag and next item): the game's schedule against the client's own tail, stopped by a
/// paused message and restarted by a resumed one (which carries that tick's insert).
struct ClientSpawner {
    line: LineIdx,
    rate: u16,
    acc: u16,
    item: Item,
    cycle: bool,
    paused: bool,
}

impl ClientSpawner {
    fn inserted(&mut self) {
        if self.cycle {
            self.item = self.item % common::world::KINDS + 1;
        }
    }
}

/// The client: one trajectory per item it can see. Its rules (M41 Extension 3), at tick `T`:
/// 1. each unpaused spawner replay inserts as the game would, from the client's items at `T - 1`;
/// 2. an arrival `(line, item, pos)` starts a trajectory at `pos`, its stop `SPACING` behind the
///    stop of the line's last item at `T - 1` (or of the previous arrival this tick), none if the
///    line had none;
/// 3. a state message of line `L` re-stops the items the client had on `L` at `T - 1` (inserts of
///    this tick included, landers not): from their `T - 1` position, stop `front_stop + SP x k`;
/// 4. a full forecast of `L` replaces the items the client had on `L` at `T - 1` with its runs.
struct Client {
    trajs: Vec<Traj>,
    spawners: Vec<ClientSpawner>,
}

impl Client {
    fn new() -> Self {
        Client {
            trajs: Vec::new(),
            spawners: Vec::new(),
        }
    }

    /// The forecasts of tick `f.tick`, with nothing before them.
    fn load(&mut self, f: &Forecast) {
        self.add(f, f.tick);
    }

    fn add(&mut self, f: &Forecast, t: u32) {
        for r in &f.runs {
            for k in 0..i32::from(r.count) {
                self.trajs.push(Traj {
                    line: f.line,
                    t0: t,
                    x0: r.pos + k * SP,
                    stop: r.stop.map(|s| s + k * SP),
                    item: r.item,
                    born: t,
                });
            }
        }
    }

    /// The client's items on `line` at `t`, front to back: `(position, index)`.
    fn on(&self, line: LineIdx, st: &[Structure], t: u32) -> Vec<(i32, usize)> {
        let mut on: Vec<(i32, usize)> = self
            .trajs
            .iter()
            .enumerate()
            .filter_map(|(i, tr)| match locate(tr, st, t) {
                Some((l, x)) if l == line => Some((x, i)),
                _ => None,
            })
            .collect();
        on.sort_unstable();
        on
    }

    fn full(&mut self, f: &Forecast, st: &[Structure], t: u32) {
        let mut gone: Vec<usize> = self.on(f.line, st, t - 1).iter().map(|&(_, i)| i).collect();
        gone.sort_unstable();
        for i in gone.into_iter().rev() {
            self.trajs.swap_remove(i);
        }
        self.add(f, t);
    }

    /// From tick `t`: `pos(t') = max(pos(t - 1) - speed * (t' - t + 1), front_stop + SP * k)`,
    /// `k` the item's index on the line at `t - 1`.
    fn state(&mut self, line: LineIdx, front_stop: Option<i32>, st: &[Structure], t: u32) {
        for (k, (x, i)) in self.on(line, st, t - 1).into_iter().enumerate() {
            let tr = &mut self.trajs[i];
            tr.line = line;
            tr.t0 = t - 1;
            tr.x0 = x;
            tr.stop = front_stop.map(|s| s + SP * k as i32);
        }
    }

    /// The stop `SPACING` behind the last item the client had on `line` at `t - 1` (`None`: no
    /// item, or an item with no stop), and that item's position.
    fn tail(&self, line: LineIdx, st: &[Structure], t: u32) -> Option<(i32, Option<i32>)> {
        let on = self.on(line, st, t - 1);
        let &(x, i) = on.last()?;
        Some((x, stop_on(&self.trajs[i], st, line).map(|s| s + SP)))
    }

    /// The spawner's `insert_back` at tick `t` as the client sees it: at `max(len - speed, tail +
    /// SP)` if that is on the line, chained behind the tail. Returns whether there was room.
    fn insert(&mut self, line: LineIdx, item: Item, st: &[Structure], t: u32) -> bool {
        let s = st[line as usize];
        let tail = self.tail(line, st, t);
        let land = match tail {
            None => s.len - s.speed,
            Some((x, _)) => (s.len - s.speed).max(x + SP),
        };
        if land > s.len - 1 {
            return false;
        }
        self.trajs.push(Traj {
            line,
            t0: t - 1,
            x0: land,
            stop: tail.and_then(|(_, s)| s),
            item,
            born: t - 1,
        });
        true
    }

    /// Applies tick `t`'s messages (rules 1-4). `full(l)` is line `l`'s full forecast at `t`.
    fn tick(
        &mut self,
        st: &[Structure],
        t: u32,
        msgs: &[(LineIdx, Msg)],
        arrivals: &[(LineIdx, Item, i32)],
        full: impl Fn(LineIdx) -> Forecast,
    ) {
        let mut sp = core::mem::take(&mut self.spawners);
        for s in sp.iter_mut().filter(|s| !s.paused) {
            s.acc += s.rate;
            if s.acc < 256 {
                continue;
            }
            if self.insert(s.line, s.item, st, t) {
                s.acc -= 256;
                s.inserted();
            } else {
                s.acc = 256;
            }
        }
        let mut prev: Vec<(LineIdx, Option<i32>)> = Vec::new();
        for &(line, item, pos) in arrivals {
            let stop = match prev.iter().rposition(|&(l, _)| l == line) {
                Some(p) => prev[p].1.map(|s| s + SP),
                None => self.tail(line, st, t).and_then(|(_, s)| s),
            };
            prev.push((line, stop));
            self.trajs.push(Traj {
                line,
                t0: t,
                x0: pos,
                stop,
                item,
                born: t,
            });
        }
        for &(l, m) in msgs {
            match m {
                Msg::State(fs) => self.state(l, fs, st, t),
                Msg::Paused(fs) => {
                    self.state(l, fs, st, t);
                    let s = sp.iter_mut().find(|s| s.line == l).expect("a spawner");
                    s.paused = true;
                }
                Msg::Resumed(fs) => {
                    let s = sp.iter_mut().find(|s| s.line == l).expect("a spawner");
                    assert!(
                        self.insert(l, s.item, st, t),
                        "line {l}: a resume with no room"
                    );
                    s.inserted();
                    s.paused = false;
                    s.acc = s.rate;
                    self.state(l, fs, st, t);
                }
                Msg::Full => {}
            }
        }
        for &(l, m) in msgs {
            if m == Msg::Full {
                self.full(&full(l), st, t);
            }
        }
        self.spawners = sp;
    }

    /// Every item on a visible line at `t`, sorted; drops the trajectories that left the view.
    fn positions(&mut self, st: &[Structure], t: u32, vis: &[bool]) -> Vec<(LineIdx, i32, Item)> {
        self.trajs
            .retain(|tr| locate(tr, st, t).is_some_and(|(l, _)| vis[l as usize]));
        let mut out: Vec<_> = self
            .trajs
            .iter()
            .filter_map(|tr| locate(tr, st, t).map(|(l, x)| (l, x, tr.item)))
            .collect();
        out.sort_unstable();
        out
    }
}

/// The game's spawner in the hand-built worlds (as `Driver`'s: `acc += rate256`, an attempt at
/// 256, a refusal holds `acc` at 256).
struct HandSpawner {
    line: LineIdx,
    rate: u16,
    acc: u16,
    item: Item,
}

impl HandSpawner {
    fn tick(&mut self, r: &mut Tracked) {
        self.acc += self.rate;
        if self.acc < 256 {
            return;
        }
        if r.insert_back(self.line, self.item).is_ok() {
            self.acc -= 256;
        } else {
            self.acc = 256;
        }
    }
}

#[test]
fn forecast_line_state_is_followable() {
    use Out::{DeadEnd, Next, Sink};
    type Pre = fn(&mut Tracked);
    /// `(tick, the edit before that tick's spawners, the messages that tick)`.
    type Step = (u32, Pre, Vec<(LineIdx, Msg)>);
    struct Case {
        name: &'static str,
        variant: Variant,
        w: Vec<LineSpec>,
        /// `(line, rate256, item)`.
        spawner: Option<(LineIdx, u16, Item)>,
        steps: Vec<Step>,
    }
    let packed = |n: u32| -> Vec<(Item, u32)> { (0..n).map(|k| (1, k * 64)).collect() };
    let cases = [
        Case {
            // A jam forming: line 2's item (no stop at depth 1) is blocked behind line 0's jam at
            // tick 42; line 0 halts it with a state message.
            name: "halt",
            variant: Variant::LineState,
            w: vec![
                line(512, DeadEnd, &[(1, 0), (1, 64)]),
                line(512, Next(0), &[]),
                line(512, Next(1), &[(2, 100)]),
            ],
            spawner: None,
            steps: vec![(42, |_| {}, vec![(0, Msg::State(Some(0)))])],
        },
        Case {
            // A jam clearing: line 0's dead end becomes a sink (`LineState`: a full forecast for a
            // structure change); line 1 resumes with a state message and no stop.
            name: "resume",
            variant: Variant::LineState,
            w: vec![
                line(256, DeadEnd, &packed(4)),
                line(512, Next(0), &[(2, 0), (3, 64)]),
            ],
            spawner: None,
            steps: vec![(
                2,
                |r| r.set_out(0, Sink),
                vec![(0, Msg::Full), (1, Msg::State(None))],
            )],
        },
        Case {
            // Two items taken off a full dead-end line (a full forecast: edits); line 1 moves on
            // and halts on line 0: its `t - 1` front item (which crosses this tick) gets -128, the
            // next -64 (448 on line 0).
            name: "halt downstream",
            variant: Variant::LineState,
            w: vec![
                line(512, DeadEnd, &packed(8)),
                line(512, Next(0), &[(2, 0), (3, 64)]),
            ],
            spawner: None,
            steps: vec![(
                2,
                |r| {
                    assert_eq!(r.remove_at(0, 0), Some(1));
                    assert_eq!(r.remove_at(0, 64), Some(1));
                },
                vec![(0, Msg::Full), (1, Msg::State(Some(-128)))],
            )],
        },
        Case {
            // Speed 72: two items cross line 1's front in the tick its state message goes out.
            // Two items taken off the back of a full dead-end line 0 (a full forecast); line 1's
            // items at 0 and 64 cross (to 440 and 504 on line 0) and its item at 128 moves to 56;
            // the message's `front_stop` is for the `t - 1` front item: 0 - 2 x 64 = -128.
            name: "two crossers at speed 72",
            variant: Variant::LineState,
            w: {
                let mut w = vec![
                    line(512, DeadEnd, &packed(8)),
                    line(512, Next(0), &[(2, 0), (3, 64), (4, 128)]),
                ];
                for l in &mut w {
                    l.speed = 72;
                }
                w
            },
            spawner: None,
            steps: vec![(
                2,
                |r| {
                    assert_eq!(r.remove_at(0, 448), Some(1));
                    assert_eq!(r.remove_at(0, 384), Some(1));
                },
                vec![(0, Msg::Full), (1, Msg::State(Some(-128)))],
            )],
        },
        Case {
            // `LineState2`, a toggled sink: the sink closes (a state message, `front_stop = 0`; the
            // output travels as a structure Put), the items halt at 0 and 64; it reopens
            // (`front_stop = None`) and they leave through it.
            name: "toggled sink",
            variant: Variant::LineState2,
            w: vec![line(1024, Sink, &[(1, 100), (2, 300)])],
            spawner: None,
            steps: vec![
                (2, |r| r.set_out(0, DeadEnd), vec![(0, Msg::State(Some(0)))]),
                (60, |r| r.set_out(0, Sink), vec![(0, Msg::State(None))]),
            ],
        },
        Case {
            // `LineState2`, a spawner pausing and resuming: one insert per 4 ticks onto a dead end
            // that is full after the insert at tick 4; the second refusal in a row (tick 9) pauses
            // the client's replay; the dead end becomes a sink at tick 20 and the spawner's next
            // insert (tick 21) resumes it.
            name: "spawner pause",
            variant: Variant::LineState2,
            w: vec![line(512, DeadEnd, &packed(7))],
            spawner: Some((0, 64, 2)),
            steps: vec![
                (9, |_| {}, vec![(0, Msg::Paused(Some(0)))]),
                (20, |r| r.set_out(0, Sink), vec![(0, Msg::State(None))]),
                (21, |_| {}, vec![(0, Msg::Resumed(None))]),
            ],
        },
    ];
    for case in cases {
        let name = case.name;
        let mut st: Vec<Structure> = case
            .w
            .iter()
            .map(|s| Structure {
                len: s.len as i32,
                speed: i32::from(s.speed),
                out: s.out,
            })
            .collect();
        let n = case.w.len() as u32;
        let mut h = Hand::new(&case.w, 1, case.variant);
        let mut spawner = case.spawner.map(|(line, rate, item)| HandSpawner {
            line,
            rate,
            acc: 0,
            item,
        });
        let mut client = Client::new();
        client
            .spawners
            .extend(case.spawner.map(|(line, rate, item)| ClientSpawner {
                line,
                rate,
                acc: 0,
                item,
                cycle: false,
                paused: false,
            }));
        {
            let (o, v) = h.r.split();
            for l in 0..n {
                client.load(&o.forecast(&v, l));
            }
        }
        let vis = vec![true; n as usize];
        let end = case.steps.last().expect("a step").0 + 50;
        for t in 1..=end {
            let step = case.steps.iter().find(|s| s.0 == t);
            let ev = h.step(t, |r| {
                if let Some(s) = step {
                    (s.1)(r);
                }
                if let Some(sp) = spawner.as_mut() {
                    sp.tick(r);
                }
            });
            // The client learns structure changes as `LineStructs` Puts (0078 §1).
            for (l, s) in st.iter_mut().enumerate() {
                s.out = h.r.out(l as LineIdx);
            }
            let mut msgs = h.r.obs().msgs.clone();
            msgs.sort_by_key(|&(l, _)| l);
            match step {
                Some(s) => assert_eq!(msgs, s.2, "{name}: tick {t}: messages"),
                None => {
                    assert_eq!(msgs, [], "{name}: tick {t}: no message");
                    assert!(
                        ev.iter()
                            .all(|&(k, _)| matches!(k, Ev::Sink | Ev::Insert | Ev::Refused)),
                        "{name}: tick {t}: a correction {ev:?}"
                    );
                }
            }
            let (o, v) = h.r.split();
            client.tick(&st, t, &msgs, &[], |l| o.forecast(&v, l));
            let a = actual(&h.r, n);
            let c = client.positions(&st, t, &vis);
            assert_eq!(c.len(), a.len(), "{name}: tick {t}: item count");
            assert_eq!(c, a, "{name}: tick {t}: client vs advance");
        }
    }
}

/// The 1/64 worlds the client and the oracle are checked on, with the lines the client sees:
/// `SaturatedView` (20, 20) and (50, 30), `Mixed`, `InserterLike` (edits: full forecasts),
/// `SaturatedView` (50, 30) at `speed = 72` (two items cross a line front in one tick), and `Mixed`
/// seen through a 64-tile-wide view (chains cut by it: arrivals from invisible lines), and `Mixed`
/// with every line empty at the start (inserts onto empty lines).
fn checked_worlds() -> Vec<(String, BenchWorld, Vec<bool>)> {
    let mut out = Vec::new();
    for (name, regime) in [
        ("saturated-view (20, 20)", sv(20, 20)),
        ("saturated-view (50, 30)", sv(50, 30)),
        ("mixed", Regime::Mixed),
        ("inserter-like", Regime::InserterLike),
    ] {
        let w = bench_world_scaled(SEED, regime, SMALL);
        let vis = vec![true; w.lines.len()];
        out.push((name.to_string(), w, vis));
    }
    let mut w = bench_world_scaled(SEED, sv(50, 30), SMALL);
    for l in &mut w.lines {
        l.speed = 72;
    }
    let vis = vec![true; w.lines.len()];
    out.push(("saturated-view (50, 30) at speed 72".to_string(), w, vis));
    let w = bench_world_scaled(SEED, Regime::Mixed, SMALL);
    let vis = visible_in(&w, 64, VIEW_H);
    out.push(("mixed, 64-tile view".to_string(), w, vis));
    // Every line empty at the start: the spawners insert onto empty lines with a dead end in sight.
    let mut w = bench_world_scaled(SEED, Regime::Mixed, SMALL);
    for l in &mut w.lines {
        l.items_at_rest.clear();
    }
    let vis = vec![true; w.lines.len()];
    out.push(("mixed, empty at the start".to_string(), w, vis));
    out
}

fn structures(w: &[LineSpec]) -> Vec<Structure> {
    w.iter()
        .map(|s| Structure {
            len: s.len as i32,
            speed: i32::from(s.speed),
            out: s.out,
        })
        .collect()
}

/// The arbiter (M41 Extension 3): a client that knows only 0078 §2's formula, path following, the
/// ownership rule, the message rules of [`Client`] and the spawner replay, fed `LineState2`'s real
/// message stream, draws every item on every visible line exactly where the advance puts it,
/// every tick.
#[test]
fn forecast_client_matches_advance() {
    let (mut states, mut fulls, mut arrived, mut paused) = (0u64, 0u64, 0u64, 0u64);
    for (name, w, vis) in checked_worlds() {
        let n = w.lines.len() as u32;
        for depth in [4, 8] {
            let at = format!("{name}, depth {depth}");
            let mut tracker = Tracker::new(&w.lines, vis.clone(), depth, Variant::LineState2);
            tracker.set_spawners(w.spawners.iter().map(|s| s.line));
            let mut r: Tracked = ReprB::build_with(&w.lines, tracker);
            let mut st = structures(&w.lines);
            let mut client = Client::new();
            {
                let (o, v) = r.split();
                o.rebuild_all(&v);
                for l in (0..n).filter(|&l| vis[l as usize]) {
                    client.load(&o.forecast(&v, l));
                }
            }
            client.spawners = w
                .spawners
                .iter()
                .filter(|s| vis[s.line as usize])
                .map(|s| ClientSpawner {
                    line: s.line,
                    rate: s.rate256,
                    acc: 0,
                    item: s.first,
                    cycle: s.cycle,
                    paused: false,
                })
                .collect();
            let mut d = Driver::new(&w);
            let mut jams = Jams::new(&w);
            let mut buf = Vec::new();
            for t in 1..=300 {
                tick_tracked(&w, t, &mut r, &mut d, &mut jams);
                for (l, s) in st.iter_mut().enumerate() {
                    s.out = r.out(l as LineIdx);
                }
                let msgs: Vec<(LineIdx, Msg)> = r
                    .obs()
                    .msgs
                    .iter()
                    .copied()
                    .filter(|&(l, _)| vis[l as usize])
                    .collect();
                let arrivals: Vec<(LineIdx, Item, i32)> = r
                    .obs()
                    .arrivals
                    .clone()
                    .into_iter()
                    .map(|(l, pos)| {
                        r.items(l, &mut buf);
                        let item = buf
                            .iter()
                            .find(|&&(_, p)| p as i32 == pos)
                            .expect("arrived")
                            .0;
                        (l, item, pos)
                    })
                    .collect();
                for &(_, m) in &msgs {
                    match m {
                        Msg::Full => fulls += 1,
                        Msg::Paused(_) | Msg::Resumed(_) => paused += 1,
                        Msg::State(_) => states += 1,
                    }
                }
                arrived += arrivals.len() as u64;
                {
                    let (o, v) = r.split();
                    client.tick(&st, t, &msgs, &arrivals, |l| o.forecast(&v, l));
                }
                let c = client.positions(&st, t, &vis);
                let mut a = actual(&r, n);
                a.retain(|&(l, _, _)| vis[l as usize]);
                assert_eq!(c.len(), a.len(), "{at}: tick {t}: items on visible lines");
                assert_eq!(c, a, "{at}: tick {t}: client vs advance");
            }
        }
    }
    // Every kind of message and an arrival took part.
    assert!(
        states > 100 && fulls > 100 && paused > 0 && arrived > 10,
        "states {states}, full {fulls}, paused/resumed {paused}, arrivals {arrived}"
    );
}

// ---- the oracle: every item's prediction, every tick ----

/// Lines where some item still on the line after the advance is not where its prediction put it.
fn oracle(before: &[Vec<(Item, u32)>], r: &Tracked, crossed: &[u64], speeds: &[i32]) -> Vec<u32> {
    let mut bad = Vec::new();
    let mut after = Vec::new();
    let mut stops = Vec::new();
    for (l, b) in before.iter().enumerate() {
        let l = l as LineIdx;
        if r.obs().invalid(l) {
            continue;
        }
        r.items(l, &mut after);
        r.obs().predicted_stops(l, &mut stops);
        let gone = (r.obs().crossed[l as usize] - crossed[l as usize]) as usize;
        let v = speeds[l as usize];
        for i in 0..b.len() - gone {
            let x = b[gone + i].1 as i32;
            let pred = if stops[i] == NONE {
                x - v
            } else {
                (x - v).max(stops[i])
            };
            if after[i].1 as i32 != pred {
                bad.push(l);
                break;
            }
        }
    }
    bad
}

#[test]
fn forecast_tracker_matches_oracle() {
    // The client test's worlds with every line visible (the speed-72 one included).
    let worlds: Vec<BenchWorld> = checked_worlds().into_iter().map(|(_, w, _)| w).collect();
    let mut deviations = 0u64;
    let mut states = 0u64;
    for w in &worlds {
        let n = w.lines.len();
        let speeds: Vec<i32> = w.lines.iter().map(|l| i32::from(l.speed)).collect();
        for depth in [1, 4, 8] {
            for variant in [
                Variant::Baseline,
                Variant::Both,
                Variant::LineState,
                Variant::LineState2,
            ] {
                let at = format!(
                    "{} (speed {}) depth {depth} {}",
                    w.regime.name(),
                    w.lines[0].speed,
                    variant.key()
                );
                let mut r: Tracked = ReprB::build_with(
                    &w.lines,
                    Tracker::new(&w.lines, vec![true; n], depth, variant),
                );
                let (o, v) = r.split();
                o.rebuild_all(&v);
                let mut a = ReprA::build(&w.lines);
                let (mut d, mut da) = (Driver::new(w), Driver::new(w));
                let mut jams = Jams::new(w);
                let mut closed = vec![false; w.toggles.len()];
                let mut before: Vec<Vec<(Item, u32)>> = vec![Vec::new(); n];
                let mut survivors = Vec::new();
                let (mut ia, mut ib) = (Vec::new(), Vec::new());
                for t in 1..=300 {
                    r.obs_mut().begin_tick(t);
                    jams.apply(w, t, &mut r);
                    d.game_phase(w, &mut r);
                    if let Regime::SaturatedView { period, .. } = w.regime {
                        for (i, tg) in w.toggles.iter().enumerate() {
                            let c = tg.closed(t, period);
                            if c != closed[i] {
                                closed[i] = c;
                                a.set_out(tg.line, if c { Out::DeadEnd } else { Out::Sink });
                            }
                        }
                    }
                    da.game_phase(w, &mut a);
                    for (l, b) in before.iter_mut().enumerate() {
                        r.items(l as LineIdx, b);
                    }
                    let crossed = r.obs().crossed.clone();
                    r.advance(&w.order);
                    a.advance(&w.order);
                    let bad = oracle(&before, &r, &crossed, &speeds);
                    r.obs_mut().scan_dues();
                    r.obs().survivor_lines(&mut survivors);
                    assert_eq!(survivors, bad, "{at}: tick {t}: tracker vs oracle");
                    deviations += bad.len() as u64;
                    let (o, v) = r.split();
                    o.rebuild_dirty(&v);
                    // A state message re-stops the items the line held at `t - 1`: from their
                    // `t - 1` positions with the new stops, they must land exactly where the advance
                    // put them (crossers: below 0; the rest: on the line, in order).
                    for &(l, m) in &r.obs().msgs {
                        let (Msg::State(fs) | Msg::Paused(fs) | Msg::Resumed(fs)) = m else {
                            continue;
                        };
                        states += 1;
                        let li = l as usize;
                        let c = (r.obs().crossed[li] - crossed[li]) as usize;
                        r.items(l, &mut ib);
                        for (k, &(_, x)) in before[li].iter().enumerate() {
                            let stop = fs.map(|s| s + SP * k as i32);
                            let mut dx = x as i32 - speeds[li];
                            if let Some(s) = stop {
                                dx = dx.max(s);
                            }
                            if k < c {
                                assert!(
                                    dx < 0,
                                    "{at}: tick {t} line {l}: state, crosser {k} at {dx}"
                                );
                            } else {
                                assert_eq!(
                                    dx,
                                    ib[k - c].1 as i32,
                                    "{at}: tick {t} line {l}: state message, item {k}"
                                );
                            }
                        }
                    }
                    for l in 0..n as LineIdx {
                        a.items(l, &mut ia);
                        r.items(l, &mut ib);
                        assert_eq!(ib, ia, "{at}: tick {t} line {l}: B1 vs A");
                    }
                }
            }
        }
    }
    // The worlds deviate (jams toggle, compression fronts meet depth limits).
    assert!(deviations > 100, "only {deviations} deviations");
    assert!(states > 100, "only {states} state messages");
}

/// `(live delta, high-water delta)` over `ticks` of a tracked run (as `spike_repr.rs`'s).
fn alloc_deltas(
    w: &BenchWorld,
    vis: &[bool],
    depth: usize,
    variant: Variant,
    ticks: u32,
) -> (isize, isize) {
    use engine::abi::arena::{thread_high_water_bytes, thread_live_bytes};
    let mut tracker = Tracker::new(&w.lines, vis.to_vec(), depth, variant);
    tracker.set_spawners(w.spawners.iter().map(|s| s.line));
    let mut r: Tracked = ReprB::build_with(&w.lines, tracker);
    let (o, v) = r.split();
    o.rebuild_all(&v);
    let mut d = Driver::new(w);
    let mut jams = Jams::new(w);
    let pad = (thread_high_water_bytes() - thread_live_bytes()).max(0) as usize + 1;
    let _pad = vec![0u8; pad];
    let (live0, high0) = (thread_live_bytes(), thread_high_water_bytes());
    assert_eq!(live0, high0, "padding did not reach the high-water mark");
    for t in 1..=ticks {
        tick_tracked(w, t, &mut r, &mut d, &mut jams);
    }
    (
        thread_live_bytes() - live0,
        thread_high_water_bytes() - high0,
    )
}

#[test]
fn forecast_no_alloc_small() {
    for regime in [Regime::Mixed, sv(20, 20)] {
        let w = bench_world_scaled(SEED, regime, SMALL);
        let vis = vec![true; w.lines.len()];
        assert_eq!(
            alloc_deltas(&w, &vis, 4, Variant::Baseline, 100),
            (0, 0),
            "tracker on, {}",
            regime.name()
        );
    }
    // The chosen setup (`LineState2`, depth 8) on the client test's worlds and views.
    for (name, w, vis) in checked_worlds() {
        assert_eq!(
            alloc_deltas(&w, &vis, 8, Variant::LineState2, 100),
            (0, 0),
            "LineState2 depth 8, {name}"
        );
    }
}

// ---- the measurement ----

const WARMUP: u32 = 200;
const MEASURED: u32 = 1_200;
const DEPTHS: [usize; 4] = [1, 2, 4, 8];

/// The variants measured at `depth`: the first five at 1, 2 and 4 (as before the second
/// extension), `LineState2` at 4 and 8.
fn variants_at(depth: usize) -> &'static [Variant] {
    use Variant::*;
    match depth {
        1 | 2 => &[Baseline, SinkPredicted, PeriodicSpawner, Both, LineState],
        4 => &[
            Baseline,
            SinkPredicted,
            PeriodicSpawner,
            Both,
            LineState,
            LineState2,
        ],
        _ => &[LineState2],
    }
}
const JAMS: [(u8, u16); 4] = [(0, 0), (5, 100), (20, 100), (20, 20)];
const COST_PAIRS: usize = 5;
/// The tick costs timed: the first measurement's setup, and the chosen one (`LineState2`, depth 8)
/// on `Mixed` and on `SaturatedView` (20, 20).
const COSTS: [(&str, usize, Variant); 3] = [
    ("mixed", 4, Variant::Baseline),
    ("mixed", 8, Variant::LineState2),
    ("saturated-view (20, 20)", 8, Variant::LineState2),
];

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let idx = ((p * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[idx]
}

struct VariantResult {
    rebuilt_mean: f64,
    rebuilt_p99: f64,
    bytes_per_sec: f64,
    corrections_per_run_per_sec: f64,
    events_per_tick: [f64; common::forecast::N_EV],
    /// `LineState`: state messages and full forecasts per tick, their bytes per second, and full
    /// forecasts per tick by reason.
    state_mean: f64,
    full_mean: f64,
    state_bps: f64,
    full_bps: f64,
    full_reasons: [f64; N_FULL],
    /// `LineState2`: paused and resumed messages per tick, `LineStructs` Put bytes per second.
    paused_mean: f64,
    resumed_mean: f64,
    struct_bps: f64,
    /// Items reaching a visible line from an invisible one per tick; as arrival messages and as
    /// full forecasts of their lines, bytes per second.
    arrivals_mean: f64,
    arrival_msg_bps: f64,
    arrival_full_bps: f64,
}

/// One world, one depth, one variant: `WARMUP` then `MEASURED` tracked ticks.
fn run_variant(
    w: &BenchWorld,
    visible: &[bool],
    depth: usize,
    variant: Variant,
) -> (VariantResult, f64) {
    let mut tracker = Tracker::new(&w.lines, visible.to_vec(), depth, variant);
    tracker.set_spawners(w.spawners.iter().map(|s| s.line));
    let mut r: Tracked = ReprB::build_with(&w.lines, tracker);
    let (o, v) = r.split();
    o.rebuild_all(&v);
    let mut d = Driver::new(w);
    let mut jams = Jams::new(w);
    let vis: Vec<LineIdx> = (0..w.lines.len() as LineIdx)
        .filter(|&l| visible[l as usize])
        .collect();
    let mut rebuilt = Vec::with_capacity(MEASURED as usize);
    let mut bytes = 0u64;
    let mut runs = 0u64;
    let mut events = [0u64; common::forecast::N_EV];
    let (mut states, mut fulls, mut state_b, mut full_b) = (0u64, 0u64, 0u64, 0u64);
    let (mut paused, mut resumed, mut struct_b) = (0u64, 0u64, 0u64);
    let (mut arrivals, mut arrival_full_b) = (0u64, 0u64);
    let mut reasons0 = [0u64; N_FULL];
    for t in 1..=WARMUP + MEASURED {
        tick_tracked(w, t, &mut r, &mut d, &mut jams);
        if t == WARMUP {
            reasons0 = r.obs().full_reasons;
        }
        if t <= WARMUP {
            continue;
        }
        let o = r.obs();
        states += u64::from(o.stats.state_visible);
        fulls += u64::from(o.stats.full_visible);
        state_b += o.stats.state_bytes;
        full_b += o.stats.full_bytes;
        paused += u64::from(o.stats.paused_visible);
        resumed += u64::from(o.stats.resumed_visible);
        struct_b += o.stats.struct_bytes;
        arrivals += u64::from(o.stats.arrivals_visible);
        arrival_full_b += o.stats.arrival_full_bytes;
        rebuilt.push(f64::from(o.stats.rebuilt_visible));
        bytes += o.stats.bytes_visible;
        for &(k, l) in &o.events {
            if visible[l as usize] {
                events[k as usize] += 1;
            }
        }
        let (_, v) = r.split();
        runs += vis.iter().map(|&l| u64::from(v.runs(l))).sum::<u64>();
    }
    let m = f64::from(MEASURED);
    let runs_mean = runs as f64 / m;
    let rebuilt_mean = rebuilt.iter().sum::<f64>() / m;
    rebuilt.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let res = VariantResult {
        rebuilt_mean,
        rebuilt_p99: percentile(&rebuilt, 0.99),
        bytes_per_sec: bytes as f64 / m * f64::from(HZ),
        corrections_per_run_per_sec: rebuilt_mean * f64::from(HZ) / runs_mean,
        events_per_tick: events.map(|e| e as f64 / m),
        state_mean: states as f64 / m,
        full_mean: fulls as f64 / m,
        state_bps: state_b as f64 / m * f64::from(HZ),
        full_bps: full_b as f64 / m * f64::from(HZ),
        full_reasons: core::array::from_fn(|i| (r.obs().full_reasons[i] - reasons0[i]) as f64 / m),
        paused_mean: paused as f64 / m,
        resumed_mean: resumed as f64 / m,
        struct_bps: struct_b as f64 / m * f64::from(HZ),
        arrivals_mean: arrivals as f64 / m,
        arrival_msg_bps: (arrivals * u64::from(ARRIVAL_BYTES)) as f64 / m * f64::from(HZ),
        arrival_full_bps: arrival_full_b as f64 / m * f64::from(HZ),
    };
    (res, runs_mean)
}

fn cell_json(
    w: &BenchWorld,
    visible: &[bool],
    view: &str,
    depth: usize,
    variants: &[Variant],
) -> String {
    let (jam_pct, period) = match w.regime {
        Regime::SaturatedView { jam_pct, period } => (jam_pct, period),
        _ => (0, 0),
    };
    let mut parts = Vec::new();
    let mut runs_mean = 0.0;
    for &variant in variants {
        let (r, rm) = run_variant(w, visible, depth, variant);
        runs_mean = rm;
        let ev: Vec<String> = Ev::ALL
            .iter()
            .map(|&k| format!("\"{}\":{:.3}", k.key(), r.events_per_tick[k as usize]))
            .collect();
        println!(
            "{} jam {jam_pct}/{period} depth {depth} {}: rebuilt/tick mean {:.2} p99 {:.0}; {:.0} B/s; \
             {:.4} corrections/visible run/s; visible runs {:.0}; events/tick {}",
            w.regime.name(),
            variant.key(),
            r.rebuilt_mean,
            r.rebuilt_p99,
            r.bytes_per_sec,
            r.corrections_per_run_per_sec,
            rm,
            ev.join(" "),
        );
        let line_state = if matches!(variant, Variant::LineState | Variant::LineState2) {
            let reasons: Vec<String> = r.full_reasons.iter().map(|x| format!("{x:.3}")).collect();
            println!(
                "  lineState: state messages/tick {:.2} ({:.0} B/s), full/tick {:.2} ({:.0} B/s); \
                 full by reason (structural, no step, blocked off stop, crossed, stop behind) {}",
                r.state_mean,
                r.state_bps,
                r.full_mean,
                r.full_bps,
                reasons.join(" ")
            );
            let ls2 = if variant == Variant::LineState2 {
                println!(
                    "  lineState2: paused/tick {:.2}, resumed/tick {:.2}; struct Puts {:.0} B/s; \
                     forecast + struct {:.0} B/s",
                    r.paused_mean,
                    r.resumed_mean,
                    r.struct_bps,
                    r.bytes_per_sec + r.struct_bps
                );
                format!(
                    ",\"pausedMean\":{:.3},\"resumedMean\":{:.3},\"totalBytesPerSec\":{:.0},\
                     \"arrivalsMean\":{:.3},\"arrivalMsgBytesPerSec\":{:.0},\
                     \"arrivalFullBytesPerSec\":{:.0}",
                    r.paused_mean,
                    r.resumed_mean,
                    r.bytes_per_sec + r.struct_bps,
                    r.arrivals_mean,
                    r.arrival_msg_bps,
                    r.arrival_full_bps,
                )
            } else {
                String::new()
            };
            format!(
                ",\"stateMean\":{:.3},\"fullMean\":{:.3},\"stateBytesPerSec\":{:.0},\
                 \"fullBytesPerSec\":{:.0},\"fullReasonsPerTick\":[{}]{ls2}",
                r.state_mean,
                r.full_mean,
                r.state_bps,
                r.full_bps,
                reasons.join(","),
            )
        } else {
            String::new()
        };
        parts.push(format!(
            "\"{}\":{{\"rebuiltMean\":{:.3},\"rebuiltP99\":{:.0},\"bytesPerSec\":{:.0},\
             \"structBytesPerSec\":{:.0},\"correctionsPerVisibleRunPerSec\":{:.5},\
             \"eventsPerTick\":{{{}}}{line_state}}}",
            variant.key(),
            r.rebuilt_mean,
            r.rebuilt_p99,
            r.bytes_per_sec,
            r.struct_bps,
            r.corrections_per_run_per_sec,
            ev.join(","),
        ));
    }
    format!(
        "{{\"regime\":\"{}\",\"view\":\"{view}\",\"jamPct\":{jam_pct},\"period\":{period},\
         \"depth\":{depth},\"visibleLines\":{},\"visibleRunsMean\":{runs_mean:.1},{}}}",
        w.regime.name(),
        visible.iter().filter(|&&v| v).count(),
        parts.join(","),
    )
}

/// Median tick µs of one run, tracker off (`None`) or on (`(depth, variant)`, every line visible),
/// and for "on" the median of the tracker's end-of-tick part.
#[allow(clippy::disallowed_types)] // the harness's own timer never reaches the measured state (0002 §2)
fn tick_cost(w: &BenchWorld, on: Option<(usize, Variant)>) -> (f64, f64) {
    use std::time::Instant;
    let mut d = Driver::new(w);
    let mut jams = Jams::new(w);
    let mut tick_us = Vec::with_capacity(MEASURED as usize);
    let mut end_us = Vec::with_capacity(MEASURED as usize);
    if let Some((depth, variant)) = on {
        let n = w.lines.len();
        let mut tracker = Tracker::new(&w.lines, vec![true; n], depth, variant);
        tracker.set_spawners(w.spawners.iter().map(|s| s.line));
        let mut r: Tracked = ReprB::build_with(&w.lines, tracker);
        let (o, v) = r.split();
        o.rebuild_all(&v);
        for t in 1..=WARMUP + MEASURED {
            let t0 = Instant::now();
            r.obs_mut().begin_tick(t);
            jams.apply(w, t, &mut r);
            d.game_phase(w, &mut r);
            r.advance(&w.order);
            let t1 = Instant::now();
            let (o, v) = r.split();
            o.end_tick(&v);
            let t2 = Instant::now();
            if t > WARMUP {
                tick_us.push((t2 - t0).as_secs_f64() * 1e6);
                end_us.push((t2 - t1).as_secs_f64() * 1e6);
            }
        }
    } else {
        let mut r = ReprB1::build(&w.lines);
        for t in 1..=WARMUP + MEASURED {
            let t0 = Instant::now();
            tick_plain(w, t, &mut r, &mut d, &mut jams);
            if t > WARMUP {
                tick_us.push(t0.elapsed().as_secs_f64() * 1e6);
            }
        }
    }
    let sort = |v: &mut Vec<f64>| v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    sort(&mut tick_us);
    sort(&mut end_us);
    (
        percentile(&tick_us, 0.5),
        if on.is_some() {
            percentile(&end_us, 0.5)
        } else {
            0.0
        },
    )
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

/// The spike's measurement: `Mixed` (its visible set) and `SaturatedView` at four jam settings,
/// each at path depth 1, 2 and 4 under five variants and at 4 and 8 under `LineState2`
/// ([`variants_at`]), and `Mixed` through a 64-tile-wide view under `LineState2` at depth 8 (200
/// warm-up ticks, 1,200 measured); then the tracker's tick cost ([`COSTS`]), off and on
/// interleaved, five pairs each. Release
/// only: the dev-profile run re-runs itself with `cargo test --release` and records the cells.
#[test]
fn slow_spike_forecast_cells() {
    if cfg!(debug_assertions) {
        let samples = common::bench_run::run_in_release_samples(
            "spike_forecast",
            "slow_spike_forecast_cells",
        );
        assert_eq!(
            samples.len(),
            DEPTHS.len() * (1 + JAMS.len()) + 1 + COSTS.len(),
            "one cell per world x depth, the 64-tile mixed view, the tick costs"
        );
        for s in &samples {
            println!("BENCH_SAMPLE {s}");
        }
        let dir = common::bench_run::repo_root().join("test-results/rust/bench");
        std::fs::create_dir_all(&dir).expect("test-results/rust/bench");
        let path = dir.join("spike-forecast.json");
        std::fs::write(&path, format!("[\n{}\n]\n", samples.join(",\n")))
            .expect("writing the spike's record");
        println!("recorded {}", path.display());
        return;
    }
    let mixed = bench_world(SEED, Regime::Mixed);
    let mixed_vis = visible_at_centre(&mixed);
    for depth in DEPTHS {
        println!(
            "BENCH_SAMPLE {}",
            cell_json(&mixed, &mixed_vis, "256x144", depth, variants_at(depth))
        );
    }
    // Finding 8: a view that cuts the chains (items arrive from lines the client cannot see).
    let narrow = visible_in(&mixed, 64, VIEW_H);
    println!(
        "BENCH_SAMPLE {}",
        cell_json(&mixed, &narrow, "64x144", 8, &[Variant::LineState2])
    );
    let sat20 = bench_world(SEED, sv(20, 20));
    for (jam_pct, period) in JAMS {
        let w = bench_world(SEED, sv(jam_pct, period));
        let vis = visible_at_centre(&w);
        assert_eq!(
            (w.width, w.height),
            (VIEW_W, VIEW_H),
            "the saturated view is one viewport"
        );
        for depth in DEPTHS {
            println!(
                "BENCH_SAMPLE {}",
                cell_json(&w, &vis, "256x144", depth, variants_at(depth))
            );
        }
    }
    let fmt = |v: &[f64]| {
        v.iter()
            .map(|x| format!("{x:.1}"))
            .collect::<Vec<_>>()
            .join(",")
    };
    for (wname, depth, variant) in COSTS {
        let w = if wname == "mixed" { &mixed } else { &sat20 };
        let (mut off, mut on, mut end) = (Vec::new(), Vec::new(), Vec::new());
        for _ in 0..COST_PAIRS {
            off.push(tick_cost(w, None).0);
            let (t, e) = tick_cost(w, Some((depth, variant)));
            on.push(t);
            end.push(e);
        }
        let (m_off, m_on, m_end) = (median(off.clone()), median(on.clone()), median(end.clone()));
        println!(
            "tick cost ({wname}, depth {depth}, {}): off median {m_off:.1} us, on median {m_on:.1} \
             us (+{:.1} us; end-of-tick part {m_end:.1} us)",
            variant.key(),
            m_on - m_off
        );
        println!(
            "BENCH_SAMPLE {{\"regime\":\"{wname}\",\"cost\":\"tracker\",\"depth\":{depth},\
             \"variant\":\"{}\",\"offMedianUs\":{m_off:.1},\"onMedianUs\":{m_on:.1},\
             \"deltaUs\":{:.1},\"endOfTickMedianUs\":{m_end:.1},\"offRunsUs\":[{}],\
             \"onRunsUs\":[{}],\"endOfTickRunsUs\":[{}]}}",
            variant.key(),
            m_on - m_off,
            fmt(&off),
            fmt(&on),
            fmt(&end),
        );
    }
}
