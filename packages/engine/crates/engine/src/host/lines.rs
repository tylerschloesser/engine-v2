//! Line-structure routing (M46, docs/decisions/0078 §1, §4): which `LineStructs` records one
//! connection's frame carries. Versions, not acks (0064 §18): a line's version is the tick of its
//! last structure change (`Transport::structure_version`), and [`LineRoute::last_sent`] holds the
//! version this connection was sent, so a stale entry can only over-send.
//!
//! **Scope.** A connection holds a line while the line's chunk set (`TransportRead::chunks_of`)
//! meets a chunk it holds (`Pacing::held`, as this frame leaves it); a line without segments has
//! no chunk set and is never sent. The per-frame candidates are the only lines looked at, never a
//! scan over every line:
//! - the lines whose structure changed this tick (`Transport::structure_changes`);
//! - the lines entering a tile of a chunk that became held this frame (an enter, pristine or by
//!   snapshot, or a resume keep: `Transport::lines_entering`);
//! - the lines anchored in a chunk snapshotted this frame (`Transport::anchored_in`): *forced*,
//!   since the client drops a snapshotted chunk's anchored structures and takes them again from
//!   this frame (the snapshot's bucket cost includes their bytes, [`anchored_bytes`]);
//! - every line held, on a frame where a chunk leaves (the `Gone` check);
//! - the lines a previous frame deferred or could not send ([`LineRoute::pending`]).
//!
//! Only when the change list overflowed (a quarter of `max_lines` changes in one tick) does the
//! plan look at every line instead. A line whose path never enters a newly held chunk but whose
//! chunk set (tile boxes) names it is not found by the enter scan (`lines_entering`'s doc): it
//! arrives with its next change. Box and path agree for axis-aligned straights and arcs inside a
//! tile, a belt's shapes.
//!
//! **Order and budget.** Records go out ascending by id. Every `Gone` goes in the frame it is
//! decided (a few bytes each); puts share a per-frame byte budget, a quarter of the frame buffer
//! (`out.len() / PUT_BUDGET_DIVISOR`, halved per consecutive overflow like the chunk bucket's cap):
//! the chunk bucket may fill half a frame with snapshots, so a quarter leaves the other quarter for
//! deltas, results, presence and hashes, and at 65,536 B it is about 470 one-segment puts a frame
//! (34.9 B each, M48's input). The first put of a frame always fits, so a frame always makes
//! progress; the puts past the budget stay in [`LineRoute::pending`] and go out over the next
//! frames (a put of a line the client holds goes `Gone` instead, below). While a put is deferred whose line the client holds or whose anchor chunk
//! it holds, a chunk hash could see the stale structure: that frame carries no chunk hash
//! ([`LinePlan::hashes_unsafe`]). A frame that overflows anyway sends nothing: every candidate stays
//! pending (a resume keep's enter scan included: its chunks need no give-back, the client applies no
//! keep message).
//!
//! **Forecasts** (M47, 0078 A3, section 13): after the structures, [`plan_forecasts`] decides
//! this frame's `Forecasts` records from the tick's corrections (`Transport::forecast_messages`)
//! and hand-offs (`Transport::forecast_crossings`). A client holds a line's motion exactly while it
//! holds its structure, and only *continuously* held lines (held before this frame and kept, not
//! put afresh) are followed: a `State` goes to every connection that holds the line continuously;
//! a `RunList` rides every put of a line the client did not hold (and every forced put: the
//! snapshot dropped it), budgeted with the put, and goes as a correction to the continuous holders
//! within what the put budget leaves; a hand-off onto a held line that the client does not follow
//! itself (from a line it does not hold continuously, across a `Fork`, from a line resent this tick)
//! is an `Arrival`, unless the target's list is resent in the frame. `State`s and `Arrival`s are not
//! budgeted (a few bytes each, like `Gone`). What the budget cannot carry is never left stale on the
//! client: a held line whose correction or structure update does not fit is sent `Gone` and put
//! again (with its list) on a later frame, so a client never steps items under a model the host no
//! longer holds, nor feeds them on into lines it does hold. A frame that overflowed (sent nothing)
//! loses that tick's records and ops: the next frame sends `Gone` for every held line the lost
//! frame had an op (a put, a budget `Gone`, a `Drop`, a deferred update), a message or a record
//! for, plus one level of targets (the client stepped the lost tick without them): those lines'
//! held hand-off targets that tick, their current `Next` targets, and the old targets of `Next`
//! outputs that changed that tick (`Transport`'s per-tick log of `max_lines / 4` entries; when it
//! overflows, every held line is lost). Losses in a row keep adding to the set until a frame is
//! sent; then the lines are put again. No other line is touched ([`LineRoute::lost`]). 0078 §7's one-second rule needs no timer here: no forecast is ever left
//! dirty on a client.
//!
//! **A list larger than a frame** (M47 review, finding 1): a run list is not bounded like a
//! structure (16,384 items a line, about 196 KB). A put or correction whose list would not fit the
//! put budget of an empty frame (`out.len() / PUT_BUDGET_DIVISOR`) together with the line's
//! structure carries an `unknown` list instead (the same sum in every path, so a line never flips):
//! the client holds the structure and no items for it ([`LineRoute::unknown`]); every frame the
//! host prices the full list again and sends it, as a budgeted correction, once it fits. Every
//! list, a frame's first included, waits for the current budget (halved after an overflow); only a
//! bare first put always goes. So nothing admits more than a frame can hold.
//!
//! **Bounds.** Candidates are deduplicated as they are pushed: a live line by its store slot, a
//! destroyed one (which matters only if the connection holds it, for its `Gone`) by its index in
//! `last_sent`, each in a bitset reserved at attach. So `cands`, `ops` and `deferred` hold at most
//! the live lines plus the held lines, `2 x max_lines`, and never reallocate. A leave frame looks at
//! every held line (`chunks_of` each, O(held lines) per connection; M48 times it while panning).

