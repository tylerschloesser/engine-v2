//! The per-tick rule (0076 §2; M40's rule, `fixtures/belts/tests/common/repr.rs`): every line in
//! update order, items front to back, `leader` the new position of the item ahead in this line's
//! coordinates (for the front item: `-SPACING` at a `DeadEnd`, the target's rearmost item
//! `tail - target.len` at a `Next`, none at a `Sink` or an empty target):
//!
//! - `bound = leader + SPACING`; an item already inside the bound does not move, else
//!   `p = max(pos - speed, bound)` (so `advance = min(speed, gap_after_leader_move - SPACING)`).
//! - `p >= 0`: the item moves to `p`. `p < 0`: it crosses the front: a `Sink` deletes and counts
//!   it, a `Next` lands it at `target.len + p` (the squash is already in `p`). Its `p` is the next
//!   item's leader, so several items cross in one tick when `speed >= SPACING`.
//! - `insert_back` lands at `max(len - speed, tail + SPACING)`, refused past `len - 1`.
//! - `insert_at(pos)`: `SPACING` clear on both sides on this line, `pos <= len - 1`.
//!   `remove_at(pos)`: the nearest item within `SPACING / 2`, the front one on a tie.
//!
//! On the run store (`line.rs`): the front items one at a time while they cross; then the front
//! run moves by `d0` and each later run by `d = min(speed, gap + d_prev)` (`gap += d_prev - d`).
//! Once a run moves the full `speed` every run behind it does too with unchanged gaps, so the walk
//! stops (a free line is O(1)); a stopped front skips its packed runs through the `jam` cursor (a
//! jammed line is O(1)); only the compression front is walked.
//!
//! The cycle cut (0079 §11, amended in M44: an item moves at most `speed` in one tick). The first
//! line of a simple cycle of `Next` links sees its target as it will be after the target moves
//! (`cut_leader`: the fixed point of dry passes around the cycle), so a packed loop rotates
//! rigidly. An item that crosses onto a line that has not advanced yet (only a cut link can do
//! that) joins a back run of such items (`Line::fresh_runs`), which may transiently sit inside
//! the spacing of the target's unmoved rearmost item. When the target advances, those runs move
//! by the ordinary rule with their limit lowered to the budget left, `speed - moved`
//! (`Line::fresh_cap`; 0 when two landings in the tick disagree), never across the front.
//! A plain `Next` needs `target.len >= feeder.speed` (`set_out`, `set_speed`, decode), so a landing
//! `target.len + p` is never negative. Positions are `i64` here so no
//! `len` near `u32::MAX` can overflow the arithmetic; stored values stay `u32`.
//!
//! `Merge` and `Fork` (M44, 0076 §1): the front item has no leader (`p = pos - speed`); when
//! `p < 0` (overshoot `o = -p`) it tries to transfer. `Merge { line, at }`: landing
//! `clamp(at - o, 0, line.len - 1)`, transferred iff `SPACING` is clear on both sides there on the
//! target (`insert_at`'s rule and code path). `Fork { a, b }`: the preferred target (the toggle)
//! if its plain hand-off landing `target.len - o` has room (`tail + SPACING <= landing`), else the
//! other, else none; the toggle flips only on a preferred delivery. A transferred item leaves no
//! leader behind (the next item is free again); a refused one waits at 0 and the walk squashes the
//! items behind it. Several items cross in one tick front to back, each against the target as the
//! previous landing left it. A merge landing in the middle of a target that has not advanced yet
//! (a cut link) is a `count == 0` run (`Line::fresh_mid`) under the same budget (a side-load
//! moved its feeder's full `speed`, so it is `target.speed - feeder.speed`, 0 at equal speeds).

use super::forecast::{ROUTE_FORK, ROUTE_MERGE, ROUTE_NEXT};
use super::line::{NIL, NO_CAP, Run, opt as opt_node};
use super::{Output, SPACING, Transport, TransportError};

const SP: i64 = SPACING as i64;
/// "No leader": far below any position, so `NONE + SP - speed` cannot overflow.
const NONE: i64 = i64::MIN / 4;
/// The most dry passes [`Transport::cut_leader`] runs around a cycle looking for its fixed point
/// (a loop without squashed pairs settles in two: the second confirms the first).
const CUT_PASSES: usize = 4;

