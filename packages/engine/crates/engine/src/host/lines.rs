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
//! frames, never dropped. While a put is deferred whose line the client holds or whose anchor chunk
//! it holds, a chunk hash could see the stale structure: that frame carries no chunk hash
//! ([`LinePlan::hashes_unsafe`]). A frame that overflows anyway sends nothing: every candidate stays
//! pending (a resume keep's enter scan included: its chunks need no give-back, the client applies no
//! keep message).
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
}

impl LineRoute {
    /// Reserved at attach for the world's `max_lines` (0079 §5), so routing never allocates.
    pub fn with_capacity(max_lines: u32) -> Self {
        LineRoute {
            last_sent: Vec::with_capacity(max_lines as usize),
            pending: Vec::with_capacity(2 * max_lines as usize),
        }
    }

    /// The version this connection holds of `line`, if any.
    pub fn sent(&self, line: LineId) -> Option<u32> {
        self.sent_at(line).map(|k| self.last_sent[k].1)
    }

    fn sent_at(&self, line: LineId) -> Option<usize> {
        self.last_sent.binary_search_by(|(l, _)| l.cmp(&line)).ok()
    }

    /// Commits a sent frame's records (`version` of each put, `None` for a gone).
    fn commit(&mut self, line: LineId, version: Option<u32>) {
        match (
            self.last_sent.binary_search_by(|(l, _)| l.cmp(&line)),
            version,
        ) {
            (Ok(k), Some(v)) => self.last_sent[k].1 = v,
            (Ok(k), None) => {
                self.last_sent.remove(k);
            }
            (Err(k), Some(v)) => self.last_sent.insert(k, (line, v)),
            (Err(_), None) => {}
        }
    }

    /// Forgets everything (a new `Welcome` on this connection: the client emptied its replica).
    pub fn reset(&mut self) {
        self.last_sent.clear();
        self.pending.clear();
    }
}

/// One record a frame carries.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LineOp {
    Put { version: u32 },
    Gone,
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
        let words = (max_lines as usize).div_ceil(64);
        if self.seen_slot.len() < words {
            self.seen_slot.resize(words, 0);
        }
        if self.seen_sent.len() < words {
            self.seen_sent.resize(words, 0);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
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
    budget: usize,
    scratch: &mut LinePlan,
) {
    scratch.cands.clear();
    scratch.forced.clear();
    scratch.ops.clear();
    scratch.deferred.clear();
    scratch.hashes_unsafe = false;
    if !t.is_reserved() || (t.max_lines() == 0 && route.last_sent.is_empty()) {
        return;
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
        ..
    } = scratch;
    let mut spent = 0usize;
    for &line in cands.iter() {
        let sent = route.sent(line);
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
        let mut count = CountSink::default();
        if let Ok(put) = t.structure(line) {
            write_put(&mut count, &put);
        }
        if spent > 0 && spent + count.0 > budget {
            deferred.push(line);
            let anchor_held = t
                .anchor(line, dims)
                .ok()
                .flatten()
                .is_some_and(|a| held(frame.held, a));
            if sent.is_some() || anchor_held {
                *hashes_unsafe = true;
            }
            continue;
        }
        spent += count.0;
        ops.push((line, LineOp::Put { version }));
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
        }
    }
}

/// After the frame: a sent frame commits its records and keeps the deferred lines pending; an
/// overflowed one (nothing sent) keeps every candidate pending.
pub fn finish(route: &mut LineRoute, scratch: &LinePlan, sent: bool) {
    route.pending.clear();
    if sent {
        for &(line, op) in &scratch.ops {
            route.commit(
                line,
                match op {
                    LineOp::Put { version } => Some(version),
                    LineOp::Gone => None,
                },
            );
        }
        route.pending.extend_from_slice(&scratch.deferred);
    } else {
        route.pending.extend_from_slice(&scratch.cands);
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
    });
    count.0 as u32
}
