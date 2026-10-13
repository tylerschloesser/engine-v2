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
//! M42 scope: `create`, `set_out` (`DeadEnd`, `Next`, `Sink`; an output into the line itself is
//! [`TransportError::Unsupported`]), `set_speed`, `insert_back`, and `insert_at`/`remove_at` (0076
//! §3's inserter primitives, `items.rs`).
//!
//! M44 (0076 §1): `Output::Merge` (a side-load: `advance.rs` lands a crossing item at `at - o`,
//! clamped, iff `SPACING` is clear on both sides there) and `Output::Fork` (alternation by the
//! line's `toggle`, sim state), the update order over two-target outputs (`order.rs`) and their
//! encoding (`codec.rs`).
//!
//! M43 (0076 §3-§4): line surgery (`surgery.rs`: `split`, `join`, `extend_*`, `shrink_*`,
//! `rescale`, the full `destroy`), `take_front` (`items.rs`), and geometry (`geometry.rs`: each
//! line's registered [`Segment`]s, `pos_to_world`, the derived chunk set, anchor and tile index).
//! Positions are below [`MAX_LEN`], so a run's signed `gap` fits an `i32` (`line.rs`: a squashed
//! pair kept by `rescale`/`join` is a negative gap).
//!
//! M46 (0078 §1): line structures replicate. Every structure change (`create`, `set_out`,
//! `set_speed`, every surgery and its redirects, `set_segments`, `destroy`; never an item) stamps
//! the line's [`Transport::structure_version`] with the tick [`Transport::set_now`] last set and
//! queues its id once in a change list ([`Transport::structure_changes`], drained by the host at
//! `seal`), both derived and never encoded, like `touched`. The list holds a quarter of
//! `max_lines` ids (structures change at placement rate); past that it is marked overflowed and
//! the host reconciles every line once instead (`host::lines`). A client replica's store is in
//! *replica mode* ([`Transport::set_replica`]): it holds structures only, through
//! [`Transport::apply_structure`], and answers `sunk`/`toggle` with `Unknown`.
//!
//! M47 (0078 A3): items replicate as forecasts. On the host, `forecast.rs`'s tracker (derived,
//! never encoded or hashed) follows every line's model through `advance`'s hooks and decides each
//! tick's corrections, which `host::lines` routes into frame section 13 (`wire::forecast`); on a
//! replica, `follow.rs` keeps one trajectory per held item and answers `count`/`front`/`items_in`
//! from them at its forecast tick.
//!
//! M49 (0078 A12): `draw.rs` is the client role's item drawing (`draw::draw_items`, called from a
//! game's `extract`): every visible item of every held line at the item clock, `T + frac`.
//!
//! M53 (0079 §21): a line's spawner [`Schedule`] is sim state on its record
//! ([`TransportWrite::set_spawner`]): encoded behind a tag bit (`codec.rs`), hashed with the store,
//! restored with it, carried by surgery to the piece that holds the line's back. `advance` runs
//! every schedule first thing (`advance.rs`, `step_schedules`), the rule the replica's follower
//! replays, so a scheduled line's inserts are the engine's (a game's `insert_back` there is
//! `Err(Scheduled)`) and cannot mismatch the forecast. A game that inserts itself declares its rule
//! instead ([`TransportWrite::declare_spawner`], derived, M47).

mod advance;
mod codec;
pub mod draw;
mod follow;
mod forecast;
mod geometry;
mod items;
mod line;
mod order;
mod replicate;
mod surgery;

use crate::game::Unknown;
use crate::world::{ChunkCoord, ChunkDims, TilePos, WorldPos};

pub use advance::dry_visits;
pub(crate) use codec::{read_out, read_segment, write_out, write_segment};
pub use follow::ForecastCounters;
pub use forecast::{
    Crossing, HostCounters, MAX_DEPTH, MSG_RUN_LIST, MSG_STATE, Msg, ROUTE_FORK, ROUTE_INSERT,
    ROUTE_MERGE, ROUTE_NEXT, Schedule,
};
pub use geometry::{Geometry, MAX_LINE_TILES, MAX_SEGMENTS, Segment, walk_evals};
use geometry::{SegRec, TileEntry};
use line::{Line, NIL, Node};

/// The longest line (M43): positions stay below `i32::MAX`, so a run's signed gap (`line.rs`) is
/// an `i32`. `create`, `extend_*`, `join` and `rescale` refuse past it with
/// [`TransportError::TooLong`]; decode rejects it.
pub const MAX_LEN: u32 = i32::MAX as u32;

/// 0076 §1: the minimum distance between two items on one line and across a plain hand-off (4
/// items per tile per lane). An engine constant; the run representation relies on it.
pub const SPACING: u32 = 64;

/// The shortest schedule period (M53): 256 (1/256 tick) is one insert a tick, the most a schedule
/// makes. `set_spawner` below it is `BadPeriod`; decode rejects it.
pub const MIN_PERIOD: u32 = 256;

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

