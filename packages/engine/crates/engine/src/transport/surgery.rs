//! Line surgery (0076 §3, M43): `split`, `join`, `extend_*`, `shrink_*`, `rescale` and the full
//! `destroy`, on the run store (`line.rs`) with positions as prefix sums.
//!
//! Every operation validates first and writes after, and keeps the store's invariants: positions
//! in `[0, len - 1]` and strictly increasing, `SPACING` within a line except for the squashed pairs
//! `rescale` and `join` keep (a negative gap, `line.rs`; the squash rule resolves them, 12 §3e),
//! `speed < len` (0076 §1) and every `Next` target at least its feeder's speed long (0079 §8),
//! counts and `tail_pos` exact. The `jam` cursor of a line whose runs change is invalidated (a
//! valid state: the next stopped `advance` re-walks from the front, O(runs), surgery is rare);
//! `graph_dirty` is set when an output changes; every changed line is touched (0079 §9). Surgery
//! runs inside `G::tick`, before `advance`, so no line holds items landed across a cycle cut
//! (`fresh_runs`, 0079 §11): asserted.
//!
//! A line whose `len` changes loses its segments and their tile-index entries (`sum(len) == len`
//! would no longer hold, and a cut cannot split an arc exactly); the game registers the new path
//! with `set_segments`. Feeder lookups scan every line (no reverse links): O(lines), rare.

use super::line::{Line, NIL, Run};
use super::{Item, LineId, MAX_LEN, Output, SPACING, Transport, TransportError};

const SP: i64 = SPACING as i64;

impl Transport {
    /// 0079 §11: surgery never sees items landed across a cut (they exist only inside `advance`).
    #[inline]
    fn assert_no_fresh(&self, l: u32) {
        debug_assert_eq!(
            self.lines[l as usize].fresh_runs, 0,
            "surgery inside advance (0079 §11)"
        );
    }

    /// Whether every line feeding slot `l` (`Next(l)`) moves at most `len` per tick (0079 §8).
    fn feeders_fit(&self, l: u32, len: u64) -> bool {
        self.index.iter().all(|&(_, s)| {
            let rec = &self.lines[s as usize];
            rec.next_slot != l || u64::from(rec.speed) <= len
        })
    }

    /// Whether a line of `speed` can be `len` long: `speed < len <= MAX_LEN` and its feeders fit.
    fn len_ok(&self, l: u32, len: u64) -> Result<(), TransportError> {
        if len > u64::from(MAX_LEN) {
            return Err(TransportError::TooLong);
        }
        if u64::from(self.lines[l as usize].speed) >= len || !self.feeders_fit(l, len) {
            return Err(TransportError::BadSpeed);
        }
        Ok(())
    }

    /// Points every `Next(from)` at `to` (slot `to_slot`); `DeadEnd` when `to` is `None`. Each
    /// changed feeder is touched.
    fn redirect_feeders(&mut self, from: LineId, to: Option<(LineId, u32)>) {
        for k in 0..self.index.len() {
            let s = self.index[k].1;
            let rec = &mut self.lines[s as usize];
            if rec.out == Output::Next(from) {
                match to {
                    Some((id, slot)) => {
                        rec.out = Output::Next(id);
                        rec.next_slot = slot;
                    }
                    None => {
                        rec.out = Output::DeadEnd;
                        rec.next_slot = NIL;
                    }
                }
                rec.jam_valid = false;
                // Its output changed: touched like `set_out` (M47 reads it; M43 review).
                self.touch(s);
            }
        }
        self.graph_dirty = true;
    }

    /// Whether any run after the front has a negative gap (the exact `squashed` flag).
    fn has_negative_gap(&self, l: u32) -> bool {
        let Some(h) = self.first(l) else {
            return false;
        };
        let mut cur = self.next(h);
        while let Some(c) = cur {
            if self.get(c).gap < 0 {
                return true;
            }
            cur = self.next(c);
        }
        false
    }

    /// After a surgery op changed slot `l`'s runs or length.
    fn finish(&mut self, l: u32) {
        self.lines[l as usize].jam_valid = false;
        self.touch(l);
    }

