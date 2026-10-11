//! Candidate B of 0077 §1: gap-encoded runs. A line is a sequence of `Run { item, count, gap }`
//! front to back; a run's items sit exactly `SPACING` apart, and `gap` is the free distance from its
//! first item to the item ahead (`pos - leader - SPACING`; the first run: its first item's position).
//! Positions are prefix sums and are never stored. Canonical form: no two adjacent runs with gap 0
//! and the same item (they merge).
//!
//! Advance, per line: the front items one at a time while they cross (a hand-off or a sink takes
//! `count -= 1` off the front run, or the whole run); then the front run moves by `d0`, and each
//! later run by `d = min(speed, gap + d_prev)` (`gap += d_prev - d`). Once a run moves the full
//! `speed`, every run behind it does too with unchanged gaps, so the walk stops: a free line costs
//! O(1). A stopped front (`d0 == 0`) skips the packed runs behind it through a per-line cache
//! (`jam`: every run strictly between the front run and `jam` has gap 0), so a jammed line costs
//! O(1) as well; only the compression front, where moving runs meet stopped ones, is walked.
//!
//! The two stores differ only in where runs live: B1 a doubly linked list per line in one global
//! arena ([`Linked`]), B2 a per-line ring buffer carved from one array ([`Ring`], contiguous reads;
//! a mid-line insert or remove shifts the shorter side).
#![allow(dead_code)]

use super::repr::{Refused, Repr, SP, front_leader};
use super::world::{Item, LineIdx, LineSpec, Out, SPACING};
use engine::bytes::ByteSink;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Run {
    pub item: Item,
    pub count: u16,
    pub gap: u32,
}

/// Where a candidate keeps its runs. Cursors: a node index (B1) or a logical index from the front
/// (B2). The store keeps each line's `jam` cache valid under its own operations.
pub trait RunStore: Clone {
    type C: Copy + Eq + core::fmt::Debug;
    const NAME: &'static str;
    /// `caps[l]`: the most runs line `l` can ever hold.
    fn new(caps: &[u32]) -> Self;
    fn first(&self, l: LineIdx) -> Option<Self::C>;
    fn last(&self, l: LineIdx) -> Option<Self::C>;
    fn next(&self, l: LineIdx, c: Self::C) -> Option<Self::C>;
    fn prev(&self, l: LineIdx, c: Self::C) -> Option<Self::C>;
    fn get(&self, l: LineIdx, c: Self::C) -> Run;
    fn get_mut(&mut self, l: LineIdx, c: Self::C) -> &mut Run;
    fn runs(&self, l: LineIdx) -> u32;
    fn push_back(&mut self, l: LineIdx, r: Run);
    fn pop_front(&mut self, l: LineIdx);
    /// Removes `c` (never the first run); returns the cursor of the run that followed it.
    fn remove(&mut self, l: LineIdx, c: Self::C) -> Option<Self::C>;
    /// Inserts `r` before `at` (`None`: at the back). Invalidates the line's `jam`.
    fn insert_before(&mut self, l: LineIdx, at: Option<Self::C>, r: Run);
    /// `None`: unknown. `Some(None)`: every run after the front is packed. `Some(Some(c))`: the walk
    /// of a stopped line resumes at `c`.
    fn jam(&self, l: LineIdx) -> Option<Option<Self::C>>;
    fn set_jam(&mut self, l: LineIdx, j: Option<Self::C>);
    fn clear_jam(&mut self, l: LineIdx);
}

#[derive(Clone, Copy)]
struct Line {
    len: i32,
    speed: i32,
    out: Out,
    /// Position of the rearmost item (meaningless when `items == 0`).
    tail: i32,
    items: u32,
}

#[derive(Clone)]
pub struct ReprB<S: RunStore> {
    lines: Vec<Line>,
    s: S,
    sunk: u64,
}

impl<S: RunStore> ReprB<S> {
    /// Appends an item at `pos` (already `>= tail + SPACING`), merging into the back run.
    fn land(&mut self, l: LineIdx, item: Item, pos: i32) {
        let line = self.lines[l as usize];
        if line.items == 0 {
            self.s.push_back(
                l,
                Run {
                    item,
                    count: 1,
                    gap: pos as u32,
                },
            );
        } else {
            let gap = pos - line.tail - SP;
            debug_assert!(gap >= 0, "landing inside the spacing");
            let b = self.s.last(l).expect("items > 0");
            let back = self.s.get_mut(l, b);
            if gap == 0 && back.item == item && back.count < u16::MAX {
                back.count += 1;
            } else {
                self.s.push_back(
                    l,
                    Run {
                        item,
                        count: 1,
                        gap: gap as u32,
                    },
                );
            }
        }
        let line = &mut self.lines[l as usize];
        line.tail = pos;
        line.items += 1;
    }

