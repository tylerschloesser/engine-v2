//! Fixture game `fx-belts` (M40 onward; docs/architecture/transport.md): the home of every engine
//! belt test. Belts are the engine's `engine::transport` module (docs/decisions/0076) exercised
//! without the reference game's rules (0076 §9: "engine tests never use the reference game").
//!
//! **The request pattern (M42b).** 0076 §6 forbids `apply` from touching lines, so every topology
//! change is a request: `Action::Request(op)` validates the op's shape and spawns one
//! [`Thing::Request`] entity, and nothing else. That apply-time spawn auto-wakes into the same
//! tick's `next_woken` (0046; `fx-machines`'s `Feed` pattern), where [`Belts::tick`] executes the
//! op through `transport_mut()` and despawns the request. Requests of one tick execute in spawn
//! order (`next_woken` is insertion order), so a scenario's ops run in the order it lists them.
//!
//! **Line ids.** `create` hands out the ids; scenarios name lines by the order of their `Chain`
//! requests instead. [`Global::lines`] is that table (index `i` is the `i`-th `Chain` ever
//! executed; `0` is none): `Chain` appends its new id (or `0` when `create` refused, so later
//! indices stay aligned), and every other op indexes it. Once the table is full (32 chains) a
//! `Chain` request creates nothing.
//!
//! **Spawners.** `Op::Spawner` turns its request entity, in place, into a [`Thing::Spawner`] on
//! the `"spawner"` active list. **The engine's schedule (M53, 0079 §21):** on the tick a spawner
//! joins the list (a request's tick, or tick 1 for a genesis spawner) it gives its line the
//! schedule `set_spawner(line, Schedule { period, acc, kinds, next })` (`kinds` 0 for a
//! [`Thing::Spawner`], [`CYCLE_KINDS`] for a [`Thing::Cycling`]; `next` its item), once, and from
//! then on neither inserts nor writes: the engine runs the rule at the start of every `advance`
//! (that same tick first). Every tick the schedule adds 256 to its accumulator; when the
//! accumulator reaches `period` (ticks per item in 1/256 tick, at least 256) the engine makes
//! exactly one `insert_back` attempt: accepted, `acc -= period`; refused (`NoRoom`, `Full`), `acc
//! -= 256`, so the credit is held and the next tick is due again, never a burst. `period = 256`
//! tries every tick (a saturating feed). The schedule is the line's state (saved, restored, carried
//! to the back piece by surgery, dropped with the line), the forecast tracker and the client
//! replay the same rule, so the line's inserts reach clients as forecasts, not arrivals, and no
//! `Game::declare_spawners` is needed. The entity's `acc` and `spawned` stay as it joined (shape
//! only); the engine counts the inserts (`Transport::scheduled_inserts_total`, store-wide, tests and tools).
//!
//! **Surgery, items and geometry (M43b).** `Cut`, `Join`, `Extend`, `Shrink`, `Rescale`, `Insert`,
//! `Remove`, `TakeFront` and `Segments` run M43's API the same way. `Cut` appends the new back line
//! to the table (or `0` when `split` refuses, as `Chain` does); `Join` destroys `back`, whose slot
//! keeps its dead id (the engine answers `NoLine` from then on). Every accepted `Insert`, `Remove`
//! and `TakeFront` is counted in the one [`Thing::Tally`] on the `"tally"` active list: the first
//! success turns its own request into the tally, in place, as a `Spawner` request does.
//! An op that changes a line's `len` clears its segments (0079 §13); a scenario re-sends `Segments`.
//!
//! **Merge and fork (M44b).** `Merge { line, into, at }` and `Fork { line, a, b }` are `set_out`
//! with M44's `Output::Merge`/`Output::Fork` (rules: 0079 §15); a refusal (`a == b`, a self-target,
//! a fork target shorter than the feeder's speed, a missing line) is dropped like every other op's.
//! `ForkPair { line, a, b, partner }` (M61) pairs two inputs of one fork (`partner` already a
//! `Fork` onto `a` and `b`): the engine's input turn and shared toggle.
//! `Destroy { line }` runs `destroy` and counts the deleted items in one [`Thing::Destroyed`] on
//! the `"destroyed"` active list (the property tests' conservation needs it). `Speed { line,
//! speed }` (M46) is `set_speed`, for the netcode scenario's structure changes.
//!
//! **A read in `apply` (M48b).** [`Action::Probe`] is the one action whose `apply` reads a line: it
//! asks `lines_at` whether a line enters its tile, rejects `Occupied` if one does, and otherwise
//! spawns an `Op::Belt` request (a `Chain` with its straight segment and an item at rest at every
//! tile). A client's `Predicting` answers `Unknown` to every transport read, so the action is
//! `NotPredictable` there; the host runs it as any other request.
//!
//! **The bench world (M45).** `BeltsParams.bench` builds M40's standard `Mixed` world at genesis
//! ([`bench`]); its mixed-kind chains' spawners are [`Thing::Cycling`] (the item steps through
//! `1..=CYCLE_KINDS`), a variant only the bench genesis makes. Its regime (M47b,
//! [`bench::BenchRegime`]) may instead build M44b's `SaturatedView` (with [`Thing::Jam`]s, the
//! scheduled sink toggles), `InserterLike` (with one [`Thing::Inserter`]), `Mixed` empty at the
//! start, or (M48c) `MixedFeeders`, `Mixed` with a [`Thing::Feeder`] in place of every spawner;
//! these schedule entities ride the `"spawner"` list and are made only by the bench genesis.
//!
//! **Feeders (M48c).** A [`Thing::Feeder`] keeps no state and is never written: on the tick it
//! joins the list it gives its line `Schedule { period: 256, acc: 0, kinds: 0, next: item }`, one
//! `insert_back` attempt of its item a tick, a refusal dropped. Since M53 a [`Thing::Spawner`] is
//! the same shape (the schedule is the line's state), so neither costs a chunk delta (0079 §19
//! (e)).
//!
//! **The client (M49, [`client`]).** `extract` draws every visible item through the engine's
//! `draw_items` with a fixture style (sprite = kind mod 3, half a tile, colour by kind, layer 2).
//!
//! Goldens (`golden/scenario-*.json`, `tests/golden_scenarios.rs`): `straight-chain` (also the
//! canonical `scenario.json`), `deadend-backup`, `spawn-to-sink`, `big-step`, `edit-while-running`,
//! `inserter-like`, `geometry-arc`, `sideload-saturated`, `sideload-contested`, `fork-50-50`,
//! `fork-blocked-side`, `big-step-fork`, `forty-actions`. `CLAUDE.md` has the detail.

