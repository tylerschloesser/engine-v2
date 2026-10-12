//! The host's forecast tracker (M47, docs/decisions/0078 A3, M41's spike written as production
//! code): it keeps, per line, the motion every client holding the line has been told (its
//! *model*), finds the ticks the line moves otherwise, and decides each correction. Derived state:
//! never encoded, never hashed, host only (a replica's store runs `follow.rs` instead); reserved
//! once at `set_caps` (0079 §5), nothing allocated after.
//!
//! **The model.** A line's items front to back as *segments*: `n` consecutive items whose stops
//! chain, item `k` of a segment stopping at `stop + SPACING x k` (`NONE`: free). Positions are not
//! stored: while the model holds, the store's positions are the model's. A client evaluates an item
//! as `max(pos - speed x t, stop)` from its last correction (0078 §2), following plain `Next` links
//! it holds.
//!
//! **Detection** (one comparison per front item, O(1) per hand-off, O(dirty) per tick). Within a
//! segment, if the front item moves as predicted every item behind it does (`max(x - v,
//! leader' + SPACING)` reduces to `max(x - v, stop)`), so `advance` checks only each line's front
//! steps ([`Tracker::front`]): a halt (moved less), a release (moved more). A segment behind
//! another whose stop is not the chain of the one ahead has a *due tick*, the first tick the two
//! predictions part (both are free motion until then), kept per line in an indexed min-heap; it
//! fires then unless the line was rebuilt first. Inserts, edits, structure changes and spawner
//! outcomes are observed directly. A line whose model cannot be trusted (an `insert_at`, a
//! `remove_at`, a surgery, a merge landing, a squashed pair, an unpredicted insert) is *invalid*:
//! its correction is a full run list.
//!
//! **The messages** (0078 A3 rules 1-5, decided at the end of the tick, [`Tracker::end_tick`]).
//! A dirty line's *`T - 1` list* is the items it held before this tick's advance (those that
//! crossed its front during `T` included) plus this tick's spawner inserts; never this tick's
//! landers. Its new stops are the cheap forecast's: [`Tracker::walk`] from the line's front along
//! `Next` links, at most [`MAX_DEPTH`] lines, to the first dead end (the front item `SPACING x
//! items ahead` behind it), sink (no stop), blocked merge or fork (as a dead end), or a line at the
//! horizon whose front held this tick (behind it). The message is a `State { front_stop = s0 -
//! SPACING x crossers }` when the client, re-stopping its `T - 1` list before it steps `T`, lands
//! every item exactly where the advance did: every blocked item sits at its new stop (blocked items
//! are packed behind a blocked front, so the front at `s0` covers them) and no free item's new stop
//! lies ahead of where it is. Otherwise, and for an invalid line, it is a `RunList`: the client
//! empties the line before it steps `T` and takes the whole list after.
//!
//! **Ownership** (rule 2): an item that crossed from `S` onto `L` during `T` belongs to `S`'s list
//! that tick; on `L` it keeps the stop `S`'s model gave it (re-stopped by `S`'s `State`), and joins
//! `L`'s model behind `L`'s own items with its own due tick. The client follows only plain `Next`
//! hand-offs between lines it holds; an item that enters a held line any other way (from a line it
//! does not hold, across a `Fork`, from a line replaced this tick) is an `Arrival` carrying the
//! model's stop, and a `Merge` landing invalidates its target (its list is resent).
//!
//! **Spawners.** `set_spawner` declares the schedule the game's tick rule follows ([`Schedule`]:
//! each tick `acc += 256`; at `acc >= period` an insert is attempted, a success takes `period` off
//! and steps the item, a refusal takes 256 off); the client replays it. A refusal the schedule did
//! not predict pauses it (a `State` with `paused`), the next success resumes it (`resumed`), any
//! other difference is a mismatch (counted, the line's list resent).

use super::line::NIL;
use super::{Item, LineId, Output, SPACING, Transport, TransportError};
use crate::bytes::ByteSink;
use crate::wire::forecast as wf;

/// No stop (free motion), in the model and in a run list.
pub(crate) const NONE: i32 = wf::NO_STOP;
const NEVER: u32 = u32::MAX;
/// The cheap forecast's horizon in lines (0078 A3: depth 8 left no line undecidable in M41).
pub const MAX_DEPTH: u32 = 8;
const SP: i64 = SPACING as i64;

/// A spawner's schedule as the game's tick rule follows it (module doc): the accumulator `acc`
/// gains 256 a tick; at `acc >= period` the game attempts `insert_back(next)`; a success takes
/// `period` off and steps `next` (`kinds == 0`: always the same item; else `next % kinds + 1`), a
/// refusal takes 256 off (the accumulator holds). Declared as it stands after this tick's step:
/// the tracker replays it from the next tick. The client's replay attempts the insert by
/// `insert_back`'s own landing rule against the tail it holds, so a refusal for room is predicted;
/// one for any other reason (the item cap) pauses the replay until the next success.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Schedule {
    pub period: u32,
    pub acc: u32,
    pub kinds: u16,
    pub next: Item,
}

impl Schedule {
    /// The item after `it` (module doc).
    pub fn cycle(&self, it: Item) -> Item {
        if self.kinds == 0 {
            it
        } else {
            Item(it.0 % self.kinds + 1)
        }
    }
}

/// A message kind.
pub const MSG_STATE: u8 = 0;
pub const MSG_RUN_LIST: u8 = 1;

/// One line's correction this tick (module doc), ascending by line in [`Tracker::msgs`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Msg {
    pub line: LineId,
    /// `front_stop` of a `State` (`NONE`: none).
    pub fs: i32,
    pub kind: u8,
    pub paused: bool,
    pub resumed: bool,
}

/// How an item crossed onto another line.
pub const ROUTE_NEXT: u8 = 0;
pub const ROUTE_FORK: u8 = 1;
pub const ROUTE_MERGE: u8 = 2;
/// Not a crossing: an `insert_back` on a line without a declared spawner (`from == to`), which
/// every holder gets as an `Arrival` at its position at the end of the tick.
pub const ROUTE_INSERT: u8 = 3;

/// One hand-off this tick (the host routes `Arrival`s from these): from `from` to `to` (store slots
/// during the tick; line ids once it ended, the log then ascending by `(to, pos)`), landing at
/// `pos`, its stop on `to` once the tick's messages are decided (`NONE`: free), its index among
/// `from`'s crossers this tick, its route (`ROUTE_*`) and whether `from`'s list was resent.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Crossing {
    pub from: u32,
    pub to: u32,
    pub pos: u32,
    pub stop: i32,
    pub item: u16,
    /// `j << 3 | resent << 2 | route`.
    jr: u16,
}

const JR_RESENT: u16 = 4;

impl Crossing {
    fn new(from: u32, to: u32, (item, pos): (u16, u32), stop: i32, j: u16, route: u8) -> Self {
        Crossing {
            from,
            to,
            pos,
            stop,
            item,
            jr: (j.min(0x1fff) << 3) | u16::from(route),
        }
    }

