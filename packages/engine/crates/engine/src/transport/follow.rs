//! The replica's side of forecasts (M47, docs/decisions/0078 §2 and A3): one trajectory per item
//! of every held line, evaluated by the formula and nothing else (the client runs no belt rule).
//! Client-only, never hashed (0078 §6), reserved at `Welcome` from the world's caps.
//!
//! Each held line keeps its items front to back as runs `{ item, count, pos, stop }` at the
//! replica's forecast tick: item `k` of a run is at `pos + SPACING x k` and stops at
//! `stop + SPACING x k` (none: free). One tick moves every item to `max(pos - speed, stop)`; an
//! item past the front follows a `Next` link the replica holds (landing at `target.len + p`, its
//! stop translated the same way) and otherwise vanishes (a `Sink`, a line not held, a `Merge` or a
//! `Fork`: the host sends what lands there as an `Arrival`).
//!
//! A frame at tick `T` ([`Follower::frame`]) first steps any tick between (no frame came for it,
//! so nothing changed for this client), then applies `T`'s section 13 around `T`'s step, in the
//! order `wire/forecast.rs`'s module doc gives each record its meaning: `State`s re-stop their
//! lines' lists, `RunList`s empty theirs, the spawner replay inserts (`transport::Schedule`'s rule,
//! landing at `max(len - speed, tail + SPACING)` with the chain's stop, none on an empty line,
//! refused past `len - 1` like `insert_back`; nothing while the host has paused it), the
//! step, then the `RunList`s' runs and the `Arrival`s are placed.

use super::line::NIL;
use super::{Item, LineId, Output, SPACING, Transport};
use crate::bytes::ByteReader;
use crate::wire::forecast as wf;

const NONE: i32 = wf::NO_STOP;
const SP: i64 = SPACING as i64;

/// The replica's forecast counters (`engine/test`'s `forecastCounters`): run lists, states and
/// arrivals applied; corrections (a state or run list for a line the client already held);
/// `seen_late` (a correction for a tick the client had already rendered, 0078 §5).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct ForecastCounters {
    pub forecasts_applied: u64,
    pub state_messages_applied: u64,
    pub arrivals_applied: u64,
    pub forecast_seen_late: u64,
    pub corrections: u64,
    /// `unknown` lists applied (a list too large for a frame: M47 review, finding 1).
    pub lists_unknown: u64,
    /// Records for lines this replica does not hold (dropped; M47 review, finding 11).
    pub records_unheld: u64,
}

#[derive(Clone, Copy)]
struct FRun {
    item: u16,
    count: u16,
    pos: i32,
    stop: i32,
    next: u32,
}

#[derive(Clone, Copy, Default)]
struct FSpawner {
    on: bool,
    paused: bool,
    period: u32,
    acc: u32,
    kinds: u16,
    next: u16,
}

#[derive(Clone, Copy)]
struct FLine {
    head: u32,
    tail: u32,
    runs: u32,
    items: u32,
    /// Runs at the back that landed during the step in progress (`land_stamp`): not moved again.
    land_stamp: u32,
    land_runs: u32,
    /// The tick a run list replaced this line (its spawner does not replay then).
    replaced: u32,
    /// Put since the last frame's forecasts (its first run list is not a correction).
    fresh: bool,
    /// The host sent an `unknown` list: no items held until a full list comes.
    unknown: bool,
    sp: FSpawner,
}

impl FLine {
    const EMPTY: FLine = FLine {
        head: NIL,
        tail: NIL,
        runs: 0,
        items: 0,
        land_stamp: u32::MAX,
        land_runs: 0,
        replaced: u32::MAX,
        fresh: true,
        unknown: false,
        sp: FSpawner {
            on: false,
            paused: false,
            period: 0,
            acc: 0,
            kinds: 0,
            next: 0,
        },
    };
}

/// The follower (module doc). Reserved once in [`Follower::reserve`].
#[derive(Default)]
pub(crate) struct Follower {
    on: bool,
    runs: Vec<FRun>,
    free: u32,
    fl: Vec<FLine>,
    /// The tick the held items are at; `None` until the first frame.
    tick: Option<u32>,
    pub counters: ForecastCounters,
}

/// A run holds at least one item: one node per item, one spare (none at 0 items).
fn run_cap(max_items: u32) -> usize {
    if max_items == 0 {
        0
    } else {
        max_items as usize + 1
    }
}