/// What the front of a line feeds (0076 §1; `Merge` and `Fork` from M44). No output names the line
/// itself (`Unsupported`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Output {
    DeadEnd,
    /// A plain hand-off: lane preserved, position continues (landing `target.len - overshoot`).
    Next(LineId),
    /// A side-load onto `line` at position `at` (M44): an item crossing the front with overshoot
    /// `o` lands at `at - o`, clamped to `[0, line.len - 1]`, iff `SPACING` is clear on both sides
    /// of that position on `line` (as `insert_at`); else it waits at position 0. The item behind a
    /// transferred one is not held back by it. Any `at` is accepted (the clamp covers a target
    /// shortened later).
    Merge {
        line: LineId,
        at: u32,
    },
    /// Alternates items between `a` and `b` (M44): an item crossing with overshoot `o` goes to the
    /// line's preferred target (`TransportRead::toggle`, `false` = `a`) if it has room at the
    /// plain hand-off landing `target.len - o` (`tail + SPACING <= landing`), else to the other
    /// on the same rule, else it waits at position 0; the toggle flips only when the item went to
    /// the preferred side. `a != b`, both at least the feeder's `speed` long (0079 §8).
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
    /// `speed` is 0 or not below `len` (0076 §1: `1 <= speed < len`), or a `Next` or `Fork`
    /// target shorter than the feeder's `speed` (`set_out`, `set_speed`: a hand-off must land
    /// inside the target).
    BadSpeed,
    /// The line (or an output's target) does not exist.
    NoLine,
    /// `Item(0)` ("none") cannot be placed on a line.
    BadItem,
    /// An output naming the line itself, or a `Fork` with `a == b`.
    Unsupported,
    /// `set_caps` after the arena was reserved, with other caps (0079 §5: reserved once).
    CapsFixed,
    /// `shrink_front`/`shrink_back` would drop an item off the line (M43).
    NotEmpty,
    /// `join(front, back)` needs `back`'s output to be `Next(front)` (M43).
    NotLinked,
    /// `set_segments`: lengths not summing to the line's `len`, more than [`MAX_SEGMENTS`], a
    /// zero-length segment or an arc field out of range (`geometry.rs`).
    BadSegments,
    /// A length past [`MAX_LEN`] (`create`, `extend_*`, `join`, `rescale`).
    TooLong,
    /// `set_spawner` with a `period` below [`MIN_PERIOD`] (M53).
    BadPeriod,
    /// `insert_back` on a line whose schedule is state (M53, 0079 §21): the engine makes that
    /// line's inserts.
    Scheduled,
}

pub use TransportError::{BadSpeed, Full, NoRoom, NotEmpty};

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
    /// The line's fork toggle (M44): `true` when its `Fork` prefers `b`; `false` for any other
    /// output.
    fn toggle(&self, line: LineId) -> Result<bool, Unknown>;
    /// The line's registered segments front to back (M43; none until `set_segments`).
    fn segments(&self, line: LineId, f: &mut dyn FnMut(Segment)) -> Result<(), Unknown>;
    /// Where position `pos` is in the world (M43, `geometry.rs`): `None` without segments or for
    /// `pos >= len`. Exact integer code (the client runs the same in M49).
    fn pos_to_world(&self, line: LineId, pos: u32) -> Result<Option<WorldPos>, Unknown>;
    /// The chunks the line's segments' tile boxes cover, sorted `(cy, cx)`, each once (derived,
    /// never encoded; computed on call from at most [`MAX_SEGMENTS`] boxes).
    fn chunks_of(
        &self,
        line: LineId,
        dims: ChunkDims,
        f: &mut dyn FnMut(ChunkCoord),
    ) -> Result<(), Unknown>;
    /// The chunk of the line's front point (position 0), `None` without segments.
    fn anchor(&self, line: LineId, dims: ChunkDims) -> Result<Option<ChunkCoord>, Unknown>;
    /// Every `(line, offset)` whose path enters `tile`, `offset` being the position of the line's
    /// first point in it (a line entering the tile twice appears twice), ascending by line then
    /// offset: the derived tile index (`geometry.rs`), never encoded. `Err(Unknown)` from a store
    /// that holds no transport state (an unreserved one: a replica's until M46).
    fn lines_at(&self, tile: TilePos, f: &mut dyn FnMut(LineId, u32)) -> Result<(), Unknown>;
}