/// What [`Transport::cut_leader`] found for a line.
enum Cut {
    /// Not the first line of a simple `Next` cycle with a non-empty target.
    No,
    /// The fixed point: the leader the line sees.
    Fixed(i64),
    /// No fixed point in [`CUT_PASSES`]: the target as it stands.
    Fallback,
}

std::thread_local! {
    /// Run nodes the cut's dry passes visited on this thread (tests and tools; not state).
    static DRY_VISITS: core::cell::Cell<u64> = const { core::cell::Cell::new(0) };
}

/// Run nodes [`Transport::cut_leader`]'s dry passes visited on the calling thread so far: the
/// pass's cost as a counter a test reads instead of a timer (M44 cut review). Not state.
pub fn dry_visits() -> u64 {
    DRY_VISITS.with(|v| v.get())
}

impl Transport {
    /// One tick of every line, in update order (recomputed first if the graph changed). Runs in
    /// `Sim::step` after `G::tick` and before `end_tick`. Allocates nothing. Returns whether
    /// anything changed: an item moved, crossed (landed or sank) or a run merged (the host marks
    /// the world dirty from it, M42 review).
    pub fn advance(&mut self) -> bool {
        if self.graph_dirty {
            self.recompute_order();
        }
        let before = std::mem::take(&mut self.changed);
        for i in 0..self.order.len() {
            let l = self.order[i];
            let cut_leader = match self.cut_leader(i) {
                Cut::No => None,
                Cut::Fixed(lead) => Some(lead),
                Cut::Fallback => {
                    self.cut_fallbacks = self.cut_fallbacks.wrapping_add(1);
                    None
                }
            };
            self.advance_line(l, cut_leader);
            #[cfg(debug_assertions)]
            self.check_line(l);
        }
        let moved = self.changed;
        self.changed |= before;
        self.advanced_epoch = self.epoch;
        self.epoch = self.epoch.wrapping_add(1).max(1);
        // M47: the forecast tracker's end of tick (dues, spawners, this tick's corrections).
        let mut fc = std::mem::take(&mut self.fc);
        fc.end_tick(self);
        self.fc = fc;
        moved
    }

    /// The leader a cycle's cut line sees (0079 §11 as amended in M44): `order[i]` is the first
    /// line of a simple cycle of `Next` links (`L0 -> L1 -> ... -> L(n-1) -> L0`, advanced as
    /// `L0, L(n-1), ..., L1`), so its target `L1` has not moved yet. Its front item is bounded by
    /// `L1`'s rearmost item where that item *will be* after `L1`'s advance, as every other line
    /// sees its target: the least constrained fixed point of one dry pass around the cycle
    /// ([`Transport::dry_leader`], from "no leader", at most [`CUT_PASSES`] passes). Without that a
    /// packed block holds one tick at the cut and laps spread to `SPACING + speed`. [`Cut::No`]
    /// (the line sees its target as it stands) for any other line or an empty target;
    /// [`Cut::Fallback`] (the same, counted) when the passes reach no fixed point. With every gap of
    /// the loop `>= 0` the first pass lands on the fixed point and the second confirms it; a
    /// squashed pair makes the iterates creep up by the loop's deficit per pass, so an overfull
    /// loop can fall back (`cut_fallback_holds_and_stays_valid`). Only a fixed point may be used:
    /// a lead below it lets a landing overrun the target's real tail.
    fn cut_leader(&self, i: usize) -> Cut {
        let l = self.order[i];
        let line = &self.lines[l as usize];
        let Output::Next(_) = line.out else {
            return Cut::No;
        };
        let t = line.next_slot;
        if self.lines[t as usize].adv_mark == self.epoch || self.lines[t as usize].items == 0 {
            return Cut::No;
        }
        // The cycle `L1, ..., L(n-1), L0` by its `Next` links; the order holds it as
        // `order[i..i + n]` = `L0, L(n-1), ..., L1` (checked).
        let mut n = 1usize;
        let mut x = t;
        while x != l {
            let rec = &self.lines[x as usize];
            if !matches!(rec.out, Output::Next(_)) || n > self.order.len() - i {
                return Cut::No;
            }
            x = rec.next_slot;
            n += 1;
        }
        for j in i + 1..i + n {
            if self.lines[self.order[j] as usize].next_slot != self.order[j - 1] {
                return Cut::No;
            }
        }
        let mut lead = NONE;
        for _ in 0..CUT_PASSES {
            let mut next = lead;
            for j in i..i + n {
                next = self.dry_leader(self.order[j], next);
            }
            if next == lead {
                return Cut::Fixed(lead);
            }
            lead = next;
        }
        Cut::Fallback
    }