use crate::bytes::CountSink;
use crate::transport::{LineId, Transport, TransportRead};
use crate::wire::lines::{write_gone, write_put};
use crate::world::{ChunkCoord, ChunkDims};

/// Puts may use at most `out.len() / PUT_BUDGET_DIVISOR` bytes of a frame (module doc).
pub const PUT_BUDGET_DIVISOR: usize = 4;

/// One connection's routing state (module doc).
#[derive(Default)]
pub struct LineRoute {
    /// `(line, version sent)`, ascending by line: what this connection holds.
    pub last_sent: Vec<(LineId, u32)>,
    /// Lines to look at again on the next frame.
    pub pending: Vec<LineId>,
    /// The lines whose records the last frame carried when it overflowed and was not sent (M47,
    /// module doc), ascending: the next frame sends them `Gone` and puts them again.
    pub lost: Vec<LineId>,
    /// Held lines whose items the client was told are unknown (an `unknown` list), ascending.
    pub unknown: Vec<LineId>,
    /// Lost frames whose plan sent a held line `Gone` for the budget (a test reads it: the two
    /// fell together).
    pub lost_with_budget_gones: u64,
}

impl LineRoute {
    /// Reserved at attach for the world's `max_lines` (0079 §5), so routing never allocates.
    pub fn with_capacity(max_lines: u32) -> Self {
        LineRoute {
            last_sent: Vec::with_capacity(max_lines as usize),
            pending: Vec::with_capacity(2 * max_lines as usize),
            lost: Vec::with_capacity(max_lines as usize),
            unknown: Vec::with_capacity(max_lines as usize),
            lost_with_budget_gones: 0,
        }
    }

    /// The version this connection holds of `line`, if any.
    pub fn sent(&self, line: LineId) -> Option<u32> {
        self.sent_at(line).map(|k| self.last_sent[k].1)
    }

    fn sent_at(&self, line: LineId) -> Option<usize> {
        self.last_sent.binary_search_by(|(l, _)| l.cmp(&line)).ok()
    }

