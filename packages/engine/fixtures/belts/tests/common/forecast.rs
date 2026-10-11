//! M41's forecast tracker (docs/decisions/0078 §2-§3, `docs/plan/41-forecast-spike.md`): the
//! cheap forecast of a line, the dirty events that invalidate it, and the byte model, observed
//! from inside M40's winner ([`ReprB`] through its [`Observer`] hooks; it never changes the
//! advance).
//!
//! **A forecast** (per line `L`, built after tick `T`'s advance): per run `item, count, pos` (first
//! item at `T`), `stop` and `path`. Positions are cumulative along the path in `L`'s coordinates
//! (positions grow backward, so a stop on a later line is negative: `stop = pos_on_P1 - P1.len`,
//! `pos_on_P2 - P2.len - P1.len`, ...). Item `k` of a run (`k = 0` the first) is at
//! `pos(t) = max(pos + k * SPACING - speed * (t - T), stop + k * SPACING)`; when it is below 0 it
//! is on the next line of `path`, past `path` on the next plain `Next` line, and gone past a
//! `Sink`. `stop` is the cheap forecast's "keep the present state" (see [`Tracker::front_stop`]):
//! walking `L`'s output and then up to `depth` path lines, a `DeadEnd` stops the first item ahead
//! at its front, a `Sink` means no stop, and at the depth limit a line whose front item held this
//! tick stops there (a jam beyond sight stays a jam); every item then stops `SPACING` behind the
//! item ahead of it, so a run's stop is `SPACING x items ahead` behind the origin. Nothing found:
//! `stop = None`.
//!
//! **Ownership** (the gap 0078 §2 leaves; recorded in M41's Deviations): a forecast built at `T`
//! describes the items on its line at `T`, and keeps describing an item after it crosses into a
//! path line until that line's own forecast is rebuilt (a newer forecast of `L` replaces only the
//! items still on `L`). So every item has exactly one current trajectory: the tracker keeps, per
//! line, the items' predicted stops as segments (`n` items, the first one's stop; item `k` of a
//! segment stops at `stop + k * SPACING`), and checks the advance against them.
//!
//! **Detection** (one comparison per front item, O(1) per hand-off). Within a segment, if an item
//! moves as predicted, the item behind it does too (`max(x - v, leader' + SP)` reduces to
//! `max(x - v, stop)` when the leader followed its own prediction and spacing holds), so only the
//! line's front item needs checking ([`Ev::Blocked`], [`Ev::Moved`]). A landed item whose stop is
//! not the chain of the segment ahead starts a new segment, and the tick at which its prediction
//! and the chain first part is computed at landing (both move freely until then) and fires then
//! unless the line was rebuilt first. Inserts, sink exits, structure changes and hand-offs off the
//! path are observed directly.
#![allow(dead_code)]

use super::repr::{NONE, Repr};
use super::repr_b::{LinesView, Observer, ReprB, RunStore};
use super::world::{BenchWorld, Item, LineIdx, LineSpec, Out, Regime};

pub const SP: i32 = super::repr::SP;
pub const MAX_DEPTH: usize = 8;
const NIL: u32 = u32::MAX;
const NEVER: u32 = u32::MAX;

/// The dirty events of 0078 §3 as instrumented, one bit each.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default)]
pub enum Ev {
    /// (a) A run blocked at a position other than its `stop` (it moved less than predicted).
    #[default]
    Blocked = 0,
    /// (b) A run moved although its `stop` said it had halted (it moved more than predicted).
    Moved = 1,
    /// (c) A hand-off onto a line other than the forecast's path (only a structure change makes
    /// one here: the spike has no `Fork`).
    OffPath = 2,
    /// (d) An item inserted (`insert_back`).
    Insert = 3,
    /// (d') Under the periodic-spawner variant: a spawner refused twice in a row with an unmoved
    /// tail (a jam reached it), once per jam.
    Refused = 4,
    /// (e) An item removed by a `Sink`.
    Sink = 5,
    /// (f) A structure change (here: a line's output).
    Structure = 6,
    /// `insert_at` / `remove_at` (inserter-like calls; no measured cell has them).
    Edit = 7,
    /// A spawner's first successful insert after a `Refused` (a correction only in `LineState2`).
    Resumed = 8,
}

pub const N_EV: usize = 9;
/// Not an event: marks a line whose deviation (a or b) was seen on an item still on the line (the
/// front item, or a segment's first item at its due tick). The oracle test compares against it.
const SURVIVOR: u16 = 1 << 15;

impl Ev {
    pub const ALL: [Ev; N_EV] = [
        Ev::Blocked,
        Ev::Moved,
        Ev::OffPath,
        Ev::Insert,
        Ev::Refused,
        Ev::Sink,
        Ev::Structure,
        Ev::Edit,
        Ev::Resumed,
    ];
    pub fn bit(self) -> u16 {
        1 << self as u16
    }
    pub fn key(self) -> &'static str {
        match self {
            Ev::Blocked => "a",
            Ev::Moved => "b",
            Ev::OffPath => "c",
            Ev::Insert => "d",
            Ev::Refused => "dRefused",
            Ev::Sink => "e",
            Ev::Structure => "f",
            Ev::Edit => "edit",
            Ev::Resumed => "dResumed",
        }
    }
}

/// Which events are corrections (a forecast is rebuilt and sent).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    /// 0078 §3 as written: every event but `Refused`.
    Baseline,
    /// A sink exit is predicted by the path's terminal `Sink`: not a correction.
    SinkPredicted,
    /// The forecast carries the spawner's schedule: an insert is not a correction, a jam reaching
    /// the spawner (`Refused`) is.
    PeriodicSpawner,
    /// Both of the above.
    Both,
    /// `Both`'s corrections, each sent as an 11-byte state message (a new `front_stop`) when the
    /// line's run list is unchanged and the new stops are exactly `front_stop + SPACING x items
    /// ahead`, else as a full forecast (see [`Tracker::rebuild_dirty`]).
    LineState,
    /// `LineState` where a structure change is a state message too (the structure itself is a
    /// `LineStructs` Put, modelled separately: [`STRUCT_PUT_BYTES`]), and a spawner's pause
    /// (`Refused`) and resume (`Resumed`) are state messages with a flag.
    LineState2,
}

