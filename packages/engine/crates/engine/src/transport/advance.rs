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
                self.get_mut(h).gap = p as u32;
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
                f.gap = (pos0 + SP) as u32;
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
                    self.get_mut(h).gap = next_pos as u32;
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
        while let Some(c) = cur {
            if c == fresh {
                break;
            }
            if last_d == speed {
                all_rest_at_speed = true;
                break;
            }
            let r = self.get(c);
            let g = i64::from(r.gap) + last_d;
            let d = g.min(speed);
            let ng = g - d;
            last_d = d;
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
                self.get_mut(c).gap = ng as u32;
                cur = self.next(c);
            }
        }
        let moved = if all_rest_at_speed { speed } else { last_d };
        if fresh != NIL {
            // The runs ahead moved `moved`; the cut's items stay, so their gap widens by it.
            self.get_mut(fresh).gap += moved as u32;
        }
        let rec = &mut self.lines[l as usize];
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
                    gap: pos,
                },
            );
            if fresh {
                self.lines[l as usize].fresh_runs += 1;
            }
        } else {
            debug_assert!(pos >= line.tail_pos + SPACING, "landing inside the spacing");
            let gap = pos - line.tail_pos - SPACING;
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

    /// Absolute position of a run's first item given the previous run's last item position.
    #[inline]
    fn first_pos(prev_last: Option<i64>, r: Run) -> i64 {
        match prev_last {
            None => i64::from(r.gap),
            Some(p) => p + SP + i64::from(r.gap),
        }
    }

    pub(super) fn insert_at_slot(
        &mut self,
        l: u32,
        pos: u32,
        item: u16,
    ) -> Result<(), TransportError> {
        let line = self.lines[l as usize];
        let pos = i64::from(pos);
        if pos > i64::from(line.len) - 1 {
            return Err(TransportError::NoRoom);
        }
        let mut prev: Option<u32> = None;
        let mut prev_last: Option<i64> = None;
        let mut cur = self.first(l);
        while let Some(c) = cur {
            let r = self.get(c);
            let f = Self::first_pos(prev_last, r);
            if f > pos {
                break;
            }
            let last = f + SP * (i64::from(r.count) - 1);
            if pos <= last {
                return Err(TransportError::NoRoom);
            }
            prev = Some(c);
            prev_last = Some(last);
            cur = self.next(c);
        }
        if prev_last.is_some_and(|pl| pos - pl < SP) {
            return Err(TransportError::NoRoom);
        }
        let gap_new = match prev_last {
            None => pos,
            Some(pl) => pos - pl - SP,
        };
        // Every merge guards `count` against `u16` overflow (0077 A6b (ii)).
        let merge_prev = gap_new == 0
            && prev.is_some_and(|p| {
                let pr = self.get(p);
                pr.item == item && pr.count < u16::MAX
            });
        match cur {
            None => {
                match prev {
                    Some(p) if merge_prev => self.get_mut(p).count += 1,
                    _ => self.insert_before(
                        l,
                        None,
                        Run {
                            item,
                            count: 1,
                            gap: gap_new as u32,
                        },
                    ),
                }
                self.lines[l as usize].tail_pos = pos as u32;
            }
            Some(c) => {
                let r = self.get(c);
                let f = Self::first_pos(prev_last, r);
                if f - pos < SP {
                    return Err(TransportError::NoRoom);
                }
                let gap_succ = (f - pos - SP) as u32;
                self.get_mut(c).gap = gap_succ;
                let merge_succ = gap_succ == 0 && r.item == item && r.count < u16::MAX;
                match prev {
                    Some(p) if merge_prev => {
                        self.get_mut(p).count += 1;
                        let merged = self.get(p).count;
                        if merge_succ && u32::from(merged) + u32::from(r.count) <= 0xFFFF {
                            self.get_mut(p).count += r.count;
                            self.remove_run(l, c);
                        }
                    }
                    _ if merge_succ => {
                        let s = self.get_mut(c);
                        s.count += 1;
                        s.gap = gap_new as u32;
                    }
                    _ => self.insert_before(
                        l,
                        Some(c),
                        Run {
                            item,
                            count: 1,
                            gap: gap_new as u32,
                        },
                    ),
                }
            }
        }
        self.items += 1;
        let epoch = self.epoch;
        let rec = &mut self.lines[l as usize];
        rec.items += 1;
        rec.jam_valid = false;
        rec.mark = epoch;
        self.changed = true;
        Ok(())
    }

    pub(super) fn remove_at_slot(&mut self, l: u32, pos: u32) -> Option<u16> {
        let pos = i64::from(pos);
        let mut prev_last: Option<i64> = None;
        let mut cur = self.first(l);
        let (c, k, r) = loop {
            let c = cur?;
            let r = self.get(c);
            let f = Self::first_pos(prev_last, r);
            if f > pos + SP / 2 {
                return None;
            }
            let last = f + SP * (i64::from(r.count) - 1);
            if last >= pos - SP / 2 {
                // Nearest item of this run, the front one on a tie.
                let k = if pos <= f {
                    0
                } else {
                    ((pos - f + SP / 2 - 1) / SP).min(i64::from(r.count) - 1)
                };
                if (f + SP * k - pos).abs() <= SP / 2 {
                    break (c, k as u16, r);
                }
            }
            prev_last = Some(last);
            cur = self.next(c);
        };
        let next = self.next(c);
        if r.count == 1 {
            match next {
                Some(n) => self.get_mut(n).gap += r.gap + SPACING,
                None => {
                    if let Some(pl) = prev_last {
                        self.lines[l as usize].tail_pos = pl as u32;
                    }
                }
            }
            if prev_last.is_none() {
                self.pop_front(l);
            } else {
                self.remove_run(l, c);
            }
        } else if k == 0 {
            let m = self.get_mut(c);
            m.count -= 1;
            m.gap += SPACING;
        } else if k == r.count - 1 {
            self.get_mut(c).count -= 1;
            match next {
                Some(n) => self.get_mut(n).gap += SPACING,
                None => self.lines[l as usize].tail_pos -= SPACING,
            }
        } else {
            self.get_mut(c).count = k;
            self.insert_before(
                l,
                next,
                Run {
                    item: r.item,
                    count: r.count - k - 1,
                    gap: SPACING,
                },
            );
        }
        self.items -= 1;
        let epoch = self.epoch;
        let rec = &mut self.lines[l as usize];
        rec.items -= 1;
        rec.jam_valid = false;
        rec.mark = epoch;
        if rec.head == NIL {
            rec.held = false;
        }
        self.changed = true;
        Some(r.item)
    }
}