    pub fn route(&self) -> u8 {
        (self.jr & 3) as u8
    }

    pub fn j(&self) -> u16 {
        self.jr >> 3
    }

    /// The source's list was resent this tick (the client did not step its items).
    pub fn resent(&self) -> bool {
        self.jr & JR_RESENT != 0
    }
}

/// What [`Tracker::front`] says of a front item that crossed: its stop in its line's coordinates
/// and its index among the line's crossers this tick (`advance` hands both to the hand-off).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Crosser {
    pub stop: i32,
    pub j: u16,
}

/// Host-side counts since the store was reserved (tests and tools; not state).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct HostCounters {
    /// Front items that moved less than predicted (a halt) or more (a release).
    pub halts: u64,
    pub releases: u64,
    /// Segments whose due tick fired.
    pub dues: u64,
    /// Lines invalidated (edit, surgery, merge landing, squash, unpredicted insert).
    pub invalidations: u64,
    pub states: u64,
    pub run_lists: u64,
    /// Spawner outcomes the declared schedule did not predict (0078 A3: expected 0).
    pub spawner_mismatches: u64,
    /// Spawner declarations the tracker had no room for (its pool holds half the line cap).
    pub spawner_declarations_dropped: u64,
    pub pauses: u64,
    pub resumes: u64,
    /// Hand-offs the per-tick log had no room for (their target's list is resent).
    pub log_overflows: u64,
}

#[derive(Clone, Copy)]
struct Seg {
    n: u32,
    stop: i32,
    due: u32,
    next: u32,
}

// Per-tick facts (`Track::f`, valid while `stamp` is the tick in progress).
const F_BLOCKED: u8 = 1;
const F_FRONT: u8 = 2;
const F_STALLED: u8 = 4;
const F_EMPTIED: u8 = 8;
const F_CROSSED: u8 = 16;
const F_WAITING: u8 = 32;
// Until the end of the tick (`Track::sticky`).
const S_DIRTY: u8 = 1;
const S_INVALID: u8 = 2;
const S_PAUSED: u8 = 4;
const S_RESUMED: u8 = 8;

/// One line slot's tracker state.
#[derive(Clone, Copy)]
struct Track {
    head: u32,
    tail: u32,
    /// The earliest due tick of the line's segments and the line's place in the heap.
    due: u32,
    hpos: u32,
    /// Index into `scheds`, `NIL` without a spawner.
    sched: u32,
    stamp: u32,
    front_pos: i32,
    /// Over this tick's crossers `j`: `min(p_j - SPACING x j)`, `p_j` the crosser's position past
    /// the front (negative).
    cross_m: i32,
    /// The chain the line's last item left when its model emptied by crossings this tick.
    emptied: i32,
    cross_n: u16,
    land_n: u16,
    /// Inserts no declared schedule predicted this tick (each an `Arrival`).
    ins_n: u16,
    f: u8,
    sticky: u8,
}

impl Track {
    const EMPTY: Track = Track {
        head: NIL,
        tail: NIL,
        due: NEVER,
        hpos: NIL,
        sched: NIL,
        stamp: NEVER,
        front_pos: 0,
        cross_m: i32::MAX,
        emptied: NONE,
        cross_n: 0,
        land_n: 0,
        ins_n: 0,
        f: 0,
        sticky: 0,
    };
}

const OUT_NONE: u8 = 0;
const OUT_OK: u8 = 1;
/// Refused for room: the replay sees the same tail and refuses too.
const OUT_ROOM: u8 = 2;
/// Refused for another reason (the item cap): the replay cannot see it.
const OUT_REFUSED: u8 = 3;
const OUT_MULTI: u8 = 4;

#[derive(Clone, Copy)]
struct Sched {
    slot: u32,
    s: Schedule,
    paused: bool,
    /// Set at the start of every tick: a schedule declared during a tick is replayed from the next.
    armed: bool,
    outcome: u8,
    out_item: u16,
    out_stamp: u32,
}

/// The tracker (module doc). Every `Vec` is reserved in [`Tracker::reserve`].
#[derive(Default)]
pub(crate) struct Tracker {
    on: bool,
    /// Ticks completed (`end_tick` calls): the tracker's own clock, so a store advanced without
    /// `set_now` (a native test) keeps its per-tick facts apart.
    tick: u32,
    /// The previous tick's output (`msgs`, `cross`) is cleared by the first hook of the next.
    fresh: bool,
    tr: Vec<Track>,
    segs: Vec<Seg>,
    free_seg: u32,
    heap: Vec<u32>,
    dirty: Vec<u32>,
    msgs: Vec<Msg>,
    cross: Vec<Crossing>,
    cross_cap: usize,
    scheds: Vec<Sched>,
    pub counters: HostCounters,
    /// Debug builds: `Host::seal` ran since the last end of tick (`Tracker::sealed`).
    #[cfg(debug_assertions)]
    sealed: bool,
    /// Debug builds: a host seals this store's ticks (set by the first `sealed`).
    #[cfg(debug_assertions)]
    host_driven: bool,
    /// Tests: allocations of a model segment to refuse (`Transport::debug_fail_segment_allocs`).
    fail_allocs: u32,
    /// This tick's `Next` outputs that changed, `(line, the old target)` (review 2, finding 2: a
    /// client that missed the change stepped the line into the old target), and whether the
    /// list ran out of room (then a lost frame names every held line).
    old_next: Vec<(LineId, LineId)>,
    old_next_full: bool,
}

/// Bytes per line and per item the tracker reserves (`Transport::reserved_bytes`).
pub(crate) fn reserved_bytes(max_lines: u32, max_items: u32) -> u64 {
    use core::mem::size_of;
    let lines = u64::from(max_lines);
    let per_line = size_of::<Track>() // the track
        + size_of::<u32>() // the heap
        + size_of::<u32>() // the dirty list
        + size_of::<Msg>(); // the messages
    lines * per_line as u64
        + u64::from(half(max_lines)) * (size_of::<Crossing>() + size_of::<Sched>()) as u64
        + u64::from(max_lines.div_ceil(4)) * size_of::<(LineId, LineId)>() as u64
        + seg_cap(max_lines, max_items) * size_of::<Seg>() as u64
}

/// Hand-offs one tick logs (a saturated lane hands off 3 items in 8 ticks) and spawners declared:
/// half the line cap each.
fn half(max_lines: u32) -> u32 {
    max_lines.div_ceil(2)
}

/// Segments: one per line and a quarter of the items more (M41: a line holds one to three; a full
/// pool resends the line that needed one more, `Tracker::push_seg`).
fn seg_cap(max_lines: u32, max_items: u32) -> u64 {
    if max_items == 0 {
        0
    } else {
        u64::from(max_lines) + u64::from(max_items / 4) + 1
    }
}