impl Variant {
    pub const ALL: [Variant; 6] = [
        Variant::Baseline,
        Variant::SinkPredicted,
        Variant::PeriodicSpawner,
        Variant::Both,
        Variant::LineState,
        Variant::LineState2,
    ];
    pub fn key(self) -> &'static str {
        match self {
            Variant::Baseline => "baseline",
            Variant::SinkPredicted => "sinkPredicted",
            Variant::PeriodicSpawner => "periodicSpawner",
            Variant::Both => "both",
            Variant::LineState => "lineState",
            Variant::LineState2 => "lineState2",
        }
    }
    pub fn mask(self) -> u16 {
        let base = Ev::Blocked.bit()
            | Ev::Moved.bit()
            | Ev::OffPath.bit()
            | Ev::Structure.bit()
            | Ev::Edit.bit();
        match self {
            Variant::Baseline => base | Ev::Insert.bit() | Ev::Sink.bit(),
            Variant::SinkPredicted => base | Ev::Insert.bit(),
            Variant::PeriodicSpawner => base | Ev::Refused.bit() | Ev::Sink.bit(),
            Variant::Both | Variant::LineState => base | Ev::Refused.bit(),
            Variant::LineState2 => base | Ev::Refused.bit() | Ev::Resumed.bit(),
        }
    }
}

/// The byte model of M41's brief (not a wire format; M47 encodes): `4` line id + `4` tick + `1` run
/// count, and per run `2` item + `1` count + `3` pos + `3` stop + `1` path length + `3` per path
/// line.
pub const FORECAST_HEADER_BYTES: u32 = 4 + 4 + 1;
pub const RUN_BYTES: u32 = 2 + 1 + 3 + 3 + 1;
pub const PATH_LINE_BYTES: u32 = 3;
/// `LineState`'s state message: `4` line id + `4` tick + `3` front stop.
pub const STATE_BYTES: u32 = 4 + 4 + 3;
/// `LineState2`'s state message with the spawner's paused flag.
pub const SPAWNER_STATE_BYTES: u32 = STATE_BYTES + 1;
/// `LineState2`: a `LineStructs` Put (0078 §1): `4` line + `4` len + `2` speed + `5` output + `4`
/// anchor.
pub const STRUCT_PUT_BYTES: u32 = 4 + 4 + 2 + 5 + 4;
/// The periodic-spawner forecast's spawner fields in a full forecast of a spawner's line: `2`
/// `rate256` + `2` accumulator + `3` cycling flag and next item.
pub const SPAWNER_FIELDS_BYTES: u32 = 2 + 2 + 3;
/// An arrival message (an item reaching a visible line from an invisible one): `4` line + `2` item +
/// `3` position.
pub const ARRIVAL_BYTES: u32 = 4 + 2 + 3;

/// Why `LineState` sent a full forecast (indices of [`Tracker::full_reasons`]).
pub const FULL_STRUCTURAL: usize = 0;
/// The line had no front-item step this tick (its items all arrived during the tick).
pub const FULL_NO_STEP: usize = 1;
/// An item was blocked this tick but the new stop of the line's front item is not where it is.
pub const FULL_BLOCKED_OFF_STOP: usize = 2;
/// Items that crossed the front this tick would get a different stop, and their line is not
/// rebuilt this tick.
pub const FULL_CROSSED: usize = 3;
/// A new stop lies behind its run's position (only a squashed pair makes one).
pub const FULL_STOP_BEHIND: usize = 4;
pub const N_FULL: usize = 5;

/// A `LineState` message: a new `front_stop` for the items the line held at `T - 1` (`None`: no
/// stop), or a full forecast.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Msg {
    State(Option<i32>),
    /// `LineState2`: a state message that also pauses the line's spawner replay.
    Paused(Option<i32>),
    /// `LineState2`: a state message that also resumes it (the spawner inserted this tick).
    Resumed(Option<i32>),
    Full,
}
/// Ticks per second (0010).
pub const HZ: u32 = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunForecast {
    pub item: Item,
    pub count: u16,
    pub pos: i32,
    pub stop: Option<i32>,
    /// How many lines of the forecast's path this run enters (its share of the byte model).
    pub path_len: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Forecast {
    pub line: LineIdx,
    pub tick: u32,
    pub path: Vec<LineIdx>,
    pub runs: Vec<RunForecast>,
    pub bytes: u32,
}

#[derive(Clone, Copy)]
struct Seg {
    n: u32,
    stop: i32,
    /// The tick at which this segment's first item leaves its own prediction (if it is still
    /// behind another segment then); `NEVER` for a consistent segment.
    due: u32,
    kind: Ev,
}

/// One tick's rebuilds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TickStats {
    pub rebuilt: u32,
    pub rebuilt_visible: u32,
    pub bytes_visible: u64,
    /// `LineState` only: visible state messages and full forecasts, and their bytes.
    pub state_visible: u32,
    pub full_visible: u32,
    pub state_bytes: u64,
    pub full_bytes: u64,
    /// `LineState2`: of `state_visible`, the paused and resumed messages; the `LineStructs` Puts'
    /// bytes (visible lines).
    pub paused_visible: u32,
    pub resumed_visible: u32,
    pub struct_bytes: u64,
    /// Items that reached a visible line from an invisible one, and the full forecasts of those
    /// lines (once per line per tick) if they were sent instead of arrival messages.
    pub arrivals_visible: u32,
    pub arrival_full_bytes: u64,
}

