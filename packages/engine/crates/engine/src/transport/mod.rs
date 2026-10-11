//! `engine::transport` (docs/decisions/0076-transport-lines-engine-game-split.md, M42): generic
//! transport lines as sim state in `Store<G>`. A line is one lane: `len` positions (1/256 tile),
//! a `speed` in positions per tick, an [`Output`], and its items front to back. Position 0 is the
//! front (exit); items move toward it; the occupiable domain is `[0, len - 1]`. Items are opaque
//! [`Item`] ids at least [`SPACING`] apart on a line.
//!
//! The store is 0077 Amendment A6's B1 shape (`line.rs`): `Run { item, count, gap }` nodes in one
//! arena reserved from `max_items` (a run holds at least one item, so `max_items` nodes bound every
//! line), a doubly linked list per line, a per-line `jam` cursor, canonical merged form; positions
//! are prefix sums and never stored. The per-tick rule is `advance.rs` (0076 §2, the M40 rule
//! cases), the update order `order.rs` (reverse topological, a cycle cut at its lowest id), the
//! encoding `codec.rs` (ascending `LineId`).
//!
//! Writes are host-tick only (0076 §6): `WorldWrite::transport_mut()` is `Ok` from `TickCx`,
//! `genesis` and `migrate`, `Err(Unknown)` in `apply`/`on_player` and under prediction. This store
//! is the one part of `Store` not mutated through `Delta` (0076 §7): `advance` and the surgery API
//! mutate it directly on the host.
//!
//! M42 scope: `create`, `destroy` (removes a line and hands back its items; feeders of the
//! destroyed line become `DeadEnd`; the full surgery semantics are M43), `set_out` (`DeadEnd`,
//! `Next`, `Sink`; `Merge`/`Fork` are refused with [`TransportError::Unsupported`] until M44, as is
//! `Next` into the line itself), `set_speed`, `insert_back`, and `insert_at`/`remove_at` (0076 §3's
//! inserter primitives, pulled forward from M43 because M40's rule table drives them).

mod advance;
mod codec;
mod line;
mod order;

use crate::game::Unknown;

use line::{Line, NIL, Node};

/// 0076 §1: the minimum distance between two items on one line and across a plain hand-off (4
/// items per tile per lane). An engine constant; the run representation relies on it.
pub const SPACING: u32 = 64;

/// 0076 §8: the default line cap (`WorldParams::max_lines`, `WorldConfig.params.maxLines`).
pub const DEFAULT_MAX_LINES: u32 = 32_768;
/// 0076 §8: the default item cap (`WorldParams::max_items`, `WorldConfig.params.maxItems`).
pub const DEFAULT_MAX_ITEMS: u32 = 262_144;

/// A line id (0076 §1): host-allocated from 1, monotonic, never reused; `0` is none.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default)]
pub struct LineId(pub u32);

impl LineId {
    pub const NONE: LineId = LineId(0);
}

/// An item kind, opaque to the engine (0076 §1); `0` is reserved for "none".
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Item(pub u16);

/// What the front of a line feeds (0076 §1). M42 runs `DeadEnd`, `Next` and `Sink`; `Merge` and
/// `Fork` exist for the shape of the API and are refused by `set_out` until M44.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Output {
    DeadEnd,
    /// A plain hand-off: lane preserved, position continues (landing `target.len - overshoot`).
    Next(LineId),
    /// A side-load onto `line` at position `at` (M44).
    Merge {
        line: LineId,
        at: u32,
    },
    /// Alternates items between `a` and `b` (M44).
    Fork {
        a: LineId,
        b: LineId,
    },
    /// Deletes the item and counts it on the line.
    Sink,
}