use engine::game::{
    EntityId, Game, Growth, PlayerEvent, PlayerId, PresenceTable, TickCx, Unknown, WorldRead,
    WorldWrite,
};
use engine::transport::{Geometry, Item, LineId, Output, Schedule, Segment, TransportError};
use engine::world::{
    ChunkCoord, Footprint, PrototypeId, Registry, SystemId, Tile, TilePos, TraitSet, WorldPos,
};
use engine::worldgen::Worldgen;

pub mod client;
use ts_rs::TS;

pub mod bench;
pub use bench::{BeltsParams, BenchRegime, BenchSpec};

/// Capacity of [`Global::lines`]: chains a world can name.
pub const MAX_CHAINS: u32 = 32;
/// Items `Op::Chain` can place at rest.
pub const REST_SLOTS: u32 = 8;
/// Positions per tile (0076 §1: 1/256 tile).
pub const TILE: u32 = 256;
/// Item kinds a [`Thing::Cycling`] spawner steps through (M40's `KINDS`).
pub const CYCLE_KINDS: u16 = 6;

/// The spawner active list (`Belts::register`); the `fx-machines` `SPINNER_SYS` pattern:
/// `Registry::system` hands out the same id for every `Registry`, so one process-wide value holds.
static SPAWNER_SYS: std::sync::OnceLock<SystemId> = std::sync::OnceLock::new();

fn spawner_sys() -> SystemId {
    *SPAWNER_SYS
        .get()
        .expect("Belts::register must run before Belts::tick")
}

/// The tally's active list (at most one member, [`Thing::Tally`]); `SPAWNER_SYS`'s pattern.
static TALLY_SYS: std::sync::OnceLock<SystemId> = std::sync::OnceLock::new();

fn tally_sys() -> SystemId {
    *TALLY_SYS
        .get()
        .expect("Belts::register must run before Belts::tick")
}

/// The destroyed-items counter's active list (at most one member, [`Thing::Destroyed`]).
static DESTROYED_SYS: std::sync::OnceLock<SystemId> = std::sync::OnceLock::new();

fn destroyed_sys() -> SystemId {
    *DESTROYED_SYS
        .get()
        .expect("Belts::register must run before Belts::tick")
}

/// A tile position, plain data (`Action` must stay `Codec + TS`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

impl Pos {
    fn tile(self) -> TilePos {
        TilePos::new(self.x, self.y)
    }
}

/// A world position in Q24.8 (1/256 tile, `WorldPos`), plain data for [`Seg`].
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct WPos {
    pub x: i32,
    pub y: i32,
}

impl WPos {
    fn world(self) -> WorldPos {
        WorldPos {
            x: self.x,
            y: self.y,
        }
    }
}

/// One segment of an `Op::Segments` path, plain data for `engine::transport::Segment` (0076 §4;
/// the mapping is `geometry.rs`'s module doc). `None` entries are skipped, so a path of `k < 4`
/// segments lists `4 - k` of them.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Seg {
    #[default]
    None,
    Straight {
        len: u32,
        from: WPos,
        to: WPos,
    },
    Arc {
        len: u32,
        centre: WPos,
        radius_q8: u32,
        start_turn_q8: u16,
        sweep_q8: i16,
    },
}