fn reserve_to<T>(v: &mut Vec<T>, n: usize) {
    if v.capacity() < n {
        v.reserve_exact(n - v.len());
    }
}

/// `v` as a stop: out of `i32` range is no stop (an item that far away deviates in time, and the
/// deviation is detected then).
fn clamp_stop(v: i64) -> i32 {
    if v <= i64::from(i32::MIN) || v > i64::from(i32::MAX) {
        NONE
    } else {
        v as i32
    }
}

fn add_stop(stop: i32, d: i64) -> i32 {
    if stop == NONE {
        NONE
    } else {
        clamp_stop(i64::from(stop) + d)
    }
}

impl Tracker {
    /// Reserves for the caps and models every line the store already holds (a decoded world) as
    /// one segment with the cheap forecast's stop.
    pub fn reserve(&mut self, t: &Transport, max_lines: u32, max_items: u32) {
        self.on = true;
        self.free_seg = NIL;
        let lines = (max_lines as usize).max(t.lines.len());
        reserve_to(&mut self.tr, lines);
        reserve_to(&mut self.heap, lines);
        reserve_to(&mut self.dirty, lines);
        reserve_to(&mut self.msgs, lines);
        reserve_to(&mut self.old_next, (max_lines as usize).div_ceil(4));
        reserve_to(&mut self.scheds, half(max_lines) as usize);
        self.cross_cap = half(max_lines) as usize;
        reserve_to(&mut self.cross, self.cross_cap);
        let segs = (seg_cap(max_lines, max_items) as usize).max(t.index.len() + 1);
        reserve_to(&mut self.segs, segs);
        while self.tr.len() < t.lines.len() {
            self.tr.push(Track::EMPTY);
        }
        for k in 0..t.index.len() {
            let slot = t.index[k].1;
            let n = t.lines[slot as usize].items;
            if n > 0 {
                let s0 = self.walk(t, slot);
                self.push_seg(slot, n, s0, NEVER);
            }
        }
    }

    /// Bytes the reservation holds (`Transport::arena_bytes`).
    pub fn capacity_bytes(&self) -> usize {
        use core::mem::size_of;
        self.tr.capacity() * size_of::<Track>()
            + (self.heap.capacity() + self.dirty.capacity()) * size_of::<u32>()
            + self.msgs.capacity() * size_of::<Msg>()
            + self.old_next.capacity() * size_of::<(LineId, LineId)>()
            + self.scheds.capacity() * size_of::<Sched>()
            + self.cross.capacity() * size_of::<Crossing>()
            + self.segs.capacity() * size_of::<Seg>()
    }

    pub fn msgs(&self) -> &[Msg] {
        &self.msgs
    }

    pub fn msg(&self, line: LineId) -> Option<&Msg> {
        self.msgs
            .binary_search_by(|m| m.line.cmp(&line))
            .ok()
            .map(|k| &self.msgs[k])
    }

    /// The first hook of a tick clears the previous tick's output and arms the schedules.
    #[inline]
    fn begin(&mut self) {
        if self.fresh {
            // The tick's corrections are cleared here, by the next tick's first write: a host
            // must have built its frames (and sealed) in between (M47 review, finding 12).
            #[cfg(debug_assertions)]
            debug_assert!(
                !self.host_driven || self.sealed || (self.msgs.is_empty() && self.cross.is_empty()),
                "a tick's forecasts cleared before the host sealed its frames"
            );
            self.fresh = false;
            self.msgs.clear();
            self.cross.clear();
            self.old_next.clear();
            self.old_next_full = false;
            for s in self.scheds.iter_mut() {
                s.armed = true;
            }
        }
    }

    /// The slot's track, its per-tick facts reset when they are another tick's.
    #[inline]
    fn track(&mut self, slot: u32) -> &mut Track {
        let now = self.tick;
        let t = &mut self.tr[slot as usize];
        if t.stamp != now {
            t.stamp = now;
            t.f = 0;
            t.cross_n = 0;
            t.land_n = 0;
            t.ins_n = 0;
            t.cross_m = i32::MAX;
            t.emptied = NONE;
        }
        t
    }

    fn mark(&mut self, slot: u32, sticky: u8) {
        let t = &mut self.tr[slot as usize];
        if t.sticky & S_DIRTY == 0 && self.dirty.len() < self.dirty.capacity() {
            self.dirty.push(slot);
            t.sticky |= S_DIRTY;
        }
        t.sticky |= sticky;
    }

    // ---- segments ----

    fn alloc_seg(&mut self, s: Seg) -> Option<u32> {
        if self.fail_allocs > 0 {
            self.fail_allocs -= 1;
            return None;
        }
        if self.free_seg != NIL {
            let k = self.free_seg;
            self.free_seg = self.segs[k as usize].next;
            self.segs[k as usize] = s;
            Some(k)
        } else if self.segs.len() < self.segs.capacity() {
            self.segs.push(s);
            Some(self.segs.len() as u32 - 1)
        } else {
            None
        }
    }

    fn free_segs(&mut self, slot: u32) {
        let mut cur = self.tr[slot as usize].head;
        while cur != NIL {
            let nx = self.segs[cur as usize].next;
            self.segs[cur as usize].next = self.free_seg;
            self.free_seg = cur;
            cur = nx;
        }
        let t = &mut self.tr[slot as usize];
        t.head = NIL;
        t.tail = NIL;
        self.set_due(slot, NEVER);
    }

    fn push_seg(&mut self, slot: u32, n: u32, stop: i32, due: u32) {
        let Some(k) = self.alloc_seg(Seg {
            n,
            stop,
            due,
            next: NIL,
        }) else {
            // The pool is full: the line's list is resent (this tick's message, or the next tick's
            // for a lander placed after the messages; a run list empties the line on the client
            // before it steps, so nothing it holds follows the model meanwhile).
            self.invalidate(slot);
            return;
        };
        let t = &mut self.tr[slot as usize];
        if t.tail == NIL {
            t.head = k;
        } else {
            self.segs[t.tail as usize].next = k;
        }
        t.tail = k;
        if due != NEVER && due < self.tr[slot as usize].due {
            self.set_due(slot, due);
        }
    }

    /// The stop the next item at the slot's back takes from the chain (module doc of `follow.rs`:
    /// the client's rule for an insert): `SPACING` behind the last item's stop, none on an empty
    /// line.
    fn back_chain(&self, slot: u32) -> i32 {
        let t = &self.tr[slot as usize];
        if t.tail == NIL {
            return NONE;
        }
        let s = self.segs[t.tail as usize];
        add_stop(s.stop, SP * i64::from(s.n))
    }