    /// Debug builds: the run store's invariants for slot `l` once it advanced (M44 cut review). A
    /// landing across a cut may sit, inside `advance`, down to `-target.speed` behind the target's
    /// unmoved rearmost item, but once the target's own walk ran, every later run's gap is above
    /// `-SPACING` (positions strictly increase), the front item is at `>= 0`, the rearmost at
    /// `tail_pos < len`, and no `count == 0` run is left.
    #[cfg(debug_assertions)]
    fn check_line(&self, l: u32) {
        let line = &self.lines[l as usize];
        let mut cur = line.head;
        let mut last: Option<i64> = None;
        let mut items = 0u32;
        while cur != NIL {
            let r = self.nodes[cur as usize].run;
            assert!(
                r.count > 0,
                "a cut landing left unwalked on line {:?}",
                line.id
            );
            let first = match last {
                None => {
                    assert!(r.gap >= 0, "front item below 0 on line {:?}", line.id);
                    i64::from(r.gap)
                }
                Some(p) => {
                    assert!(
                        r.gap > -(SPACING as i32),
                        "gap {} at or below -SPACING on line {:?}",
                        r.gap,
                        line.id
                    );
                    p + SP + i64::from(r.gap)
                }
            };
            last = Some(first + SP * (i64::from(r.count) - 1));
            items += u32::from(r.count);
            cur = self.nodes[cur as usize].next;
        }
        assert_eq!(items, line.items, "item count of line {:?}", line.id);
        if let Some(p) = last {
            assert_eq!(p, i64::from(line.tail_pos), "tail of line {:?}", line.id);
            assert!(
                p < i64::from(line.len),
                "tail past the end of line {:?}",
                line.id
            );
        }
    }

    /// Without writing: the leader slot `k`'s feeder would see after `k` advanced with front
    /// leader `leader` (`NONE`: none), by the walk of [`Transport::advance_line`]'s rule (no
    /// line of a cycle holds landings across a cut before the cycle's first line advances):
    /// `tail - d - len` for the rearmost item's move `d`, or `NONE` when the line is empty or
    /// ends empty (every item crossed).
    fn dry_leader(&self, k: u32, leader: i64) -> i64 {
        let line = &self.lines[k as usize];
        let Some(h) = self.first(k) else {
            return NONE;
        };
        let mut visits = 1u64;
        let speed = i64::from(line.speed);
        let pos0 = i64::from(self.get(h).gap);
        let bound = leader + SP;
        let p = if pos0 < bound {
            pos0
        } else {
            (pos0 - speed).max(bound)
        };
        // The front run's items all move as its first (the next is bounded by `p + SPACING`).
        let mut d = pos0 - p;
        let mut cur = self.next(h);
        while let Some(c) = cur {
            if d == speed && !line.squashed {
                break;
            }
            d = (i64::from(self.get(c).gap) + d).clamp(0, speed);
            cur = self.next(c);
            visits += 1;
        }
        DRY_VISITS.with(|v| v.set(v.get() + visits));
        let tail = i64::from(line.tail_pos) - d;
        if tail < 0 {
            NONE
        } else {
            tail - i64::from(line.len)
        }
    }