impl Seg {
    fn segment(self) -> Option<Segment> {
        match self {
            Seg::None => None,
            Seg::Straight { len, from, to } => Some(Segment {
                len,
                geometry: Geometry::Straight {
                    from: from.world(),
                    to: to.world(),
                },
            }),
            Seg::Arc {
                len,
                centre,
                radius_q8,
                start_turn_q8,
                sweep_q8,
            } => Some(Segment {
                len,
                geometry: Geometry::Arc {
                    centre: centre.world(),
                    radius_q8,
                    start_turn_q8,
                    sweep_q8,
                },
            }),
        }
    }
}

/// A chain's direction. Recorded, not used: the fixture computes no geometry (M43 registers it).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Dir {
    #[default]
    East,
    South,
    West,
    North,
}

/// One topology request (M42b), executed by `Belts::tick`. Lines are named by index into
/// [`Global::lines`] (module doc).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Op {
    /// One line (one lane) of `tiles x 256` positions at `speed`, `DeadEnd` output, appended to
    /// the table; then each `(item, pos)` of `items_at_rest` with `item != 0` lands by `insert_at`
    /// (a refused one is skipped). A belt is two chains.
    Chain {
        from: Pos,
        dir: Dir,
        tiles: u16,
        speed: u16,
        #[serde(default)]
        items_at_rest: [(u16, u32); 8], // REST_SLOTS
    },
    /// `set_out(from_line, Next(to_line))`: a plain hand-off.
    Link { from_line: u8, to_line: u8 },
    /// A spawner of `item` on `line`, one item per `period / 256` ticks at most (module doc).
    Spawner { line: u8, item: u16, period: u32 },
    /// `set_out(line, Sink)`.
    Sink { line: u8 },
    /// `set_out(line, DeadEnd)`.
    DeadEnd { line: u8 },
    /// `split(line, at)`: the new back line `[at, len)` is appended to the table (`0` if refused).
    Cut { line: u8, at: u32 },
    /// `join(front, back)` (`back` must feed `front`); `back`'s slot keeps its dead id.
    Join { front: u8, back: u8 },
    /// `extend_front` (`front`) or `extend_back` by `by` positions.
    Extend { line: u8, front: bool, by: u32 },
    /// `shrink_front` (`front`) or `shrink_back` by `by` positions.
    Shrink { line: u8, front: bool, by: u32 },
    /// `rescale(line, new_len)`: every position scaled by `new_len / len`, rounding down.
    Rescale { line: u8, new_len: u32 },
    /// `insert_at(line, pos, item)`, counted in the tally when accepted.
    Insert { line: u8, pos: u32, item: u16 },
    /// `remove_at(line, pos)`, counted in the tally when it removed an item.
    Remove { line: u8, pos: u32 },
    /// `take_front(line)`, counted in the tally when it took an item.
    TakeFront { line: u8 },
    /// `set_segments(line, ..)` with the non-`None` entries, front to back (all `None` clears).
    Segments { line: u8, segments: [Seg; 4] },
    /// `set_out(line, Merge { line: into, at })`: a side-load onto `into` at position `at` (M44b).
    Merge { line: u8, into: u8, at: u32 },
    /// `set_out(line, Fork { a, b })`: alternate items between `a` and `b` (M44b).
    Fork { line: u8, a: u8, b: u8 },
    /// `destroy(line)`: its items are counted in [`Thing::Destroyed`]; its slot keeps the dead id.
    Destroy { line: u8 },
    /// `set_speed(line, speed)` (M46: a structure change the netcode scenario replicates).
    Speed { line: u8, speed: u16 },
    /// A `Chain` with its path (M48b, what [`Action::Probe`] requests): `tiles x 256` positions at
    /// `speed`, appended to the table as `Chain` is, one straight segment east through the tile
    /// centres from `from` (position 0, the front, at `from`), and `item` at rest at every whole
    /// tile from the front (`0`: none). Appended last, so no encoded op moved.
    Belt {
        from: Pos,
        tiles: u16,
        speed: u16,
        item: u16,
    },
    /// `set_out(line, Fork { a, b, partner })` (M61): a splitter lane's input paired with
    /// `partner`, which must already fork onto `a` and `b` (a `Fork` op first, then this one: the
    /// engine links the partner back). The two take turns and share one toggle. Appended last, so
    /// no encoded op moved.
    ForkPair { line: u8, a: u8, b: u8, partner: u8 },
}