    /// Appends an item at `pos` on the slot's back with stop `stop`: into the back segment when it
    /// is the chain, else as a segment with its due tick (module doc).
    fn append(&mut self, slot: u32, pos: u32, stop: i32, speed: u16, chain: i32) {
        let t = self.tr[slot as usize];
        if t.tail != NIL && stop == chain {
            self.segs[t.tail as usize].n += 1;
            return;
        }
        let due = if t.tail == NIL {
            // The line's front: the front check covers it.
            NEVER
        } else {
            let m = i64::from(stop.max(chain));
            let (x, v) = (i64::from(pos), i64::from(speed));
            let k = if x - v < m { 1 } else { (x - m) / v + 1 };
            self.tick
                .saturating_add(k.min(i64::from(u32::MAX / 2)) as u32)
        };
        self.push_seg(slot, 1, stop, due);
    }

    // ---- the due heap: one entry per line, keyed by `Track::due` ----

    fn set_due(&mut self, slot: u32, due: u32) {
        let hpos = self.tr[slot as usize].hpos;
        self.tr[slot as usize].due = due;
        if due == NEVER {
            if hpos != NIL {
                let last = self.heap.pop().expect("an entry");
                self.tr[slot as usize].hpos = NIL;
                if last != slot {
                    self.heap[hpos as usize] = last;
                    self.tr[last as usize].hpos = hpos;
                    self.sift(hpos as usize);
                }
            }
            return;
        }
        if hpos == NIL {
            if self.heap.len() == self.heap.capacity() {
                return;
            }
            self.heap.push(slot);
            let k = self.heap.len() - 1;
            self.tr[slot as usize].hpos = k as u32;
            self.sift(k);
        } else {
            self.sift(hpos as usize);
        }
    }

    fn key(&self, k: usize) -> u32 {
        self.tr[self.heap[k] as usize].due
    }

    fn swap(&mut self, a: usize, b: usize) {
        self.heap.swap(a, b);
        self.tr[self.heap[a] as usize].hpos = a as u32;
        self.tr[self.heap[b] as usize].hpos = b as u32;
    }

    fn sift(&mut self, mut k: usize) {
        while k > 0 && self.key((k - 1) / 2) > self.key(k) {
            self.swap(k, (k - 1) / 2);
            k = (k - 1) / 2;
        }
        loop {
            let (l, r) = (2 * k + 1, 2 * k + 2);
            let mut m = k;
            if l < self.heap.len() && self.key(l) < self.key(m) {
                m = l;
            }
            if r < self.heap.len() && self.key(r) < self.key(m) {
                m = r;
            }
            if m == k {
                return;
            }
            self.swap(k, m);
            k = m;
        }
    }

    // ---- hooks (the store calls them; each is a no-op while the tracker is off) ----

    /// A slot holds a new line (`create`; a reused slot keeps a pending dirty mark).
    pub fn create(&mut self, slot: u32) {
        if !self.on {
            return;
        }
        self.begin();
        while self.tr.len() <= slot as usize && self.tr.len() < self.tr.capacity() {
            self.tr.push(Track::EMPTY);
        }
        if slot as usize >= self.tr.len() {
            return;
        }
        self.drop_line(slot);
        let dirty = self.tr[slot as usize].sticky & S_DIRTY;
        self.tr[slot as usize] = Track::EMPTY;
        self.tr[slot as usize].sticky = dirty;
        self.mark(slot, S_INVALID);
    }

    /// The slot's line is gone (`destroy`, a `join`'s back line).
    pub fn destroy(&mut self, slot: u32) {
        if !self.on || slot as usize >= self.tr.len() {
            return;
        }
        self.begin();
        self.drop_line(slot);
    }

    fn drop_line(&mut self, slot: u32) {
        self.free_segs(slot);
        let k = self.tr[slot as usize].sched;
        if k != NIL {
            self.remove_sched(k);
        }
    }

    /// A structure change: `motion` (an output or a speed) can be told as a `State`; any other
    /// (a length, the items of a surgery) invalidates the line.
    pub fn structure(&mut self, slot: u32, motion: bool) {
        if !self.on || slot as usize >= self.tr.len() {
            return;
        }
        self.begin();
        if motion {
            self.mark(slot, 0);
        } else {
            self.invalidate(slot);
        }
    }

    /// A line's speed changed: one with a declared spawner is resent (its replay lands by the
    /// speed the frame's structure carries, the game's insert may have used the old one).
    pub fn spawner_speed_changed(&mut self, slot: u32) {
        if self.on && self.tr.get(slot as usize).is_some_and(|t| t.sched != NIL) {
            self.invalidate(slot);
        }
    }

    /// A line's `Next` output changed away from `old` this tick.
    pub fn next_changed(&mut self, line: LineId, old: LineId) {
        if !self.on {
            return;
        }
        self.begin();
        if self.old_next.len() < self.old_next.capacity() {
            self.old_next.push((line, old));
        } else {
            self.old_next_full = true;
        }
    }

    /// The line's model cannot be trusted this tick (module doc): it is resent whole.
    pub fn invalidate(&mut self, slot: u32) {
        if !self.on || slot as usize >= self.tr.len() {
            return;
        }
        self.begin();
        if self.tr[slot as usize].sticky & S_INVALID == 0 {
            self.counters.invalidations += 1;
        }
        self.mark(slot, S_INVALID);
    }

    /// An `insert_back` on the slot (`Ok`: it landed at `pos`). Records the spawner's outcome, and
    /// extends the model by the chain (the client's replay chains it the same way).
    pub fn insert_back(
        &mut self,
        slot: u32,
        r: Result<(), TransportError>,
        item: Item,
        pos: u32,
        speed: u16,
    ) {
        let ok = r.is_ok();
        if !self.on || slot as usize >= self.tr.len() {
            return;
        }
        self.begin();
        let now = self.tick;
        let k = self.tr[slot as usize].sched;
        let predicted = k != NIL && self.scheds[k as usize].armed;
        if k != NIL {
            let s = &mut self.scheds[k as usize];
            if s.out_stamp == now {
                s.outcome = OUT_MULTI;
            } else {
                s.out_stamp = now;
                s.outcome = match r {
                    Ok(()) => OUT_OK,
                    Err(TransportError::NoRoom) => OUT_ROOM,
                    Err(_) => OUT_REFUSED,
                };
                s.out_item = item.0;
            }
        }
        if ok {
            let chain = self.back_chain(slot);
            self.append(slot, pos, chain, speed, chain);
            if k == NIL {
                // No spawner declared: the item reaches every holder as an arrival (its position
                // and stop are filled in at the end of the tick).
                let t = self.track(slot);
                let j = t.ins_n;
                t.ins_n = t.ins_n.saturating_add(1);
                if self.cross.len() >= self.cross_cap || j == u16::MAX {
                    self.counters.log_overflows += 1;
                    self.invalidate(slot);
                } else {
                    self.cross.push(Crossing::new(
                        slot,
                        slot,
                        (item.0, 0),
                        NONE,
                        j,
                        ROUTE_INSERT,
                    ));
                }
            } else if !predicted {
                self.invalidate(slot);
            }
        }
    }