/// The write side (0076 §3, M42's part), host tick only (0076 §6).
pub trait TransportWrite: TransportRead {
    /// A new line with no items and a `DeadEnd` output. `Err(Full)` at `max_lines`,
    /// `Err(BadSpeed)` unless `1 <= speed < len`.
    fn create(&mut self, len: u32, speed: u16) -> Result<LineId, TransportError>;
    /// Removes the line, handing its items to `f` front to back and returning how many; lines
    /// that fed it become `DeadEnd`; its runs, slot, segments, tile-index entries and schedule are
    /// freed (its id is never reused).
    fn destroy(&mut self, line: LineId, f: &mut dyn FnMut(Item)) -> Result<u32, TransportError>;
    /// Cuts the line at `at` (`surgery.rs`): the line keeps `[0, at)` and its output; the new line
    /// (returned) is `[at, len)`, items at `pos >= at` moved to `pos - at`, its output `Next(line)`;
    /// every `Next(line)` now feeds the new line, and the line's schedule moves to it (M53: it
    /// inserts at the back). `BadSpeed` unless `speed < at` and
    /// `speed < len - at` and every feeder's speed is at most `len - at`; `Full` at `max_lines`.
    fn split(&mut self, line: LineId, at: u32) -> Result<LineId, TransportError>;
    /// Appends `back` (whose output must be `Next(front)`, else `NotLinked`) to `front`: its items
    /// at `pos + front.len`, gaps kept, a packed same-kind boundary pair merged; `back` is
    /// destroyed and its feeders feed `front`. `front` keeps its speed and output. `Unsupported` if
    /// `front` feeds `back` (the joined line would feed itself) or `front` holds a schedule (M53:
    /// it would sit mid-line); `back`'s schedule moves to `front`, whose back it now is. Any other line feeding `front`
    /// (`Next(front)`) now lands at the joined line's back, `back.len` further upstream than
    /// before: topology is the game's (0076 §3), and a second plain feeder into one back edge has
    /// no geometric meaning in a belt game, so `join` does not refuse it.
    fn join(&mut self, front: LineId, back: LineId) -> Result<(), TransportError>;
    /// `len += by` at the front: every position grows by `by` (O(1)).
    fn extend_front(&mut self, line: LineId, by: u32) -> Result<(), TransportError>;
    /// `len += by` at the back (O(1)).
    fn extend_back(&mut self, line: LineId, by: u32) -> Result<(), TransportError>;
    /// `len -= by` at the front, every position shrinking by `by`: `NotEmpty` if the front item is
    /// below `by`; `BadSpeed` if the line would not exceed its speed or a feeder's speed.
    fn shrink_front(&mut self, line: LineId, by: u32) -> Result<(), TransportError>;
    /// `len -= by` at the back: `NotEmpty` if the rearmost item is past `len - by - 1`; `BadSpeed`
    /// as `shrink_front`.
    fn shrink_back(&mut self, line: LineId, by: u32) -> Result<(), TransportError>;
    /// Scales every position to `floor(pos x new_len / len)` (a reshape, 12 §3e), keeping squashed
    /// pairs for the squash rule to resolve; `NoRoom` if two items would share a position;
    /// `BadSpeed` as `shrink_front`.
    fn rescale(&mut self, line: LineId, new_len: u32) -> Result<(), TransportError>;
    /// Removes the front item, if any (a sink the game drives itself).
    fn take_front(&mut self, line: LineId) -> Result<Option<Item>, TransportError>;
    /// Registers the line's path front to back (`geometry.rs`): lengths summing to `len`, at most
    /// [`MAX_SEGMENTS`] (`BadSegments`); `&[]` clears it. `Full` when the segment pool or the tile
    /// index is out of room, or the path enters more than [`MAX_LINE_TILES`] tiles. Every surgery
    /// that changes a line's `len` clears its segments; the game registers them again.
    fn set_segments(&mut self, line: LineId, segs: &[Segment]) -> Result<(), TransportError>;
    /// Sets what the line feeds (refusals: [`TransportError`]). A changed output clears the fork
    /// toggle; the same output again is a no-op (toggle, order and `touched` unchanged).
    fn set_out(&mut self, line: LineId, out: Output) -> Result<(), TransportError>;
    fn set_speed(&mut self, line: LineId, speed: u16) -> Result<(), TransportError>;
    /// A spawner's primitive: lands at `max(len - speed, tail + SPACING)`, refused (`NoRoom`) past
    /// `len - 1`; `Err(Full)` at `max_items`. Checks spacing on this line only (0077 A6b (i)).
    /// `Err(Scheduled)` on a line with a schedule (M53: the engine makes its inserts; a debug
    /// build panics, naming the line).
    /// Called from `G::tick`, it lands *before* that tick's `advance`, which then moves the item:
    /// at the end of the tick an item inserted this tick sits at `len - 2 x speed` (it entered one
    /// tick's travel inside the back edge and then moved), and on a `Sink` line with
    /// `len < 2 x speed` it sinks the same tick (legal, and the count is conserved).
    fn insert_back(&mut self, line: LineId, item: Item) -> Result<(), TransportError>;
    /// An inserter's primitive: `SPACING` clear on both sides on this line, `pos <= len - 1`.
    fn insert_at(&mut self, line: LineId, pos: u32, item: Item) -> Result<(), TransportError>;
    /// The nearest item within `SPACING / 2` of `pos` (the front one on a tie), if any.
    fn remove_at(&mut self, line: LineId, pos: u32) -> Result<Option<Item>, TransportError>;
    /// Gives the line a spawner schedule (M53, 0079 §21; [`Schedule`]'s rule), or clears it with
    /// `None`. Sim state: encoded, hashed and restored with the store, so the game writes it once,
    /// at configuration. From this tick's `advance` on, the engine runs it first thing every tick
    /// (at most one insert at the line's back, the credit held on a refusal and never grown,
    /// paused by the item cap) and a game's `insert_back` on the line is `Err(Scheduled)`. The
    /// line's forecast list is resent (it carries the schedule). `BadPeriod` below
    /// [`MIN_PERIOD`], `BadItem` for `next == Item(0)`, `NoLine`, and `Full` when the line has no
    /// schedule or declaration yet and the forecast tracker's pool (half the line cap, shared with
    /// `declare_spawner`) is full: past it the line's inserts could only reach clients as
    /// arrivals. Clearing (`None`) a line without a schedule changes nothing (a declaration stays).
    fn set_spawner(&mut self, line: LineId, s: Option<Schedule>) -> Result<(), TransportError>;
    /// Declares the spawner the game's own tick rule runs on this line (M47, [`Schedule`]: the
    /// engine forecasts it, the game keeps inserting through `insert_back`), as it stands after
    /// this tick; `None` clears it. For a game that inserts itself; a scheduled line
    /// ([`TransportWrite::set_spawner`]) needs none. Returns nothing: a declaration is derived
    /// state, never part of the sim (no result the game could branch on). It is not encoded, so it
    /// is lost on restore: the game declares again from `Game::declare_spawners` (M48), which the
    /// host calls once after every restore, upgrade and migrate, and the declarations arm from the
    /// first restored tick. One the tracker cannot hold (no such line, a scheduled line, or half
    /// the line cap declared already) is counted (`HostCounters::spawner_declarations_dropped`).
    fn declare_spawner(&mut self, line: LineId, s: Option<Schedule>);
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
    fn toggle(&self, _line: LineId) -> Result<bool, Unknown> {
        Err(Unknown)
    }
    fn segments(&self, _line: LineId, _f: &mut dyn FnMut(Segment)) -> Result<(), Unknown> {
        Err(Unknown)
    }
    fn pos_to_world(&self, _line: LineId, _pos: u32) -> Result<Option<WorldPos>, Unknown> {
        Err(Unknown)
    }
    fn chunks_of(
        &self,
        _line: LineId,
        _dims: ChunkDims,
        _f: &mut dyn FnMut(ChunkCoord),
    ) -> Result<(), Unknown> {
        Err(Unknown)
    }
    fn anchor(&self, _line: LineId, _dims: ChunkDims) -> Result<Option<ChunkCoord>, Unknown> {
        Err(Unknown)
    }
    fn lines_at(&self, _tile: TilePos, _f: &mut dyn FnMut(LineId, u32)) -> Result<(), Unknown> {
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
    /// How many times the order was recomputed (tests and tools; not state).
    order_recomputes: u32,
    /// How many times a cycle's cut line fell back to its target as it stands (no fixed point in
    /// the dry passes, `advance.rs`); tests and tools, not state.
    cut_fallbacks: u32,
    /// What the item crossing now already moved on its feeder this tick (`advance` scratch, read
    /// by a landing across a cut; not state).
    cut_moved: i64,
    /// Where the last `Merge` or `Fork` transfer landed, `(slot, pos)` (`advance` scratch for the
    /// forecast tracker's hand-off; not state).
    last_land: (u32, u32),
    scratch: order::Scratch,
    /// The segment pool (`geometry.rs`): every line's segments, contiguous per line, compacted in
    /// place when the tail is reached. `seg_cap` records at most (`max_lines x
    /// SEGMENTS_PER_LINE`), `seg_live` of them in use.
    segs: Vec<SegRec>,
    seg_cap: u32,
    seg_live: u32,
    /// The tile index (`geometry.rs`): sorted `(tile.y, tile.x, line, offset)`, at most `tile_cap`
    /// entries (`max_lines x TILES_PER_LINE`) plus [`MAX_LINE_TILES`] of merge room. Derived:
    /// never encoded or hashed; `rebuild_index` reaches what incremental maintenance reaches.
    tiles: Vec<TileEntry>,
    tile_cap: u32,
    /// `touched` bookkeeping (M47 reads it): a line is touched when its `mark` equals the epoch of
    /// the last `advance`; `advance` also stamps each line it visits with `epoch` (`adv_mark`), so
    /// a hand-off knows whether its target has moved this tick. Not state: never encoded or hashed.
    epoch: u32,
    advanced_epoch: u32,
    /// Something changed since the last [`Transport::take_changed`] (a write through the API or an
    /// `advance` that moved, landed, sank or merged): `Authority` marks the world dirty from it so a
    /// world where only belts move is still snapshotted. Not state.
    changed: bool,
    /// M46: per slot, the tick of the line's last structure change (`structure_version`). Derived:
    /// never encoded or hashed (a decoded line starts at 0).
    struct_ver: Vec<u32>,
    /// M46: the ids whose structure changed (or that were destroyed) since the last drain, each
    /// once (`Line::struct_queued`), in change order; at most `struct_cap` (module doc).
    struct_changes: Vec<LineId>,
    struct_cap: u32,
    /// A change found the list full: the host reconciles every line instead of the list.
    struct_overflow: bool,
    /// The tick structure changes are stamped with ([`Transport::set_now`]).
    now: u32,
    /// A client replica's store (module doc): structures and forecasts.
    replica: bool,
    /// M47: the host's forecast tracker (`forecast.rs`), reserved by `set_caps` unless a replica.
    fc: forecast::Tracker,
    /// M47: the replica's forecast follower (`follow.rs`), reserved by `set_caps` on a replica.
    fl: follow::Follower,
    /// M53: the slots of the lines holding a schedule (`Line::sched`), ascending by `LineId`:
    /// what `advance` steps. Derived from the records (decode lists them), edited by `set_spawner`
    /// and surgery only, reserved at `set_caps` for half the line cap (the tracker's room, which
    /// `set_spawner` checks); not state.
    sched_slots: Vec<u32>,
    /// M53: items every schedule inserted since this store was built or decoded, and slots the
    /// schedule step visited (tests and tools; not state).
    sched_inserts: u64,
    sched_visits: u64,
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
            order_recomputes: 0,
            cut_moved: 0,
            last_land: (NIL, 0),
            cut_fallbacks: 0,
            scratch: order::Scratch::default(),
            segs: Vec::new(),
            seg_cap: 0,
            seg_live: 0,
            tiles: Vec::new(),
            tile_cap: 0,
            epoch: 1,
            advanced_epoch: 0,
            changed: false,
            struct_ver: Vec::new(),
            struct_changes: Vec::new(),
            struct_cap: 0,
            struct_overflow: false,
            now: 0,
            replica: false,
            fc: forecast::Tracker::default(),
            fl: follow::Follower::default(),
            sched_slots: Vec::new(),
            sched_inserts: 0,
            sched_visits: 0,
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
        reserve_to(&mut self.struct_ver, lines);
        reserve_to(&mut self.index, lines);
        let items = max_items.max(self.items);
        // M47 review (finding 3): a replica never advances, queues no change and holds its items
        // in the follower, so it reserves no update order, Tarjan scratch, change list or run
        // nodes.
        if !self.replica {
            let n = (sched_cap(max_lines) as usize).max(self.sched_slots.len());
            reserve_to(&mut self.sched_slots, n);
            self.struct_cap = struct_cap(max_lines);
            reserve_to(&mut self.struct_changes, self.struct_cap as usize);
            reserve_to(&mut self.order, lines);
            self.scratch.reserve(lines);
            let nodes = if items == 0 {
                0
            } else {
                (items as usize + 1).max(self.nodes.len())
            };
            reserve_to(&mut self.nodes, nodes);
            self.node_cap = nodes as u32;
        }
        let (seg_cap, tile_cap, headroom) = geometry::caps(max_lines);
        self.seg_cap = seg_cap.max(self.segs.len() as u32);
        reserve_to(&mut self.segs, self.seg_cap as usize);
        self.tile_cap = tile_cap.max(self.tiles.len() as u32);
        reserve_to(&mut self.tiles, self.tile_cap as usize + headroom as usize);
        // M47: the replica follows forecasts; the host tracks them.
        if self.replica {
            self.fl.reserve(lines as u32, items);
        } else if lines > 0 || items > 0 {
            let mut fc = std::mem::take(&mut self.fc);
            fc.reserve(self, max_lines, max_items);
            self.fc = fc;
        }
        Ok(())
    }