/// Every refusal of the transport API. Tick rules handle `Full` and `NoRoom` (a spawner waits);
/// the rest are caller bugs reported as values, never panics.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TransportError {
    /// The line cap (`create`) or the item cap (`insert_*`) is reached (0076 §8).
    Full,
    /// No room on the line: `insert_back` would land past `len - 1`, or `insert_at` lacks
    /// `SPACING` clear on either side.
    NoRoom,
    /// `speed` is 0 or not below `len` (0076 §1: `1 <= speed < len`), or a `Next` target shorter
    /// than the feeder's `speed` (`set_out`, `set_speed`: a hand-off must land inside the target).
    BadSpeed,
    /// The line (or an output's target) does not exist.
    NoLine,
    /// `Item(0)` ("none") cannot be placed on a line.
    BadItem,
    /// Not in M42: a `Merge`/`Fork` output (M44) or a `Next` into the line itself.
    Unsupported,
    /// `set_caps` after the arena was reserved, with other caps (0079 §5: reserved once).
    CapsFixed,
}

pub use TransportError::{BadSpeed, Full, NoRoom};

/// The read side every `WorldRead` context answers (0076 §1, M42 Seams). A line this context does
/// not hold is `Err(Unknown)`: on the host that is a line that does not exist; on a client replica
/// (empty until M46) every line.
pub trait TransportRead {
    /// Lines that exist.
    fn lines_len(&self) -> u32;
    fn len(&self, line: LineId) -> Result<u32, Unknown>;
    fn speed(&self, line: LineId) -> Result<u16, Unknown>;
    fn out(&self, line: LineId) -> Result<Output, Unknown>;
    /// Items on the line.
    fn count(&self, line: LineId) -> Result<u32, Unknown>;
    /// The front item and its position, if any.
    fn front(&self, line: LineId) -> Result<Option<(Item, u32)>, Unknown>;
    /// Every item front to back with its computed position (tests and tools: O(items)).
    fn items_in(&self, line: LineId, f: &mut dyn FnMut(Item, u32)) -> Result<(), Unknown>;
    /// Items this line's `Sink` has deleted so far.
    fn sunk(&self, line: LineId) -> Result<u64, Unknown>;
}

/// The write side (0076 §3, M42's part), host tick only (0076 §6).
pub trait TransportWrite: TransportRead {
    /// A new line with no items and a `DeadEnd` output. `Err(Full)` at `max_lines`,
    /// `Err(BadSpeed)` unless `1 <= speed < len`.
    fn create(&mut self, len: u32, speed: u16) -> Result<LineId, TransportError>;
    /// Removes the line, handing its items to `f` front to back; lines that fed it become
    /// `DeadEnd`. M43 owns the full surgery semantics.
    fn destroy(&mut self, line: LineId, f: &mut dyn FnMut(Item)) -> Result<(), TransportError>;
    fn set_out(&mut self, line: LineId, out: Output) -> Result<(), TransportError>;
    fn set_speed(&mut self, line: LineId, speed: u16) -> Result<(), TransportError>;
    /// A spawner's primitive: lands at `max(len - speed, tail + SPACING)`, refused (`NoRoom`) past
    /// `len - 1`; `Err(Full)` at `max_items`. Checks spacing on this line only (0077 A6b (i)).
    /// Called from `G::tick`, it lands *before* that tick's `advance`, which then moves the item:
    /// at the end of the tick an item inserted this tick sits at `len - 2 x speed` (it entered one
    /// tick's travel inside the back edge and then moved), and on a `Sink` line with
    /// `len < 2 x speed` it sinks the same tick (legal, and the count is conserved).
    fn insert_back(&mut self, line: LineId, item: Item) -> Result<(), TransportError>;
    /// An inserter's primitive: `SPACING` clear on both sides on this line, `pos <= len - 1`.
    fn insert_at(&mut self, line: LineId, pos: u32, item: Item) -> Result<(), TransportError>;
    /// The nearest item within `SPACING / 2` of `pos` (the front one on a tie), if any.
    fn remove_at(&mut self, line: LineId, pos: u32) -> Result<Option<Item>, TransportError>;
}

/// The read side of a context that holds no transport state (a `WorldRead` implementor that does
/// not override `transport()`): no lines, every read `Unknown`.
pub struct NoTransport;