/// The dirty-line tracker and forecast builder: an [`Observer`] of [`ReprB`]. Everything is
/// allocated in [`Tracker::new`] (segments: one ring per line of `ceil(len / 64)`, the most items a
/// line can hold).
#[derive(Clone, Default)]
pub struct Tracker {
    depth: usize,
    mask: u16,
    now: u32,
    len: Vec<i32>,
    speed: Vec<i32>,
    out: Vec<Out>,
    visible: Vec<bool>,
    items: Vec<u32>,
    segs: Vec<Seg>,
    base: Vec<u32>,
    cap: Vec<u32>,
    head: Vec<u32>,
    nseg: Vec<u32>,
    due_min: Vec<u32>,
    /// The first line of the forecast's path (`NIL`: none).
    path0: Vec<u32>,
    /// The front item held this tick (did not move, nothing crossed); `front_pos`: where.
    stalled: Vec<bool>,
    front_pos: Vec<i32>,
    /// An `insert_at`/`remove_at` this tick: segments unknown until the rebuild.
    invalid: Vec<bool>,
    refused_tick: Vec<u32>,
    refused_tail: Vec<i32>,
    jammed: Vec<bool>,
    ev_mask: Vec<u16>,
    touched: Vec<LineIdx>,
    /// This tick's events in the order seen, one per (kind, line).
    pub events: Vec<(Ev, LineIdx)>,
    /// Items that crossed each line's front, ever (the oracle test's bookkeeping).
    pub crossed: Vec<u64>,
    pending: i32,
    pending_valid: bool,
    cur: LineIdx,
    cur_crossed: bool,
    pub stats: TickStats,
    /// 0: full forecasts only; 1: `LineState`; 2: `LineState2`.
    line_state: u8,
    /// `LineState`'s per-tick facts per line, valid when `step_tick == now`: an item reaching
    /// the front was blocked; items that crossed, the first one's old stop and whether the
    /// crossers' old stops formed one chain. `front_tick == now`: `front_pos` is this tick's.
    step_tick: Vec<u32>,
    front_tick: Vec<u32>,
    blocked: Vec<bool>,
    cross_n: Vec<u32>,
    cross_first: Vec<i32>,
    cross_chain: Vec<bool>,
    land_blocked_tick: Vec<u32>,
    last_cross_blocked: bool,
    /// This tick's `LineState` messages (every line, visible or not).
    pub msgs: Vec<(LineIdx, Msg)>,
    /// Lines with a spawner, and whether the variant forecasts spawners (their fields cost
    /// [`SPAWNER_FIELDS_BYTES`] in a full forecast).
    spawner: Vec<bool>,
    periodic: bool,
    /// Items that landed on a line this tick (`land_tick == now`), all from `land_src` (one feeder
    /// per line in these worlds); `landed`: those lines.
    land_tick: Vec<u32>,
    land_n: Vec<u32>,
    land_src: Vec<u32>,
    landed: Vec<LineIdx>,
    /// Rebuilt this tick (`dirty_tick == now`): the new stop of the front item at `T` (`s0_of`) and
    /// of the first item of the line's `T - 1` list (`msg_base = s0 - SP x crossers`).
    dirty_tick: Vec<u32>,
    s0_of: Vec<i32>,
    msg_base: Vec<i32>,
    /// A line emptied by crossings this tick, and the chain its last item left (the stop the next
    /// item at its back would get).
    emptied_tick: Vec<u32>,
    emptied_chain: Vec<i32>,
    /// This tick's arrivals on visible lines from invisible ones (`(line, pos)`), and those lines.
    pub arrivals: Vec<(LineIdx, i32)>,
    arrival_tick: Vec<u32>,
    arrival_lines: Vec<LineIdx>,
    scratch_pos: Vec<i32>,
    scratch_stop: Vec<i32>,
    /// Full forecasts by reason, visible lines, since [`Tracker::new`].
    pub full_reasons: [u64; N_FULL],
    /// Events per kind since [`Tracker::new`] (one per line per tick per kind).
    pub totals: [u64; N_EV],
    /// Forecast rebuilds since [`Tracker::new`], every line and visible lines.
    pub rebuilt_total: u64,
}

impl Tracker {
    pub fn new(specs: &[LineSpec], visible: Vec<bool>, depth: usize, variant: Variant) -> Self {
        assert!((1..=MAX_DEPTH).contains(&depth), "path depth 1-8");
        assert_eq!(visible.len(), specs.len());
        let n = specs.len();
        let cap: Vec<u32> = specs
            .iter()
            .map(|s| s.len.div_ceil(SP as u32).max(1))
            .collect();
        let mut base = Vec::with_capacity(n);
        let mut b = 0u32;
        for &c in &cap {
            base.push(b);
            b += c;
        }
        Tracker {
            depth,
            mask: variant.mask(),
            now: 0,
            len: specs.iter().map(|s| s.len as i32).collect(),
            speed: specs.iter().map(|s| i32::from(s.speed)).collect(),
            out: specs.iter().map(|s| s.out).collect(),
            visible,
            items: vec![0; n],
            segs: vec![
                Seg {
                    n: 0,
                    stop: NONE,
                    due: NEVER,
                    kind: Ev::Blocked,
                };
                b as usize
            ],
            base,
            cap,
            head: vec![0; n],
            nseg: vec![0; n],
            due_min: vec![NEVER; n],
            path0: vec![NIL; n],
            stalled: vec![false; n],
            front_pos: vec![0; n],
            invalid: vec![false; n],
            refused_tick: vec![NEVER; n],
            refused_tail: vec![0; n],
            jammed: vec![false; n],
            ev_mask: vec![0; n],
            touched: Vec::with_capacity(n),
            events: Vec::with_capacity(n * N_EV),
            crossed: vec![0; n],
            pending: NONE,
            pending_valid: false,
            cur: NIL,
            cur_crossed: false,
            stats: TickStats::default(),
            line_state: match variant {
                Variant::LineState => 1,
                Variant::LineState2 => 2,
                _ => 0,
            },
            step_tick: vec![NEVER; n],
            front_tick: vec![NEVER; n],
            blocked: vec![false; n],
            cross_n: vec![0; n],
            cross_first: vec![NONE; n],
            cross_chain: vec![true; n],
            land_blocked_tick: vec![NEVER; n],
            last_cross_blocked: false,
            msgs: Vec::with_capacity(n),
            spawner: vec![false; n],
            periodic: matches!(
                variant,
                Variant::PeriodicSpawner | Variant::Both | Variant::LineState | Variant::LineState2
            ),
            land_tick: vec![NEVER; n],
            land_n: vec![0; n],
            land_src: vec![NIL; n],
            landed: Vec::with_capacity(n),
            dirty_tick: vec![NEVER; n],
            s0_of: vec![NONE; n],
            msg_base: vec![NONE; n],
            emptied_tick: vec![NEVER; n],
            emptied_chain: vec![NONE; n],
            arrivals: Vec::with_capacity(4 * n),
            arrival_tick: vec![NEVER; n],
            arrival_lines: Vec::with_capacity(n),
            scratch_pos: Vec::with_capacity(256),
            scratch_stop: Vec::with_capacity(256),
            full_reasons: [0; N_FULL],
            totals: [0; N_EV],
            rebuilt_total: 0,
        }
    }