    fn advance_line(&mut self, l: u32, cut_leader: Option<i64>) {
        let epoch = self.epoch;
        let fresh_runs = self.lines[l as usize].fresh_runs;
        // Merge landings across a cut in the middle of this line (`count == 0` runs, M44).
        let mut mid_left = u32::from(self.lines[l as usize].fresh_mid);
        // What this tick's cut landings may still move (`Line::fresh_cap`).
        let cap = i64::from(self.lines[l as usize].fresh_cap);
        self.lines[l as usize].adv_mark = epoch;
        self.lines[l as usize].fresh_runs = 0;
        self.lines[l as usize].fresh_mid = 0;
        self.lines[l as usize].fresh_cap = NO_CAP;
        let Some(mut h) = self.first(l) else {
            self.lines[l as usize].held = false;
            return;
        };
        if self.lines[l as usize].squashed {
            // M47: a squashed pair moves by the squash rule, which no forecast follows.
            self.fc.invalidate(l);
        }
        // The first of the back runs that crossed a cycle cut onto this line this tick (0079 §11):
        // they move at most `cap` more (their budget left), never across this line's front.
        let mut fresh = NIL;
        if fresh_runs > 0 {
            fresh = self.lines[l as usize].tail;
            for _ in 1..fresh_runs {
                fresh = self.prev(fresh).expect("fresh runs are on the line");
            }
        }
        let line = self.lines[l as usize];
        let speed = i64::from(line.speed);
        let out = line.out;
        let target = line.next_slot;
        let mut leader = match out {
            Output::Sink | Output::Merge { .. } | Output::Fork { .. } => NONE,
            Output::Next(_) if cut_leader.is_some() => cut_leader.expect("checked"),
            Output::Next(_) => {
                let t = &self.lines[target as usize];
                if t.items > 0 {
                    i64::from(t.tail_pos) - i64::from(t.len)
                } else {
                    NONE
                }
            }
            Output::DeadEnd => -SP,
        };
        let mut crossed = false;
        // The front run landed across a cut this tick (a merge's `count == 0` run, or the back
        // block): it moves at most `cap` and stops at 0 (one hand-off per item per tick).
        let mut front_fresh = false;
        // The front items, one at a time while they cross.
        let d0 = loop {
            let r = self.get(h);
            let pos0 = i64::from(r.gap);
            let bound = leader + SP;
            if r.count == 0 || h == fresh {
                if r.count == 0 {
                    self.get_mut(h).count = 1;
                    mid_left -= 1;
                }
                front_fresh = true;
                let p = if pos0 < bound {
                    pos0
                } else {
                    (pos0 - cap).max(bound).max(0)
                };
                self.get_mut(h).gap = p as i32;
                break pos0 - p;
            }
            let mut p = if pos0 < bound {
                pos0
            } else {
                (pos0 - speed).max(bound)
            };
            if p < 0 {
                self.cut_moved = pos0 - p;
                let taken = match out {
                    Output::Merge { at, .. } => self.merge_land(target, at, -p, r.item),
                    Output::Fork { .. } => self.fork_land(l, target, line.alt_slot, -p, r.item),
                    _ => true,
                };
                if !taken {
                    // No room on the target: the item waits at the front.
                    p = 0;
                }
            }
            // M47: the front check (one comparison per front item).
            let crosser = self.fc.front(l, pos0, p, line.speed);
            if p >= 0 {
                self.get_mut(h).gap = p as i32;
                break pos0 - p;
            }
            // `p < 0` needs no leader or one below `-SP`: a `Sink`, `Next`, or a transfer (a dead
            // end bounds p at 0).
            crossed = true;
            leader = p;
            match out {
                Output::Sink => {
                    self.lines[l as usize].sunk += 1;
                    self.items -= 1;
                }
                Output::Next(_) => {
                    let t = &self.lines[target as usize];
                    let (tlen, fresh_landing) = (i64::from(t.len), t.adv_mark != epoch);
                    debug_assert!(
                        tlen + p >= 0,
                        "a hand-off lands inside the target (set_out)"
                    );
                    self.land(target, r.item, (tlen + p) as u32, fresh_landing);
                    self.fc
                        .hand_off(l, target, (r.item, (tlen + p) as u32), crosser, ROUTE_NEXT);
                }
                // Already landed; the item left this line's run, so the next one is free.
                _ => {
                    leader = NONE;
                    let (ts, tp) = self.last_land;
                    let route = if matches!(out, Output::Merge { .. }) {
                        ROUTE_MERGE
                    } else {
                        ROUTE_FORK
                    };
                    self.fc.hand_off(l, ts, (r.item, tp), crosser, route);
                }
            }
            self.lines[l as usize].items -= 1;
            if r.count > 1 {
                let f = self.get_mut(h);
                f.count -= 1;
                f.gap = (pos0 + SP) as i32;
                continue;
            }
            match self.next(h) {
                None => {
                    self.pop_front(l);
                    let rec = &mut self.lines[l as usize];
                    rec.held = false;
                    rec.mark = epoch;
                    self.changed = true;
                    return;
                }
                Some(n) => {
                    let next_pos = pos0 + SP + i64::from(self.get(n).gap);
                    self.pop_front(l);
                    h = self.first(l).expect("a run followed");
                    self.get_mut(h).gap = next_pos as i32;
                }
            }
        };
        // The runs behind the front run.
        let tracking = d0 == 0;
        let start = if tracking {
            match self.jam_cursor(l) {
                Some(j) => j,
                None => {
                    let j = self.next(h);
                    self.set_jam(l, j);
                    j
                }
            }
        } else {
            self.next(h)
        };
        let mut last_d = d0;
        let mut cur = start;
        let mut all_rest_at_speed = false;
        // The limit of the runs walked now: `speed`, or `cap` from the cut's back block on.
        let mut lim = if h == fresh { cap } else { speed };
        let mut in_block = h == fresh;
        // A squashed line (M43) has no early exit: a negative gap behind a run that moved the full
        // `speed` still holds its item. Behind such a run every gap `>= 0` is skipped untouched
        // (exactly what the early exit leaves), so the flag being stale changes nothing.
        let squashed = self.lines[l as usize].squashed;
        let mut saw_negative = false;
        while let Some(c) = cur {
            if c == fresh {
                in_block = true;
                lim = cap;
            }
            let mut r = self.get(c);
            let fresh_mid = r.count == 0;
            // A merge landing across a cut (M44) moves at most `cap`; the runs behind it are
            // held by it as by any leader.
            let run_lim = if fresh_mid { cap } else { lim };
            if fresh_mid {
                self.get_mut(c).count = 1;
                r.count = 1;
                mid_left -= 1;
            } else if last_d == run_lim {
                // Every run behind moves `run_lim` with its gap unchanged, unless a cut landing
                // with another limit is still ahead (then the walk goes on, skipping like a
                // squashed line).
                if !squashed && mid_left == 0 && (fresh == NIL || in_block) {
                    all_rest_at_speed = true;
                    break;
                }
                if r.gap >= 0 {
                    cur = self.next(c);
                    continue;
                }
            }
            let g = i64::from(r.gap) + last_d;
            // The squash rule: an item inside its bound (`g < 0`) does not move.
            let d = g.min(run_lim).max(0);
            let ng = g - d;
            last_d = d;
            if ng < 0 {
                saw_negative = true;
            }
            if ng == 0 {
                let pc = self.prev(c).expect("never the front run");
                let pr = self.get(pc);
                if pr.item == r.item
                    && u32::from(pr.count) + u32::from(r.count) <= u32::from(u16::MAX)
                {
                    // Packed and the same item: merge (`remove_run` moves `jam` past `c`).
                    self.get_mut(pc).count += r.count;
                    self.changed = true;
                    cur = self.remove_run(l, c);
                    continue;
                }
                self.get_mut(c).gap = 0;
                let nx = self.next(c);
                if tracking && self.jam_cursor(l) == Some(Some(c)) {
                    self.set_jam(l, nx);
                }
                cur = nx;
            } else {
                self.get_mut(c).gap = ng as i32;
                cur = self.next(c);
            }
        }
        debug_assert_eq!(mid_left, 0, "every merge landing across a cut was walked");
        let moved = if all_rest_at_speed { lim } else { last_d };
        let rec = &mut self.lines[l as usize];
        if squashed && !saw_negative {
            // Every run but the packed ones the cursor skipped (gap 0) and the cut's landed ones
            // (gap >= 0) was walked: none is squashed any more.
            rec.squashed = false;
        }
        rec.tail_pos -= moved as u32;
        rec.held = d0 == 0 && !front_fresh;
        if crossed || d0 > 0 || moved > 0 {
            rec.mark = epoch;
            self.changed = true;
        }
    }

