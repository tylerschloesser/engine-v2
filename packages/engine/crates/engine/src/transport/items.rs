//! The inserter-shaped item primitives (0076 §3; M42 pulled `insert_at`/`remove_at` forward, M43
//! adds `take_front`): `insert_at(pos)` needs `SPACING` clear on both sides on this line and
//! `pos <= len - 1` and lands exactly at `pos` (no push-back); `remove_at(pos)` takes the nearest
//! item within `SPACING / 2`, the front one on a tie; `take_front` removes the front item (a sink
//! the game drives itself, an inserter picking from the belt's end). Squashed pairs (`line.rs`) are
//! walked like any other: positions still strictly increase.

use super::line::{NIL, Run};
use super::{SPACING, Transport, TransportError};

const SP: i64 = SPACING as i64;

impl Transport {
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
                            gap: gap_new as i32,
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
                let gap_succ = (f - pos - SP) as i32;
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
                        s.gap = gap_new as i32;
                    }
                    _ => self.insert_before(
                        l,
                        Some(c),
                        Run {
                            item,
                            count: 1,
                            gap: gap_new as i32,
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
        // `(run, index in it, the run, the previous run's last position, distance)`. Every run
        // reaching `pos` is looked at: a squashed follower (`line.rs`) can be nearer than the item
        // a run ahead offers. Strictly nearer wins, so a tie keeps the front one.
        let mut best: Option<(u32, u16, Run, Option<i64>, i64)> = None;
        while let Some(c) = cur {
            let r = self.get(c);
            let f = Self::first_pos(prev_last, r);
            if f > pos + SP / 2 {
                break;
            }
            let last = f + SP * (i64::from(r.count) - 1);
            if last >= pos - SP / 2 {
                // Nearest item of this run, the front one on a tie.
                let k = if pos <= f {
                    0
                } else {
                    ((pos - f + SP / 2 - 1) / SP).min(i64::from(r.count) - 1)
                };
                let d = (f + SP * k - pos).abs();
                if d <= SP / 2 && best.is_none_or(|b| d < b.4) {
                    best = Some((c, k as u16, r, prev_last, d));
                }
            }
            prev_last = Some(last);
            cur = self.next(c);
        }
        let (c, k, r, prev_last, _) = best?;
        let next = self.next(c);
        if r.count == 1 {
            match next {
                Some(n) => self.get_mut(n).gap += r.gap + SP as i32,
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
            m.gap += SP as i32;
        } else if k == r.count - 1 {
            self.get_mut(c).count -= 1;
            match next {
                Some(n) => self.get_mut(n).gap += SP as i32,
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
                    gap: SP as i32,
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

    /// Removes the front item: the nearest item to the front item's own position is that item
    /// (distance 0; a squashed follower is at least 1 behind), so this is `remove_at` at the
    /// front, which touches only the front run.
    pub(super) fn take_front_slot(&mut self, l: u32) -> Option<u16> {
        let h = self.first(l)?;
        let pos = self.get(h).gap as u32;
        let got = self.remove_at_slot(l, pos);
        debug_assert!(got.is_some(), "the front item is within reach of itself");
        got
    }
}