    pub fn now(&self) -> u32 {
        self.now
    }

    /// Marks the lines that have a spawner (the byte model's spawner fields).
    pub fn set_spawners(&mut self, lines: impl IntoIterator<Item = LineIdx>) {
        for l in lines {
            self.spawner[l as usize] = true;
        }
    }

    // ---- segments: a ring per line ----

    #[inline]
    fn seg_idx(&self, l: LineIdx, i: u32) -> usize {
        let l = l as usize;
        (self.base[l] + (self.head[l] + i) % self.cap[l]) as usize
    }

    #[inline]
    fn push_seg(&mut self, l: LineIdx, s: Seg) {
        assert!(
            self.nseg[l as usize] < self.cap[l as usize],
            "segment ring full"
        );
        let i = self.seg_idx(l, self.nseg[l as usize]);
        self.segs[i] = s;
        self.nseg[l as usize] += 1;
    }

    /// Item `k`'s predicted stops, front to back (tests: the oracle).
    pub fn predicted_stops(&self, l: LineIdx, out: &mut Vec<i32>) {
        out.clear();
        for i in 0..self.nseg[l as usize] {
            let s = self.segs[self.seg_idx(l, i)];
            for k in 0..s.n as i32 {
                out.push(if s.stop == NONE {
                    NONE
                } else {
                    s.stop + k * SP
                });
            }
        }
    }

    pub fn invalid(&self, l: LineIdx) -> bool {
        self.invalid[l as usize]
    }

    /// Lines whose deviation was seen on an item still on the line, this tick (tests: the oracle).
    pub fn survivor_lines(&self, out: &mut Vec<LineIdx>) {
        out.clear();
        out.extend(
            self.touched
                .iter()
                .copied()
                .filter(|&l| self.ev_mask[l as usize] & SURVIVOR != 0),
        );
        out.sort_unstable();
    }

    #[inline]
    fn event(&mut self, kind: Ev, l: LineIdx) {
        let m = &mut self.ev_mask[l as usize];
        if *m == 0 {
            self.touched.push(l);
        }
        if *m & kind.bit() == 0 {
            *m |= kind.bit();
            self.events.push((kind, l));
            self.totals[kind as usize] += 1;
        }
    }

    #[inline]
    fn survivor(&mut self, l: LineIdx) {
        self.ev_mask[l as usize] |= SURVIVOR;
    }

    /// An item arrives at `l`'s back at `pos` with predicted stop `s_new` (`l`'s coordinates).
    fn append(&mut self, l: LineIdx, pos: i32, s_new: i32) {
        if self.nseg[l as usize] == 0 {
            self.push_seg(
                l,
                Seg {
                    n: 1,
                    stop: s_new,
                    due: NEVER,
                    kind: Ev::Blocked,
                },
            );
            return;
        }
        let bi = self.seg_idx(l, self.nseg[l as usize] - 1);
        let back = self.segs[bi];
        let chain = if back.stop == NONE {
            NONE
        } else {
            back.stop + back.n as i32 * SP
        };
        if s_new == chain {
            self.segs[bi].n += 1;
            return;
        }
        // Both trajectories are free motion until it first goes below the higher of the two stops.
        let m = s_new.max(chain);
        let v = self.speed[l as usize];
        let k = if pos - v < m { 1 } else { (pos - m) / v + 1 };
        let due = self.now + k as u32;
        self.push_seg(
            l,
            Seg {
                n: 1,
                stop: s_new,
                due,
                kind: if s_new > chain {
                    Ev::Moved
                } else {
                    Ev::Blocked
                },
            },
        );
        self.due_min[l as usize] = self.due_min[l as usize].min(due);
    }

    /// The stop the next item at `l`'s back gets from the chain: `SPACING` behind the back item's
    /// stop; on a line its last items left by crossing this tick, behind the stop the last of them
    /// had; else `NONE` (an empty line: the client has no item to chain from, M41 Extension 3).
    fn back_chain(&self, l: LineIdx) -> i32 {
        let li = l as usize;
        if self.nseg[li] == 0 {
            return if self.emptied_tick[li] == self.now {
                self.emptied_chain[li]
            } else {
                NONE
            };
        }
        let back = self.segs[self.seg_idx(l, self.nseg[li] - 1)];
        if back.stop == NONE {
            NONE
        } else {
            back.stop + back.n as i32 * SP
        }
    }