    /// M48: closes the tracker's tick after the declarations of `Game::declare_spawners` on a
    /// restored store, as the end of the saved tick would have: they were made after that tick's
    /// step (0079 §19 (a)), so they arm at the next tick's first hook and replay it. Nothing moves;
    /// the declared lines' models are rebuilt (their lists carry the schedule). Host only, never on
    /// a tick path.
    pub(crate) fn forecast_close_restored(&mut self) {
        if self.replica {
            return;
        }
        let mut fc = std::mem::take(&mut self.fc);
        fc.closing = true;
        fc.end_tick(self);
        fc.closing = false;
        self.fc = fc;
    }

    /// The line's schedule as it stands after the last tick's step and whether the item cap paused
    /// it (M53; `None` without one). Tests and tools.
    pub fn schedule(&self, line: LineId) -> Result<Option<(Schedule, bool)>, Unknown> {
        Ok(self.read_line(line)?.sched.map(|ls| (ls.s, ls.paused)))
    }

    /// Scheduled slots the schedule step visited since this store was built or decoded (M53 fix
    /// round 1: the step walks the scheduled lines only). Tests and tools.
    pub fn schedule_visits(&self) -> u64 {
        self.sched_visits
    }

    /// Lists `slot` (a line that just got a schedule) in `sched_slots` at its id's place, within
    /// the reserved room (`set_spawner` checked the tracker's pool, the same size).
    fn list_sched(&mut self, slot: u32) {
        let id = self.lines[slot as usize].id;
        let lines = &self.lines;
        let k = self
            .sched_slots
            .partition_point(|&s| lines[s as usize].id < id);
        self.sched_slots.insert(k, slot);
    }