    /// One front step of the slot's line during `advance`: the item at `pos0` went to `p` (`< 0`:
    /// it crossed). Checks it against the model, records the tick's facts and, for a crosser,
    /// returns its stop in the line's coordinates and its index among this tick's crossers.
    pub fn front(&mut self, slot: u32, pos0: i64, p: i64, speed: u16) -> Crosser {
        if !self.on || slot as usize >= self.tr.len() {
            return Crosser { stop: NONE, j: 0 };
        }
        self.begin();
        let v = i64::from(speed);
        let invalid = self.tr[slot as usize].sticky & S_INVALID != 0;
        let head = self.tr[slot as usize].head;
        let t = self.track(slot);
        if p != pos0 - v {
            t.f |= F_BLOCKED;
        }
        let mut pend = NONE;
        if !invalid {
            if head == NIL {
                // Items the model does not hold: resent.
                self.invalidate(slot);
            } else {
                let s = self.segs[head as usize];
                let pred = if s.stop == NONE {
                    pos0 - v
                } else {
                    (pos0 - v).max(i64::from(s.stop))
                };
                if p != pred {
                    if p > pred {
                        self.counters.halts += 1;
                    } else {
                        self.counters.releases += 1;
                    }
                    self.mark(slot, 0);
                }
                if p < 0 {
                    pend = s.stop;
                    self.pop_front_item(slot);
                }
            }
        }
        let t = self.track(slot);
        if p < 0 {
            let j = t.cross_n;
            let m = (p - SP * i64::from(j)).max(i64::from(i32::MIN)) as i32;
            t.cross_m = t.cross_m.min(m);
            t.cross_n = t.cross_n.saturating_add(1);
            t.f |= F_CROSSED;
            t.f &= !F_STALLED;
            Crosser { stop: pend, j }
        } else {
            t.f |= F_FRONT;
            t.front_pos = p as i32;
            if p == pos0 && t.f & F_CROSSED == 0 {
                t.f |= F_STALLED;
            } else {
                t.f &= !F_STALLED;
            }
            if p == 0 && pos0 - v < 0 {
                t.f |= F_WAITING;
            } else {
                t.f &= !F_WAITING;
            }
            Crosser { stop: NONE, j: 0 }
        }
    }

    /// The model's first item crossed the front.
    fn pop_front_item(&mut self, slot: u32) {
        let head = self.tr[slot as usize].head;
        let s = &mut self.segs[head as usize];
        s.n -= 1;
        s.stop = add_stop(s.stop, SP);
        if s.n > 0 {
            return;
        }
        let (chain, next) = (s.stop, s.next);
        s.next = self.free_seg;
        self.free_seg = head;
        let t = &mut self.tr[slot as usize];
        t.head = next;
        if next == NIL {
            t.tail = NIL;
            let t = self.track(slot);
            t.f |= F_EMPTIED;
            t.emptied = chain;
        } else {
            // Now the line's front: the front check covers it.
            self.segs[next as usize].due = NEVER;
        }
    }

    /// An item crossed from `from` onto `to`, landing at `pos` (`pend`, `j`: [`Tracker::front`]'s).
    pub fn hand_off(&mut self, from: u32, to: u32, (item, pos): (u16, u32), c: Crosser, route: u8) {
        let Crosser { stop: pend, j } = c;
        if !self.on || to as usize >= self.tr.len() {
            return;
        }
        self.begin();
        if route == ROUTE_MERGE {
            // A landing in the middle of `to`: its list is resent (its items behind the landing
            // now stop behind one more item).
            self.invalidate(to);
        } else {
            let t = self.track(to);
            t.land_n = t.land_n.saturating_add(1);
        }
        if self.cross.len() >= self.cross_cap {
            self.counters.log_overflows += 1;
            self.invalidate(to);
            return;
        }
        self.cross
            .push(Crossing::new(from, to, (item, pos), pend, j, route));
    }

    /// `set_spawner` (module doc): declares or clears the slot's schedule; the line's list is
    /// resent (it carries the schedule).
    pub fn set_spawner(&mut self, slot: u32, s: Option<Schedule>) {
        if !self.on || slot as usize >= self.tr.len() {
            return;
        }
        self.begin();
        let k = self.tr[slot as usize].sched;
        match (s, k) {
            (Some(s), NIL) => {
                if self.scheds.len() == self.scheds.capacity() {
                    // Never a game-visible result (derived state): counted, and the line's
                    // inserts reach clients as arrivals.
                    self.counters.spawner_declarations_dropped += 1;
                    return;
                }
                self.scheds.push(Sched {
                    slot,
                    s,
                    paused: false,
                    armed: false,
                    outcome: OUT_NONE,
                    out_item: 0,
                    out_stamp: NEVER,
                });
                self.tr[slot as usize].sched = self.scheds.len() as u32 - 1;
            }
            (Some(s), k) => {
                let e = &mut self.scheds[k as usize];
                e.s = s;
                e.paused = false;
                e.armed = false;
            }
            (None, NIL) => return,
            (None, k) => self.remove_sched(k),
        }
        self.invalidate(slot);
    }

    fn remove_sched(&mut self, k: u32) {
        let slot = self.scheds[k as usize].slot;
        self.tr[slot as usize].sched = NIL;
        self.scheds.swap_remove(k as usize);
        if let Some(moved) = self.scheds.get(k as usize) {
            self.tr[moved.slot as usize].sched = k;
        }
    }

    /// How many segments the slot's model has, and how many items they cover.
    pub fn segments(&self, slot: u32) -> (u32, u32) {
        let (mut n, mut items) = (0, 0);
        let mut cur = self.tr.get(slot as usize).map_or(NIL, |t| t.head);
        while cur != NIL {
            n += 1;
            items += self.segs[cur as usize].n;
            cur = self.segs[cur as usize].next;
        }
        (n, items)
    }

    /// The slot's spawner as the client replays it (a run list carries it).
    pub fn spawner(&self, slot: u32) -> Option<wf::Spawner> {
        let k = *self.tr.get(slot as usize).map(|t| &t.sched)?;
        let e = self.scheds.get(k as usize)?;
        Some(wf::Spawner {
            period: e.s.period,
            acc: e.s.acc,
            kinds: e.s.kinds,
            next: e.s.next,
            paused: e.paused,
        })
    }

    // ---- the end of the tick ----

    /// The cheap forecast's stop for the slot's front item (module doc), in its coordinates.
    pub fn walk(&self, t: &Transport, slot: u32) -> i32 {
        self.walk_at(t, slot, self.tick)
    }

