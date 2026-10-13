//! A line's record and the run store (0077 Amendment A6: B1). A line's items are a doubly linked
//! list of [`Run`]s in the transport's one node arena, front to back: a run's items sit exactly
//! `SPACING` apart, and `gap` is the free distance from its first item to the item ahead
//! (`pos - leader_pos - SPACING`; for the front run, its first item's position). A later run's
//! `gap` is negative for a squashed pair (M43: `rescale` and `join` keep them, 12 §3e; the squash
//! rule of `advance` resolves them), never below `1 - SPACING` (positions strictly increase), and
//! only on a line whose `squashed` flag is set. One exception, inside `advance` only (M44): a
//! landing across a cycle's cut may sit down to `-target.speed` behind the target's unmoved
//! rearmost item (even ahead of it, out of order) until the target's own walk resolves it; at the
//! end of `advance` every gap is above `-SPACING` (debug-asserted per line, `check_line`). Canonical form:
//! two adjacent runs merge when the rear one's gap is 0 and the item is the same, unless the merged
//! `count` would overflow `u16` (0077 A6b (ii)).
//!
//! The `jam` cursor (0077 A6): when valid, every run strictly between the front run and `jam` has
//! gap 0, so a stopped line skips them in O(1). `NIL` with `jam_valid` means "every run after the
//! front is packed". A mid-line insert or remove and any structure change invalidate it; it only
//! ever costs a re-walk. It is encoded (`codec.rs`), because a re-walk can merge a pair the cached
//! skip would leave, and a restored world must advance exactly like the live one.

use super::{LineId, Output, Schedule, Transport};

pub(super) const NIL: u32 = u32::MAX;
/// `Line::fresh_cap` with no landing across a cut this tick.
pub(super) const NO_CAP: u16 = u16::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(super) struct Run {
    pub item: u16,
    pub count: u16,
    /// Signed (module doc); `i32` because positions are below [`super::MAX_LEN`].
    pub gap: i32,
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Node {
    pub run: Run,
    pub next: u32,
    pub prev: u32,
}

/// One line's record. A free slot has `id == LineId::NONE` and `head` is the next free slot.
#[derive(Clone, Copy, Debug)]
pub(super) struct Line {
    pub id: LineId,
    pub len: u32,
    pub speed: u16,
    pub out: Output,
    /// The slot of `out`'s first target (`Next`'s, `Merge`'s line, `Fork`'s `a`; `NIL` otherwise),
    /// refreshed by `set_out`, the surgery redirects and decode.
    pub next_slot: u32,
    /// The slot of `Fork`'s `b` (`NIL` otherwise), kept like `next_slot` (M44).
    pub alt_slot: u32,
    /// A `Fork`'s preferred output (M44, 0076 §1): `false` is `a`. Sim state (encoded with the
    /// fork's output, `codec.rs`); always `false` on a line whose output is not a `Fork`.
    pub toggle: bool,
    pub head: u32,
    pub tail: u32,
    pub runs: u32,
    pub items: u32,
    /// Position of the rearmost item (meaningless when `items == 0`).
    pub tail_pos: u32,
    pub jam: u32,
    pub jam_valid: bool,
    pub sunk: u64,
    /// The front item held during the last `advance` (`Transport::jam`). Not state.
    pub held: bool,
    /// The epoch of the last change (`Transport::touched`). Not state.
    pub mark: u32,
    /// The epoch of the last `advance` that visited this line: a hand-off onto a line whose
    /// `adv_mark` is not the current epoch lands on a line that has not moved yet (a cycle cut).
    pub adv_mark: u32,
    /// Back runs made only of items that crossed a cycle cut onto this line this tick, before it
    /// advanced: they move at most `fresh_cap` more this tick (0079 §11). Zero outside `advance`.
    pub fresh_runs: u32,
    /// Runs landed by a `Merge` across a cycle cut in the middle of this line before it advanced
    /// (M44): each is a single item marked by `count == 0` (only inside `advance`), which this
    /// line's walk restores to 1 (it moves at most `fresh_cap`). Zero outside `advance`. A `u16`
    /// (it kept M44's record at 88 B): at `u16::MAX` such landings in one tick a further one is
    /// refused and waits (unreachable in practice: it needs 65,535 side-loads onto one line in a tick).
    pub fresh_mid: u16,
    /// How far this tick's cut landings may still move when this line advances (0079 §11 as
    /// amended in M44: an item moves at most `speed` in one tick): `speed - moved`, `moved` being
    /// what the item already moved on its feeder; 0 when two landings disagree; [`NO_CAP`] when
    /// none landed (a budget is below `u16::MAX`: `moved >= 1`). Only inside `advance`.
    pub fresh_cap: u16,
    /// The line may hold a negative gap (a squashed pair, M43): set by `rescale`, `join`, `split`
    /// and decode, cleared by an `advance` walk that saw none. Conservative and unobservable (the
    /// walk with it set reaches exactly the state the early exit reaches when no gap is negative),
    /// so it is not encoded.
    pub squashed: bool,
    /// The line's segments in the transport's segment pool (`geometry.rs`): the first record, or
    /// `NIL` with `seg_count == 0`.
    pub seg_start: u32,
    pub seg_count: u8,
    /// The line is in the store's structure-change list (`Transport::structure_changes`, M46),
    /// cleared by the drain: one entry per line per drain. Not state; it fills the record's one
    /// byte of padding.
    pub struct_queued: bool,
    /// The line's spawner schedule (M53, 0079 §21): sim state, encoded behind the `out` tag's
    /// `SCHEDULE` bit (`codec.rs`) and hashed with the store; `advance` runs it first thing
    /// (`Transport::step_schedules`). `None` on a line without one and always on a replica (the
    /// forecast's `RunList` carries it there).
    pub sched: Option<LineSched>,
}

/// A line's schedule as state (M53, 0079 §21): the game's [`Schedule`] as it stands after the last
/// step and `paused` while the item cap refuses it (the next success clears it). 13 B; the `paused`
/// flag gives the `Option` its niche, so the field is 16 B and the record grows by 16 B to 104 B.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct LineSched {
    pub s: Schedule,
    pub paused: bool,
}