    /// Drops `slot` from `sched_slots` (its schedule cleared or moved, or the line destroyed).
    fn unlist_sched(&mut self, slot: u32) {
        if let Some(k) = self.sched_slots.iter().position(|&s| s == slot) {
            self.sched_slots.remove(k);
        }
    }

    /// Items every schedule inserted since this store was built or decoded (M53). Tests and tools.
    pub fn scheduled_inserts_total(&self) -> u64 {
        self.sched_inserts
    }

    /// The bytes [`Transport::set_caps`] reserves for `max_lines` lines and `max_items` items on an
    /// empty host store: line records, the id index, the update order and Tarjan's scratch per
    /// line, `max_items + 1` run nodes (none at 0 items), the geometry (M43): the segment pool and
    /// the tile index per line plus the index's merge room (`geometry::caps`), and the forecast
    /// tracker (M47). `Host::init`'s memory-split check adds it (0079 §5).
    pub fn reserved_bytes(max_lines: u32, max_items: u32) -> u64 {
        Self::host_bytes(max_lines, max_items)
    }

    /// What a client replica's store reserves (M47 review, finding 3): the line records, id index
    /// and structure versions, the geometry, and the forecast follower; no update order, scratch,
    /// change list or run nodes.
    pub fn replica_reserved_bytes(max_lines: u32, max_items: u32) -> u64 {
        use core::mem::size_of;
        let per_line = size_of::<Line>() + size_of::<(LineId, u32)>() + size_of::<u32>();
        let (segs, tiles, headroom) = geometry::caps(max_lines);
        u64::from(max_lines) * per_line as u64
            + u64::from(segs) * size_of::<SegRec>() as u64
            + (u64::from(tiles) + u64::from(headroom)) * size_of::<TileEntry>() as u64
            + follow::reserved_bytes(max_lines, max_items)
    }

    /// The larger of the two roles' reserve: what a device that may host or join needs.
    pub fn max_role_bytes(max_lines: u32, max_items: u32) -> u64 {
        Self::host_bytes(max_lines, max_items)
            .max(Self::replica_reserved_bytes(max_lines, max_items))
    }