    /// Commits a sent frame's records (`ops` ascending by line) in one pass over `last_sent`
    /// (M47 review, finding 2: a `Gone` per held line removed one by one was quadratic): the
    /// removals compacted out, the updates written in place, the new lines merged from the back.
    fn commit(&mut self, ops: &[(LineId, LineOp)]) {
        let removal = |op: LineOp| matches!(op, LineOp::Gone | LineOp::Drop);
        let mut k = 0;
        self.last_sent.retain(|&(l, _)| {
            while k < ops.len() && ops[k].0 < l {
                k += 1;
            }
            !(k < ops.len() && ops[k].0 == l && removal(ops[k].1))
        });
        let mut inserts = 0;
        for &(l, op) in ops {
            if let LineOp::Put { version, .. } = op {
                match self.last_sent.binary_search_by(|(x, _)| x.cmp(&l)) {
                    Ok(i) => self.last_sent[i].1 = version,
                    Err(_) => inserts += 1,
                }
            }
        }
        if inserts == 0 {
            return;
        }
        let old = self.last_sent.len();
        self.last_sent.resize(old + inserts, (LineId::NONE, 0));
        let (mut r, mut w) = (old, old + inserts);
        for &(l, op) in ops.iter().rev() {
            let LineOp::Put { version, .. } = op else {
                continue;
            };
            if self.last_sent[..r]
                .binary_search_by(|(x, _)| x.cmp(&l))
                .is_ok()
            {
                continue;
            }
            while r > 0 && self.last_sent[r - 1].0 > l {
                w -= 1;
                r -= 1;
                self.last_sent[w] = self.last_sent[r];
            }
            w -= 1;
            self.last_sent[w] = (l, version);
        }
    }

    fn is_unknown(&self, line: LineId) -> bool {
        self.unknown.binary_search(&line).is_ok()
    }

    /// Forgets everything (a new `Welcome` on this connection: the client emptied its replica).
    pub fn reset(&mut self) {
        self.last_sent.clear();
        self.pending.clear();
        self.lost.clear();
        self.unknown.clear();
    }
}

/// One record a frame carries.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LineOp {
    /// `fresh`: the client does not hold the line before this frame (a first put, or a forced one
    /// whose snapshot dropped it): its run list rides with it (M47).
    Put {
        version: u32,
        fresh: bool,
    },
    Gone,
    /// No record: the client already dropped the line (a snapshot of its anchor chunk) and its
    /// forced put did not fit; the host forgets it was sent (M47).
    Drop,
}

/// The host's reused per-frame scratch (one per host, every connection's frame in turn).
#[derive(Default)]
pub struct LinePlan {
    pub cands: Vec<LineId>,
    pub forced: Vec<LineId>,
    pub ops: Vec<(LineId, LineOp)>,
    pub deferred: Vec<LineId>,
    /// A deferred put leaves a structure the client holds, or one anchored in a chunk it holds,
    /// stale this frame: the frame carries no chunk hash (module doc).
    pub hashes_unsafe: bool,
    /// Put bytes (with their run lists) this frame.
    pub spent: usize,
    /// Held lines this plan sent `Gone` because their update or correction did not fit.
    pub budget_gones: u32,
    /// M47: this frame's section 13 (module doc): indices into `Transport::forecast_messages`,
    /// the lines whose run list goes (ascending; `true`: an `unknown` list), and
    /// `(line, pos, crossing index)` per arrival.
    pub states: Vec<u32>,
    pub run_lists: Vec<(LineId, bool)>,
    pub arrivals: Vec<(LineId, u32, u32)>,
    /// The put budget of an empty frame: no list larger than it is ever sent (module doc).
    pub full_budget: usize,
    /// A lost frame's record lines, before they are sorted into `LineRoute::lost`.
    lost_scratch: Vec<LineId>,
    /// Candidates seen this plan, by store slot (live lines) and by `last_sent` index (destroyed
    /// held lines); cleared through `cands` after each plan.
    seen_slot: Vec<u64>,
    seen_sent: Vec<u64>,
}

/// Grows `v` to hold `n` items' worth of capacity (setup time).
fn reserve_to<T>(v: &mut Vec<T>, n: usize) {
    if v.capacity() < n {
        v.reserve_exact(n - v.len());
    }
}

fn bit_test_set(bits: &mut Vec<u64>, i: usize) -> bool {
    let w = i / 64;
    if w >= bits.len() {
        // Only past the reservation (a decoded store larger than its caps): grows once.
        bits.resize(w + 1, 0);
    }
    let m = 1u64 << (i % 64);
    let was = bits[w] & m != 0;
    bits[w] |= m;
    was
}