/// What [`Follower::reserve`] reserves (`Transport::replica_reserved_bytes`).
pub(crate) fn reserved_bytes(max_lines: u32, max_items: u32) -> u64 {
    u64::from(max_lines) * core::mem::size_of::<FLine>() as u64
        + run_cap(max_items) as u64 * core::mem::size_of::<FRun>() as u64
}

fn reserve_to<T>(v: &mut Vec<T>, n: usize) {
    if v.capacity() < n {
        v.reserve_exact(n - v.len());
    }
}

fn add(stop: i32, d: i64) -> i32 {
    if stop == NONE {
        return NONE;
    }
    let v = i64::from(stop) + d;
    if v <= i64::from(i32::MIN) || v > i64::from(i32::MAX) {
        NONE
    } else {
        v as i32
    }
}

impl Follower {
    pub fn reserve(&mut self, max_lines: u32, max_items: u32) {
        self.on = true;
        self.free = NIL;
        reserve_to(&mut self.fl, max_lines as usize);
        reserve_to(&mut self.runs, run_cap(max_items));
    }

    pub fn capacity_bytes(&self) -> usize {
        self.fl.capacity() * core::mem::size_of::<FLine>()
            + self.runs.capacity() * core::mem::size_of::<FRun>()
    }

    /// A held line's slot was (re)assigned: no items, no spawner.
    pub fn init_line(&mut self, slot: u32) {
        if !self.on {
            return;
        }
        while self.fl.len() <= slot as usize && self.fl.len() < self.fl.capacity() {
            self.fl.push(FLine::EMPTY);
        }
        if (slot as usize) < self.fl.len() {
            self.clear_runs(slot);
            self.fl[slot as usize] = FLine::EMPTY;
        }
    }

    /// The slot's line is no longer held: its items go with it.
    pub fn drop_line(&mut self, slot: u32) {
        if (slot as usize) < self.fl.len() {
            self.clear_runs(slot);
            self.fl[slot as usize] = FLine::EMPTY;
        }
    }

    /// Every line dropped (a new `Welcome`): the forecast tick starts again.
    pub fn clear(&mut self) {
        self.runs.clear();
        self.free = NIL;
        self.fl.clear();
        self.tick = None;
    }

    fn line(&self, slot: u32) -> Option<&FLine> {
        self.fl.get(slot as usize)
    }

    fn alloc(&mut self, r: FRun) -> Option<u32> {
        if self.free != NIL {
            let k = self.free;
            self.free = self.runs[k as usize].next;
            self.runs[k as usize] = r;
            Some(k)
        } else if self.runs.len() < self.runs.capacity() {
            self.runs.push(r);
            Some(self.runs.len() as u32 - 1)
        } else {
            None
        }
    }

    fn clear_runs(&mut self, slot: u32) {
        let mut cur = self.fl[slot as usize].head;
        while cur != NIL {
            let nx = self.runs[cur as usize].next;
            self.runs[cur as usize].next = self.free;
            self.free = cur;
            cur = nx;
        }
        let l = &mut self.fl[slot as usize];
        l.head = NIL;
        l.tail = NIL;
        l.runs = 0;
        l.items = 0;
    }

    /// Appends a run at the slot's back, joining the back run when it continues it (same item,
    /// `SPACING` behind, chained stop) and `join` allows.
    fn push_back(&mut self, slot: u32, item: u16, pos: i32, stop: i32, join: bool) -> bool {
        let l = self.fl[slot as usize];
        if join && l.tail != NIL {
            let t = &mut self.runs[l.tail as usize];
            let n = i64::from(t.count);
            if t.item == item
                && t.count < u16::MAX
                && i64::from(t.pos) + SP * n == i64::from(pos)
                && add(t.stop, SP * n) == stop
            {
                t.count += 1;
                self.fl[slot as usize].items += 1;
                return false;
            }
        }
        let Some(k) = self.alloc(FRun {
            item,
            count: 1,
            pos,
            stop,
            next: NIL,
        }) else {
            return false;
        };
        let l = &mut self.fl[slot as usize];
        if l.tail == NIL {
            l.head = k;
        } else {
            self.runs[l.tail as usize].next = k;
        }
        l.tail = k;
        l.runs += 1;
        l.items += 1;
        true
    }