impl TransportRead for NoTransport {
    fn lines_len(&self) -> u32 {
        0
    }
    fn len(&self, _line: LineId) -> Result<u32, Unknown> {
        Err(Unknown)
    }
    fn speed(&self, _line: LineId) -> Result<u16, Unknown> {
        Err(Unknown)
    }
    fn out(&self, _line: LineId) -> Result<Output, Unknown> {
        Err(Unknown)
    }
    fn count(&self, _line: LineId) -> Result<u32, Unknown> {
        Err(Unknown)
    }
    fn front(&self, _line: LineId) -> Result<Option<(Item, u32)>, Unknown> {
        Err(Unknown)
    }
    fn items_in(&self, _line: LineId, _f: &mut dyn FnMut(Item, u32)) -> Result<(), Unknown> {
        Err(Unknown)
    }
    fn sunk(&self, _line: LineId) -> Result<u64, Unknown> {
        Err(Unknown)
    }
}

/// The transport store (module doc). Every `Vec` is reserved once, by [`Transport::set_caps`] when
/// the world params arrive, and only ever pushed within that capacity, so `advance` and the API
/// allocate nothing per tick.
pub struct Transport {
    max_lines: u32,
    max_items: u32,
    /// Whether [`Transport::set_caps`] has run: the arena is reserved exactly once (0079 §5).
    reserved: bool,
    /// Line records by slot; a destroyed line's slot (`id == NONE`) is reused through `free_line`.
    lines: Vec<Line>,
    free_line: u32,
    /// `(id, slot)` ascending by id: the id lookup and the encoding order.
    index: Vec<(LineId, u32)>,
    next_id: u32,
    /// The run arena (B1): `max_items + 1` nodes (one spare: a hand-off lands its run before the
    /// feeder's run is released).
    nodes: Vec<Node>,
    node_cap: u32,
    free_node: u32,
    /// Items on every line together (the `max_items` check).
    items: u32,
    /// Slots in update order; recomputed by `advance` when `graph_dirty`.
    order: Vec<u32>,
    graph_dirty: bool,
    scratch: order::Scratch,
    /// `touched` bookkeeping (M47 reads it): a line is touched when its `mark` equals the epoch of
    /// the last `advance`; `advance` also stamps each line it visits with `epoch` (`adv_mark`), so
    /// a hand-off knows whether its target has moved this tick. Not state: never encoded or hashed.
    epoch: u32,
    advanced_epoch: u32,
    /// Something changed since the last [`Transport::take_changed`] (a write through the API or an
    /// `advance` that moved, landed, sank or merged): `Authority` marks the world dirty from it so a
    /// world where only belts move is still snapshotted. Not state.
    changed: bool,
}

impl Transport {
    /// An empty store with no arena and no caps (a client replica's, until M46; a restore shell's,
    /// until [`Transport::set_caps`]). `create` and `insert_*` return `Full` until caps are set.
    pub fn empty() -> Self {
        Transport {
            max_lines: 0,
            max_items: 0,
            reserved: false,
            lines: Vec::new(),
            free_line: NIL,
            index: Vec::new(),
            next_id: 1,
            nodes: Vec::new(),
            node_cap: 0,
            free_node: NIL,
            items: 0,
            order: Vec::new(),
            graph_dirty: false,
            scratch: order::Scratch::default(),
            epoch: 1,
            advanced_epoch: 0,
            changed: false,
        }
    }

    /// An empty store with every arena reserved for `max_lines` lines and `max_items` items (0076
    /// §8): [`Transport::empty`] then [`Transport::set_caps`].
    pub fn new(max_lines: u32, max_items: u32) -> Self {
        let mut t = Self::empty();
        t.set_caps(max_lines, max_items)
            .expect("a fresh store has no caps yet");
        t
    }

