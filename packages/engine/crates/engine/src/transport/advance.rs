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
//! The cycle cut (0079, M42 review): an item that crosses onto a line that has not advanced yet
//! this tick (only the cut link of a cycle can do that) joins a back run of such items
//! (`Line::fresh_runs`); that line's advance stops its walk before them and widens the gap in front
//! of them by what the runs ahead moved, so every item moves at most one tick's travel per tick.
//! A plain `Next` needs `target.len >= feeder.speed` (`set_out`, `set_speed`, decode), so a landing
//! `target.len + p` is never negative. Positions are `i64` here so no
//! `len` near `u32::MAX` can overflow the arithmetic; stored values stay `u32`.

use super::line::{NIL, Run};
use super::{Output, SPACING, Transport, TransportError};

const SP: i64 = SPACING as i64;
/// "No leader": far below any position, so `NONE + SP - speed` cannot overflow.
const NONE: i64 = i64::MIN / 4;

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
            self.advance_line(l);
        }
        let moved = self.changed;
        self.changed |= before;
        self.advanced_epoch = self.epoch;
        self.epoch = self.epoch.wrapping_add(1).max(1);
        moved
    }

    fn advance_line(&mut self, l: u32) {
        let epoch = self.epoch;
        let fresh_runs = self.lines[l as usize].fresh_runs;
        self.lines[l as usize].adv_mark = epoch;
        self.lines[l as usize].fresh_runs = 0;
        let Some(mut h) = self.first(l) else {
            self.lines[l as usize].held = false;
            return;
        };
        // The first of the back runs that crossed a cycle cut onto this line this tick (0079, M42
        // review): they do not move again; the gap in front of them widens instead.
        let mut fresh = NIL;
        if fresh_runs > 0 {
            fresh = self.lines[l as usize].tail;
            for _ in 1..fresh_runs {
                fresh = self.prev(fresh).expect("fresh runs are on the line");
            }
        }
        if h == fresh {
            self.lines[l as usize].held = false;
            return;
        }
        let line = self.lines[l as usize];
        let speed = i64::from(line.speed);
        let out = line.out;
        let target = line.next_slot;
        let mut leader = match out {
            Output::Sink => NONE,
            Output::Next(_) => {
                let t = &self.lines[target as usize];
                if t.items > 0 {
                    i64::from(t.tail_pos) - i64::from(t.len)
                } else {
                    NONE
                }
            }
            // `Merge`/`Fork` are never stored in M42 (`set_out` and decode refuse them).
            Output::DeadEnd | Output::Merge { .. } | Output::Fork { .. } => -SP,
        };
        let mut crossed = false;
        // The front items, one at a time while they cross.
        let d0 = loop {
            let r = self.get(h);
            let pos0 = i64::from(r.gap);
            let bound = leader + SP;
            let p = if pos0 < bound {
                pos0
            } else {
                (pos0 - speed).max(bound)
            };
            if p >= 0 {
                self.get_mut(h).gap = p as i32;
                break pos0 - p;
            }
            // `p < 0` needs a leader below `-SP`: a `Sink` or a `Next` (a dead end bounds p at 0).
            crossed = true;
            leader = p;
            if out == Output::Sink {
                self.lines[l as usize].sunk += 1;
                self.items -= 1;
            } else {
                let t = &self.lines[target as usize];
                let (tlen, fresh_landing) = (i64::from(t.len), t.adv_mark != epoch);
                debug_assert!(
                    tlen + p >= 0,
                    "a hand-off lands inside the target (set_out)"
                );
                self.land(target, r.item, (tlen + p) as u32, fresh_landing);
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
                    if h == fresh {
                        // Only items that crossed the cut are left: they stay where they landed.
                        let rec = &mut self.lines[l as usize];
                        rec.held = false;
                        rec.mark = epoch;
                        self.changed = true;
                        return;
                    }
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
        // A squashed line (M43) has no early exit: a negative gap behind a run that moved the full
        // `speed` still holds its item. Behind such a run every gap `>= 0` is skipped untouched
        // (exactly what the early exit leaves), so the flag being stale changes nothing.
        let squashed = self.lines[l as usize].squashed;
        let mut saw_negative = false;
        while let Some(c) = cur {
            if c == fresh {
                break;
            }
            let r = self.get(c);
            if last_d == speed {
                if !squashed {
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
            let d = g.min(speed).max(0);
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
        let moved = if all_rest_at_speed { speed } else { last_d };
        if fresh != NIL {
            // The runs ahead moved `moved`; the cut's items stay, so their gap widens by it.
            self.get_mut(fresh).gap += moved as i32;
        }
        let rec = &mut self.lines[l as usize];
        if squashed && !saw_negative {
            // Every run but the packed ones the cursor skipped (gap 0) and the cut's landed ones
            // (gap >= 0) was walked: none is squashed any more.
            rec.squashed = false;
        }
        if fresh == NIL {
            rec.tail_pos -= moved as u32;
        }
        rec.held = d0 == 0;
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
            debug_assert!(pos >= line.tail_pos + SPACING, "landing inside the spacing");
            let gap = (pos - line.tail_pos - SPACING) as i32;
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
        let rec = &mut self.lines[l as usize];
        rec.tail_pos = pos;
        rec.items += 1;
        rec.mark = epoch;
        self.changed = true;
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