    /// [`Tracker::walk`] reading the per-tick facts of tick `now`.
    fn walk_at(&self, t: &Transport, slot: u32, now: u32) -> i32 {
        let fact = |x: u32, bit: u8| {
            self.tr
                .get(x as usize)
                .is_some_and(|tr| tr.stamp == now && tr.f & bit != 0)
        };
        let mut x = slot;
        let (mut off, mut ahead, mut depth) = (0i64, 0i64, 0u32);
        loop {
            let rec = &t.lines[x as usize];
            match rec.out {
                Output::DeadEnd => return clamp_stop(off + SP * ahead),
                Output::Sink => return NONE,
                Output::Merge { .. } | Output::Fork { .. } => {
                    return if rec.items > 0 && fact(x, F_FRONT) && fact(x, F_WAITING) {
                        clamp_stop(off + SP * ahead)
                    } else {
                        NONE
                    };
                }
                Output::Next(_) => {
                    if depth == MAX_DEPTH {
                        return if rec.items > 0 && fact(x, F_FRONT) && fact(x, F_STALLED) {
                            let fp = i64::from(self.tr[x as usize].front_pos);
                            clamp_stop(off + fp + SP * ahead)
                        } else {
                            NONE
                        };
                    }
                    let nx = rec.next_slot;
                    depth += 1;
                    off -= i64::from(t.lines[nx as usize].len);
                    ahead += i64::from(t.lines[nx as usize].items);
                    x = nx;
                }
            }
        }
    }

    /// After `advance`: fires the due segments, steps the spawners, decides every dirty line's
    /// message, rebuilds their models and places this tick's landers (module doc).
    pub fn end_tick(&mut self, t: &Transport) {
        if !self.on {
            return;
        }
        self.begin();
        let now = self.tick;
        // Due segments.
        while let Some(&slot) = self.heap.first() {
            if self.tr[slot as usize].due > now {
                break;
            }
            self.set_due(slot, NEVER);
            let head = self.tr[slot as usize].head;
            let mut fired = false;
            let mut next = NEVER;
            let mut cur = if head == NIL {
                NIL
            } else {
                self.segs[head as usize].next
            };
            while cur != NIL {
                let s = self.segs[cur as usize];
                if s.due <= now {
                    fired = true;
                } else {
                    next = next.min(s.due);
                }
                cur = s.next;
            }
            if fired {
                self.counters.dues += 1;
                self.mark(slot, 0);
            } else if next != NEVER {
                self.set_due(slot, next);
            }
        }
        // Spawners.
        for k in 0..self.scheds.len() {
            self.step_spawner(k);
        }
        // An undeclared insert that already crossed its line's front again this tick cannot arrive
        // there: its line's list is resent instead.
        for k in 0..self.cross.len() {
            let c = self.cross[k];
            if c.route() == ROUTE_INSERT {
                let tr = self.tr[c.to as usize];
                let on_line = t.lines[c.to as usize]
                    .items
                    .saturating_sub(u32::from(tr.land_n));
                if tr.stamp != now || on_line < u32::from(tr.ins_n) {
                    self.invalidate(c.to);
                }
            }
        }
        // Squashed lines cannot be followed by the formula.
        for i in 0..self.dirty.len() {
            let slot = self.dirty[i];
            if t.lines[slot as usize].id != LineId::NONE && t.lines[slot as usize].squashed {
                self.tr[slot as usize].sticky |= S_INVALID;
            }
        }
        // Messages.
        for i in 0..self.dirty.len() {
            let slot = self.dirty[i];
            let rec = &t.lines[slot as usize];
            if rec.id == LineId::NONE {
                continue;
            }
            let s0 = self.walk(t, slot);
            let (kind, fs) = self.classify(t, slot, s0);
            let sticky = self.tr[slot as usize].sticky;
            self.msgs.push(Msg {
                line: rec.id,
                fs,
                kind,
                paused: sticky & S_PAUSED != 0,
                resumed: sticky & S_RESUMED != 0,
            });
            if kind == MSG_STATE {
                self.counters.states += 1;
            } else {
                self.counters.run_lists += 1;
            }
            // The model from now: the line's items (all of them for a run list; for a state, all
            // but this tick's landers, which are placed below) on the new chain.
            let land_n = if self.tr[slot as usize].stamp == now {
                self.tr[slot as usize].land_n
            } else {
                0
            };
            let n = if kind == MSG_RUN_LIST {
                rec.items
            } else {
                rec.items.saturating_sub(u32::from(land_n))
            };
            self.free_segs(slot);
            if n > 0 {
                self.push_seg(slot, n, s0, NEVER);
            }
        }
        self.msgs.sort_unstable_by_key(|m| m.line);
        for i in 0..self.dirty.len() {
            let slot = self.dirty[i];
            self.tr[slot as usize].sticky = 0;
        }
        self.dirty.clear();
        // A rebuild the full pool refused (`push_seg` invalidated a line already in this tick's
        // dirty list, whose flags were just cleared): resent on the next tick (M47 review,
        // finding 10).
        for i in 0..self.msgs.len() {
            if let Some(slot) = t.slot(self.msgs[i].line)
                && self.tr[slot as usize].head == NIL
                && t.lines[slot as usize].items > 0
            {
                self.invalidate(slot);
            }
        }
        // Landers, in landing order (a full segment pool marks a line for the next tick).
        for k in 0..self.cross.len() {
            let c = self.cross[k];
            let to = &t.lines[c.to as usize];
            if c.route() == ROUTE_INSERT {
                if to.id != LineId::NONE && self.msg(to.id).is_none_or(|m| m.kind != MSG_RUN_LIST) {
                    let (pos, stop) = self.insert_at_end(t, c.to, c.j());
                    self.cross[k].pos = pos;
                    self.cross[k].stop = stop;
                }
                continue;
            }
            if c.route() == ROUTE_MERGE
                || to.id == LineId::NONE
                || self.msg(to.id).is_some_and(|m| m.kind == MSG_RUN_LIST)
            {
                continue;
            }
            let chain = self.lander_chain(t, c.to);
            let from = &t.lines[c.from as usize];
            let stop = if c.route() == ROUTE_FORK {
                chain
            } else {
                match self.msg(from.id) {
                    Some(m) if m.kind == MSG_RUN_LIST => chain,
                    Some(m) => add_stop(add_stop(m.fs, SP * i64::from(c.j())), i64::from(to.len)),
                    None => add_stop(c.stop, i64::from(to.len)),
                }
            };
            self.cross[k].stop = stop;
            self.append(c.to, c.pos, stop, to.speed, chain);
        }
        #[cfg(debug_assertions)]
        self.check_models(t);
        // For the routing (once per tick, not per connection): line ids, the resent flag, and the
        // log in the order the arrivals go on the wire.
        for k in 0..self.cross.len() {
            let c = &mut self.cross[k];
            let from = t.lines[c.from as usize].id;
            c.from = from.0;
            c.to = t.lines[c.to as usize].id.0;
            let resent = self
                .msgs
                .binary_search_by(|m| m.line.cmp(&from))
                .is_ok_and(|i| self.msgs[i].kind == MSG_RUN_LIST);
            if resent {
                c.jr |= JR_RESENT;
            }
        }
        self.cross.sort_unstable_by_key(|c| (c.to, c.pos));
        self.tick = self.tick.wrapping_add(1);
        self.fresh = true;
        #[cfg(debug_assertions)]
        {
            self.sealed = false;
        }
    }