impl Op {
    /// The shape check `apply` makes (validate first, write after); the engine checks the rest
    /// when the op executes.
    fn valid(&self) -> bool {
        let idx = |i: u8| u32::from(i) < MAX_CHAINS;
        match *self {
            Op::Chain {
                from, tiles, speed, ..
            } => from.tile().in_range() && tiles >= 1 && speed >= 1,
            Op::Link { from_line, to_line } => idx(from_line) && idx(to_line),
            Op::Spawner { line, item, period } => idx(line) && item != 0 && period >= 256,
            Op::Sink { line }
            | Op::DeadEnd { line }
            | Op::Remove { line, .. }
            | Op::TakeFront { line }
            | Op::Segments { line, .. } => idx(line),
            Op::Cut { line, at } => idx(line) && at >= 1,
            Op::Join { front, back } => idx(front) && idx(back),
            Op::Extend { line, by, .. } | Op::Shrink { line, by, .. } => idx(line) && by >= 1,
            Op::Rescale { line, new_len } => idx(line) && new_len >= 1,
            Op::Insert { line, item, .. } => idx(line) && item != 0,
            Op::Merge { line, into, .. } => idx(line) && idx(into),
            Op::Fork { line, a, b } => idx(line) && idx(a) && idx(b),
            Op::ForkPair {
                line,
                a,
                b,
                partner,
            } => idx(line) && idx(a) && idx(b) && idx(partner),
            Op::Destroy { line } => idx(line),
            Op::Speed { line, speed } => idx(line) && speed >= 1,
            // The far end tile too: `execute` computes its centre in `i32` (M48b review).
            Op::Belt {
                from, tiles, speed, ..
            } => {
                from.tile().in_range()
                    && from
                        .x
                        .checked_add(i32::from(tiles))
                        .is_some_and(|x| TilePos::new(x, from.y).in_range())
                    && tiles >= 1
                    && speed >= 1
            }
        }
    }

    /// The request entity's anchor: a chain's own start tile, else the origin.
    fn anchor(&self) -> Pos {
        match *self {
            Op::Chain { from, .. } | Op::Belt { from, .. } => from,
            _ => Pos::default(),
        }
    }
}

/// `Noop` stays first so pre-existing encoded values keep their variant index.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    Noop,
    /// Spawns a [`Thing::Request`] for `Belts::tick` to execute (module doc).
    Request(Op),
    /// M48b: places a belt at `tile` only where no line is. `apply` reads the line index
    /// (`lines_at`), so on a client the action is `NotPredictable` (`Predicting` answers `Unknown`
    /// to every transport read, 0079 §17 (f)); on the host it spawns an `Op::Belt` request of
    /// [`PROBE_TILES`] tiles at speed [`PROBE_SPEED`] with item [`PROBE_ITEM`] at every tile, or
    /// rejects `Occupied`. Appended last, so no encoded action moved.
    Probe {
        tile: Pos,
    },
}

/// What [`Action::Probe`] places: tiles, speed and item at rest of its `Op::Belt`.
pub const PROBE_TILES: u16 = 4;
pub const PROBE_SPEED: u16 = 24;
pub const PROBE_ITEM: u16 = 1;

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Reject {
    /// A read the handler tried missed (`Unknown`): only reachable on a predicting client.
    Unknown,
    /// `Request`: the op's shape is invalid (`Op::valid`).
    BadOp,
    /// `Probe`: a line already enters the tile (M48b; appended last).
    Occupied,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// A pending request: plain data, lives from `apply` to the same tick's `Belts::tick`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct Request {
    pub at: Pos,
    pub op: Op,
}

/// A spawner on the `"spawner"` active list (module doc for the rule). Since M53 its line's
/// schedule runs it; `acc` and `spawned` keep the values it joined with (the engine counts the
/// inserts store-wide: `Transport::scheduled_inserts_total`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct Spawner {
    pub at: Pos,
    pub line: u32,
    pub item: u16,
    pub period: u32,
    pub acc: u32,
    /// Always 0 since M53 (shape only).
    pub spawned: u32,
}

impl Spawner {
    /// The schedule this spawner gives its line when it joins the list (module doc): a cycling
    /// one's `k`-th accepted insert is kind `(item - 1 + k) % CYCLE_KINDS + 1`.
    fn schedule(&self, cycling: bool) -> Schedule {
        Schedule {
            period: self.period,
            acc: self.acc,
            kinds: if cycling { CYCLE_KINDS } else { 0 },
            next: Item(if cycling { self.item.max(1) } else { self.item }),
        }
    }
}

/// A scheduled sink toggle of the `SaturatedView` bench world (M47b, M44b's `Toggle`): `line` is a
/// `Sink` while `(tick + phase) % period >= period / 2` and a `DeadEnd` otherwise, set by
/// `set_out` on the ticks it changes. Never written after genesis.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct Jam {
    pub at: Pos,
    pub line: u32,
    pub phase: u16,
    pub period: u16,
}

/// The `InserterLike` bench world's edits (M47b; M40's inserter-like calls): `calls` per tick,
/// each an `insert_at` or a `remove_at` on one of the `lines` lines from `first`, at a position
/// drawn from `(seed, tick, call)` by a stateless mix (no state to encode). Never written.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct Inserter {
    pub at: Pos,
    pub first: u32,
    pub lines: u32,
    pub calls: u32,
    pub seed: u32,
}