    fn host_bytes(max_lines: u32, max_items: u32) -> u64 {
        use core::mem::size_of;
        // The record, the id index, the update order, the structure version (M46) and Tarjan's
        // scratch.
        let per_line = size_of::<Line>()
            + size_of::<(LineId, u32)>()
            + size_of::<u32>()
            + size_of::<u32>()
            + order::Scratch::BYTES_PER_LINE;
        let nodes = if max_items == 0 {
            0
        } else {
            u64::from(max_items) + 1
        };
        let (segs, tiles, headroom) = geometry::caps(max_lines);
        u64::from(max_lines) * per_line as u64
            + u64::from(struct_cap(max_lines)) * size_of::<LineId>() as u64
            + u64::from(sched_cap(max_lines)) * size_of::<u32>() as u64
            + nodes * size_of::<Node>() as u64
            + u64::from(segs) * size_of::<SegRec>() as u64
            + (u64::from(tiles) + u64::from(headroom)) * size_of::<TileEntry>() as u64
            + forecast::reserved_bytes(max_lines, max_items)
    }

    /// The bytes this store's arenas hold now (their capacities): what `set_caps` reserved, or
    /// more for a decoded store larger than its caps. Tests and tools.
    pub fn arena_bytes(&self) -> u64 {
        use core::mem::size_of;
        (self.lines.capacity() * size_of::<Line>()
            + self.struct_ver.capacity() * size_of::<u32>()
            + self.struct_changes.capacity() * size_of::<LineId>()
            + self.sched_slots.capacity() * size_of::<u32>()
            + self.index.capacity() * size_of::<(LineId, u32)>()
            + self.order.capacity() * size_of::<u32>()
            + self.scratch.capacity_bytes()
            + self.nodes.capacity() * size_of::<Node>()
            + self.segs.capacity() * size_of::<SegRec>()
            + self.tiles.capacity() * size_of::<TileEntry>()
            + self.fc.capacity_bytes()
            + self.fl.capacity_bytes()) as u64
    }

    /// The line's runs front to back, `f(item, count, gap)` (the store's shape, 0077 A6; a later
    /// run's `gap` is negative for a squashed pair; tests and tools).
    pub fn runs_in(&self, line: LineId, f: &mut dyn FnMut(Item, u16, i32)) -> Result<(), Unknown> {
        let mut cur = self.read_line(line)?.head;
        while cur != NIL {
            let n = self.nodes[cur as usize];
            f(Item(n.run.item), n.run.count, n.run.gap);
            cur = n.next;
        }
        Ok(())
    }

    /// How many times a cycle's cut line found no fixed point and saw its target as it stands
    /// (`advance.rs` `cut_leader`; tests and tools, not state).
    pub fn cut_fallbacks(&self) -> u32 {
        self.cut_fallbacks
    }

    /// How many times the update order was recomputed so far (a graph change recomputes it once,
    /// at the next `advance`; tests and tools, not state).
    pub fn order_recomputes(&self) -> u32 {
        self.order_recomputes
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
        let mut last = first.run.gap as u32 + SPACING * (u32::from(first.run.count) - 1);
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

    /// A structure change of the slot's line (every caller changes `len`, `speed`, `out` or
    /// segments; item writes mark `touched` themselves): `touched`, the world's `changed`, and the
    /// line's structure version and change-list entry (M46).
    fn touch(&mut self, slot: u32) {
        self.touch_as(slot, false);
    }

    /// [`Transport::touch`] for a change of motion only (an output or a speed): the forecast tracker
    /// can tell it as a state message (M47).
    fn touch_motion(&mut self, slot: u32) {
        self.touch_as(slot, true);
    }

    fn touch_as(&mut self, slot: u32, motion: bool) {
        self.fc.structure(slot, motion);
        self.lines[slot as usize].mark = self.epoch;
        self.changed = true;
        self.struct_ver[slot as usize] = self.now;
        if !self.replica
            && !self.lines[slot as usize].struct_queued
            && self.queue_change(self.lines[slot as usize].id)
        {
            self.lines[slot as usize].struct_queued = true;
        }
    }

    /// Appends `id` to the change list within its reserved room, else marks it overflowed.
    pub(super) fn queue_change(&mut self, id: LineId) -> bool {
        if (self.struct_changes.len() as u32) < self.struct_cap {
            self.struct_changes.push(id);
            true
        } else {
            self.struct_overflow = true;
            false
        }
    }

    /// Allocates a line slot (reusing a destroyed one first).
    fn alloc_line(&mut self, rec: Line) -> u32 {
        let s = if self.free_line != NIL {
            let s = self.free_line;
            self.free_line = self.lines[s as usize].head;
            self.lines[s as usize] = rec;
            self.struct_ver[s as usize] = self.now;
            s
        } else {
            let s = self.lines.len() as u32;
            self.lines.push(rec);
            self.struct_ver.push(self.now);
            s
        };
        // M47: a new line's model (host) or held items (replica) start empty.
        self.fc.create(s);
        self.fl.init_line(s);
        s
    }

    fn read_line(&self, line: LineId) -> Result<&Line, Unknown> {
        self.slot(line)
            .map(|s| &self.lines[s as usize])
            .ok_or(Unknown)
    }
}

/// The scheduled-slot list's room (M53): half the line cap, the forecast tracker's schedule pool.
fn sched_cap(max_lines: u32) -> u32 {
    max_lines.div_ceil(2)
}

/// The change list's room for `max_lines` (module doc): a quarter, rounded up.
fn struct_cap(max_lines: u32) -> u32 {
    max_lines.div_ceil(4)
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
        if self.replica {
            // M47: from the held trajectories at the forecast tick.
            let slot = self.slot(line).ok_or(Unknown)?;
            return Ok(self.fl.count(slot));
        }
        Ok(self.read_line(line)?.items)
    }