    /// The host sealed the tick's frames (`Host::seal`, `Transport::forecast_sealed`).
    pub fn sealed(&mut self) {
        #[cfg(debug_assertions)]
        {
            self.sealed = true;
            self.host_driven = true;
        }
    }

    /// Where this tick's `j`-th undeclared insert on the slot is at the end of the tick, and its
    /// stop in the model: the line's items are its survivors, then this tick's inserts, then its
    /// landers.
    fn insert_at_end(&self, t: &Transport, slot: u32, j: u16) -> (u32, i32) {
        let tr = &self.tr[slot as usize];
        let rec = &t.lines[slot as usize];
        let mut back =
            u32::from(tr.land_n) + u32::from(tr.ins_n.saturating_sub(1).saturating_sub(j));
        // The position, walking the store's runs back from the rearmost item.
        let mut cur = rec.tail;
        let mut last = i64::from(rec.tail_pos);
        let mut pos = 0i64;
        while cur != NIL {
            let n = t.nodes[cur as usize];
            let count = u32::from(n.run.count);
            if back < count {
                pos = last - SP * i64::from(back);
                break;
            }
            back -= count;
            let first = last - SP * i64::from(count - 1);
            last = first - SP - i64::from(n.run.gap);
            cur = n.prev;
        }
        // The stop of that item (front index `i`) in the model.
        let behind = u32::from(tr.land_n) + u32::from(tr.ins_n.saturating_sub(1).saturating_sub(j));
        let i = rec.items.saturating_sub(1 + behind);
        let mut seg = tr.head;
        let mut at = 0u32;
        while seg != NIL {
            let s = self.segs[seg as usize];
            if i < at + s.n {
                return (pos as u32, add_stop(s.stop, SP * i64::from(i - at)));
            }
            at += s.n;
            seg = s.next;
        }
        (pos as u32, NONE)
    }

    /// The stop a lander placed now at the slot's back would chain to: behind the model's last
    /// item, or behind the last item that left it this tick (a state message re-stopped it).
    fn lander_chain(&self, t: &Transport, slot: u32) -> i32 {
        let tr = &self.tr[slot as usize];
        if tr.tail != NIL {
            return self.back_chain(slot);
        }
        if tr.stamp != self.tick || tr.f & F_EMPTIED == 0 {
            return NONE;
        }
        match self.msg(t.lines[slot as usize].id) {
            Some(m) => add_stop(m.fs, SP * i64::from(tr.cross_n)),
            None => tr.emptied,
        }
    }

    /// The message of a dirty line with front stop `s0` (module doc): `(kind, front_stop)`.
    fn classify(&self, t: &Transport, slot: u32, s0: i32) -> (u8, i32) {
        let tr = &self.tr[slot as usize];
        if tr.sticky & S_INVALID != 0 {
            return (MSG_RUN_LIST, NONE);
        }
        let facts = tr.stamp == self.tick;
        let (f, c, land_n) = if facts {
            (tr.f, tr.cross_n, tr.land_n)
        } else {
            (0, 0, 0)
        };
        let fs = add_stop(s0, -SP * i64::from(c));
        if s0 != NONE && fs == NONE {
            return (MSG_RUN_LIST, NONE);
        }
        if f & F_BLOCKED != 0 && !(s0 != NONE && f & F_FRONT != 0 && tr.front_pos == s0) {
            return (MSG_RUN_LIST, NONE);
        }
        if s0 != NONE {
            // No item's new stop lies ahead of where it is: the crossers ...
            if c > 0 && i64::from(s0) > i64::from(tr.cross_m) + SP * i64::from(c) {
                return (MSG_RUN_LIST, NONE);
            }
            // ... and the items still on the line (all but this tick's landers).
            let rec = &t.lines[slot as usize];
            let limit = rec.items.saturating_sub(u32::from(land_n));
            let mut idx = 0u32;
            let mut cur = rec.head;
            let mut prev_last: Option<i64> = None;
            while cur != NIL && idx < limit {
                let n = t.nodes[cur as usize];
                let first = match prev_last {
                    None => i64::from(n.run.gap),
                    Some(p) => p + SP + i64::from(n.run.gap),
                };
                if i64::from(s0) + SP * i64::from(idx) > first {
                    return (MSG_RUN_LIST, NONE);
                }
                idx += u32::from(n.run.count);
                prev_last = Some(first + SP * (i64::from(n.run.count) - 1));
                cur = n.next;
            }
        }
        (MSG_STATE, fs)
    }

    fn step_spawner(&mut self, k: usize) {
        let now = self.tick;
        let e = self.scheds[k];
        if !e.armed {
            return;
        }
        let out = if e.out_stamp == now {
            e.outcome
        } else {
            OUT_NONE
        };
        let mut s = e.s;
        s.acc = s.acc.saturating_add(256);
        let expected = s.acc >= s.period;
        let mut paused = e.paused;
        let mut sticky = 0;
        let mut mismatch = false;
        match (expected, out) {
            (true, OUT_OK) if e.out_item == s.next.0 => {
                if paused {
                    paused = false;
                    sticky = S_RESUMED;
                    self.counters.resumes += 1;
                }
                s.acc -= s.period;
                s.next = s.cycle(s.next);
            }
            (true, OUT_ROOM) => s.acc -= 256,
            (true, OUT_REFUSED) => {
                if !paused {
                    paused = true;
                    sticky = S_PAUSED;
                    self.counters.pauses += 1;
                }
                s.acc -= 256;
            }
            (false, OUT_NONE) => {}
            _ => {
                mismatch = true;
                // Keep the replay's own schedule (the resent list carries it); hold it like a
                // refusal so it cannot run ahead of the game.
                if expected {
                    s.acc -= 256;
                }
            }
        }
        let slot = e.slot;
        let e = &mut self.scheds[k];
        e.s = s;
        e.paused = paused;
        if mismatch {
            self.counters.spawner_mismatches += 1;
            self.invalidate(slot);
        } else if sticky != 0 {
            self.mark(slot, sticky);
        }
    }

    /// Debug builds: every model's segments add up to its line's items after the tick.
    #[cfg(debug_assertions)]
    fn check_models(&self, t: &Transport) {
        for i in 0..self.msgs.len() {
            if let Some(slot) = t.slot(self.msgs[i].line) {
                self.check_model(t, slot);
            }
        }
        for i in 0..self.cross.len() {
            let slot = self.cross[i].to;
            if t.lines[slot as usize].id != LineId::NONE {
                self.check_model(t, slot);
            }
        }
    }