    /// Inserts one item at `pos` among the slot's runs (an arrival), before the first run whose
    /// first item lies behind it.
    fn insert_at(&mut self, slot: u32, item: u16, pos: i32, stop: i32) {
        let mut prev = NIL;
        let mut cur = self.fl[slot as usize].head;
        while cur != NIL && self.runs[cur as usize].pos < pos {
            prev = cur;
            cur = self.runs[cur as usize].next;
        }
        if cur == NIL {
            self.push_back(slot, item, pos, stop, true);
            return;
        }
        let Some(k) = self.alloc(FRun {
            item,
            count: 1,
            pos,
            stop,
            next: cur,
        }) else {
            return;
        };
        if prev == NIL {
            self.fl[slot as usize].head = k;
        } else {
            self.runs[prev as usize].next = k;
        }
        let l = &mut self.fl[slot as usize];
        l.runs += 1;
        l.items += 1;
    }

    fn restop(&mut self, slot: u32, fs: i32) {
        let mut k = 0i64;
        let mut cur = self.fl[slot as usize].head;
        while cur != NIL {
            let r = &mut self.runs[cur as usize];
            r.stop = add(fs, SP * k);
            k += i64::from(r.count);
            cur = r.next;
        }
    }

    /// The spawner replay for one tick (`transport::Schedule`'s rule; the host pauses it).
    fn replay(&mut self, t: &Transport, slot: u32, tick: u32) {
        let l = self.fl[slot as usize];
        if !l.sp.on || l.replaced == tick {
            return;
        }
        let mut sp = l.sp;
        sp.acc = sp.acc.saturating_add(256);
        if sp.acc >= sp.period {
            let rec = &t.lines[slot as usize];
            let (len, v) = (i64::from(rec.len), i64::from(rec.speed));
            // `insert_back`'s landing against the tail this replica holds.
            let (pos, stop) = if l.tail == NIL {
                (len - v, NONE)
            } else {
                let b = self.runs[l.tail as usize];
                let n = i64::from(b.count);
                (
                    (len - v).max(i64::from(b.pos) + SP * n),
                    add(b.stop, SP * n),
                )
            };
            if sp.paused || pos > len - 1 {
                sp.acc -= 256;
            } else {
                self.push_back(slot, sp.next, pos as i32, stop, true);
                sp.acc -= sp.period;
                if sp.kinds != 0 {
                    sp.next = sp.next % sp.kinds + 1;
                }
            }
        }
        self.fl[slot as usize].sp = sp;
    }

    /// One tick of every held line (module doc), no record applied.
    fn step(&mut self, t: &Transport, tick: u32) {
        for k in 0..t.index.len() {
            let slot = t.index[k].1;
            if (slot as usize) < self.fl.len() {
                self.replay(t, slot, tick);
            }
        }
        for k in 0..t.index.len() {
            let slot = t.index[k].1;
            if (slot as usize) < self.fl.len() {
                self.step_line(t, slot, tick);
            }
        }
    }