    /// Sets the caps (the world params, 0076 §8) and reserves every arena for them, once (0079
    /// §5): called when a world is created or restored, never on a tick path. A second call with
    /// the same caps is a no-op; with other caps it is `Err(TransportError::CapsFixed)`. Caps below
    /// a decoded store's content keep the content (new lines or items are refused until it drops
    /// under the cap). `(0, 0)` reserves nothing.
    pub fn set_caps(&mut self, max_lines: u32, max_items: u32) -> Result<(), TransportError> {
        if self.reserved {
            return if (max_lines, max_items) == (self.max_lines, self.max_items) {
                Ok(())
            } else {
                Err(TransportError::CapsFixed)
            };
        }
        self.reserved = true;
        self.max_lines = max_lines;
        self.max_items = max_items;
        let lines = max_lines.max(self.lines.len() as u32) as usize;
        reserve_to(&mut self.lines, lines);
        reserve_to(&mut self.index, lines);
        reserve_to(&mut self.order, lines);
        self.scratch.reserve(lines);
        let items = max_items.max(self.items);
        let nodes = if items == 0 {
            0
        } else {
            (items as usize + 1).max(self.nodes.len())
        };
        reserve_to(&mut self.nodes, nodes);
        self.node_cap = nodes as u32;
        Ok(())
    }

    /// The bytes [`Transport::set_caps`] reserves for `max_lines` lines and `max_items` items on an
    /// empty store: line records, the id index, the update order and Tarjan's scratch per line,
    /// `max_items + 1` run nodes (none at 0 items). `Host::init`'s memory-split check adds it (0079
    /// §5).
    pub fn reserved_bytes(max_lines: u32, max_items: u32) -> u64 {
        use core::mem::size_of;
        let per_line = size_of::<Line>()
            + size_of::<(LineId, u32)>()
            + size_of::<u32>()
            + order::Scratch::BYTES_PER_LINE;
        let nodes = if max_items == 0 {
            0
        } else {
            u64::from(max_items) + 1
        };
        u64::from(max_lines) * per_line as u64 + nodes * size_of::<Node>() as u64
    }

    /// The bytes this store's arenas hold now (their capacities): what `set_caps` reserved, or
    /// more for a decoded store larger than its caps. Tests and tools.
    pub fn arena_bytes(&self) -> u64 {
        use core::mem::size_of;
        (self.lines.capacity() * size_of::<Line>()
            + self.index.capacity() * size_of::<(LineId, u32)>()
            + self.order.capacity() * size_of::<u32>()
            + self.scratch.capacity_bytes()
            + self.nodes.capacity() * size_of::<Node>()) as u64
    }

    /// The line's runs front to back, `f(item, count, gap)` (the store's shape, 0077 A6; tests and
    /// tools).
    pub fn runs_in(&self, line: LineId, f: &mut dyn FnMut(Item, u16, u32)) -> Result<(), Unknown> {
        let mut cur = self.read_line(line)?.head;
        while cur != NIL {
            let n = self.nodes[cur as usize];
            f(Item(n.run.item), n.run.count, n.run.gap);
            cur = n.next;
        }
        Ok(())
    }

    /// Whether [`Transport::set_caps`] has run (the arena is reserved, possibly empty at caps 0).
    pub fn is_reserved(&self) -> bool {
        self.reserved
    }

    /// Whether anything changed since the last call (module field `changed`), clearing it.
    pub fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    pub fn max_lines(&self) -> u32 {
        self.max_lines
    }

    pub fn max_items(&self) -> u32 {
        self.max_items
    }

    /// Items on every line together.
    pub fn items_len(&self) -> u32 {
        self.items
    }

    /// The id the next `create` returns.
    pub fn next_id(&self) -> u32 {
        self.next_id
    }

    /// Whether the store is exactly as `new` left it: no line was ever created. Such a store adds
    /// nothing to the state hash (`Store::write_canonical`), so a world that never uses transport
    /// keeps the hash it had before M42.
    pub fn is_pristine(&self) -> bool {
        self.next_id == 1 && self.index.is_empty()
    }