fn bit_clear(bits: &mut [u64], i: usize) {
    if let Some(w) = bits.get_mut(i / 64) {
        *w &= !(1u64 << (i % 64));
    }
}

impl LinePlan {
    /// Reserved at attach for the world's `max_lines` (module doc's bounds).
    pub fn reserve(&mut self, max_lines: u32) {
        let n = 2 * max_lines as usize;
        reserve_to(&mut self.cands, n);
        reserve_to(&mut self.forced, max_lines as usize);
        reserve_to(&mut self.ops, n);
        reserve_to(&mut self.deferred, n);
        reserve_to(&mut self.states, max_lines as usize);
        reserve_to(&mut self.run_lists, n);
        reserve_to(&mut self.arrivals, max_lines as usize);
        reserve_to(&mut self.lost_scratch, 4 * max_lines as usize);
        let words = (max_lines as usize).div_ceil(64);
        if self.seen_slot.len() < words {
            self.seen_slot.resize(words, 0);
        }
        if self.seen_sent.len() < words {
            self.seen_sent.resize(words, 0);
        }
    }

    /// No record in section 12 (a `Drop` writes none).
    pub fn is_empty(&self) -> bool {
        self.ops.iter().all(|(_, op)| *op == LineOp::Drop)
    }

    /// No record in section 13.
    pub fn forecasts_empty(&self) -> bool {
        self.states.is_empty() && self.run_lists.is_empty() && self.arrivals.is_empty()
    }

    /// Whether this frame sends `line`'s run list, and whether it is `unknown`.
    fn run_list(&self, line: LineId) -> Option<bool> {
        self.run_lists
            .binary_search_by(|(l, _)| l.cmp(&line))
            .ok()
            .map(|k| self.run_lists[k].1)
    }

    fn op(&self, line: LineId) -> Option<LineOp> {
        self.ops
            .binary_search_by(|(l, _)| l.cmp(&line))
            .ok()
            .map(|k| self.ops[k].1)
    }

    /// Adds a `Gone` for `line` (held, its update or correction did not fit) and keeps it pending.
    fn gone(&mut self, line: LineId) {
        let k = self.ops.partition_point(|(l, _)| *l < line);
        if self.ops.get(k).is_some_and(|(l, _)| *l == line) {
            self.ops[k].1 = LineOp::Gone;
        } else {
            self.ops.insert(k, (line, LineOp::Gone));
        }
        self.deferred.push(line);
        self.hashes_unsafe = true;
        self.budget_gones += 1;
    }

    /// Adds `line` to the candidates once: a live line by slot, a destroyed one only if the
    /// connection holds it (by its `last_sent` index), else nothing to say about it.
    fn add(&mut self, t: &Transport, route: &LineRoute, line: LineId) {
        if let Some(s) = t.slot_of(line) {
            if !bit_test_set(&mut self.seen_slot, s as usize) {
                self.cands.push(line);
            }
        } else if let Some(k) = route.sent_at(line)
            && !bit_test_set(&mut self.seen_sent, k)
        {
            self.cands.push(line);
        }
    }

    /// Clears the bits `add` set (one pass over the candidates).
    fn clear_seen(&mut self, t: &Transport, route: &LineRoute) {
        for i in 0..self.cands.len() {
            let line = self.cands[i];
            match t.slot_of(line) {
                Some(s) => bit_clear(&mut self.seen_slot, s as usize),
                None => {
                    if let Some(k) = route.sent_at(line) {
                        bit_clear(&mut self.seen_sent, k);
                    }
                }
            }
        }
    }
}

/// What [`plan`] reads of the frame being built.
pub struct FrameChunks<'a> {
    /// The chunks the connection holds once this frame is applied, sorted `(y, x)`.
    pub held: &'a [(ChunkCoord, u8)],
    /// Chunks that became held this frame: enters, and resume keeps.
    pub entered: &'a [ChunkCoord],
    pub keeps: &'a [ChunkCoord],
    /// Chunks this frame snapshots (enters by snapshot and re-snapshots).
    pub snapshots: &'a [ChunkCoord],
    /// A chunk left this frame.
    pub any_left: bool,
}