    fn front(&self, line: LineId) -> Result<Option<(Item, u32)>, Unknown> {
        if self.replica {
            let slot = self.slot(line).ok_or(Unknown)?;
            return Ok(self.fl.front(slot));
        }
        let rec = self.read_line(line)?;
        if rec.head == NIL {
            return Ok(None);
        }
        let r = self.nodes[rec.head as usize].run;
        Ok(Some((Item(r.item), r.gap as u32)))
    }

    fn items_in(&self, line: LineId, f: &mut dyn FnMut(Item, u32)) -> Result<(), Unknown> {
        if self.replica {
            let slot = self.slot(line).ok_or(Unknown)?;
            self.fl.items_in(slot, f);
            return Ok(());
        }
        let rec = self.read_line(line)?;
        let mut prev_last: Option<i64> = None;
        let mut cur = rec.head;
        let sp = i64::from(SPACING);
        while cur != NIL {
            let n = self.nodes[cur as usize];
            let first = match prev_last {
                None => i64::from(n.run.gap),
                Some(p) => p + sp + i64::from(n.run.gap),
            };
            for k in 0..i64::from(n.run.count) {
                f(Item(n.run.item), (first + sp * k) as u32);
            }
            prev_last = Some(first + sp * (i64::from(n.run.count) - 1));
            cur = n.next;
        }
        Ok(())
    }

    fn sunk(&self, line: LineId) -> Result<u64, Unknown> {
        self.items_known()?;
        Ok(self.read_line(line)?.sunk)
    }

    fn toggle(&self, line: LineId) -> Result<bool, Unknown> {
        self.items_known()?;
        Ok(self.read_line(line)?.toggle)
    }

    fn segments(&self, line: LineId, f: &mut dyn FnMut(Segment)) -> Result<(), Unknown> {
        let l = self.slot(line).ok_or(Unknown)?;
        for r in self.seg_slice(l) {
            f(r.seg);
        }
        Ok(())
    }

    fn pos_to_world(&self, line: LineId, pos: u32) -> Result<Option<WorldPos>, Unknown> {
        let l = self.slot(line).ok_or(Unknown)?;
        Ok(self.pos_to_world_slot(l, pos))
    }

    fn chunks_of(
        &self,
        line: LineId,
        dims: ChunkDims,
        f: &mut dyn FnMut(ChunkCoord),
    ) -> Result<(), Unknown> {
        let l = self.slot(line).ok_or(Unknown)?;
        self.chunks_of_slot(l, dims, f);
        Ok(())
    }

    fn anchor(&self, line: LineId, dims: ChunkDims) -> Result<Option<ChunkCoord>, Unknown> {
        let l = self.slot(line).ok_or(Unknown)?;
        Ok(self
            .pos_to_world_slot(l, 0)
            .map(|p| dims.chunk_of(p.tile())))
    }

    fn lines_at(&self, tile: TilePos, f: &mut dyn FnMut(LineId, u32)) -> Result<(), Unknown> {
        // M43 review (the prediction rule): this read names no line, so a store holding no
        // transport state (a replica's is never reserved, until M46) answers `Unknown`, not
        // "no line here".
        if !self.reserved {
            return Err(Unknown);
        }
        self.lines_at_tile(tile, f);
        Ok(())
    }
}

impl TransportWrite for Transport {
    fn create(&mut self, len: u32, speed: u16) -> Result<LineId, TransportError> {
        if self.index.len() as u32 >= self.max_lines || self.next_id == u32::MAX {
            return Err(Full);
        }
        if len > MAX_LEN {
            return Err(TransportError::TooLong);
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

    fn destroy(&mut self, line: LineId, f: &mut dyn FnMut(Item)) -> Result<u32, TransportError> {
        self.destroy_line(line, f)
    }

    fn split(&mut self, line: LineId, at: u32) -> Result<LineId, TransportError> {
        self.split_line(line, at)
    }

    fn join(&mut self, front: LineId, back: LineId) -> Result<(), TransportError> {
        self.join_lines(front, back)
    }

    fn extend_front(&mut self, line: LineId, by: u32) -> Result<(), TransportError> {
        self.extend(line, by, true)
    }

    fn extend_back(&mut self, line: LineId, by: u32) -> Result<(), TransportError> {
        self.extend(line, by, false)
    }

    fn shrink_front(&mut self, line: LineId, by: u32) -> Result<(), TransportError> {
        self.shrink(line, by, true)
    }

    fn shrink_back(&mut self, line: LineId, by: u32) -> Result<(), TransportError> {
        self.shrink(line, by, false)
    }

    fn rescale(&mut self, line: LineId, new_len: u32) -> Result<(), TransportError> {
        self.rescale_line(line, new_len)
    }

    fn take_front(&mut self, line: LineId) -> Result<Option<Item>, TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        let r = self.take_front_slot(slot).map(Item);
        if r.is_some() {
            self.fc.invalidate(slot);
        }
        Ok(r)
    }

    fn set_segments(&mut self, line: LineId, segs: &[Segment]) -> Result<(), TransportError> {
        self.set_segments_line(line, segs)
    }

    fn set_out(&mut self, line: LineId, out: Output) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        if self.lines[slot as usize].out == out {
            // The same output again is a no-op (M44 review): a game re-applying a region's
            // outputs must not reset its forks' toggles or recompute the order.
            return Ok(());
        }
        let speed = u32::from(self.lines[slot as usize].speed);
        // 0079 §8 (M42 review): a landing `target.len + p` with `p >= -speed` is never negative
        // only if the target is at least one tick's travel long (`Next` and both `Fork` targets;
        // a `Merge` landing is clamped instead).
        let fits = |t: &Transport, s: u32| t.lines[s as usize].len >= speed;
        let (next_slot, alt_slot) = match out {
            Output::DeadEnd | Output::Sink => (NIL, NIL),
            Output::Next(t) | Output::Merge { line: t, .. } => {
                if t == line {
                    return Err(TransportError::Unsupported);
                }
                let ts = self.slot(t).ok_or(TransportError::NoLine)?;
                if matches!(out, Output::Next(_)) && !fits(self, ts) {
                    return Err(BadSpeed);
                }
                (ts, NIL)
            }
            Output::Fork { a, b } => {
                if a == line || b == line || a == b {
                    return Err(TransportError::Unsupported);
                }
                let sa = self.slot(a).ok_or(TransportError::NoLine)?;
                let sb = self.slot(b).ok_or(TransportError::NoLine)?;
                if !fits(self, sa) || !fits(self, sb) {
                    return Err(BadSpeed);
                }
                (sa, sb)
            }
        };
        if let Output::Next(old) = self.lines[slot as usize].out {
            self.fc.next_changed(self.lines[slot as usize].id, old);
        }
        let rec = &mut self.lines[slot as usize];
        rec.out = out;
        rec.next_slot = next_slot;
        rec.alt_slot = alt_slot;
        // A changed output starts preferring `a` (the toggle is only ever set on a fork).
        rec.toggle = false;
        rec.jam_valid = false;
        self.graph_dirty = true;
        self.touch_motion(slot);
        Ok(())
    }