/// A stateless feeder of the `MixedFeeders` bench world (M48c, module doc): one `insert_back`
/// attempt of `item` on `line` a tick. Never written after genesis.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct Feeder {
    pub at: Pos,
    pub line: u32,
    pub item: u16,
}

impl Feeder {
    /// The schedule a feeder gives its line: an attempt every tick.
    fn schedule(&self) -> Schedule {
        Schedule {
            period: 256,
            acc: 0,
            kinds: 0,
            next: Item(self.item),
        }
    }
}

/// SplitMix64's finaliser: the inserter's per-call draw.
fn mix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Accepted item requests over the world's life (module doc): the inserter-like conservation
/// `inserted + spawned == live + removed + taken + sunk`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Tally {
    pub inserted: u32,
    pub removed: u32,
    pub taken: u32,
}

/// The one entity type (0022 §3: a single `G::Entity`), one variant per kind (new kinds appended,
/// so earlier encoded values keep their variant index).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub enum Thing {
    Request(Request),
    Spawner(Spawner),
    Tally(Tally),
    /// Items deleted by accepted `Destroy` requests over the world's life (M44b), on the
    /// `"destroyed"` active list; made from the first such request, as the tally is. Separate from
    /// [`Tally`] so the tally's encoding, and the goldens holding one, did not change.
    Destroyed(u32),
    /// A spawner whose item cycles (M45, made only by the bench genesis, [`bench`]): the `k`-th
    /// accepted insert is kind `(item - 1 + k) % CYCLE_KINDS + 1`, M40's mixed-kind chains ("runs
    /// that never merge", 0077 §2). Its own variant rather than a field of [`Spawner`], so every
    /// golden holding a spawner keeps its encoding, and `Op::Spawner`'s `item` keeps its meaning.
    Cycling(Spawner),
    /// A scheduled sink toggle (M47b, the `SaturatedView` bench world only), on the `"spawner"` list.
    Jam(Jam),
    /// The `InserterLike` bench world's edits (M47b), on the `"spawner"` list.
    Inserter(Inserter),
    /// A stateless feeder (M48c, the `MixedFeeders` bench world only), on the `"spawner"` list.
    Feeder(Feeder),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player;

/// The chain table (module doc): `lines[i]` is the `i`-th chain's `LineId`, `0` none.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global {
    pub chains: u32,
    pub lines: [u32; 32], // `MAX_CHAINS`, a literal for the serialized-types scan
}

impl Global {
    /// The `LineId` of chain `i`, `NONE` when absent.
    pub fn line(&self, i: u32) -> LineId {
        LineId(if i < self.chains.min(MAX_CHAINS) {
            self.lines[i as usize]
        } else {
            0
        })
    }
}

pub struct Belts;

impl Belts {
    /// Counts one accepted item request in the tally. The first one ever turns request `id` itself
    /// into the tally and returns `true` (the caller must not despawn it).
    fn count(cx: &mut TickCx<'_, Self>, id: EntityId, f: fn(&mut Tally)) -> bool {
        let sys = tally_sys();
        if let Some(tid) = cx.active_at(sys, 0)
            && let Some(Thing::Tally(mut c)) = cx.entity(tid).ok().flatten().copied()
        {
            f(&mut c);
            cx.put_entity(tid, Thing::Tally(c));
            return false;
        }
        let mut c = Tally::default();
        f(&mut c);
        cx.put_entity(id, Thing::Tally(c));
        cx.activate(sys, id);
        true
    }

    /// Adds `n` destroyed items to the counter; [`Self::count`]'s pattern (the first accepted
    /// `Destroy` turns request `id` into the counter and returns `true`).
    fn count_destroyed(cx: &mut TickCx<'_, Self>, id: EntityId, n: u32) -> bool {
        let sys = destroyed_sys();
        if let Some(did) = cx.active_at(sys, 0)
            && let Some(Thing::Destroyed(was)) = cx.entity(did).ok().flatten().copied()
        {
            if n > 0 {
                cx.put_entity(did, Thing::Destroyed(was + n));
            }
            return false;
        }
        cx.put_entity(id, Thing::Destroyed(n));
        cx.activate(sys, id);
        true
    }