    #[cfg(debug_assertions)]
    fn check_model(&self, t: &Transport, slot: u32) {
        if self.tr[slot as usize].sticky & S_INVALID != 0 {
            // A full pool left it for the next tick's run list.
            return;
        }
        let mut n = 0u32;
        let mut cur = self.tr[slot as usize].head;
        while cur != NIL {
            n += self.segs[cur as usize].n;
            cur = self.segs[cur as usize].next;
        }
        assert_eq!(
            n, t.lines[slot as usize].items,
            "forecast model of line {:?}",
            t.lines[slot as usize].id
        );
    }

    /// The slot's run list: the store's runs cut at the model's segment boundaries, each with its
    /// stop, `f` per run front to back.
    pub fn for_each_run(&self, t: &Transport, slot: u32, mut f: impl FnMut(wf::Run)) {
        let mut seg = self.tr.get(slot as usize).map_or(NIL, |tr| tr.head);
        let (mut seg_left, mut seg_at) = (0u32, 0u32);
        if seg != NIL {
            seg_left = self.segs[seg as usize].n;
        }
        let mut cur = t.lines[slot as usize].head;
        let mut prev_last: Option<i64> = None;
        while cur != NIL {
            let n = t.nodes[cur as usize];
            let first = match prev_last {
                None => i64::from(n.run.gap),
                Some(p) => p + SP + i64::from(n.run.gap),
            };
            prev_last = Some(first + SP * (i64::from(n.run.count) - 1));
            let mut left = u32::from(n.run.count);
            let mut pos = first;
            while left > 0 {
                let (take, stop) = if seg == NIL {
                    (left, NONE)
                } else {
                    let s = self.segs[seg as usize];
                    (left.min(seg_left), add_stop(s.stop, SP * i64::from(seg_at)))
                };
                f(wf::Run {
                    item: Item(n.run.item),
                    count: take as u16,
                    pos: pos as u32,
                    stop: (stop != NONE).then_some(stop),
                });
                pos += SP * i64::from(take);
                left -= take;
                if seg != NIL {
                    seg_left -= take;
                    seg_at += take;
                    if seg_left == 0 {
                        seg = self.segs[seg as usize].next;
                        seg_at = 0;
                        if seg != NIL {
                            seg_left = self.segs[seg as usize].n;
                        }
                    }
                }
            }
            cur = n.next;
        }
    }
}

impl Transport {
    /// This tick's corrections, ascending by line (the host routes them; M47).
    pub fn forecast_messages(&self) -> &[Msg] {
        self.fc.msgs()
    }

    /// The message of `line` this tick, if any.
    pub fn forecast_message(&self, line: LineId) -> Option<&Msg> {
        self.fc.msg(line)
    }

    /// This tick's hand-offs and undeclared inserts, ascending by `(to, pos)` ([`Crossing`]).
    pub fn forecast_crossings(&self) -> &[Crossing] {
        &self.fc.cross
    }

    /// `Host::seal`: every frame of the tick read its forecasts (debug builds check that the next
    /// tick does not clear them before this; M47 review, finding 12).
    pub fn forecast_sealed(&mut self) {
        self.fc.sealed();
    }

    /// Tests (M47 review, finding 10): the next `n` model segment allocations fail, as from a full
    /// pool.
    #[doc(hidden)]
    pub fn debug_fail_segment_allocs(&mut self, n: u32) {
        self.fc.fail_allocs = n;
    }

    /// Tests (M47 review 3): whether `line`'s model covers fewer items than the line holds (a full
    /// pool refused a lander).
    #[doc(hidden)]
    pub fn debug_forecast_short(&self, line: LineId) -> bool {
        self.slot(line)
            .is_some_and(|slot| self.fc.segments(slot).1 < self.lines[slot as usize].items)
    }

    /// This tick's changed `Next` outputs, `(line, old target)`, and whether some were not
    /// recorded (the host's lost-frame recovery reads them).
    pub fn forecast_old_next(&self) -> (&[(LineId, LineId)], bool) {
        (&self.fc.old_next, self.fc.old_next_full)
    }

    /// The host tracker's counters (tests and tools).
    pub fn forecast_host_counters(&self) -> HostCounters {
        self.fc.counters
    }

    /// Writes `line`'s `RunList` record (the model's runs and its spawner) into `sink`.
    pub fn write_run_list(&self, line: LineId, sink: &mut (impl ByteSink + ?Sized)) {
        let Some(slot) = self.slot(line) else {
            return;
        };
        let mut n = 0u32;
        self.fc.for_each_run(self, slot, |_| n += 1);
        let spawner = self.fc.spawner(slot);
        wf::write_run_list_header(sink, line, spawner.is_some(), n);
        self.fc
            .for_each_run(self, slot, |r| wf::write_run(sink, &r));
        if let Some(s) = spawner {
            wf::write_spawner(sink, &s);
        }
    }

    /// A bound on the bytes of `line`'s `RunList` record, never below what
    /// [`Transport::write_run_list`] writes, in O(the model's segments): the list cuts the store's
    /// runs at segment boundaries, so it has at most `runs + segments - 1` runs (M47 review,
    /// finding 9: the put budget and the chunk bucket price lists every frame; counting them
    /// exactly was a fifth of the bench's time).
    pub fn run_list_bytes(&self, line: LineId) -> usize {
        let Some(slot) = self.slot(line) else {
            return 0;
        };
        let (segs, covered) = self.fc.segments(slot);
        let rec = &self.lines[slot as usize];
        // A model short of the line's items (a full pool refused a lander) ends one more cut.
        let n = rec.runs + segs.saturating_sub(1) + u32::from(covered < rec.items);
        let varint = |v: u64| (64 - v.max(1).leading_zeros() as usize).div_ceil(7);
        let mut bytes = 1 + varint(u64::from(line.0)) + 1 + varint(u64::from(n)) + 12 * n as usize;
        if let Some(sp) = self.fc.spawner(slot) {
            bytes += varint(u64::from(sp.period)) + varint(u64::from(sp.acc)) + 2 + 2 + 1;
        }
        bytes
    }

    /// The stop the cheap forecast gives the line's front item now (tests).
    pub fn forecast_front_stop(&self, line: LineId) -> Option<Option<i32>> {
        let slot = self.slot(line)?;
        // Between ticks the per-tick facts are the last completed tick's.
        let now = if self.fc.fresh {
            self.fc.tick.wrapping_sub(1)
        } else {
            self.fc.tick
        };
        let s = self.fc.walk_at(self, slot, now);
        Some((s != NONE).then_some(s))
    }

    /// The model's stops of the line's items front to back (tests: the host's expectation).
    pub fn forecast_model(&self, line: LineId, f: &mut dyn FnMut(Item, u32, Option<i32>)) {
        let Some(slot) = self.slot(line) else {
            return;
        };
        self.fc.for_each_run(self, slot, |r| {
            for k in 0..u32::from(r.count) {
                f(
                    r.item,
                    r.pos + SPACING * k,
                    r.stop.map(|s| add_stop(s, SP * i64::from(k))),
                );
            }
        });
    }
}