    fn advance_line(&mut self, l: LineIdx) {
        let Some(mut h) = self.s.first(l) else {
            return;
        };
        let Line { speed, out, .. } = self.lines[l as usize];
        let target = match out {
            Out::Next(t) => {
                let tl = self.lines[t as usize];
                (tl.items > 0).then_some((tl.tail, tl.len))
            }
            _ => None,
        };
        let mut leader = front_leader(out, target);
        // The front items, one at a time while they cross.
        let d0 = loop {
            let r = self.s.get(l, h);
            let pos0 = r.gap as i32;
            let bound = leader + SP;
            let p = if pos0 < bound {
                pos0
            } else {
                (pos0 - speed).max(bound)
            };
            if p >= 0 {
                self.s.get_mut(l, h).gap = p as u32;
                break pos0 - p;
            }
            leader = p;
            match out {
                Out::Sink => self.sunk += 1,
                Out::Next(t) => {
                    let tlen = self.lines[t as usize].len;
                    self.land(t, r.item, tlen + p);
                }
                Out::DeadEnd => unreachable!("a dead end bounds p at 0"),
            }
            self.lines[l as usize].items -= 1;
            if r.count > 1 {
                let f = self.s.get_mut(l, h);
                f.count -= 1;
                f.gap = (pos0 + SP) as u32;
                continue;
            }
            match self.s.next(l, h) {
                None => {
                    self.s.pop_front(l);
                    return;
                }
                Some(n) => {
                    let next_pos = pos0 + SP + self.s.get(l, n).gap as i32;
                    self.s.pop_front(l);
                    h = self.s.first(l).expect("a run followed");
                    self.s.get_mut(l, h).gap = next_pos as u32;
                }
            }
        };
        // The runs behind the front run.
        let tracking = d0 == 0;
        let start = if tracking {
            match self.s.jam(l) {
                Some(j) => j,
                None => {
                    let j = self.s.next(l, h);
                    self.s.set_jam(l, j);
                    j
                }
            }
        } else {
            self.s.next(l, h)
        };
        let mut last_d = d0;
        let mut cur = start;
        let mut all_rest_at_speed = false;
        while let Some(c) = cur {
            if last_d == speed {
                all_rest_at_speed = true;
                break;
            }
            let r = self.s.get(l, c);
            let g = r.gap as i32 + last_d;
            let d = g.min(speed);
            let ng = g - d;
            last_d = d;
            if ng == 0 {
                let pc = self.s.prev(l, c).expect("never the front run");
                let pr = self.s.get(l, pc);
                if pr.item == r.item
                    && u32::from(pr.count) + u32::from(r.count) <= u32::from(u16::MAX)
                {
                    // Packed and the same item: merge (the store moves `jam` past `c` if it was there).
                    self.s.get_mut(l, pc).count += r.count;
                    cur = self.s.remove(l, c);
                    continue;
                }
                self.s.get_mut(l, c).gap = 0;
                let nx = self.s.next(l, c);
                if tracking && self.s.jam(l) == Some(Some(c)) {
                    self.s.set_jam(l, nx);
                }
                cur = nx;
            } else {
                self.s.get_mut(l, c).gap = ng as u32;
                cur = self.s.next(l, c);
            }
        }
        let moved = if all_rest_at_speed { speed } else { last_d };
        self.lines[l as usize].tail -= moved;
    }

    /// Absolute position of run `c`'s first item given the previous run's last item position.
    #[inline]
    fn first_pos(prev_last: Option<i32>, r: Run) -> i32 {
        match prev_last {
            None => r.gap as i32,
            Some(p) => p + SP + r.gap as i32,
        }
    }
}

impl<S: RunStore> Repr for ReprB<S> {
    const NAME: &'static str = S::NAME;