    /// An item arrives whose prediction is the chain: an insert (the client's spawner replay chains
    /// it the same way), an arrival, or an item whose own stop is replaced this tick anyway.
    fn append_chain(&mut self, l: LineIdx, pos: i32) {
        let s = self.back_chain(l);
        self.append(l, pos, s);
    }

    /// The cheap forecast's stop for `l`'s front item, and its path (see the module doc).
    pub fn front_stop(&self, l: LineIdx) -> (i32, [LineIdx; MAX_DEPTH], usize) {
        let mut path = [NIL; MAX_DEPTH];
        let mut n = 0;
        let mut x = l;
        let mut off = 0i32;
        let mut ahead = 0i32;
        loop {
            match self.out[x as usize] {
                Out::DeadEnd => return (off + SP * ahead, path, n),
                Out::Sink => return (NONE, path, n),
                Out::Next(t) => {
                    if n == self.depth {
                        let xi = x as usize;
                        // `x`'s front item is the origin; `ahead` counts it and every item
                        // between it and `l`'s front.
                        let s = if self.items[xi] > 0 && self.stalled[xi] {
                            off + self.front_pos[xi] + SP * ahead
                        } else {
                            NONE
                        };
                        return (s, path, n);
                    }
                    path[n] = t;
                    n += 1;
                    off -= self.len[t as usize];
                    ahead += self.items[t as usize] as i32;
                    x = t;
                }
            }
        }
    }

    fn path_len(&self, stop: i32, path: &[LineIdx; MAX_DEPTH], n: usize) -> u32 {
        if stop == NONE {
            return n as u32;
        }
        let mut bound = 0;
        let mut k = 0;
        for &p in &path[..n] {
            if stop >= bound {
                break;
            }
            k += 1;
            bound -= self.len[p as usize];
        }
        k
    }

    /// Builds `l`'s forecast from the line as it is now, handing each run to `f`; returns its
    /// modelled bytes. Allocates nothing.
    #[inline]
    fn build<S: RunStore>(
        &self,
        v: &LinesView<S>,
        l: LineIdx,
        s0: i32,
        (path, n): (&[LineIdx; MAX_DEPTH], usize),
        limit: u32,
        mut f: impl FnMut(RunForecast),
    ) -> u32 {
        let mut bytes = FORECAST_HEADER_BYTES;
        let mut ahead = 0i32;
        v.for_each_run(l, |item, count, pos| {
            // Only the first `limit` items (the line's items but this tick's landers).
            if ahead as u32 >= limit {
                return;
            }
            let count = count.min((limit - ahead as u32) as u16);
            let stop = if s0 == NONE { NONE } else { s0 + SP * ahead };
            let path_len = self.path_len(stop, path, n);
            bytes += RUN_BYTES + PATH_LINE_BYTES * path_len;
            f(RunForecast {
                item,
                count,
                pos,
                stop: (stop != NONE).then_some(stop),
                path_len: path_len as u8,
            });
            ahead += i32::from(count);
        });
        bytes
    }

    /// `LineState`: whether `l`'s correction can be a state message (`Ok(front_stop)` for the items
    /// it held at `T - 1`), else why not. With `s0` the new stop of `l`'s front item:
    /// - only `a`/`b` this tick (a structure change, an off-path hand-off, a refused spawner or an
    ///   edit changes the run list or what the client must know);
    /// - every item that was blocked this tick ends exactly at its new stop: blocked items are
    ///   packed behind a blocked leader back to the front, so it is enough that the front item is
    ///   at `s0` when any item reaching the front or landing on the line was blocked (a free item
    ///   is at `max(x - v, s_k)` because `s_k` is never ahead of it, checked in the build);
    /// - the items that crossed the front this tick (they are in the `T - 1` list) keep their stops,
    ///   unless their new line is rebuilt this tick anyway.
    fn classify(&self, l: LineIdx, s0: i32) -> Result<i32, usize> {
        let li = l as usize;
        let structural = if self.line_state == 2 {
            Ev::OffPath.bit() | Ev::Edit.bit()
        } else {
            Ev::OffPath.bit() | Ev::Refused.bit() | Ev::Structure.bit() | Ev::Edit.bit()
        };
        if self.ev_mask[li] & structural != 0 {
            return Err(FULL_STRUCTURAL);
        }
        if self.step_tick[li] != self.now {
            return Err(FULL_NO_STEP);
        }
        if self.blocked[li]
            && !(s0 != NONE && self.front_tick[li] == self.now && self.front_pos[li] == s0)
        {
            return Err(FULL_BLOCKED_OFF_STOP);
        }
        let c = self.crossers(l) as i32;
        Ok(if s0 == NONE { NONE } else { s0 - SP * c })
    }

    fn crossers(&self, l: LineIdx) -> u32 {
        let li = l as usize;
        if self.step_tick[li] == self.now {
            self.cross_n[li]
        } else {
            0
        }
    }

    fn landers(&self, l: LineIdx) -> u32 {
        let li = l as usize;
        if self.land_tick[li] == self.now {
            self.land_n[li]
        } else {
            0
        }
    }