fn held(chunks: &[(ChunkCoord, u8)], c: ChunkCoord) -> bool {
    chunks
        .binary_search_by(|(h, _)| (h.y, h.x).cmp(&(c.y, c.x)))
        .is_ok()
}

/// Decides this frame's records for one connection into `scratch.ops` (ascending by id) and the
/// lines left for the next frame into `scratch.deferred` (module doc), the puts within `budget`
/// bytes. Reads only the store and the connection's state: the bytes are a function of both.
pub fn plan(
    t: &Transport,
    dims: ChunkDims,
    route: &LineRoute,
    frame: &FrameChunks,
    (budget, full_budget): (usize, usize),
    scratch: &mut LinePlan,
) {
    scratch.cands.clear();
    scratch.forced.clear();
    scratch.ops.clear();
    scratch.deferred.clear();
    scratch.hashes_unsafe = false;
    scratch.spent = 0;
    scratch.budget_gones = 0;
    scratch.full_budget = full_budget;
    if !t.is_reserved() || (t.max_lines() == 0 && route.last_sent.is_empty()) {
        return;
    }
    // M47: the lines a lost frame's records named go and come again (module doc).
    for i in 0..route.lost.len() {
        scratch.add(t, route, route.lost[i]);
    }
    for i in 0..route.pending.len() {
        scratch.add(t, route, route.pending[i]);
    }
    let (changes, overflowed) = t.structure_changes();
    if overflowed {
        t.line_ids(&mut |l| scratch.add(t, route, l));
        for i in 0..route.last_sent.len() {
            scratch.add(t, route, route.last_sent[i].0);
        }
    } else {
        for &l in changes {
            scratch.add(t, route, l);
        }
    }
    for &c in frame.snapshots {
        // Each line is anchored in one chunk: no duplicates.
        let forced = &mut scratch.forced;
        t.anchored_in(c, dims, &mut |l| forced.push(l));
    }
    scratch.forced.sort_unstable();
    for i in 0..scratch.forced.len() {
        let l = scratch.forced[i];
        scratch.add(t, route, l);
    }
    for &c in frame.entered.iter().chain(frame.keeps) {
        t.lines_entering(c, dims, &mut |l| scratch.add(t, route, l));
    }
    if frame.any_left {
        for i in 0..route.last_sent.len() {
            scratch.add(t, route, route.last_sent[i].0);
        }
    }
    scratch.clear_seen(t, route);
    // In place, no allocation; ids are unique.
    scratch.cands.sort_unstable();

    let LinePlan {
        cands,
        forced,
        ops,
        deferred,
        hashes_unsafe,
        budget_gones,
        ..
    } = scratch;
    let mut spent = 0usize;
    for &line in cands.iter() {
        let sent = route.sent(line);
        if sent.is_some() && route.lost.binary_search(&line).is_ok() {
            ops.push((line, LineOp::Gone));
            deferred.push(line);
            *hashes_unsafe = true;
            continue;
        }
        let alive = t.has_segments(line);
        let mut meets = false;
        if alive {
            let _ = t.chunks_of(line, dims, &mut |c| meets |= held(frame.held, c));
        }
        if !alive || !meets {
            if sent.is_some() {
                ops.push((line, LineOp::Gone));
            }
            continue;
        }
        let version = t.structure_version(line).unwrap_or(0);
        let is_forced = forced.binary_search(&line).is_ok();
        if !is_forced && sent.is_some_and(|v| v >= version) {
            continue;
        }
        let fresh = sent.is_none() || is_forced;
        let mut count = CountSink::default();
        if let Ok(put) = t.structure(line) {
            write_put(&mut count, &put);
        }
        // M47: a put the client did not hold carries the line's run list; so does an update whose
        // correction this tick is a run list. A list larger than an empty frame's budget is sent
        // `unknown` (module doc; priced at its few bytes).
        // A put that does not fit by itself is deferred without pricing its list (a pending set
        // can be thousands of lines; their lists are counted only when they may go).
        let put_fits = spent == 0 || spent + count.0 <= budget;
        let mut with_list = false;
        if put_fits
            && (fresh
                || route.is_unknown(line)
                || t.forecast_message(line)
                    .is_some_and(|m| m.kind == crate::transport::MSG_RUN_LIST))
        {
            let list = t.run_list_bytes(line);
            // `unknown`: structure plus list against the empty frame's bound (`list_unknown`).
            if count.0 + list > full_budget {
                count.0 += UNKNOWN_LIST_BYTES;
            } else {
                count.0 += list;
                with_list = true;
            }
        }
        // The first put always goes, but one carrying a list only within the current budget
        // (review 2, finding 5: halved after an overflow, so a list between the halved and the
        // full bound waits until the budget recovers).
        let over = if spent > 0 {
            spent + count.0 > budget
        } else {
            with_list && count.0 > budget
        };
        if over {
            deferred.push(line);
            let anchor_held = t
                .anchor(line, dims)
                .ok()
                .flatten()
                .is_some_and(|a| held(frame.held, a));
            if sent.is_some() || anchor_held {
                *hashes_unsafe = true;
            }
            // M47: a held line is never left with a structure or motion the host no longer
            // holds (module doc): an update that does not fit goes `Gone`; a forced put that does
            // not fit was already dropped by the client's snapshot.
            if sent.is_some() {
                *budget_gones += u32::from(!is_forced);
                ops.push((
                    line,
                    if is_forced {
                        LineOp::Drop
                    } else {
                        LineOp::Gone
                    },
                ));
            }
            continue;
        }
        spent += count.0;
        ops.push((line, LineOp::Put { version, fresh }));
    }
    scratch.spent = spent;
}