    /// Appends an item at `pos` (already `>= tail + SPACING` on this line), merging into the back
    /// run. Keeps the line's own count; the store-wide `items` is the caller's. `fresh`: the item
    /// crossed a cycle cut onto a line that has not advanced yet this tick; it joins only a back run
    /// of such items (`fresh_runs`), never one that will still move.
    fn land(&mut self, l: u32, item: u16, pos: u32, fresh: bool) {
        let line = self.lines[l as usize];
        debug_assert!(
            pos < line.len,
            "landing past the end: {pos} >= {}",
            line.len
        );
        if line.items == 0 {
            self.push_back(
                l,
                Run {
                    item,
                    count: 1,
                    gap: pos as i32,
                },
            );
            if fresh {
                self.lines[l as usize].fresh_runs += 1;
            }
        } else {
            // A landing across a cut may sit inside the spacing of (even ahead of) the target's
            // rearmost item as it stands before the target moves: the cut line saw the target as it
            // will be after its move (`cut_leader`), and the target's walk resolves the gap.
            debug_assert!(
                fresh || pos >= line.tail_pos + SPACING,
                "landing inside the spacing"
            );
            let gap = i64::from(pos) - i64::from(line.tail_pos) - SP;
            if gap < 0 {
                self.lines[l as usize].squashed = true;
                self.fc.invalidate(l);
            }
            let gap = gap as i32;
            let b = line.tail;
            let joinable = !fresh || line.fresh_runs > 0;
            let back = self.get_mut(b);
            if joinable && gap == 0 && back.item == item && back.count < u16::MAX {
                back.count += 1;
            } else {
                if fresh {
                    self.lines[l as usize].fresh_runs += 1;
                }
                self.push_back(
                    l,
                    Run {
                        item,
                        count: 1,
                        gap,
                    },
                );
            }
        }
        let epoch = self.epoch;
        if fresh {
            self.note_cut_landing(l);
        }
        let rec = &mut self.lines[l as usize];
        rec.tail_pos = pos;
        rec.items += 1;
        rec.mark = epoch;
        self.changed = true;
    }