    /// Executes one request's op (host tick only). Refusals are dropped: a request that cannot
    /// apply changes nothing but the table (`Chain` appends `0`).
    fn execute(cx: &mut TickCx<'_, Self>, id: EntityId, req: Request) {
        let mut g = *cx.global();
        let Ok(t) = cx.transport_mut() else {
            return; // unreachable from `tick` (TickCx answers `Ok`).
        };
        match req.op {
            Op::Chain {
                tiles,
                speed,
                items_at_rest,
                ..
            } => {
                if g.chains >= MAX_CHAINS {
                    // A full table: no op could name the line, so none is created.
                    cx.despawn(id);
                    return;
                }
                let line = t
                    .create(u32::from(tiles) * TILE, speed)
                    .unwrap_or(LineId::NONE);
                if line != LineId::NONE {
                    for (item, pos) in items_at_rest {
                        if item != 0 {
                            let _ = t.insert_at(line, pos, Item(item));
                        }
                    }
                }
                g.lines[g.chains as usize] = line.0;
                g.chains += 1;
                cx.put_global(g);
            }
            Op::Link { from_line, to_line } => {
                let to = g.line(u32::from(to_line));
                let _ = t.set_out(g.line(u32::from(from_line)), Output::Next(to));
            }
            Op::Sink { line } => {
                let _ = t.set_out(g.line(u32::from(line)), Output::Sink);
            }
            Op::DeadEnd { line } => {
                let _ = t.set_out(g.line(u32::from(line)), Output::DeadEnd);
            }
            Op::Spawner { line, item, period } => {
                let line = g.line(u32::from(line));
                if line != LineId::NONE {
                    let s = Spawner {
                        at: req.at,
                        line: line.0,
                        item,
                        period,
                        acc: 0,
                        spawned: 0,
                    };
                    cx.put_entity(id, Thing::Spawner(s));
                    cx.activate(spawner_sys(), id);
                    return; // the entity lives on as the spawner.
                }
            }
            Op::Cut { line, at } => {
                if g.chains >= MAX_CHAINS {
                    // A full table: the back part could not be named, so nothing is cut.
                    cx.despawn(id);
                    return;
                }
                let back = t.split(g.line(u32::from(line)), at).unwrap_or(LineId::NONE);
                g.lines[g.chains as usize] = back.0;
                g.chains += 1;
                cx.put_global(g);
            }
            Op::Join { front, back } => {
                let _ = t.join(g.line(u32::from(front)), g.line(u32::from(back)));
            }
            Op::Extend { line, front, by } => {
                let l = g.line(u32::from(line));
                let _ = if front {
                    t.extend_front(l, by)
                } else {
                    t.extend_back(l, by)
                };
            }
            Op::Shrink { line, front, by } => {
                let l = g.line(u32::from(line));
                let _ = if front {
                    t.shrink_front(l, by)
                } else {
                    t.shrink_back(l, by)
                };
            }
            Op::Rescale { line, new_len } => {
                let _ = t.rescale(g.line(u32::from(line)), new_len);
            }
            Op::Insert { line, pos, item } => {
                if t.insert_at(g.line(u32::from(line)), pos, Item(item))
                    .is_ok()
                    && Self::count(cx, id, |c| c.inserted += 1)
                {
                    return; // the request became the tally.
                }
            }
            Op::Remove { line, pos } => {
                if let Ok(Some(_)) = t.remove_at(g.line(u32::from(line)), pos)
                    && Self::count(cx, id, |c| c.removed += 1)
                {
                    return;
                }
            }
            Op::TakeFront { line } => {
                if let Ok(Some(_)) = t.take_front(g.line(u32::from(line)))
                    && Self::count(cx, id, |c| c.taken += 1)
                {
                    return;
                }
            }
            Op::Segments { line, segments } => {
                let mut segs = [Segment {
                    len: 0,
                    geometry: Geometry::Straight {
                        from: WorldPos { x: 0, y: 0 },
                        to: WorldPos { x: 0, y: 0 },
                    },
                }; 4];
                let mut n = 0;
                for s in segments.iter().filter_map(|s| s.segment()) {
                    segs[n] = s;
                    n += 1;
                }
                let _ = t.set_segments(g.line(u32::from(line)), &segs[..n]);
            }
            Op::Merge { line, into, at } => {
                let into = g.line(u32::from(into));
                let _ = t.set_out(g.line(u32::from(line)), Output::Merge { line: into, at });
            }
            Op::Fork { line, a, b } => {
                let (a, b) = (g.line(u32::from(a)), g.line(u32::from(b)));
                let _ = t.set_out(
                    g.line(u32::from(line)),
                    Output::Fork {
                        a,
                        b,
                        partner: None,
                    },
                );
            }
            Op::Destroy { line } => {
                if let Ok(n) = t.destroy(g.line(u32::from(line)), &mut |_| {})
                    && Self::count_destroyed(cx, id, n)
                {
                    return; // the request became the counter.
                }
            }
            Op::Speed { line, speed } => {
                let _ = t.set_speed(g.line(u32::from(line)), speed);
            }
            Op::ForkPair {
                line,
                a,
                b,
                partner,
            } => {
                let [a, b, partner] = [a, b, partner].map(|i| g.line(u32::from(i)));
                let fork = Output::Fork {
                    a,
                    b,
                    partner: Some(partner),
                };
                let _ = t.set_out(g.line(u32::from(line)), fork);
            }
            Op::Belt {
                from,
                tiles,
                speed,
                item,
            } => {
                if g.chains >= MAX_CHAINS {
                    cx.despawn(id);
                    return;
                }
                let len = u32::from(tiles) * TILE;
                let line = t.create(len, speed).unwrap_or(LineId::NONE);
                if line != LineId::NONE {
                    let centre = |x: i32| WorldPos {
                        x: x * TILE as i32 + TILE as i32 / 2,
                        y: from.y * TILE as i32 + TILE as i32 / 2,
                    };
                    let seg = Segment {
                        len,
                        geometry: Geometry::Straight {
                            from: centre(from.x),
                            to: centre(from.x + i32::from(tiles)),
                        },
                    };
                    let _ = t.set_segments(line, &[seg]);
                    if item != 0 {
                        for k in 0..u32::from(tiles) {
                            let _ = t.insert_at(line, k * TILE, Item(item));
                        }
                    }
                }
                g.lines[g.chains as usize] = line.0;
                g.chains += 1;
                cx.put_global(g);
            }
        }
        cx.despawn(id);
    }
}