/// The most bytes an `unknown` list takes (tag, a 5-byte line id, flags).
const UNKNOWN_LIST_BYTES: usize = 7;

/// Whether `line`'s run list goes `unknown`: its structure's put and its list together exceed an
/// empty frame's budget. Every path (`plan`'s puts, corrections, recovery) judges this same sum,
/// so a line never flips between known and `unknown` while neither changes (review 3, finding 3).
fn list_unknown(t: &Transport, line: LineId, full_budget: usize) -> bool {
    let mut put = CountSink::default();
    if let Ok(p) = t.structure(line) {
        write_put(&mut put, &p);
    }
    put.0 + t.run_list_bytes(line) > full_budget
}

/// Decides this frame's section 13 for one connection (module doc), after [`plan`]: within
/// `budget` bytes of puts and run lists together. A held line whose correction does not fit is
/// sent `Gone` instead (added to `scratch.ops`, kept pending); one larger than an empty frame's
/// budget goes `unknown`.
pub fn plan_forecasts(t: &Transport, route: &LineRoute, budget: usize, scratch: &mut LinePlan) {
    use crate::transport::{MSG_STATE, ROUTE_MERGE, ROUTE_NEXT};
    scratch.states.clear();
    scratch.run_lists.clear();
    scratch.arrivals.clear();
    if !t.is_reserved() || t.is_replica() {
        return;
    }
    let full_budget = scratch.full_budget;
    // Held before this frame and kept: the client follows the line's items itself (it holds
    // them: not `unknown`).
    let continuous = |s: &LinePlan, line: LineId| {
        route.sent(line).is_some()
            && !route.is_unknown(line)
            && matches!(s.op(line), None | Some(LineOp::Put { fresh: false, .. }))
    };
    // Lists riding a put: an update's correction, or a line the client did not hold.
    for i in 0..scratch.ops.len() {
        let (line, op) = scratch.ops[i];
        let LineOp::Put { fresh, .. } = op else {
            continue;
        };
        let correction = t
            .forecast_message(line)
            .is_some_and(|m| m.kind != MSG_STATE);
        if fresh || correction || route.is_unknown(line) {
            // Priced in `plan` the same way.
            let fits = !list_unknown(t, line, full_budget);
            scratch.run_lists.push((line, !fits));
        }
    }
    let msgs = t.forecast_messages();
    for (i, m) in msgs.iter().enumerate() {
        if !continuous(scratch, m.line) {
            continue;
        }
        if m.kind == MSG_STATE {
            scratch.states.push(i as u32);
            continue;
        }
        if matches!(scratch.op(m.line), Some(LineOp::Put { .. })) {
            // Its list rides the put (above).
            continue;
        }
        let cost = t.run_list_bytes(m.line);
        if list_unknown(t, m.line, full_budget) {
            scratch.spent += UNKNOWN_LIST_BYTES;
            scratch.run_lists.push((m.line, true));
        } else if scratch.spent + cost > budget {
            // Review 3, finding 2: even a frame's first list waits for the current budget
            // (halved after an overflow), as a put's does in `plan`.
            scratch.gone(m.line);
        } else {
            scratch.spent += cost;
            scratch.run_lists.push((m.line, false));
        }
    }
    // Lines whose items the client does not know: their full list as soon as it fits.
    for i in 0..route.unknown.len() {
        let line = route.unknown[i];
        if route.sent(line).is_none()
            || scratch.op(line).is_some()
            || scratch.run_lists.iter().any(|(l, _)| *l == line)
        {
            continue;
        }
        let cost = t.run_list_bytes(line);
        if !list_unknown(t, line, full_budget) && scratch.spent + cost <= budget {
            scratch.spent += cost;
            scratch.run_lists.push((line, false));
        }
    }
    scratch.run_lists.sort_unstable();
    let holds_after = |s: &LinePlan, line: LineId| match s.op(line) {
        Some(LineOp::Put { .. }) => true,
        Some(LineOp::Gone | LineOp::Drop) => false,
        None => route.sent(line).is_some(),
    };
    // The log is ascending by `(to, pos)`: the arrivals come out in wire order. O(the world's
    // hand-offs) per connection (M47 review, finding 9: recorded in the plan's Deviations).
    let crossings = t.forecast_crossings();
    for (k, c) in crossings.iter().enumerate() {
        if c.route() == ROUTE_MERGE {
            continue;
        }
        let to = LineId(c.to);
        if !holds_after(scratch, to) || scratch.run_list(to).is_some() || route.is_unknown(to) {
            continue;
        }
        let from = LineId(c.from);
        let followed = c.route() == ROUTE_NEXT
            && !c.resent()
            && continuous(scratch, from)
            && scratch.run_list(from).is_none();
        if !followed {
            scratch.arrivals.push((to, c.pos, k as u32));
        }
    }
}