    /// Phase 1 of a rebuild: `l`'s message (classified under `LineState`/`LineState2`) and its
    /// bytes. What a message of `l` at `T` covers (M41 Extension 3): the items `l` held at `T - 1`
    /// (those that crossed its front during `T` included, at their position on the next line) and
    /// the items inserted on `l` during `T`; never the items that landed on `l` during `T` (their
    /// own line's message, or their trajectory, covers them).
    fn message<S: RunStore>(&mut self, v: &LinesView<S>, l: LineIdx) {
        let li = l as usize;
        self.items[li] = v.items(l);
        let (s0, path, n) = self.front_stop(l);
        let class = if self.line_state > 0 {
            Some(self.classify(l, s0))
        } else {
            None
        };
        let c = self.crossers(l) as i32;
        self.s0_of[li] = s0;
        self.msg_base[li] = if s0 == NONE { NONE } else { s0 - SP * c };
        self.dirty_tick[li] = self.now;
        self.path0[li] = if n > 0 { path[0] } else { NIL };
        self.invalid[li] = false;
        let limit = self.items[li] - self.landers(l);
        let mut behind = false;
        let mut full = self.build(v, l, s0, (&path, n), limit, |r| {
            behind |= r.stop.is_some_and(|s| s > r.pos);
        });
        if matches!(self.out[li], Out::Next(_)) {
            for j in 0..c {
                let st = if s0 == NONE {
                    NONE
                } else {
                    self.msg_base[li] + SP * j
                };
                full += RUN_BYTES + PATH_LINE_BYTES * self.path_len(st, &path, n);
            }
        }
        if self.periodic && self.spawner[li] {
            full += SPAWNER_FIELDS_BYTES;
        }
        self.stats.rebuilt += 1;
        self.rebuilt_total += 1;
        let class = class.map(|c| {
            if behind {
                c.and(Err(FULL_STOP_BEHIND))
            } else {
                c
            }
        });
        let m = self.ev_mask[li];
        let msg = class.map(|c| match c {
            Ok(fs) => {
                let fs = (fs != NONE).then_some(fs);
                if self.line_state == 2 && m & Ev::Refused.bit() != 0 {
                    Msg::Paused(fs)
                } else if self.line_state == 2 && m & Ev::Resumed.bit() != 0 {
                    Msg::Resumed(fs)
                } else {
                    Msg::State(fs)
                }
            }
            Err(_) => Msg::Full,
        });
        let bytes = match msg {
            Some(Msg::State(_)) => STATE_BYTES,
            Some(Msg::Paused(_) | Msg::Resumed(_)) => SPAWNER_STATE_BYTES,
            _ => full,
        };
        if let Some(msg) = msg {
            self.msgs.push((l, msg));
        }
        if self.visible[li] {
            self.stats.rebuilt_visible += 1;
            self.stats.bytes_visible += u64::from(bytes);
            match class {
                Some(Ok(_)) => {
                    self.stats.state_visible += 1;
                    self.stats.state_bytes += u64::from(bytes);
                    match msg {
                        Some(Msg::Paused(_)) => self.stats.paused_visible += 1,
                        Some(Msg::Resumed(_)) => self.stats.resumed_visible += 1,
                        _ => {}
                    }
                }
                Some(Err(why)) => {
                    self.stats.full_visible += 1;
                    self.stats.full_bytes += u64::from(bytes);
                    self.full_reasons[why] += 1;
                }
                None => {}
            }
        }
    }

    /// Phase 2: `l`'s predictions after this tick's messages. A rebuilt line's held and inserted
    /// items take its new chain; its landers keep their own stops, replaced by their source's new
    /// chain when the source sent a message the client gets (a visible source), and are appended
    /// again behind the new chain (a lander that disagrees with it gets its due tick).
    fn resegment<S: RunStore>(&mut self, v: &LinesView<S>, l: LineIdx, rebuilt: bool) {
        let li = l as usize;
        let k = self.landers(l);
        let mut stops = core::mem::take(&mut self.scratch_stop);
        let mut pos = core::mem::take(&mut self.scratch_pos);
        stops.clear();
        pos.clear();
        if k > 0 {
            // The last `k` items' stops, front to back.
            stops.resize(k as usize, NONE);
            let mut need = k;
            let mut i = self.nseg[li];
            while need > 0 {
                i -= 1;
                let sg = self.segs[self.seg_idx(l, i)];
                let take = need.min(sg.n);
                for m in 0..take {
                    let idx = sg.n - 1 - m;
                    stops[(need - 1 - m) as usize] = if sg.stop == NONE {
                        NONE
                    } else {
                        sg.stop + SP * idx as i32
                    };
                }
                need -= take;
            }
            let src = self.land_src[li] as usize;
            if self.dirty_tick[src] == self.now && self.visible[src] {
                let b = self.msg_base[src];
                for (j, s) in stops.iter_mut().enumerate() {
                    *s = if b == NONE {
                        NONE
                    } else {
                        b + SP * j as i32 + self.len[li]
                    };
                }
            }
            let total = v.items(l);
            let mut idx = 0u32;
            v.for_each_run(l, |_, count, first| {
                for q in 0..u32::from(count) {
                    if idx + q >= total - k {
                        pos.push(first + SP * q as i32);
                    }
                }
                idx += u32::from(count);
            });
        }
        if rebuilt {
            self.items[li] = v.items(l);
            self.nseg[li] = 0;
            self.head[li] = 0;
            self.due_min[li] = NEVER;
            let main = self.items[li] - k;
            if main > 0 {
                self.push_seg(
                    l,
                    Seg {
                        n: main,
                        stop: self.s0_of[li],
                        due: NEVER,
                        kind: Ev::Blocked,
                    },
                );
            }
        } else {
            let mut need = k;
            while need > 0 {
                let bi = self.seg_idx(l, self.nseg[li] - 1);
                let take = need.min(self.segs[bi].n);
                self.segs[bi].n -= take;
                if self.segs[bi].n == 0 {
                    self.nseg[li] -= 1;
                }
                need -= take;
            }
        }
        for j in 0..k as usize {
            self.append(l, pos[j], stops[j]);
        }
        self.scratch_stop = stops;
        self.scratch_pos = pos;
    }

    /// The full forecast of `l` (all its runs, `l`'s own path), for an arrival's line.
    fn full_bytes_all<S: RunStore>(&self, v: &LinesView<S>, l: LineIdx) -> u32 {
        let (s0, path, n) = self.front_stop(l);
        let mut b = self.build(v, l, s0, (&path, n), u32::MAX, |_| {});
        if self.periodic && self.spawner[l as usize] {
            b += SPAWNER_FIELDS_BYTES;
        }
        b
    }