impl Belts {
    /// A [`Jam`]'s toggle at tick `now`: its line's output follows the schedule.
    fn jam(cx: &mut TickCx<'_, Self>, j: Jam, now: u32) {
        let closed = j.period > 0
            && (now.wrapping_add(u32::from(j.phase))) % u32::from(j.period)
                < u32::from(j.period / 2);
        let want = if closed {
            Output::DeadEnd
        } else {
            Output::Sink
        };
        if let Ok(t) = cx.transport_mut()
            && t.out(LineId(j.line)).is_ok_and(|o| o != want)
        {
            let _ = t.set_out(LineId(j.line), want);
        }
    }

    /// An [`Inserter`]'s calls at tick `now` (refusals dropped).
    fn insert(cx: &mut TickCx<'_, Self>, ins: Inserter, now: u32) {
        let Ok(t) = cx.transport_mut() else {
            return;
        };
        if ins.lines == 0 {
            return;
        }
        for k in 0..ins.calls {
            let h = mix((u64::from(ins.seed) << 32 | u64::from(now)) ^ (u64::from(k) << 48));
            let line = LineId(ins.first + (h % u64::from(ins.lines)) as u32);
            let Ok(len) = t.len(line) else {
                continue;
            };
            let pos = ((h >> 16) % u64::from(len.max(1))) as u32;
            if (h >> 48) & 1 == 0 {
                let item = ((h >> 49) % u64::from(CYCLE_KINDS)) as u16 + 1;
                let _ = t.insert_at(line, pos, Item(item));
            } else {
                let _ = t.remove_at(line, pos);
            }
        }
    }
}

impl Game for Belts {
    const SCHEMA_VERSION: u32 = 2;
    type Worldgen = FlatWorldgen;
    type Action = Action;
    type Reject = Reject;
    type Entity = Thing;
    type Player = Player;
    type Global = Global;
    type Presence = ();
    type Ui = ();
    type Client = client::BeltsClient;

    fn register(r: &mut Registry) {
        let id = r.add_prototype(TraitSet::EMPTY, Footprint { w: 1, h: 1 });
        debug_assert_eq!(id, PrototypeId(0));
        let _ = SPAWNER_SYS.set(r.system("spawner"));
        let _ = TALLY_SYS.set(r.system("tally"));
        let _ = DESTROYED_SYS.set(r.system("destroyed"));
    }

    fn prototype(_e: &Thing) -> PrototypeId {
        PrototypeId(0)
    }

    fn anchor(e: &Thing) -> TilePos {
        match e {
            Thing::Request(r) => r.at.tile(),
            Thing::Spawner(s) | Thing::Cycling(s) => s.at.tile(),
            Thing::Jam(j) => j.at.tile(),
            Thing::Inserter(i) => i.at.tile(),
            Thing::Feeder(f) => f.at.tile(),
            Thing::Tally(_) | Thing::Destroyed(_) => TilePos::new(0, 0),
        }
    }

    /// An empty world, or the bench world when the worldgen carried a spec ([`bench`]).
    fn genesis(w: &mut dyn WorldWrite<Self>) {
        w.put_global(Global::default());
        if let Some(spec) = bench::marker(w) {
            bench::build(w, spec);
        }
    }

    fn on_player(w: &mut dyn WorldWrite<Self>, who: PlayerId, ev: PlayerEvent) {
        if let PlayerEvent::Joined = ev {
            w.put_player(who, Player);
        }
    }