/// Writes a planned frame's section 13 (pure: it runs twice).
pub fn write_forecasts(
    t: &Transport,
    scratch: &LinePlan,
    sink: &mut (impl crate::bytes::ByteSink + ?Sized),
) {
    use crate::wire::forecast as wf;
    let msgs = t.forecast_messages();
    for &i in &scratch.states {
        let m = msgs[i as usize];
        wf::write_state(
            sink,
            &wf::State {
                line: m.line,
                front_stop: (m.fs != wf::NO_STOP).then_some(m.fs),
                paused: m.paused,
                resumed: m.resumed,
            },
        );
    }
    let crossings = t.forecast_crossings();
    for &(line, pos, k) in &scratch.arrivals {
        let c = crossings[k as usize];
        wf::write_arrival(
            sink,
            &wf::Arrival {
                line,
                item: crate::transport::Item(c.item),
                pos,
                stop: (c.stop != wf::NO_STOP).then_some(c.stop),
            },
        );
    }
    for &(line, unknown) in &scratch.run_lists {
        if unknown {
            wf::write_run_list_unknown(sink, line);
        } else {
            t.write_run_list(line, sink);
        }
    }
}

/// Writes a planned frame's records (the `LineStructs` section body; pure, it runs twice).
pub fn write_section(
    t: &Transport,
    ops: &[(LineId, LineOp)],
    sink: &mut (impl crate::bytes::ByteSink + ?Sized),
) {
    for &(line, op) in ops {
        match op {
            LineOp::Put { .. } => {
                if let Ok(put) = t.structure(line) {
                    write_put(sink, &put);
                }
            }
            LineOp::Gone => write_gone(sink, line),
            LineOp::Drop => {}
        }
    }
}