    /// Every line's forecast, from the current state (at the start, or a test's chosen tick).
    pub fn rebuild_all<S: RunStore>(&mut self, v: &LinesView<S>) {
        let ls = self.line_state;
        self.line_state = 0; // the initial forecasts are full
        for l in 0..v.count() {
            self.message(v, l);
        }
        for l in 0..v.count() {
            self.resegment(v, l, true);
        }
        self.line_state = ls;
    }

    /// `l`'s full forecast as a rebuild at this tick sends it (tests; allocates): the items that
    /// crossed its front this tick (at their position on the next line, in `l`'s coordinates;
    /// none past a sink), then its items but this tick's landers.
    pub fn forecast<S: RunStore>(&self, v: &LinesView<S>, l: LineIdx) -> Forecast {
        let li = l as usize;
        let (s0, path, n) = self.front_stop(l);
        let c = self.crossers(l);
        let mut runs = Vec::new();
        if let Out::Next(t) = self.out[li]
            && c > 0
        {
            assert_eq!(self.land_src[t as usize], l, "one feeder per line");
            let total = v.items(t);
            let mut idx = 0u32;
            let mut j = 0i32;
            let len_t = self.len[t as usize];
            let c_land = self.landers(t);
            v.for_each_run(t, |item, count, first| {
                for q in 0..u32::from(count) {
                    if idx + q >= total - c_land {
                        let stop = if s0 == NONE {
                            None
                        } else {
                            Some(s0 - SP * c as i32 + SP * j)
                        };
                        runs.push(RunForecast {
                            item,
                            count: 1,
                            pos: first + SP * q as i32 - len_t,
                            stop,
                            path_len: 1,
                        });
                        j += 1;
                    }
                }
                idx += u32::from(count);
            });
        }
        let limit = self.items[li] - self.landers(l);
        let bytes = self.build(v, l, s0, (&path, n), limit, |r| runs.push(r));
        Forecast {
            line: l,
            tick: self.now,
            path: path[..n].to_vec(),
            runs,
            bytes,
        }
    }

    pub fn begin_tick(&mut self, tick: u32) {
        self.now = tick;
        self.cur = NIL;
        self.cur_crossed = false;
        self.events.clear();
        self.msgs.clear();
        self.landed.clear();
        self.arrivals.clear();
        self.arrival_lines.clear();
        self.stats = TickStats::default();
    }

    /// Fires the segment deviations due this tick (after the advance).
    pub fn scan_dues(&mut self) {
        for l in 0..self.due_min.len() as LineIdx {
            if self.due_min[l as usize] > self.now {
                continue;
            }
            let mut next = NEVER;
            for i in 1..self.nseg[l as usize] {
                let s = self.segs[self.seg_idx(l, i)];
                if s.due <= self.now {
                    self.event(s.kind, l);
                    self.survivor(l);
                } else {
                    next = next.min(s.due);
                }
            }
            self.due_min[l as usize] = next;
        }
    }

    /// Rebuilds every line with a correction this tick and clears the tick's marks.
    pub fn rebuild_dirty<S: RunStore>(&mut self, v: &LinesView<S>) {
        for i in 0..self.touched.len() {
            let l = self.touched[i];
            if self.ev_mask[l as usize] & self.mask != 0 {
                self.message(v, l);
            }
        }
        for i in 0..self.touched.len() {
            let l = self.touched[i];
            if self.dirty_tick[l as usize] == self.now {
                self.resegment(v, l, true);
            }
        }
        for i in 0..self.landed.len() {
            let x = self.landed[i];
            let src = self.land_src[x as usize] as usize;
            if self.dirty_tick[x as usize] != self.now
                && self.dirty_tick[src] == self.now
                && self.visible[src]
            {
                self.resegment(v, x, false);
            }
        }
        for i in 0..self.arrival_lines.len() {
            let l = self.arrival_lines[i];
            self.stats.arrival_full_bytes += u64::from(self.full_bytes_all(v, l));
        }
        for i in 0..self.touched.len() {
            let l = self.touched[i];
            self.ev_mask[l as usize] = 0;
        }
        self.touched.clear();
    }

    pub fn end_tick<S: RunStore>(&mut self, v: &LinesView<S>) {
        self.scan_dues();
        self.rebuild_dirty(v);
    }
}

impl Observer for Tracker {
    #[inline]
    fn front(&mut self, l: LineIdx, pos0: i32, p: i32) {
        if l != self.cur {
            self.cur = l;
            self.cur_crossed = false;
        }
        let li = l as usize;
        let fi = self.seg_idx(l, 0);
        debug_assert!(self.nseg[li] > 0, "line {l}: items without segments");
        let seg = self.segs[fi];
        if self.step_tick[li] != self.now {
            self.step_tick[li] = self.now;
            self.blocked[li] = false;
            self.cross_n[li] = 0;
            self.cross_chain[li] = true;
        }
        let free = p == pos0 - self.speed[li];
        self.blocked[li] |= !free;
        if !self.invalid[li] {
            let v = self.speed[li];
            let pred = if seg.stop == NONE {
                pos0 - v
            } else {
                (pos0 - v).max(seg.stop)
            };
            if p != pred {
                self.event(if p > pred { Ev::Blocked } else { Ev::Moved }, l);
                if p >= 0 {
                    self.survivor(l);
                }
            }
        }
        if p < 0 {
            let c = self.cross_n[li] as i32;
            if c == 0 {
                self.cross_first[li] = seg.stop;
            } else {
                let want = if self.cross_first[li] == NONE {
                    NONE
                } else {
                    self.cross_first[li] + SP * c
                };
                self.cross_chain[li] &= seg.stop == want;
            }
            self.cross_n[li] += 1;
            self.last_cross_blocked = !free;
            self.pending = seg.stop;
            self.pending_valid = !self.invalid[li];
            let s = &mut self.segs[fi];
            s.n -= 1;
            if s.stop != NONE {
                s.stop += SP;
            }
            if s.n == 0 {
                let chain = s.stop;
                self.head[li] = (self.head[li] + 1) % self.cap[li];
                self.nseg[li] -= 1;
                if self.nseg[li] == 0 {
                    self.emptied_tick[li] = self.now;
                    self.emptied_chain[li] = chain;
                }
            }
            self.items[li] -= 1;
            self.crossed[li] += 1;
            self.cur_crossed = true;
            self.stalled[li] = false;
        } else {
            self.stalled[li] = p == pos0 && !self.cur_crossed;
            self.front_pos[li] = p;
            self.front_tick[li] = self.now;
        }
    }