impl Line {
    pub fn new(id: LineId, len: u32, speed: u16) -> Self {
        Line {
            id,
            len,
            speed,
            out: Output::DeadEnd,
            next_slot: NIL,
            alt_slot: NIL,
            toggle: false,
            head: NIL,
            tail: NIL,
            runs: 0,
            items: 0,
            tail_pos: 0,
            jam: NIL,
            jam_valid: false,
            sunk: 0,
            held: false,
            mark: 0,
            adv_mark: 0,
            fresh_runs: 0,
            fresh_mid: 0,
            fresh_cap: NO_CAP,
            squashed: false,
            seg_start: NIL,
            seg_count: 0,
            struct_queued: false,
            sched: None,
        }
    }

    /// The target slots 0079 §8's hand-off bound applies to (`target.len >= speed`): a `Next`'s and
    /// both of a `Fork`'s; `NIL` for none (a `Merge` landing is clamped instead).
    pub fn bound_targets(&self) -> [u32; 2] {
        match self.out {
            Output::Next(_) | Output::Fork { .. } => [self.next_slot, self.alt_slot],
            _ => [NIL, NIL],
        }
    }

    pub fn free(next_free: u32) -> Self {
        let mut l = Line::new(LineId::NONE, 0, 0);
        l.head = next_free;
        l
    }
}

#[inline]
pub(super) fn opt(n: u32) -> Option<u32> {
    (n != NIL).then_some(n)
}

/// The run store's list operations, per line slot `l` and node cursor `c`.
impl Transport {
    pub(super) fn alloc_node(&mut self, run: Run) -> u32 {
        let node = Node {
            run,
            next: NIL,
            prev: NIL,
        };
        if self.free_node != NIL {
            let n = self.free_node;
            self.free_node = self.nodes[n as usize].next;
            self.nodes[n as usize] = node;
            n
        } else {
            // Within the reserved capacity: the item cap bounds the runs (module doc of `mod.rs`).
            debug_assert!(
                (self.nodes.len() as u32) < self.node_cap,
                "transport run arena exhausted"
            );
            let n = self.nodes.len() as u32;
            self.nodes.push(node);
            n
        }
    }