    fn build(specs: &[LineSpec]) -> Self {
        let caps: Vec<u32> = specs.iter().map(|s| s.len.div_ceil(SPACING)).collect();
        let mut r = ReprB {
            lines: specs
                .iter()
                .map(|s| Line {
                    len: s.len as i32,
                    speed: i32::from(s.speed),
                    out: s.out,
                    tail: 0,
                    items: 0,
                })
                .collect(),
            s: S::new(&caps),
            sunk: 0,
        };
        for (l, s) in specs.iter().enumerate() {
            for &(item, pos) in &s.items_at_rest {
                r.land(l as LineIdx, item, pos as i32);
            }
        }
        r
    }

    fn advance(&mut self, order: &[LineIdx]) {
        for &l in order {
            self.advance_line(l);
        }
    }

    fn insert_back(&mut self, l: LineIdx, item: Item) -> Result<(), Refused> {
        let line = self.lines[l as usize];
        let land = if line.items == 0 {
            line.len - line.speed
        } else {
            (line.len - line.speed).max(line.tail + SP)
        };
        if land > line.len - 1 {
            return Err(Refused::NoRoom);
        }
        self.land(l, item, land);
        Ok(())
    }

    fn insert_at(&mut self, l: LineIdx, pos: u32, item: Item) -> Result<(), Refused> {
        let line = self.lines[l as usize];
        let pos = pos as i32;
        if pos > line.len - 1 {
            return Err(Refused::NoRoom);
        }
        let mut prev: Option<S::C> = None;
        let mut prev_last: Option<i32> = None;
        let mut cur = self.s.first(l);
        while let Some(c) = cur {
            let r = self.s.get(l, c);
            let f = Self::first_pos(prev_last, r);
            if f > pos {
                break;
            }
            let last = f + SP * (i32::from(r.count) - 1);
            if pos <= last {
                return Err(Refused::NoRoom);
            }
            prev = Some(c);
            prev_last = Some(last);
            cur = self.s.next(l, c);
        }
        if prev_last.is_some_and(|pl| pos - pl < SP) {
            return Err(Refused::NoRoom);
        }
        let gap_new = match prev_last {
            None => pos,
            Some(pl) => pos - pl - SP,
        };
        let merge_prev = gap_new == 0 && prev.is_some_and(|p| self.s.get(l, p).item == item);
        match cur {
            None => {
                // At the back.
                if merge_prev {
                    self.s.get_mut(l, prev.unwrap()).count += 1;
                } else {
                    self.s.insert_before(
                        l,
                        None,
                        Run {
                            item,
                            count: 1,
                            gap: gap_new as u32,
                        },
                    );
                }
                self.lines[l as usize].tail = pos;
            }
            Some(c) => {
                let r = self.s.get(l, c);
                let f = Self::first_pos(prev_last, r);
                if f - pos < SP {
                    return Err(Refused::NoRoom);
                }
                let gap_succ = (f - pos - SP) as u32;
                self.s.get_mut(l, c).gap = gap_succ;
                let merge_succ = gap_succ == 0 && r.item == item;
                if merge_prev {
                    let p = prev.unwrap();
                    self.s.get_mut(l, p).count += 1;
                    if merge_succ {
                        self.s.get_mut(l, p).count += r.count;
                        self.s.remove(l, c);
                    }
                } else if merge_succ {
                    let s = self.s.get_mut(l, c);
                    s.count += 1;
                    s.gap = gap_new as u32;
                } else {
                    self.s.insert_before(
                        l,
                        Some(c),
                        Run {
                            item,
                            count: 1,
                            gap: gap_new as u32,
                        },
                    );
                }
            }
        }
        self.lines[l as usize].items += 1;
        self.s.clear_jam(l);
        Ok(())
    }