    /// Records a landing across a cut on slot `l` (0079 §11 as amended in M44): the item may move
    /// `speed - moved` more when `l` advances, `moved` (`cut_moved`) being what it already moved on
    /// its feeder. One budget per line per tick: a second landing with another budget sets it to 0.
    fn note_cut_landing(&mut self, l: u32) {
        let rec = &mut self.lines[l as usize];
        let cap = (i64::from(rec.speed) - self.cut_moved).max(0) as u16;
        if cap > 0 {
            // M47: the landing moves again this tick, past its forecast.
            self.fc.invalidate(l);
        }
        let rec = &mut self.lines[l as usize];
        rec.fresh_cap = match rec.fresh_cap {
            NO_CAP => cap,
            c if c == cap => cap,
            _ => 0,
        };
    }

    /// A `Merge` transfer onto slot `t` with overshoot `o` (module doc): `true` if the item landed.
    /// On a target that has advanced this tick it is exactly `insert_at` (which may refuse); on one
    /// that has not (a cut link) [`Transport::land_fresh_at`].
    fn merge_land(&mut self, t: u32, at: u32, o: i64, item: u16) -> bool {
        let tl = &self.lines[t as usize];
        let pos = (i64::from(at) - o).clamp(0, i64::from(tl.len) - 1);
        self.last_land = (t, pos as u32);
        if tl.adv_mark != self.epoch {
            return self.land_fresh_at(t, pos, item);
        }
        if self.insert_at_slot(t, pos as u32, item).is_err() {
            return false;
        }
        // `insert_at` counted a new item; this one only moved.
        self.items -= 1;
        true
    }

    /// A `Fork` transfer from slot `l` with overshoot `o` (module doc): the preferred target, else
    /// the other; `true` if the item landed. Flips `l`'s toggle on a preferred delivery only.
    fn fork_land(&mut self, l: u32, a: u32, b: u32, o: i64, item: u16) -> bool {
        let toggle = self.lines[l as usize].toggle;
        let (pref, other) = if toggle { (b, a) } else { (a, b) };
        if self.try_hand_off(pref, o, item) {
            self.lines[l as usize].toggle = !toggle;
            return true;
        }
        self.try_hand_off(other, o, item)
    }

    /// The plain hand-off landing `target.len - o` on slot `t` if it has room behind the target's
    /// rearmost item (`tail + SPACING <= landing`, the rule `Next`'s leader enforces).
    fn try_hand_off(&mut self, t: u32, o: i64, item: u16) -> bool {
        let tl = &self.lines[t as usize];
        let pos = i64::from(tl.len) - o;
        debug_assert!(
            (0..i64::from(tl.len)).contains(&pos),
            "a fork target is at least the feeder's speed long (set_out)"
        );
        if tl.items > 0 && i64::from(tl.tail_pos) + SP > pos {
            return false;
        }
        self.last_land = (t, pos as u32);
        let fresh = tl.adv_mark != self.epoch;
        self.land(t, item, pos as u32, fresh);
        true
    }