    /// The jam summary M47's forecast reads (M42 Planning decisions): `Some(pos)` when the line's
    /// front item held during the last `advance` (it did not move), `pos` being the rearmost item of
    /// the packed block at the front (items exactly `SPACING` apart from the front item); `None`
    /// when the front moved or the line is empty. Computed on read over the packed runs (one run for
    /// a same-kind jam, canonical form).
    pub fn jam(&self, line: LineId) -> Result<Option<u32>, Unknown> {
        let l = self.slot(line).ok_or(Unknown)?;
        let rec = &self.lines[l as usize];
        if !rec.held || rec.head == NIL {
            return Ok(None);
        }
        let first = self.nodes[rec.head as usize];
        let mut last = first.run.gap + SPACING * (u32::from(first.run.count) - 1);
        let mut cur = first.next;
        while cur != NIL {
            let n = self.nodes[cur as usize];
            if n.run.gap != 0 {
                break;
            }
            last += SPACING * u32::from(n.run.count);
            cur = n.next;
        }
        Ok(Some(last))
    }

    /// Whether anything on the line changed (an item moved, crossed, landed, was inserted or
    /// removed, or the line's structure changed) during the last ticked tick: the `G::tick` calls
    /// and the `advance` that followed them (M47 reads it).
    pub fn touched(&self, line: LineId) -> Result<bool, Unknown> {
        let l = self.slot(line).ok_or(Unknown)?;
        Ok(self.advanced_epoch != 0 && self.lines[l as usize].mark == self.advanced_epoch)
    }

    /// The update order (ascending in position: the first line advances first), recomputed first
    /// if the graph changed. Tests and tools; `advance` uses its own copy.
    pub fn order_into(&mut self, out: &mut Vec<LineId>) {
        if self.graph_dirty {
            self.recompute_order();
        }
        out.clear();
        out.extend(self.order.iter().map(|&s| self.lines[s as usize].id));
    }

    #[inline]
    fn slot(&self, id: LineId) -> Option<u32> {
        if id == LineId::NONE {
            return None;
        }
        self.index
            .binary_search_by(|(i, _)| i.cmp(&id))
            .ok()
            .map(|k| self.index[k].1)
    }

    fn touch(&mut self, slot: u32) {
        self.lines[slot as usize].mark = self.epoch;
        self.changed = true;
    }

    /// Allocates a line slot (reusing a destroyed one first).
    fn alloc_line(&mut self, rec: Line) -> u32 {
        if self.free_line != NIL {
            let s = self.free_line;
            self.free_line = self.lines[s as usize].head;
            self.lines[s as usize] = rec;
            s
        } else {
            let s = self.lines.len() as u32;
            self.lines.push(rec);
            s
        }
    }

    fn read_line(&self, line: LineId) -> Result<&Line, Unknown> {
        self.slot(line)
            .map(|s| &self.lines[s as usize])
            .ok_or(Unknown)
    }
}

/// Grows `v`'s capacity to at least `n` (a setup-time reservation, never on a tick path).
fn reserve_to<T>(v: &mut Vec<T>, n: usize) {
    if v.capacity() < n {
        v.reserve_exact(n - v.len());
    }
}

impl TransportRead for Transport {
    fn lines_len(&self) -> u32 {
        self.index.len() as u32
    }

    fn len(&self, line: LineId) -> Result<u32, Unknown> {
        Ok(self.read_line(line)?.len)
    }

    fn speed(&self, line: LineId) -> Result<u16, Unknown> {
        Ok(self.read_line(line)?.speed)
    }

    fn out(&self, line: LineId) -> Result<Output, Unknown> {
        Ok(self.read_line(line)?.out)
    }

    fn count(&self, line: LineId) -> Result<u32, Unknown> {
        Ok(self.read_line(line)?.items)
    }

    fn front(&self, line: LineId) -> Result<Option<(Item, u32)>, Unknown> {
        let rec = self.read_line(line)?;
        if rec.head == NIL {
            return Ok(None);
        }
        let r = self.nodes[rec.head as usize].run;
        Ok(Some((Item(r.item), r.gap)))
    }

    fn items_in(&self, line: LineId, f: &mut dyn FnMut(Item, u32)) -> Result<(), Unknown> {
        let rec = self.read_line(line)?;
        let mut prev_last: Option<u32> = None;
        let mut cur = rec.head;
        while cur != NIL {
            let n = self.nodes[cur as usize];
            let first = match prev_last {
                None => n.run.gap,
                Some(p) => p + SPACING + n.run.gap,
            };
            for k in 0..u32::from(n.run.count) {
                f(Item(n.run.item), first + SPACING * k);
            }
            prev_last = Some(first + SPACING * (u32::from(n.run.count) - 1));
            cur = n.next;
        }
        Ok(())
    }