    fn remove_at(&mut self, l: LineIdx, pos: u32) -> Option<Item> {
        let pos = pos as i32;
        let mut prev_last: Option<i32> = None;
        let mut cur = self.s.first(l);
        let (c, k, r) = loop {
            let c = cur?;
            let r = self.s.get(l, c);
            let f = Self::first_pos(prev_last, r);
            if f > pos + SP / 2 {
                return None;
            }
            let last = f + SP * (i32::from(r.count) - 1);
            if last >= pos - SP / 2 {
                // Nearest item of this run, the front one on a tie.
                let k = if pos <= f {
                    0
                } else {
                    ((pos - f + SP / 2 - 1) / SP).min(i32::from(r.count) - 1)
                };
                if (f + SP * k - pos).abs() <= SP / 2 {
                    break (c, k as u16, r);
                }
            }
            prev_last = Some(last);
            cur = self.s.next(l, c);
        };
        let next = self.s.next(l, c);
        let is_first = prev_last.is_none();
        if r.count == 1 {
            match next {
                Some(n) => self.s.get_mut(l, n).gap += r.gap + SPACING,
                None => {
                    if let Some(pl) = prev_last {
                        self.lines[l as usize].tail = pl;
                    }
                }
            }
            if is_first {
                self.s.pop_front(l);
            } else {
                self.s.remove(l, c);
            }
        } else if k == 0 {
            let m = self.s.get_mut(l, c);
            m.count -= 1;
            m.gap += SPACING;
        } else if k == r.count - 1 {
            self.s.get_mut(l, c).count -= 1;
            match next {
                Some(n) => self.s.get_mut(l, n).gap += SPACING,
                None => self.lines[l as usize].tail -= SP,
            }
        } else {
            self.s.get_mut(l, c).count = k;
            self.s.insert_before(
                l,
                next,
                Run {
                    item: r.item,
                    count: r.count - k - 1,
                    gap: SPACING,
                },
            );
        }
        self.lines[l as usize].items -= 1;
        self.s.clear_jam(l);
        Some(r.item)
    }

    fn encode(&self, sink: &mut dyn ByteSink) {
        for l in 0..self.lines.len() as LineIdx {
            sink.put_varint(u64::from(self.s.runs(l)));
            let mut cur = self.s.first(l);
            while let Some(c) = cur {
                let r = self.s.get(l, c);
                sink.put_u16(r.item);
                sink.put_varint(u64::from(r.count));
                sink.put_varint(u64::from(r.gap));
                cur = self.s.next(l, c);
            }
        }
    }

    fn items(&self, l: LineIdx, out: &mut Vec<(Item, u32)>) {
        out.clear();
        let mut prev_last: Option<i32> = None;
        let mut cur = self.s.first(l);
        while let Some(c) = cur {
            let r = self.s.get(l, c);
            let f = Self::first_pos(prev_last, r);
            for k in 0..i32::from(r.count) {
                out.push((r.item, (f + SP * k) as u32));
            }
            prev_last = Some(f + SP * (i32::from(r.count) - 1));
            cur = self.s.next(l, c);
        }
    }

    fn sunk(&self) -> u64 {
        self.sunk
    }
}

// ---- B1: linked runs in one global arena ----

const NIL: u32 = u32::MAX;

#[derive(Clone, Copy, Default)]
struct Node {
    run: Run,
    next: u32,
    prev: u32,
}

#[derive(Clone, Copy)]
struct L1 {
    head: u32,
    tail: u32,
    runs: u32,
    /// `NIL`: the end. Meaningful only when `jam_valid`.
    jam: u32,
    jam_valid: bool,
}

#[derive(Clone)]
pub struct Linked {
    nodes: Vec<Node>,
    lines: Vec<L1>,
    free: u32,
}

#[inline]
fn opt(n: u32) -> Option<u32> {
    (n != NIL).then_some(n)
}

impl Linked {
    fn alloc(&mut self, run: Run) -> u32 {
        let n = self.free;
        assert!(n != NIL, "run arena full");
        self.free = self.nodes[n as usize].next;
        self.nodes[n as usize] = Node {
            run,
            next: NIL,
            prev: NIL,
        };
        n
    }

    fn release(&mut self, n: u32) {
        self.nodes[n as usize].next = self.free;
        self.free = n;
    }

    fn unlink(&mut self, l: LineIdx, n: u32) {
        let Node { next, prev, .. } = self.nodes[n as usize];
        let line = &mut self.lines[l as usize];
        if prev == NIL {
            line.head = next;
        } else {
            self.nodes[prev as usize].next = next;
        }
        if next == NIL {
            line.tail = prev;
        } else {
            self.nodes[next as usize].prev = prev;
        }
        line.runs -= 1;
        if line.runs == 0 {
            line.jam_valid = false;
        }
        self.release(n);
    }
}

impl RunStore for Linked {
    type C = u32;
    const NAME: &'static str = "B1";

    fn new(caps: &[u32]) -> Self {
        let cap: u32 = caps.iter().sum();
        let nodes = (0..cap)
            .map(|i| Node {
                run: Run::default(),
                next: if i + 1 < cap { i + 1 } else { NIL },
                prev: NIL,
            })
            .collect();
        Linked {
            nodes,
            lines: vec![
                L1 {
                    head: NIL,
                    tail: NIL,
                    runs: 0,
                    jam: NIL,
                    jam_valid: false,
                };
                caps.len()
            ],
            free: if cap > 0 { 0 } else { NIL },
        }
    }