    pub(super) fn destroy_line(
        &mut self,
        line: LineId,
        f: &mut dyn FnMut(Item),
    ) -> Result<u32, TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        self.assert_no_fresh(slot);
        let removed = self.lines[slot as usize].items;
        let mut cur = self.lines[slot as usize].head;
        while cur != NIL {
            let n = self.nodes[cur as usize];
            for _ in 0..n.run.count {
                f(Item(n.run.item));
            }
            self.items -= u32::from(n.run.count);
            self.release_node(cur);
            cur = n.next;
        }
        self.clear_geometry(slot);
        self.free_slot(line, slot);
        self.redirect_feeders(line, None);
        self.changed = true;
        Ok(removed)
    }

    /// Drops `line` from the id index and puts its slot on the free list (runs and geometry
    /// already released). Ids are never reused; slots are.
    fn free_slot(&mut self, line: LineId, slot: u32) {
        let k = self
            .index
            .binary_search_by(|(i, _)| i.cmp(&line))
            .expect("a live line is indexed");
        self.index.remove(k);
        self.lines[slot as usize] = Line::free(self.free_line);
        self.free_line = slot;
        self.graph_dirty = true;
    }

    pub(super) fn split_line(&mut self, line: LineId, at: u32) -> Result<LineId, TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        self.assert_no_fresh(slot);
        let rec = self.lines[slot as usize];
        let speed = u32::from(rec.speed);
        // Both parts keep `1 <= speed < len` (0076 §1); the new back part receives the feeders
        // (0079 §8), and the front part is the back part's target, `at > speed` long.
        if at <= speed || at >= rec.len {
            return Err(TransportError::BadSpeed);
        }
        let back_len = rec.len - at;
        if back_len <= speed || !self.feeders_fit(slot, u64::from(back_len)) {
            return Err(TransportError::BadSpeed);
        }
        if self.index.len() as u32 >= self.max_lines || self.next_id == u32::MAX {
            return Err(TransportError::Full);
        }
        // Find the first item at or past the cut: the run `c` holding it, and how many of `c`'s
        // items stay in front (`keep`).
        let at_i = i64::from(at);
        let mut prev_last: Option<i64> = None;
        let mut cur = self.first(slot);
        let mut cut: Option<(u32, u16, i64)> = None; // (run, items kept in front, first back pos)
        while let Some(c) = cur {
            let r = self.get(c);
            let f = match prev_last {
                None => i64::from(r.gap),
                Some(p) => p + SP + i64::from(r.gap),
            };
            let last = f + SP * (i64::from(r.count) - 1);
            if last >= at_i {
                let keep = if f >= at_i {
                    0
                } else {
                    ((at_i - f + SP - 1) / SP) as u16
                };
                cut = Some((c, keep, f + SP * i64::from(keep)));
                break;
            }
            prev_last = Some(last);
            cur = self.next(c);
        }
        let id = LineId(self.next_id);
        self.next_id += 1;
        // Created as a dead end: its own output is set after the feeders are redirected to it.
        let back_slot = self.alloc_line(Line::new(id, back_len, rec.speed));
        self.index.push((id, back_slot));
        if let Some((c, keep, first_back)) = cut {
            // The back part's first node: `c` itself, or a new node for `c`'s rear items.
            let b = if keep == 0 {
                c
            } else {
                let r = self.get(c);
                self.get_mut(c).count = keep;
                let n = self.alloc_node(Run {
                    item: r.item,
                    count: r.count - keep,
                    gap: 0,
                });
                let after = self.nodes[c as usize].next;
                self.nodes[n as usize].next = after;
                self.nodes[n as usize].prev = c;
                if after != NIL {
                    self.nodes[after as usize].prev = n;
                } else {
                    self.lines[slot as usize].tail = n;
                }
                self.nodes[c as usize].next = n;
                self.lines[slot as usize].runs += 1;
                n
            };
            self.get_mut(b).gap = (first_back - at_i) as i32;
            // Relink: the front part ends before `b`; the back part is `b ..= tail`.
            let front_tail = self.nodes[b as usize].prev;
            self.nodes[b as usize].prev = NIL;
            let old_tail = self.lines[slot as usize].tail;
            let mut runs = 0u32;
            let mut items = 0u32;
            let mut cur = b;
            while cur != NIL {
                runs += 1;
                items += u32::from(self.nodes[cur as usize].run.count);
                cur = self.nodes[cur as usize].next;
            }
            let back = &mut self.lines[back_slot as usize];
            back.head = b;
            back.tail = old_tail;
            back.runs = runs;
            back.items = items;
            back.tail_pos = rec.tail_pos - at;
            let front = &mut self.lines[slot as usize];
            front.runs -= runs;
            front.items -= items;
            front.tail = front_tail;
            if front_tail == NIL {
                front.head = NIL;
            } else {
                self.nodes[front_tail as usize].next = NIL;
                // The front part's last item: the run ahead's last, or `c`'s last kept item.
                let tail_pos = if keep == 0 {
                    prev_last.expect("a run is ahead of the cut")
                } else {
                    first_back - SP
                };
                self.lines[slot as usize].tail_pos = tail_pos as u32;
            }
            self.lines[back_slot as usize].squashed = self.has_negative_gap(back_slot);
            self.lines[slot as usize].squashed = self.has_negative_gap(slot);
        }
        self.lines[slot as usize].len = at;
        self.clear_geometry(slot);
        self.redirect_feeders(line, Some((id, back_slot)));
        self.lines[back_slot as usize].out = Output::Next(line);
        self.lines[back_slot as usize].next_slot = slot;
        self.finish(slot);
        self.finish(back_slot);
        Ok(id)
    }

    pub(super) fn join_lines(&mut self, front: LineId, back: LineId) -> Result<(), TransportError> {
        let fs = self.slot(front).ok_or(TransportError::NoLine)?;
        let bs = self.slot(back).ok_or(TransportError::NoLine)?;
        self.assert_no_fresh(fs);
        self.assert_no_fresh(bs);
        if self.lines[bs as usize].out != Output::Next(front) {
            return Err(TransportError::NotLinked);
        }
        if self.lines[fs as usize].out == Output::Next(back) {
            return Err(TransportError::Unsupported);
        }
        let (f, b) = (self.lines[fs as usize], self.lines[bs as usize]);
        let new_len = u64::from(f.len) + u64::from(b.len);
        if new_len > u64::from(MAX_LEN) {
            return Err(TransportError::TooLong);
        }
        // `back`'s feeders land on a line longer than `back`, so 0079 §8 still holds.
        if b.head != NIL {
            let first_back = i64::from(self.get(b.head).gap) + i64::from(f.len);
            let mut b_head = b.head;
            let mut b_runs = b.runs;
            if f.head == NIL {
                self.get_mut(b_head).gap = first_back as i32;
            } else {
                let gap = first_back - i64::from(f.tail_pos) - SP;
                debug_assert!(gap > -SP, "positions strictly increase across a join");
                let (tr, br) = (self.get(f.tail), self.get(b_head));
                if gap == 0
                    && tr.item == br.item
                    && u32::from(tr.count) + u32::from(br.count) <= u32::from(u16::MAX)
                {
                    // A packed same-kind boundary pair merges (canonical form, 0077 A6b (ii)).
                    self.get_mut(f.tail).count += br.count;
                    let next = self.nodes[b_head as usize].next;
                    self.release_node(b_head);
                    b_runs -= 1;
                    b_head = next;
                    if b_head != NIL {
                        self.nodes[b_head as usize].prev = NIL;
                    }
                } else {
                    self.get_mut(b_head).gap = gap as i32;
                }
            }
            if b_head != NIL {
                if f.tail == NIL {
                    self.lines[fs as usize].head = b_head;
                } else {
                    self.nodes[f.tail as usize].next = b_head;
                    self.nodes[b_head as usize].prev = f.tail;
                }
                self.lines[fs as usize].tail = b.tail;
            }
            let rec = &mut self.lines[fs as usize];
            rec.runs += b_runs;
            rec.items += b.items;
            rec.tail_pos = b.tail_pos + f.len;
            // The back line's runs now belong to `front`; its record must not release them.
            self.lines[bs as usize].head = NIL;
            self.lines[bs as usize].tail = NIL;
        }
        self.lines[fs as usize].len = new_len as u32;
        self.lines[fs as usize].squashed = self.has_negative_gap(fs);
        self.clear_geometry(fs);
        self.clear_geometry(bs);
        self.free_slot(back, bs);
        self.redirect_feeders(back, Some((front, fs)));
        self.finish(fs);
        Ok(())
    }

    pub(super) fn extend(
        &mut self,
        line: LineId,
        by: u32,
        at_front: bool,
    ) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        self.assert_no_fresh(slot);
        let rec = self.lines[slot as usize];
        let new_len = u64::from(rec.len) + u64::from(by);
        if new_len > u64::from(MAX_LEN) {
            return Err(TransportError::TooLong);
        }
        if at_front && rec.head != NIL {
            // Positions from the front, gaps toward the back: only the front run's gap moves.
            self.get_mut(rec.head).gap += by as i32;
            self.lines[slot as usize].tail_pos += by;
        }
        self.lines[slot as usize].len = new_len as u32;
        self.clear_geometry(slot);
        self.finish(slot);
        Ok(())
    }

    pub(super) fn shrink(
        &mut self,
        line: LineId,
        by: u32,
        at_front: bool,
    ) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        self.assert_no_fresh(slot);
        let rec = self.lines[slot as usize];
        let new_len = i64::from(rec.len) - i64::from(by);
        self.len_ok(slot, new_len.max(0) as u64)?;
        if rec.head != NIL {
            let falls_off = if at_front {
                i64::from(self.get(rec.head).gap) < i64::from(by)
            } else {
                i64::from(rec.tail_pos) > new_len - 1
            };
            if falls_off {
                return Err(TransportError::NotEmpty);
            }
            if at_front {
                self.get_mut(rec.head).gap -= by as i32;
                self.lines[slot as usize].tail_pos -= by;
            }
        }
        self.lines[slot as usize].len = new_len as u32;
        self.clear_geometry(slot);
        self.finish(slot);
        Ok(())
    }

    /// The position `pos` scales to (12 §3e): `floor(pos x new / old)`, in `u64`.
    #[inline]
    fn scaled(pos: i64, new_len: u32, old_len: u32) -> i64 {
        (pos as u64 * u64::from(new_len) / u64::from(old_len)) as i64
    }

    pub(super) fn rescale_line(
        &mut self,
        line: LineId,
        new_len: u32,
    ) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        self.assert_no_fresh(slot);
        self.len_ok(slot, u64::from(new_len))?;
        let rec = self.lines[slot as usize];
        // Validate: scaled positions strictly increase (two items never share a position; only a
        // rescale below 1/64 of the length can collapse a pair). `pos <= old - 1` scales below
        // `new`, so every item stays on the line.
        let mut prev: Option<i64> = None;
        let mut prev_last: Option<i64> = None;
        let mut cur = self.first(slot);
        while let Some(c) = cur {
            let r = self.get(c);
            let f = match prev_last {
                None => i64::from(r.gap),
                Some(p) => p + SP + i64::from(r.gap),
            };
            for k in 0..i64::from(r.count) {
                let s = Self::scaled(f + SP * k, new_len, rec.len);
                if prev.is_some_and(|p| s <= p) {
                    return Err(TransportError::NoRoom);
                }
                prev = Some(s);
            }
            prev_last = Some(f + SP * (i64::from(r.count) - 1));
            cur = self.next(c);
        }
        // Rebuild the runs in place: each old node is read, released, and its items appended at
        // their scaled positions (a released node is reused at once, so the arena never holds
        // more nodes than items).
        let mut cur = rec.head;
        {
            let l = &mut self.lines[slot as usize];
            l.head = NIL;
            l.tail = NIL;
            l.runs = 0;
            l.items = 0;
            l.jam_valid = false;
            l.squashed = false;
        }
        let mut prev_last: Option<i64> = None;
        while cur != NIL {
            let n = self.nodes[cur as usize];
            self.release_node(cur);
            let f = match prev_last {
                None => i64::from(n.run.gap),
                Some(p) => p + SP + i64::from(n.run.gap),
            };
            for k in 0..i64::from(n.run.count) {
                let s = Self::scaled(f + SP * k, new_len, rec.len);
                self.append_item(slot, n.run.item, s);
            }
            prev_last = Some(f + SP * (i64::from(n.run.count) - 1));
            cur = n.next;
        }
        self.lines[slot as usize].len = new_len;
        self.clear_geometry(slot);
        self.finish(slot);
        Ok(())
    }

    /// Appends one item at `pos` behind the line's tail (`pos > tail_pos`), merging into the back
    /// run when packed and the same kind; a gap under `SPACING` is kept negative (a squashed pair).
    /// The store-wide `items` is the caller's.
    fn append_item(&mut self, l: u32, item: u16, pos: i64) {
        let rec = self.lines[l as usize];
        if rec.head == NIL {
            self.push_back(
                l,
                Run {
                    item,
                    count: 1,
                    gap: pos as i32,
                },
            );
        } else {
            let gap = pos - i64::from(rec.tail_pos) - SP;
            debug_assert!(gap > -SP, "positions strictly increase");
            let back = self.get_mut(rec.tail);
            if gap == 0 && back.item == item && back.count < u16::MAX {
                back.count += 1;
            } else {
                self.push_back(
                    l,
                    Run {
                        item,
                        count: 1,
                        gap: gap as i32,
                    },
                );
                if gap < 0 {
                    self.lines[l as usize].squashed = true;
                }
            }
        }
        let rec = &mut self.lines[l as usize];
        rec.items += 1;
        rec.tail_pos = pos as u32;
    }
}