    fn sunk(&self, line: LineId) -> Result<u64, Unknown> {
        Ok(self.read_line(line)?.sunk)
    }
}

impl TransportWrite for Transport {
    fn create(&mut self, len: u32, speed: u16) -> Result<LineId, TransportError> {
        if self.index.len() as u32 >= self.max_lines || self.next_id == u32::MAX {
            return Err(Full);
        }
        if speed == 0 || u32::from(speed) >= len {
            return Err(BadSpeed);
        }
        let id = LineId(self.next_id);
        self.next_id += 1;
        let slot = self.alloc_line(Line::new(id, len, speed));
        // Ids are monotonic, so the new one sorts last.
        self.index.push((id, slot));
        self.graph_dirty = true;
        self.touch(slot);
        Ok(id)
    }

    fn destroy(&mut self, line: LineId, f: &mut dyn FnMut(Item)) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
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
        let k = self
            .index
            .binary_search_by(|(i, _)| i.cmp(&line))
            .expect("slot() found it");
        self.index.remove(k);
        // Feeders of the destroyed line lose their target (M43 decides the full semantics).
        for &(_, s) in &self.index {
            let rec = &mut self.lines[s as usize];
            if rec.out == Output::Next(line) {
                rec.out = Output::DeadEnd;
                rec.next_slot = NIL;
                rec.jam_valid = false;
            }
        }
        self.lines[slot as usize] = Line::free(self.free_line);
        self.free_line = slot;
        self.graph_dirty = true;
        self.changed = true;
        Ok(())
    }

    fn set_out(&mut self, line: LineId, out: Output) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        let next_slot = match out {
            Output::DeadEnd | Output::Sink => NIL,
            Output::Next(t) => {
                if t == line {
                    return Err(TransportError::Unsupported);
                }
                let ts = self.slot(t).ok_or(TransportError::NoLine)?;
                // 0079 (M42 review): a landing `target.len + p` with `p >= -speed` is never
                // negative only if the target is at least one tick's travel long.
                if self.lines[ts as usize].len < u32::from(self.lines[slot as usize].speed) {
                    return Err(BadSpeed);
                }
                ts
            }
            Output::Merge { .. } | Output::Fork { .. } => {
                return Err(TransportError::Unsupported);
            }
        };
        let rec = &mut self.lines[slot as usize];
        rec.out = out;
        rec.next_slot = next_slot;
        rec.jam_valid = false;
        self.graph_dirty = true;
        self.touch(slot);
        Ok(())
    }

    fn set_speed(&mut self, line: LineId, speed: u16) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        let rec = self.lines[slot as usize];
        if speed == 0 || u32::from(speed) >= rec.len {
            return Err(BadSpeed);
        }
        // The hand-off bound (`set_out`): a `Next` target at least `speed` long.
        if rec.next_slot != NIL && self.lines[rec.next_slot as usize].len < u32::from(speed) {
            return Err(BadSpeed);
        }
        self.lines[slot as usize].speed = speed;
        self.touch(slot);
        Ok(())
    }

    fn insert_back(&mut self, line: LineId, item: Item) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        if item.0 == 0 {
            return Err(TransportError::BadItem);
        }
        if self.items >= self.max_items {
            return Err(Full);
        }
        self.insert_back_slot(slot, item.0)
    }

    fn insert_at(&mut self, line: LineId, pos: u32, item: Item) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        if item.0 == 0 {
            return Err(TransportError::BadItem);
        }
        if self.items >= self.max_items {
            return Err(Full);
        }
        self.insert_at_slot(slot, pos, item.0)
    }

    fn remove_at(&mut self, line: LineId, pos: u32) -> Result<Option<Item>, TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        Ok(self.remove_at_slot(slot, pos).map(Item))
    }
}