    #[inline]
    fn first(&self, l: LineIdx) -> Option<u32> {
        opt(self.lines[l as usize].head)
    }
    #[inline]
    fn last(&self, l: LineIdx) -> Option<u32> {
        opt(self.lines[l as usize].tail)
    }
    #[inline]
    fn next(&self, _l: LineIdx, c: u32) -> Option<u32> {
        opt(self.nodes[c as usize].next)
    }
    #[inline]
    fn prev(&self, _l: LineIdx, c: u32) -> Option<u32> {
        opt(self.nodes[c as usize].prev)
    }
    #[inline]
    fn get(&self, _l: LineIdx, c: u32) -> Run {
        self.nodes[c as usize].run
    }
    #[inline]
    fn get_mut(&mut self, _l: LineIdx, c: u32) -> &mut Run {
        &mut self.nodes[c as usize].run
    }
    fn runs(&self, l: LineIdx) -> u32 {
        self.lines[l as usize].runs
    }

    fn push_back(&mut self, l: LineIdx, r: Run) {
        let n = self.alloc(r);
        let line = &mut self.lines[l as usize];
        let tail = line.tail;
        self.nodes[n as usize].prev = tail;
        if tail == NIL {
            line.head = n;
        } else {
            self.nodes[tail as usize].next = n;
        }
        line.tail = n;
        line.runs += 1;
        if line.jam_valid && line.jam == NIL {
            line.jam = n;
        }
    }

    fn pop_front(&mut self, l: LineIdx) {
        let h = self.lines[l as usize].head;
        let new_first = self.nodes[h as usize].next;
        let line = &mut self.lines[l as usize];
        if line.jam_valid && new_first != NIL && line.jam == new_first {
            line.jam = self.nodes[new_first as usize].next;
        }
        self.unlink(l, h);
    }

    fn remove(&mut self, l: LineIdx, c: u32) -> Option<u32> {
        let next = self.nodes[c as usize].next;
        let line = &mut self.lines[l as usize];
        if line.jam_valid && line.jam == c {
            line.jam = next;
        }
        self.unlink(l, c);
        opt(next)
    }

    fn insert_before(&mut self, l: LineIdx, at: Option<u32>, r: Run) {
        self.lines[l as usize].jam_valid = false;
        let Some(at) = at else {
            self.push_back(l, r);
            return;
        };
        let n = self.alloc(r);
        let prev = self.nodes[at as usize].prev;
        self.nodes[n as usize].prev = prev;
        self.nodes[n as usize].next = at;
        self.nodes[at as usize].prev = n;
        let line = &mut self.lines[l as usize];
        if prev == NIL {
            line.head = n;
        } else {
            self.nodes[prev as usize].next = n;
        }
        line.runs += 1;
    }

    fn jam(&self, l: LineIdx) -> Option<Option<u32>> {
        let line = &self.lines[l as usize];
        line.jam_valid.then_some(opt(line.jam))
    }
    fn set_jam(&mut self, l: LineIdx, j: Option<u32>) {
        let line = &mut self.lines[l as usize];
        line.jam = j.unwrap_or(NIL);
        line.jam_valid = true;
    }
    fn clear_jam(&mut self, l: LineIdx) {
        self.lines[l as usize].jam_valid = false;
    }
}

// ---- B2: a ring buffer per line, carved from one array ----

#[derive(Clone, Copy)]
struct L2 {
    base: u32,
    mask: u32,
    head: u32,
    runs: u32,
    /// Logical index; `>= runs` is the end. Meaningful only when `jam_valid`.
    jam: u32,
    jam_valid: bool,
}

#[derive(Clone)]
pub struct Ring {
    slots: Vec<Run>,
    lines: Vec<L2>,
}

impl Ring {
    #[inline]
    fn slot(&self, l: LineIdx, i: u32) -> usize {
        let line = &self.lines[l as usize];
        (line.base + ((line.head + i) & line.mask)) as usize
    }
}

impl RunStore for Ring {
    type C = u32;
    const NAME: &'static str = "B2";

    fn new(caps: &[u32]) -> Self {
        let mut base = 0u32;
        let lines = caps
            .iter()
            .map(|&c| {
                let size = c.max(1).next_power_of_two();
                let line = L2 {
                    base,
                    mask: size - 1,
                    head: 0,
                    runs: 0,
                    jam: 0,
                    jam_valid: false,
                };
                base += size;
                line
            })
            .collect();
        Ring {
            slots: vec![Run::default(); base as usize],
            lines,
        }
    }