/// After the frame: a sent frame commits its records and keeps the deferred lines pending; an
/// overflowed one (nothing sent) keeps every candidate pending and marks the lines its records
/// named lost (module doc).
pub fn finish(route: &mut LineRoute, scratch: &mut LinePlan, t: &Transport, sent: bool) {
    route.pending.clear();
    if sent {
        route.commit(&scratch.ops);
        route.pending.extend_from_slice(&scratch.deferred);
        route.lost.clear();
        // The client's unknown lines: gone ones forgotten, this frame's lists recorded.
        let ops = &scratch.ops;
        route.unknown.retain(|l| {
            !matches!(
                ops.binary_search_by(|(x, _)| x.cmp(l)).map(|k| ops[k].1),
                Ok(LineOp::Gone | LineOp::Drop)
            )
        });
        for &(line, unknown) in &scratch.run_lists {
            match (route.unknown.binary_search(&line), unknown) {
                (Err(k), true) => route.unknown.insert(k, line),
                (Ok(k), false) => {
                    route.unknown.remove(k);
                }
                _ => {}
            }
        }
        return;
    }
    route.pending.extend_from_slice(&scratch.cands);
    route.lost_with_budget_gones += u64::from(scratch.budget_gones > 0);
    // M47 (review 2, findings 2-3): tick `T`'s frame never reached the client, which will step `T`
    // under what it held before applying `T + 1`. Every held line `T` changed for it goes and
    // comes again: each line with an op in the lost plan (a put, a budget `Gone`, a `Drop`), a
    // message or a record this tick; then, one level on (enough: a line's own items move before
    // its landers, which do not move again in the tick), the held targets of their hand-offs at
    // `T`, their `Next` targets now and the old targets of `Next` outputs `T` changed (the client,
    // still holding the old output, stepped into those). If a changed output was not recorded,
    // every held line goes.
    let (old_next, old_next_full) = t.forecast_old_next();
    let lost = &mut scratch.lost_scratch;
    lost.clear();
    if old_next_full {
        lost.extend(route.last_sent.iter().map(|&(l, _)| l));
    } else {
        let held = |l: LineId| route.sent(l).is_some();
        let dedup = |v: &mut Vec<LineId>| {
            v.sort_unstable();
            v.dedup();
        };
        lost.extend(scratch.ops.iter().map(|&(l, _)| l).filter(|&l| held(l)));
        dedup(lost);
        lost.extend(
            t.forecast_messages()
                .iter()
                .map(|m| m.line)
                .filter(|&l| held(l)),
        );
        dedup(lost);
        lost.extend(
            scratch
                .run_lists
                .iter()
                .map(|&(l, _)| l)
                .filter(|&l| held(l)),
        );
        lost.extend(
            scratch
                .arrivals
                .iter()
                .map(|&(l, _, _)| l)
                .filter(|&l| held(l)),
        );
        dedup(lost);
        lost.extend(route.lost.iter().copied());
        dedup(lost);
        let named = lost.len();
        for c in t.forecast_crossings() {
            if lost[..named].binary_search(&LineId(c.from)).is_ok() && held(LineId(c.to)) {
                lost.push(LineId(c.to));
            }
        }
        for k in 0..named {
            if let Ok(crate::transport::Output::Next(to)) = t.out(lost[k])
                && held(to)
            {
                lost.push(to);
            }
        }
        for &(line, old) in old_next {
            if lost[..named].binary_search(&line).is_ok() && held(old) {
                lost.push(old);
            }
        }
        dedup(lost);
    }
    route.lost.clear();
    for &l in lost.iter() {
        if route.sent(l).is_some() && route.lost.len() < route.lost.capacity() {
            route.lost.push(l);
        }
    }
}

/// The bytes of the puts of every line anchored in `chunk` (a snapshot's bucket cost adds them:
/// they ride the snapshot's frame).
pub fn anchored_bytes(t: &Transport, chunk: ChunkCoord, dims: ChunkDims) -> u32 {
    let mut count = CountSink::default();
    t.anchored_in(chunk, dims, &mut |l| {
        if let Ok(put) = t.structure(l) {
            write_put(&mut count, &put);
        }
        // M47 review (finding 9): a forced put carries the line's list (priced once a tick).
        count.0 += t.run_list_bytes(l);
    });
    count.0 as u32
}