    fn step_line(&mut self, t: &Transport, slot: u32, tick: u32) {
        let rec = t.lines[slot as usize];
        let v = i64::from(rec.speed);
        let l = self.fl[slot as usize];
        let skip = if l.land_stamp == tick { l.land_runs } else { 0 };
        let todo = l.runs.saturating_sub(skip);
        let target = match rec.out {
            // A line whose items are unknown takes none (review 2, finding 4): the item
            // vanishes, as into a line not held; the host sends an arrival for each one leaving it.
            Output::Next(id) => t
                .slot(id)
                .filter(|&s| s != slot && !self.fl.get(s as usize).is_some_and(|l| l.unknown)),
            _ => None,
        };
        let dead_end = matches!(rec.out, Output::DeadEnd);
        let mut prev = NIL;
        let mut cur = l.head;
        let mut done = 0u32;
        while cur != NIL && done < todo {
            done += 1;
            let r = self.runs[cur as usize];
            let nx = r.next;
            let mut p = i64::from(r.pos) - v;
            if r.stop != NONE {
                p = p.max(i64::from(r.stop));
            }
            if dead_end {
                // A forecast never moves an item past a dead end (0078 §2: it holds there).
                p = p.max(0);
            }
            let mut count = i64::from(r.count);
            let mut stop = r.stop;
            if p < 0 {
                let m = count.min((-p + SP - 1) / SP);
                for j in 0..m {
                    let pj = p + SP * j;
                    if let Some(ts) = target {
                        let tl = i64::from(t.lines[ts as usize].len);
                        let sj = add(add(stop, SP * j), tl);
                        self.land(ts, r.item, (tl + pj) as i32, sj, tick);
                    }
                }
                count -= m;
                p += SP * m;
                stop = add(stop, SP * m);
                self.fl[slot as usize].items -= m as u32;
            }
            if count == 0 {
                // Only the front run crosses whole: unlink it.
                if prev == NIL {
                    self.fl[slot as usize].head = nx;
                } else {
                    self.runs[prev as usize].next = nx;
                }
                if self.fl[slot as usize].tail == cur {
                    self.fl[slot as usize].tail = prev;
                }
                self.fl[slot as usize].runs -= 1;
                self.runs[cur as usize].next = self.free;
                self.free = cur;
                cur = nx;
                continue;
            }
            let r = &mut self.runs[cur as usize];
            r.pos = p as i32;
            r.count = count as u16;
            r.stop = stop;
            // Joins the run ahead when it continues it (same item, packed, chained stops).
            if prev != NIL {
                let a = self.runs[prev as usize];
                let n = i64::from(a.count);
                let b = self.runs[cur as usize];
                if a.item == b.item
                    && u32::from(a.count) + u32::from(b.count) <= u32::from(u16::MAX)
                    && i64::from(a.pos) + SP * n == i64::from(b.pos)
                    && add(a.stop, SP * n) == b.stop
                {
                    self.runs[prev as usize].count += b.count;
                    self.runs[prev as usize].next = nx;
                    if self.fl[slot as usize].tail == cur {
                        self.fl[slot as usize].tail = prev;
                    }
                    self.fl[slot as usize].runs -= 1;
                    self.runs[cur as usize].next = self.free;
                    self.free = cur;
                    cur = nx;
                    continue;
                }
            }
            prev = cur;
            cur = nx;
        }
    }

    /// An item crossed onto held slot `ts` during the step of `tick`: it moves no more this tick.
    fn land(&mut self, ts: u32, item: u16, pos: i32, stop: i32, tick: u32) {
        if ts as usize >= self.fl.len() {
            return;
        }
        let l = self.fl[ts as usize];
        let landing = l.land_stamp == tick && l.land_runs > 0;
        if l.land_stamp != tick {
            self.fl[ts as usize].land_stamp = tick;
            self.fl[ts as usize].land_runs = 0;
        }
        // Two feeders landing on one line in one tick land in the host's update order, behind one
        // another; this replica steps in id order, so a later landing may sort ahead of an
        // earlier one: it goes among this tick's landers by position.
        let tail = self.fl[ts as usize].tail;
        if landing && tail != NIL && self.runs[tail as usize].pos > pos {
            self.insert_at(ts, item, pos, stop);
            self.fl[ts as usize].land_runs += 1;
            return;
        }
        // Joins only a run that landed this tick too (a run still to move must not carry it).
        if self.push_back(ts, item, pos, stop, landing) {
            self.fl[ts as usize].land_runs += 1;
        }
    }