    /// A merge landing at `pos` on slot `l`, which has not advanced yet this tick (a cut link):
    /// `insert_at`'s room rule over the line as it stands (earlier landings across the cut
    /// included; [`Transport::locate`] walks from the nearer end), and the item never joins a run
    /// that will still move. Behind the rearmost item it is a back landing ([`Transport::land`],
    /// `fresh_runs`); in front of or among the cut's back runs it joins that block, merging with a
    /// packed same-kind neighbour in it (canonical form, `u16` guard; M44 review); elsewhere it is
    /// its own run marked `count == 0` (`fresh_mid`), restored by the line's walk. `true` if it
    /// landed.
    fn land_fresh_at(&mut self, l: u32, pos: i64, item: u16) -> bool {
        if self.lines[l as usize].fresh_mid == u16::MAX {
            return false;
        }
        let Some(slot) = self.locate(l, pos) else {
            return false;
        };
        if slot.prev.is_some_and(|(_, pl)| pos - pl < SP) {
            return false;
        }
        let Some((c, f)) = slot.next else {
            self.land(l, item, pos as u32, true);
            return true;
        };
        if f - pos < SP {
            return false;
        }
        // Whether `c` is in the cut's back block (the last `fresh_runs` runs), and its first run.
        let line = self.lines[l as usize];
        let (mut in_block, mut first) = (false, NIL);
        let mut b = opt_node(line.tail);
        for _ in 0..line.fresh_runs {
            let Some(n) = b else { break };
            in_block |= n == c;
            first = n;
            b = self.prev(n);
        }
        let gap = slot.prev.map_or(pos, |(_, pl)| pos - pl - SP) as i32;
        let gap_after = (f - pos - SP) as i32;
        let epoch = self.epoch;
        if in_block {
            let next = self.get(c);
            let join_next = gap_after == 0 && next.item == item && next.count < u16::MAX;
            let join_prev = c != first
                && slot.prev.is_some_and(|(p, _)| {
                    let pr = self.get(p);
                    gap == 0 && pr.item == item && pr.count < u16::MAX
                });
            match (join_prev, join_next) {
                (true, _) => {
                    let p = slot.prev.expect("joined").0;
                    self.get_mut(p).count += 1;
                    let total = u32::from(self.get(p).count) + u32::from(next.count);
                    if join_next && total <= u32::from(u16::MAX) {
                        self.get_mut(p).count = total as u16;
                        self.remove_run(l, c);
                        self.lines[l as usize].fresh_runs -= 1;
                    } else {
                        self.get_mut(c).gap = gap_after;
                    }
                }
                (false, true) => {
                    let n = self.get_mut(c);
                    n.count += 1;
                    n.gap = gap;
                }
                (false, false) => {
                    self.get_mut(c).gap = gap_after;
                    self.insert_before(
                        l,
                        Some(c),
                        Run {
                            item,
                            count: 1,
                            gap,
                        },
                    );
                    self.lines[l as usize].fresh_runs += 1;
                }
            }
            self.lines[l as usize].jam_valid = false;
        } else {
            self.get_mut(c).gap = gap_after;
            self.insert_before(
                l,
                Some(c),
                Run {
                    item,
                    count: 0,
                    gap,
                },
            );
            self.lines[l as usize].fresh_mid += 1;
        }
        self.note_cut_landing(l);
        let rec = &mut self.lines[l as usize];
        rec.items += 1;
        rec.mark = epoch;
        self.changed = true;
        true
    }

    pub(super) fn insert_back_slot(&mut self, l: u32, item: u16) -> Result<(), TransportError> {
        let line = self.lines[l as usize];
        let len = i64::from(line.len);
        let speed = i64::from(line.speed);
        let land = if line.items == 0 {
            len - speed
        } else {
            (len - speed).max(i64::from(line.tail_pos) + SP)
        };
        if land > len - 1 {
            return Err(TransportError::NoRoom);
        }
        self.land(l, item, land as u32, false);
        self.items += 1;
        Ok(())
    }
}