    pub(super) fn release_node(&mut self, n: u32) {
        self.nodes[n as usize].next = self.free_node;
        self.free_node = n;
    }

    #[inline]
    pub(super) fn first(&self, l: u32) -> Option<u32> {
        opt(self.lines[l as usize].head)
    }

    #[inline]
    pub(super) fn next(&self, c: u32) -> Option<u32> {
        opt(self.nodes[c as usize].next)
    }

    #[inline]
    pub(super) fn prev(&self, c: u32) -> Option<u32> {
        opt(self.nodes[c as usize].prev)
    }

    #[inline]
    pub(super) fn get(&self, c: u32) -> Run {
        self.nodes[c as usize].run
    }

    #[inline]
    pub(super) fn get_mut(&mut self, c: u32) -> &mut Run {
        &mut self.nodes[c as usize].run
    }

    fn unlink(&mut self, l: u32, n: u32) {
        let Node { next, prev, .. } = self.nodes[n as usize];
        if prev == NIL {
            self.lines[l as usize].head = next;
        } else {
            self.nodes[prev as usize].next = next;
        }
        if next == NIL {
            self.lines[l as usize].tail = prev;
        } else {
            self.nodes[next as usize].prev = prev;
        }
        let line = &mut self.lines[l as usize];
        line.runs -= 1;
        if line.runs == 0 {
            line.jam_valid = false;
        }
        self.release_node(n);
    }

    pub(super) fn push_back(&mut self, l: u32, r: Run) {
        let n = self.alloc_node(r);
        let tail = self.lines[l as usize].tail;
        self.nodes[n as usize].prev = tail;
        if tail == NIL {
            self.lines[l as usize].head = n;
        } else {
            self.nodes[tail as usize].next = n;
        }
        let line = &mut self.lines[l as usize];
        line.tail = n;
        line.runs += 1;
        if line.jam_valid && line.jam == NIL {
            line.jam = n;
        }
    }

    pub(super) fn pop_front(&mut self, l: u32) {
        let h = self.lines[l as usize].head;
        let new_first = self.nodes[h as usize].next;
        if new_first != NIL {
            let after = self.nodes[new_first as usize].next;
            let line = &mut self.lines[l as usize];
            if line.jam_valid && line.jam == new_first {
                line.jam = after;
            }
        }
        self.unlink(l, h);
    }

    /// Removes `c` (never the front run); returns the run that followed it.
    pub(super) fn remove_run(&mut self, l: u32, c: u32) -> Option<u32> {
        let next = self.nodes[c as usize].next;
        let line = &mut self.lines[l as usize];
        if line.jam_valid && line.jam == c {
            line.jam = next;
        }
        self.unlink(l, c);
        opt(next)
    }

    /// Inserts `r` before `at` (`None`: at the back). Invalidates the line's `jam`.
    pub(super) fn insert_before(&mut self, l: u32, at: Option<u32>, r: Run) {
        self.lines[l as usize].jam_valid = false;
        let Some(at) = at else {
            self.push_back(l, r);
            return;
        };
        let n = self.alloc_node(r);
        let prev = self.nodes[at as usize].prev;
        self.nodes[n as usize].prev = prev;
        self.nodes[n as usize].next = at;
        self.nodes[at as usize].prev = n;
        if prev == NIL {
            self.lines[l as usize].head = n;
        } else {
            self.nodes[prev as usize].next = n;
        }
        self.lines[l as usize].runs += 1;
    }

    /// `None`: unknown. `Some(None)`: every run after the front is packed. `Some(Some(c))`: the
    /// walk of a stopped line resumes at `c`.
    #[inline]
    pub(super) fn jam_cursor(&self, l: u32) -> Option<Option<u32>> {
        let line = &self.lines[l as usize];
        line.jam_valid.then_some(opt(line.jam))
    }

    #[inline]
    pub(super) fn set_jam(&mut self, l: u32, j: Option<u32>) {
        let line = &mut self.lines[l as usize];
        line.jam = j.unwrap_or(NIL);
        line.jam_valid = true;
    }
}