    /// Applies one frame's forecasts at tick `tick` (module doc): `body` is the frame's section 13
    /// (validated; empty when the frame has none), `render_t` the client's last render time.
    pub fn frame(&mut self, t: &Transport, tick: u32, body: &[u8], render_t: f64) {
        if !self.on {
            return;
        }
        let from = match self.tick {
            Some(prev) if tick > prev => prev,
            Some(_) => return,
            None => tick.wrapping_sub(1),
        };
        let mut k = from.wrapping_add(1);
        while k != tick {
            // A tick with no frame: nothing changed for this client.
            self.step(t, k);
            k = k.wrapping_add(1);
        }
        // Rendered already (a render time of 0 is "nothing rendered yet").
        let late = render_t > 0.0 && f64::from(tick) <= render_t;
        // States, then the run lists' emptying, before the step.
        let _ = wf::read(&mut ByteReader::new(body), |rec| match rec {
            wf::Record::State(s) => {
                let Some(slot) = t.slot(s.line).filter(|&s| (s as usize) < self.fl.len()) else {
                    self.counters.records_unheld += 1;
                    return;
                };
                if self.fl[slot as usize].unknown {
                    return;
                }
                self.restop(slot, s.front_stop.unwrap_or(NONE));
                let sp = &mut self.fl[slot as usize].sp;
                if s.paused {
                    sp.paused = true;
                }
                if s.resumed {
                    sp.paused = false;
                }
                self.counters.state_messages_applied += 1;
                self.counters.corrections += 1;
                if late {
                    self.counters.forecast_seen_late += 1;
                }
            }
            wf::Record::RunList(r) => {
                if let Some(slot) = t.slot(r.line).filter(|&s| (s as usize) < self.fl.len()) {
                    self.clear_runs(slot);
                    self.fl[slot as usize].replaced = tick;
                }
            }
            wf::Record::Arrival(_) => {}
        });
        self.step(t, tick);
        let _ = wf::read(&mut ByteReader::new(body), |rec| match rec {
            wf::Record::RunList(r) => {
                let Some(slot) = t.slot(r.line).filter(|&s| (s as usize) < self.fl.len()) else {
                    self.counters.records_unheld += 1;
                    return;
                };
                self.clear_runs(slot);
                self.fl[slot as usize].unknown = r.unknown;
                if r.unknown {
                    self.fl[slot as usize].sp = FSpawner::default();
                    self.counters.lists_unknown += 1;
                    return;
                }
                let mut runs = r.runs;
                for run in &mut runs {
                    for k in 0..u32::from(run.count) {
                        let pos = (u64::from(run.pos) + u64::from(SPACING) * u64::from(k)) as i32;
                        let stop = add(run.stop.unwrap_or(NONE), SP * i64::from(k));
                        self.push_back(slot, run.item.0, pos, stop, true);
                    }
                }
                self.fl[slot as usize].sp = match r.spawner {
                    Some(s) => FSpawner {
                        on: true,
                        paused: s.paused,
                        period: s.period,
                        acc: s.acc,
                        kinds: s.kinds,
                        next: s.next.0,
                    },
                    None => FSpawner::default(),
                };
                self.counters.forecasts_applied += 1;
                // A line the client held before this frame: a correction, not a first list.
                if !self.fl[slot as usize].fresh {
                    self.counters.corrections += 1;
                    if late {
                        self.counters.forecast_seen_late += 1;
                    }
                }
            }
            wf::Record::Arrival(a) => {
                let Some(slot) = t.slot(a.line).filter(|&s| (s as usize) < self.fl.len()) else {
                    self.counters.records_unheld += 1;
                    return;
                };
                if self.fl[slot as usize].unknown {
                    return;
                }
                self.insert_at(slot, a.item.0, a.pos as i32, a.stop.unwrap_or(NONE));
                self.counters.arrivals_applied += 1;
            }
            wf::Record::State(_) => {}
        });
        for l in self.fl.iter_mut() {
            l.fresh = false;
        }
        self.tick = Some(tick);
    }

    /// Steps to `tick` with no records: the ticks no frame came for (nothing changed for this
    /// client in them). The client calls it with `T - 1` before it applies frame `T`'s sections;
    /// a native test that knows no frame is coming calls the same.
    pub fn catch_up(&mut self, t: &Transport, tick: u32) {
        if !self.on {
            return;
        }
        // Before the first frame there is nothing to step.
        let Some(prev) = self.tick else {
            return;
        };
        let mut k = prev.wrapping_add(1);
        while prev < tick && k != tick.wrapping_add(1) {
            self.step(t, k);
            k = k.wrapping_add(1);
        }
        if tick > prev {
            self.tick = Some(tick);
        }
    }

    pub fn tick(&self) -> Option<u32> {
        self.tick
    }

    pub fn count(&self, slot: u32) -> u32 {
        self.line(slot).map_or(0, |l| l.items)
    }

    pub fn items_in(&self, slot: u32, f: &mut dyn FnMut(Item, u32)) {
        let Some(l) = self.line(slot) else {
            return;
        };
        let mut cur = l.head;
        while cur != NIL {
            let r = self.runs[cur as usize];
            for k in 0..i64::from(r.count) {
                f(Item(r.item), (i64::from(r.pos) + SP * k) as u32);
            }
            cur = r.next;
        }
    }