    /// Validates the op's shape, then spawns the request: never `transport_mut()` (0076 §6).
    fn apply(w: &mut dyn WorldWrite<Self>, _who: PlayerId, a: &Action) -> Result<(), Reject> {
        match a {
            Action::Noop => Ok(()),
            Action::Request(op) => {
                if !op.valid() {
                    return Err(Reject::BadOp);
                }
                w.spawn(Thing::Request(Request {
                    at: op.anchor(),
                    op: *op,
                }));
                Ok(())
            }
            Action::Probe { tile } => {
                let op = Op::Belt {
                    from: *tile,
                    tiles: PROBE_TILES,
                    speed: PROBE_SPEED,
                    item: PROBE_ITEM,
                };
                if !op.valid() {
                    return Err(Reject::BadOp);
                }
                // A read of the line index: `?` makes it `NotPredictable` on a client.
                let mut taken = false;
                w.transport()
                    .lines_at(tile.tile(), &mut |_, _| taken = true)?;
                if taken {
                    return Err(Reject::Occupied);
                }
                w.spawn(Thing::Request(Request {
                    at: op.anchor(),
                    op,
                }));
                Ok(())
            }
        }
    }

    /// Requests woken this tick execute in spawn order; then a spawner or feeder new on the list
    /// gives its line the engine schedule (module doc), and the jams and inserters run.
    fn tick(cx: &mut TickCx<'_, Self>) {
        let sys = spawner_sys();
        // The list only appends between compactions (0007 §7), so the members at or past this
        // index joined it this tick: they set their line's schedule, once.
        let joined_from = cx.active_len(sys);
        while let Some(id) = cx.next_woken() {
            match cx.entity(id).ok().flatten().copied() {
                Some(Thing::Request(req)) => Self::execute(cx, id, req),
                // Woken only when spawned at genesis (the bench world, M45; `TickCx` puts never
                // auto-wake): it joins its list here, and runs below this same tick.
                Some(
                    Thing::Spawner(_)
                    | Thing::Cycling(_)
                    | Thing::Jam(_)
                    | Thing::Inserter(_)
                    | Thing::Feeder(_),
                ) => cx.activate(sys, id),
                // Not woken in practice; already on their lists.
                Some(Thing::Tally(_) | Thing::Destroyed(_)) | None => {}
            }
        }

        let now = cx.tick().0;
        for i in 0..cx.active_len(sys) {
            let Some(id) = cx.active_at(sys, i) else {
                continue; // a tombstoned slot (0007 §7).
            };
            let (line, schedule) = match cx.entity(id).ok().flatten().copied() {
                Some(Thing::Spawner(s)) => (s.line, s.schedule(false)),
                Some(Thing::Cycling(s)) => (s.line, s.schedule(true)),
                Some(Thing::Feeder(f)) => (f.line, f.schedule()),
                Some(Thing::Jam(j)) => {
                    Self::jam(cx, j, now);
                    continue;
                }
                Some(Thing::Inserter(ins)) => {
                    Self::insert(cx, ins, now);
                    continue;
                }
                _ => continue,
            };
            // Once, on the tick it joins; the engine inserts from then on and nothing is written
            // (module doc). A line destroyed since (an op naming a dead table slot) is `NoLine`,
            // dropped like any refused op; any other refusal is a fixture bug: `Op::valid` checked
            // `period >= 256` and `item != 0`, and the bench genesis builds valid schedules within
            // the tracker's room (half the line cap).
            if i >= joined_from
                && let Ok(t) = cx.transport_mut()
            {
                match t.set_spawner(LineId(line), Some(schedule)) {
                    Ok(()) | Err(TransportError::NoLine) => {}
                    Err(e) => panic!(
                        "set_spawner({line}) refused {e:?}: Op::valid checks period >= 256 and \
                         item != 0, and a world's spawners fit half its line cap"
                    ),
                }
            }
        }
    }

    fn growth(a: &Action) -> Option<Growth> {
        match a {
            Action::Noop => Some(Growth::NONE),
            Action::Request(_) | Action::Probe { .. } => Some(Growth::entities(1)),
        }
    }

    fn admit(
        _w: &dyn WorldRead<Self>,
        _p: &PresenceTable<Self>,
        _who: PlayerId,
        _a: &Action,
    ) -> Result<(), Reject> {
        Ok(())
    }

    // `declare_spawners` keeps the default (nothing, M53): the schedules are line state, restored
    // with the store.
}

/// Flat grass everywhere: belt tests want a world with nothing in the way. With a bench spec it
/// also writes the three marker tiles of [`bench`] into chunk `(-1, -1)`.
pub struct FlatWorldgen;

const EDGE: usize = 32; // matches `Game::CHUNK_BITS`'s default (5)

impl Worldgen for FlatWorldgen {
    type Params = BeltsParams;
    const WORLDGEN_VERSION: u32 = 1;
    fn generate(_seed: u64, params: &BeltsParams, chunk: ChunkCoord, out: &mut [Tile]) {
        debug_assert_eq!(out.len(), EDGE * EDGE);
        out.fill(Tile::new(0, 0, 0));
        if let Some(spec) = params.bench
            && chunk == (ChunkCoord { x: -1, y: -1 })
        {
            for (i, t) in bench::marker_tiles(spec) {
                out[i] = t;
            }
        }
    }
}

engine::export_game!(Belts);