    #[inline]
    fn handoff(&mut self, from: LineIdx, to: LineIdx, pos: i32) {
        let ti = to as usize;
        self.items[ti] += 1;
        if self.last_cross_blocked {
            self.land_blocked_tick[ti] = self.now;
        }
        if self.land_tick[ti] != self.now {
            self.land_tick[ti] = self.now;
            self.land_n[ti] = 0;
            self.land_src[ti] = from;
            self.landed.push(to);
        }
        assert_eq!(
            self.land_src[ti], from,
            "line {to}: two feeders in one tick"
        );
        self.land_n[ti] += 1;
        if self.visible[ti] && !self.visible[from as usize] {
            // An arrival from an invisible line: the client gets the item and chains it.
            if self.arrival_tick[ti] != self.now {
                self.arrival_tick[ti] = self.now;
                self.arrival_lines.push(to);
            }
            self.arrivals.push((to, pos));
            self.stats.arrivals_visible += 1;
            self.append_chain(to, pos);
            return;
        }
        if self.path0[from as usize] != to {
            self.event(Ev::OffPath, to);
            self.append_chain(to, pos);
        } else if !self.pending_valid {
            self.append_chain(to, pos);
        } else {
            let s = if self.pending == NONE {
                NONE
            } else {
                self.pending + self.len[to as usize]
            };
            self.append(to, pos, s);
        }
    }

    #[inline]
    fn sunk(&mut self, l: LineIdx) {
        self.event(Ev::Sink, l);
    }

    #[inline]
    fn inserted(&mut self, l: LineIdx, pos: i32) {
        self.event(Ev::Insert, l);
        if self.jammed[l as usize] {
            self.event(Ev::Resumed, l);
        }
        self.items[l as usize] += 1;
        self.jammed[l as usize] = false;
        self.append_chain(l, pos);
    }

    #[inline]
    fn refused(&mut self, l: LineIdx, tail: i32) {
        let li = l as usize;
        if self.refused_tick[li] == self.now.wrapping_sub(1)
            && self.refused_tail[li] == tail
            && !self.jammed[li]
        {
            self.jammed[li] = true;
            self.event(Ev::Refused, l);
        }
        self.refused_tick[li] = self.now;
        self.refused_tail[li] = tail;
    }

    fn edited(&mut self, l: LineIdx, delta: i32) {
        let li = l as usize;
        self.event(Ev::Edit, l);
        self.items[li] = (self.items[li] as i32 + delta) as u32;
        self.invalid[li] = true;
        self.nseg[li] = 0;
        self.head[li] = 0;
        self.due_min[li] = NEVER;
        if self.items[li] > 0 {
            self.push_seg(
                l,
                Seg {
                    n: self.items[li],
                    stop: NONE,
                    due: NEVER,
                    kind: Ev::Blocked,
                },
            );
        }
    }

    fn structure(&mut self, l: LineIdx, out: Out) {
        self.event(Ev::Structure, l);
        if self.visible[l as usize] {
            self.stats.struct_bytes += u64::from(STRUCT_PUT_BYTES);
        }
        self.out[l as usize] = out;
    }
}

// ---- driving a world ----

/// The jam schedule's state (which toggled sinks are closed).
#[derive(Clone)]
pub struct Jams {
    closed: Vec<bool>,
}

impl Jams {
    pub fn new(w: &BenchWorld) -> Self {
        Jams {
            closed: vec![false; w.toggles.len()],
        }
    }

    /// Closes and reopens the toggled sinks for tick `tick` (the game's part of the tick, before
    /// the spawners).
    pub fn apply<S: RunStore, O: Observer>(
        &mut self,
        w: &BenchWorld,
        tick: u32,
        r: &mut ReprB<S, O>,
    ) {
        let Regime::SaturatedView { period, .. } = w.regime else {
            return;
        };
        for (i, t) in w.toggles.iter().enumerate() {
            let c = t.closed(tick, period);
            if c != self.closed[i] {
                self.closed[i] = c;
                r.set_out(t.line, if c { Out::DeadEnd } else { Out::Sink });
            }
        }
    }
}

/// One tick with the tracker on: jams, spawners, advance, then the dues and the rebuilds.
pub fn tick_tracked<S: RunStore>(
    w: &BenchWorld,
    tick: u32,
    r: &mut ReprB<S, Tracker>,
    d: &mut super::repr::Driver,
    jams: &mut Jams,
) {
    r.obs_mut().begin_tick(tick);
    jams.apply(w, tick, r);
    d.game_phase(w, r);
    r.advance(&w.order);
    let (o, v) = r.split();
    o.end_tick(&v);
}

/// One tick with no observer.
pub fn tick_plain<S: RunStore>(
    w: &BenchWorld,
    tick: u32,
    r: &mut ReprB<S>,
    d: &mut super::repr::Driver,
    jams: &mut Jams,
) {
    jams.apply(w, tick, r);
    d.game_phase(w, r);
    r.advance(&w.order);
}