    /// Whether the host sent the line's items as `unknown`.
    pub fn unknown(&self, slot: u32) -> bool {
        self.line(slot).is_some_and(|l| l.unknown)
    }

    pub fn front(&self, slot: u32) -> Option<(Item, u32)> {
        let l = self.line(slot)?;
        if l.head == NIL {
            return None;
        }
        let r = self.runs[l.head as usize];
        Some((Item(r.item), r.pos as u32))
    }

    /// Item `idx`'s position and stop at the forecast tick.
    fn item(&self, slot: u32, idx: u32) -> Option<(i64, i32)> {
        let l = self.line(slot)?;
        let mut cur = l.head;
        let mut k = idx;
        while cur != NIL {
            let r = self.runs[cur as usize];
            if k < u32::from(r.count) {
                return Some((
                    i64::from(r.pos) + SP * i64::from(k),
                    add(r.stop, SP * i64::from(k)),
                ));
            }
            k -= u32::from(r.count);
            cur = r.next;
        }
        None
    }

    /// 0078 §2's formula at render time `render_t` (host ticks, fractional): item `idx` of the
    /// line at `max(pos - speed x (render_t - T), stop)`, `T` the forecast tick, following `Next`
    /// through held lines past the front (`None` once its path leaves them, reaches an `unknown`
    /// line or ends in a sink). A
    /// render time before `T` extrapolates back along the same line (M49 draws).
    pub fn pos_at(
        &self,
        t: &Transport,
        line: LineId,
        idx: u32,
        render_t: f64,
    ) -> Option<(LineId, f64)> {
        let mut slot = t.slot(line)?;
        let (pos, stop) = self.item(slot, idx)?;
        let tick = f64::from(self.tick?);
        let v = f64::from(t.lines[slot as usize].speed);
        let mut p = pos as f64 - v * (render_t - tick);
        if stop != NONE && p < f64::from(stop) {
            p = f64::from(stop);
        }
        let mut id = line;
        let mut hops = 0;
        while p < 0.0 {
            let rec = t.lines[slot as usize];
            match rec.out {
                Output::Next(next) => {
                    let ns = t.slot(next)?;
                    // As the step: an item reaching an `unknown` line vanishes there (review 3).
                    if self.fl.get(ns as usize).is_some_and(|l| l.unknown) {
                        return None;
                    }
                    p += f64::from(t.lines[ns as usize].len);
                    slot = ns;
                    id = next;
                }
                Output::DeadEnd => p = 0.0,
                _ => return None,
            }
            hops += 1;
            if hops > 64 {
                return None;
            }
        }
        Some((id, p))
    }
}

impl Transport {
    /// The replica (M47): applies a frame's section 13 at its tick (`body` validated, empty when the
    /// frame carries none); `render_t` the client's last render time (late corrections are
    /// counted).
    pub fn apply_forecast(&mut self, tick: u32, body: &[u8], render_t: f64) {
        let mut fl = std::mem::take(&mut self.fl);
        fl.frame(self, tick, body, render_t);
        self.fl = fl;
    }

    /// The replica: steps its forecasts to `tick` with no records (tests that know no frame is
    /// coming for the ticks between).
    pub fn forecast_catch_up(&mut self, tick: u32) {
        let mut fl = std::mem::take(&mut self.fl);
        fl.catch_up(self, tick);
        self.fl = fl;
    }

    /// The replica's forecast tick (`None` before its first frame).
    pub fn forecast_tick(&self) -> Option<u32> {
        self.fl.tick()
    }

    /// The replica: whether the host sent this held line's items as `unknown` (a list too large
    /// for a frame); `items_in` is then empty.
    pub fn forecast_unknown(&self, line: LineId) -> bool {
        self.slot(line).is_some_and(|s| self.fl.unknown(s))
    }

    /// The replica's forecast counters.
    pub fn forecast_counters(&self) -> ForecastCounters {
        self.fl.counters
    }

    /// The replica (0078 §2): where item `idx` of `line` is at render time `render_t`
    /// ([`Follower::pos_at`]).
    pub fn pos_at(&self, line: LineId, idx: u32, render_t: f64) -> Option<(LineId, f64)> {
        self.fl.pos_at(self, line, idx, render_t)
    }
}