    fn set_speed(&mut self, line: LineId, speed: u16) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        let rec = self.lines[slot as usize];
        if speed == 0 || u32::from(speed) >= rec.len {
            return Err(BadSpeed);
        }
        // The hand-off bound (`set_out`): `Next` and `Fork` targets at least `speed` long.
        if rec
            .bound_targets()
            .iter()
            .any(|&s| s != NIL && self.lines[s as usize].len < u32::from(speed))
        {
            return Err(BadSpeed);
        }
        self.lines[slot as usize].speed = speed;
        self.touch_motion(slot);
        // M47: a declared spawner's insert this tick may have landed by the old speed, which the
        // client's replay (under the new structure) cannot know: the line's list is resent.
        if rec.speed != speed {
            self.fc.spawner_speed_changed(slot);
        }
        Ok(())
    }

    fn insert_back(&mut self, line: LineId, item: Item) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        if self.lines[slot as usize].sched.is_some() {
            debug_assert!(
                false,
                "insert_back on {line:?}, whose schedule is state: the engine inserts there (0079 §21)"
            );
            return Err(TransportError::Scheduled);
        }
        if item.0 == 0 {
            return Err(TransportError::BadItem);
        }
        let speed = self.lines[slot as usize].speed;
        let r = if self.items >= self.max_items {
            Err(Full)
        } else {
            self.insert_back_slot(slot, item.0)
        };
        // M47: the tracker sees the spawner's outcome and extends the line's model.
        let pos = self.lines[slot as usize].tail_pos;
        self.fc.insert_back(slot, r, item, pos, speed);
        r
    }

    fn insert_at(&mut self, line: LineId, pos: u32, item: Item) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        if item.0 == 0 {
            return Err(TransportError::BadItem);
        }
        if self.items >= self.max_items {
            return Err(Full);
        }
        let r = self.insert_at_slot(slot, pos, item.0);
        if r.is_ok() {
            // M47: an inserter's item the forecast cannot derive: the line's list is resent.
            self.fc.invalidate(slot);
        }
        r
    }

    fn remove_at(&mut self, line: LineId, pos: u32) -> Result<Option<Item>, TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        let r = self.remove_at_slot(slot, pos).map(Item);
        if r.is_some() {
            self.fc.invalidate(slot);
        }
        Ok(r)
    }

    fn set_spawner(&mut self, line: LineId, s: Option<Schedule>) -> Result<(), TransportError> {
        let slot = self.slot(line).ok_or(TransportError::NoLine)?;
        if let Some(s) = s {
            if s.period < MIN_PERIOD {
                return Err(TransportError::BadPeriod);
            }
            if s.next.0 == 0 {
                return Err(TransportError::BadItem);
            }
        }
        let had = self.lines[slot as usize].sched.is_some();
        if !had && s.is_none() {
            // Nothing to clear; a `declare_spawner` declaration on the line stays.
            return Ok(());
        }
        if !had && !self.fc.sched_room(slot) {
            return Err(TransportError::Full);
        }
        self.lines[slot as usize].sched = s.map(|s| line::LineSched { s, paused: false });
        match (had, s.is_some()) {
            (false, true) => self.list_sched(slot),
            (true, false) => self.unlist_sched(slot),
            _ => {}
        }
        self.changed = true;
        // The tracker replays it from the next tick and resends the line's list now (it carries
        // the schedule as this tick's step leaves it).
        self.fc.set_spawner(slot, s);
        Ok(())
    }

    fn declare_spawner(&mut self, line: LineId, s: Option<Schedule>) {
        let valid = s.is_none_or(|s| s.period != 0 && s.next.0 != 0);
        match self.slot(line) {
            Some(slot) if valid && self.lines[slot as usize].sched.is_none() => {
                self.fc.set_spawner(slot, s)
            }
            _ => self.fc.counters.spawner_declarations_dropped += 1,
        }
    }
}