    #[inline]
    fn first(&self, l: LineIdx) -> Option<u32> {
        (self.lines[l as usize].runs > 0).then_some(0)
    }
    #[inline]
    fn last(&self, l: LineIdx) -> Option<u32> {
        self.lines[l as usize].runs.checked_sub(1)
    }
    #[inline]
    fn next(&self, l: LineIdx, c: u32) -> Option<u32> {
        (c + 1 < self.lines[l as usize].runs).then_some(c + 1)
    }
    #[inline]
    fn prev(&self, _l: LineIdx, c: u32) -> Option<u32> {
        c.checked_sub(1)
    }
    #[inline]
    fn get(&self, l: LineIdx, c: u32) -> Run {
        self.slots[self.slot(l, c)]
    }
    #[inline]
    fn get_mut(&mut self, l: LineIdx, c: u32) -> &mut Run {
        let s = self.slot(l, c);
        &mut self.slots[s]
    }
    fn runs(&self, l: LineIdx) -> u32 {
        self.lines[l as usize].runs
    }

    fn push_back(&mut self, l: LineIdx, r: Run) {
        let line = self.lines[l as usize];
        assert!(line.runs <= line.mask, "run ring full");
        let s = self.slot(l, line.runs);
        self.slots[s] = r;
        self.lines[l as usize].runs += 1;
    }

    fn pop_front(&mut self, l: LineIdx) {
        let line = &mut self.lines[l as usize];
        line.head = (line.head + 1) & line.mask;
        line.runs -= 1;
        line.jam = line.jam.saturating_sub(1).max(1);
        if line.runs == 0 {
            line.jam_valid = false;
        }
    }

    fn remove(&mut self, l: LineIdx, c: u32) -> Option<u32> {
        let runs = self.lines[l as usize].runs;
        if c < runs - 1 - c {
            // Shift the front side back by one.
            for i in (0..c).rev() {
                let (from, to) = (self.slot(l, i), self.slot(l, i + 1));
                self.slots[to] = self.slots[from];
            }
            let line = &mut self.lines[l as usize];
            line.head = (line.head + 1) & line.mask;
        } else {
            for i in c..runs - 1 {
                let (from, to) = (self.slot(l, i + 1), self.slot(l, i));
                self.slots[to] = self.slots[from];
            }
        }
        let line = &mut self.lines[l as usize];
        line.runs -= 1;
        if line.jam > c {
            line.jam -= 1;
        }
        if line.runs == 0 {
            line.jam_valid = false;
        }
        (c < line.runs).then_some(c)
    }

    fn insert_before(&mut self, l: LineIdx, at: Option<u32>, r: Run) {
        let line = self.lines[l as usize];
        assert!(line.runs <= line.mask, "run ring full");
        let at = at.unwrap_or(line.runs);
        if at < line.runs - at {
            // Grow toward the front: the runs ahead of `at` move one slot forward.
            let ln = &mut self.lines[l as usize];
            ln.head = (ln.head + ln.mask) & ln.mask;
            for i in 0..at {
                let (from, to) = (self.slot(l, i + 1), self.slot(l, i));
                self.slots[to] = self.slots[from];
            }
        } else {
            for i in (at..line.runs).rev() {
                let (from, to) = (self.slot(l, i), self.slot(l, i + 1));
                self.slots[to] = self.slots[from];
            }
        }
        let s = self.slot(l, at);
        self.slots[s] = r;
        let ln = &mut self.lines[l as usize];
        ln.runs += 1;
        ln.jam_valid = false;
    }

    fn jam(&self, l: LineIdx) -> Option<Option<u32>> {
        let line = &self.lines[l as usize];
        line.jam_valid
            .then_some((line.jam < line.runs).then_some(line.jam))
    }
    fn set_jam(&mut self, l: LineIdx, j: Option<u32>) {
        let line = &mut self.lines[l as usize];
        line.jam = j.unwrap_or(line.runs);
        line.jam_valid = true;
    }
    fn clear_jam(&mut self, l: LineIdx) {
        self.lines[l as usize].jam_valid = false;
    }
}

pub type ReprB1 = ReprB<Linked>;
pub type ReprB2 = ReprB<Ring>;
