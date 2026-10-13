//! Belt topology (M52): placed belts mapped onto the engine's transport lines on the host tick
//! (0076 §3-§4, §6; README "Belts": Numbers, Lanes, Shape, Side-loading).
//!
//! **Rules** (`/Users/tyler/repos/belts/docs/03-belt-shapes-and-connections.md` §4-§5, §9). A
//! neighbour *feeds* a belt when it is a live belt (not `removing`) whose front is the belt's tile;
//! only the back, left and right tiles count ([`inputs`]), so head-on belts never feed each other
//! (R6). [`shape_for`]: a back input or none or both sides is straight (R1, R2, R4), exactly one side
//! input and no back input a curve toward that side (R3); the front never matters (R5). A belt's
//! output ([`output_of`], C1-C4): into the back of a belt facing the same way, or into a curve whose
//! sole input it is, lanes kept ([`Link::Next`]); into the side of a straight belt, both lanes onto the
//! near lane ([`Link::SideLoad`], R7); anything else (nothing, a furnace, a head-on belt) stops at the
//! front ([`Link::DeadEnd`]).
//!
//! **Spawners and despawners** (M53b, the game's rule; README "Belts", Spawner and despawner). A
//! spawner accepts no input (its back is its lines' back, where the engine inserts: 0079 §21), so it
//! is always straight, a belt pointing into it dead-ends, and it is never joined into a run: its two
//! lines are its own, linked to its front by its output like a curve's. The tick sets each lane
//! line's engine schedule from `Belt.spawn` whenever the tile's lines are (re)created (both lanes)
//! or a `SetSpawner` or a rotation woke it (both lanes again), and nothing per insert (0079
//! §19 (e)). A despawner feeds nothing: its lines end in `Output::Sink` whatever stands in front
//! ([`Link::Sink`]), it never joins the run in front (it is always a run's front) and it is no input
//! of the tile in front; it takes inputs, curves and side-loads like a plain belt.
//!
//! **Splitters** (M54; README "Belts", Splitters). A splitter is a run boundary with eight lines of
//! its own, never joined, split or rescaled: per half (left and right seen along `dir`,
//! [`splitter_halves`]) and per lane, an input line from the half's midline back to its back edge
//! and an output line from its front edge to the midline, [`SPLITTER_LEN`] (128) each, straight,
//! on the lane's usual cross position (the edge rule as for a run). Each input line's output is
//! `Fork { a: the left half's output lane k, b: the right half's }` (one sub-splitter per input lane
//! with the engine's toggle: `a`, the left half, is preferred first; Factorio's "first item goes
//! right" is not copied). A belt behind a half facing the same way feeds that half's input lanes
//! (`Next`, lane for lane); anything pointing into a long side, or head-on into its front, stops
//! ([`Link::DeadEnd`]; measured `q15_splitter_long_side`). Each half's output feeds the tile in front
//! like a belt's (C1-C4: `Next`, the sole side input of a curve, a side-load, or a dead end), and a
//! half counts as an input of the tile in front (§4.2), so it curves or straightens it like a belt.
//! A splitter's lines are re-created (its items destroyed) when it turns 180 degrees in place and
//! destroyed when it is picked up; [`splitter_lanes`] reads a half's four lines back from the tile
//! index (input or output by where its segment starts).
//!
//! **Undergrounds** (M55; README "Belts", Undergrounds and Numbers). An entrance
//! ([`BeltKind::UndergroundIn`]) and an exit ([`BeltKind::UndergroundOut`]) are one tile each, run
//! boundaries with a line pair of their own (never joined, split or rescaled), always straight, with
//! no inputs of their own ([`inputs_of`]). Per lane the entrance holds its visible back half (from
//! the midline back to the back edge, [`UNDERGROUND_HALF`] = 128) and the exit its visible front half
//! (from the front edge to the midline, 128), on the lane's usual cross position (the edge rule);
//! [`Form::Underground`] tells the two apart by where the segment starts. **Pairing**
//! ([`underground_partner`]): from an entrance facing `d`, the first underground on `d`'s axis within
//! tiles 1..=5 ahead ends the search, and it is the partner iff it is an exit facing `d` (so gaps
//! 0..=[`UNDERGROUND_MAX_GAP`]); tiles between hold anything, and undergrounds on the other axis are
//! transparent (question 14 (b)'s default). Pairing is a pure function of the layout: no partner id
//! is stored (0076 §4), and it runs in the tick only (`apply` never reads five tiles), so a steal, a
//! removal and a rotation reconcile from the layout alone. A paired entrance owns a **hidden line**
//! per lane, `(gap + 1) x 256` long with no segments (never in the tile index, never drawn, never
//! replicated: 0079 §17), linked entrance `Next(hidden)` and hidden `Next(exit lane)`, lane for lane,
//! so an item takes exactly the surface belt's time; it is reached from the entrance lane's `Next`.
//! Unpaired, the entrance's lanes dead-end at the hood (its line's position 0); a pair that breaks
//! or whose gap changes destroys the hidden line and its items (question 14 (c)'s default) and a new
//! gap gets a new hidden line. An exit's own lines never change with pairing; a belt behind it
//! facing the same way dead-ends (an unpaired exit accepts nothing from behind, and a paired one
//! only from its hidden line); the exit's output feeds the tile in front like a belt's (C1-C4), and
//! it counts as an input of that tile. A belt behind an entrance feeds it (`Next`); a belt into
//! either end's side lands through the hood: on an entrance a landing `L` positions behind the tile's
//! front edge is `Merge { at: L - 128 }` when `L >= 128` and a dead end otherwise, on an exit `Merge
//! { at: L }` when `L < 128` and a dead end otherwise. Rotating an end turns that end only (`dir.cw()`,
//! the README's assumed line; question 14 (a)): its lines are re-created and it unpairs.
//!
//! **Lines.** One engine line is one lane (0076 §1). Lane 0 is the lane on the belt's left seen along
//! `dir`, lane 1 its right; lanes keep their index through `Next` (C2) and a curve. One line per lane
//! per maximal straight run (straight tiles of one direction, each feeding the next from behind),
//! `256 x tiles` long with one straight segment; a curve tile is its own pair of single-arc lines,
//! 106 (inner, the lane on the turn side) and 295 (outer), about the corner between its front edge
//! and its input side, radii 68 and 188 (0.5 tile -/+ 60/256), so lanes meet the straight lanes'
//! centres 68 positions from each edge. A side-load is `Merge { near lane, at }` with `at` the
//! target tile's first position on its line plus 192 for the feeder lane nearer the target's back
//! and plus 64 for the other (README Side-loading). Curves are never joined into a run, so `join`
//! never closes a cycle (a loop keeps its curve links as `Next`, 0079 §11).
//!
//! **Rotation** (M59, Tyler's 2026-10-13 answer to question 10, README "Belts": rotating keeps the
//! items, as Factorio does). A tile whose lines are a run or a curve before and after a rotation
//! (plain belts, spawners and despawners) keeps its two lines: `cut` takes it out of its run, then
//! [`reshape`] `rescale`s each lane to its new length (items at `floor(pos x new / old)`) and lays it
//! along the new direction with `set_segments`; lane `k` stays lane `k` (the belt's left stays its
//! left). The kept ids last only until the join phase: a rotated tile that becomes a run joining
//! the run in front has its items moved into the front line by `join`, which destroys the back one
//! (nothing is lost, but a line id is not stable across a join). A rotated spawner's schedules
//! restart at zero credit (question 13), as after a `SetSpawner`. **Fallback**: if a `rescale` is refused (`NoRoom`: two items would share a position
//! after the squash), the tile's lines are destroyed and re-created as before M59, their items
//! counted in [`belts_destroyed_items`]. Rare: items `SPACING` apart squash at worst to 22 (295 ->
//! 106), and only a squashed pair held at rest through many more rescales (each may lose a position
//! to rounding) can come within the 2 positions a 295 -> 106 or 256 -> 106 squash collides; the unit
//! test builds such a pair with the engine's own surgery. Splitters (180 degrees) and underground
//! ends keep re-creating their lines on a rotation (their items destroyed).
//!
//! **Run boundaries.** A run is at most [`MAX_LINE_TILES`] (4,096) tiles, the most one line's path
//! may enter: a tile that would make a run longer starts the next run, linked by `Next` like a curve.
//!
//! **The edge rule.** `WorldPos::tile` floors, so a point on an east or south tile edge belongs to
//! the next tile. Every segment's points stay inside its own tiles: a run's first point is its front
//! edge on a west or north run and one position behind it on an east or south run (its last point is
//! then the back edge or one before it), and a curve's centre is pulled one position back on an east
//! or south curve. `lines_at` of the tile in front of a line reports nothing of it. So on an east or
//! south belt every position sits one position nearer the front edge than on a west or north one: a
//! side-load's +64 / +192 lands 65 / 193 positions behind the target tile's front edge there (64 /
//! 192 on west and north), and an east or south arc is one position off the corner. Invisible, and
//! the same on every replica.
//!
//! **The mapping** ([`on_wake`]) runs in the tick only (`apply` cannot write transport). For a woken
//! tile P it reconciles P and its four neighbours (every tile whose inputs, shape or run membership P
//! can change), in phases: cut (split runs where a tile must leave or change form), reform (destroy
//! a tile's lines when its belt is gone, create or extend them for a new belt, rescale them keeping
//! their items for a reshape or a rotation, see **Rotation**), join (`set_out(Next)` then `join` for neighbours of one run), outputs
//! (every live belt within two tiles of P whose line it fronts: its output is a function of its front
//! tile, whose shape P can change), shapes (one `put_entity` per changed shape) and, for a `removing`
//! belt, the despawn. Every op that changes a line's `len` is followed by `set_segments` on that line,
//! so every line is always in the tile index and the mapping is read back from `lines_at`
//! ([`mapped`]): the entity stores no line id (0076 §4). Each phase is idempotent, so a tile woken
//! twice, or two edits in one tick, end in the same structure. No `HashMap`, no float, no allocation.

use engine::game::{EntityId, TickCx, Unknown, WorldRead, WorldWrite};
use engine::transport::{
    Geometry, LineId, MAX_LINE_TILES, Output, Segment, TransportError, TransportRead,
    TransportWrite,
};
use engine::world::{TilePos, WorldPos};

use engine::transport::{Item, Schedule};

use crate::{Belt, BeltKind, BeltShape, Dir, RefEntity, RefGame, content};

/// Belt speed in positions per tick (README "Belts", Numbers).
pub const SPEED: u16 = 24;
/// A straight lane per tile.
pub const STRAIGHT_LEN: u32 = 256;
/// A curve's inner lane (the lane on the turn side) and outer lane.
pub const INNER_LEN: u32 = 106;
pub const OUTER_LEN: u32 = 295;
/// A curve lane's radius about the inner corner: 0.5 tile -/+ 60/256.
pub const INNER_RADIUS: u32 = 68;
pub const OUTER_RADIUS: u32 = 188;
/// A lane's centre from the tile edge on its own side (lane 0 from the left edge, lane 1 the right).
pub const LANE_INSET: i32 = 68;
/// A splitter's input and output lane lines (M54): half a tile each.
pub const SPLITTER_LEN: u32 = 128;
/// An underground end's visible lane line (M55): half a tile, the entrance's back half or the
/// exit's front half.
pub const UNDERGROUND_HALF: u32 = 128;
/// The most empty tiles between a paired entrance and exit (README "Belts", Numbers: one span).
pub const UNDERGROUND_MAX_GAP: u32 = 4;
/// Side-load landings past the target tile's first position: the feeder lane nearer the target's
/// back lands 64 from its back edge, the other 64 from its front edge.
pub const SIDE_BACK: u32 = 192;
pub const SIDE_FRONT: u32 = 64;

// Test probes (derived, never state), counted only where `debug_assertions` is on (native tests and
// the dev `.wasm`); a release build carries neither counter and both readers answer 0.
#[cfg(debug_assertions)]
thread_local! {
    static OPS: core::cell::Cell<u64> = const { core::cell::Cell::new(0) };
    static UNMAPPED: core::cell::Cell<u64> = const { core::cell::Cell::new(0) };
    static UNSCHEDULED: core::cell::Cell<u64> = const { core::cell::Cell::new(0) };
    static DESTROYED: core::cell::Cell<u64> = const { core::cell::Cell::new(0) };
}

/// Transport writes (`create`, `destroy`, `split`, `join`, `extend_*`, `rescale`, `set_segments`,
/// a changing `set_out`, `insert_at`) this module has made on this thread: a test's cost probe
/// (`debug_assertions` only; 0 otherwise).
pub fn ops() -> u64 {
    #[cfg(debug_assertions)]
    return OPS.with(core::cell::Cell::get);
    #[cfg(not(debug_assertions))]
    0
}

/// Tiles dropped by a refused op on this thread (`belts_unmapped`: a refused `create`, `split` or
/// `set_segments` drops the whole pair it was building, never half of it, and counts its tiles;
/// re-attempts count again, so it is a zero / non-zero signal, not a number of belts). Every test
/// but the cap tests reads 0 (`debug_assertions` only; 0 otherwise).
pub fn belts_unmapped() -> u64 {
    #[cfg(debug_assertions)]
    return UNMAPPED.with(core::cell::Cell::get);
    #[cfg(not(debug_assertions))]
    0
}

/// Spawner lanes whose `set_spawner` was refused on this thread (M53b fix round 1: `Full` at the
/// forecast tracker's pool, or any other error): the lane shows as configured but makes nothing.
/// A zero / non-zero signal like [`belts_unmapped`]; every test but a cap test reads 0
/// (`debug_assertions` only; 0 otherwise).
pub fn spawners_unscheduled() -> u64 {
    #[cfg(debug_assertions)]
    return UNSCHEDULED.with(core::cell::Cell::get);
    #[cfg(not(debug_assertions))]
    0
}

/// Items this module's `destroy`s removed from the world on this thread (M56: a refused rotation's
/// (M59), a pick-up's, a re-pairing's and a splitter's or underground's lines, and a pair a full cap left
/// unfinished), so a test's conservation reads made = live + sunk + destroyed exactly
/// (`debug_assertions` only; 0 otherwise, like [`belts_unmapped`]).
pub fn belts_destroyed_items() -> u64 {
    #[cfg(debug_assertions)]
    return DESTROYED.with(core::cell::Cell::get);
    #[cfg(not(debug_assertions))]
    0
}

#[inline]
fn unscheduled() {
    #[cfg(debug_assertions)]
    UNSCHEDULED.with(|c| c.set(c.get() + 1));
}

#[inline]
fn bump() {
    #[cfg(debug_assertions)]
    OPS.with(|c| c.set(c.get() + 1));
}

#[inline]
fn unmapped(_tiles: u32) {
    #[cfg(debug_assertions)]
    UNMAPPED.with(|c| c.set(c.get() + u64::from(_tiles)));
}

// ---------------------------------------------------------------------------------------------
// Directions

const fn step(d: Dir) -> (i32, i32) {
    match d {
        Dir::East => (1, 0),
        Dir::South => (0, 1),
        Dir::West => (-1, 0),
        Dir::North => (0, -1),
    }
}

const fn ccw(d: Dir) -> Dir {
    match d {
        Dir::East => Dir::North,
        Dir::South => Dir::East,
        Dir::West => Dir::South,
        Dir::North => Dir::West,
    }
}

const fn opposite(d: Dir) -> Dir {
    d.cw().cw()
}

/// `d` in 1/256 turn, a positive turn going from `+x` toward `+y` (the engine's arc angles).
const fn turn(d: Dir) -> u16 {
    match d {
        Dir::East => 0,
        Dir::South => 64,
        Dir::West => 128,
        Dir::North => 192,
    }
}

const fn from_turn(t: u16) -> Dir {
    match t {
        0 => Dir::East,
        64 => Dir::South,
        128 => Dir::West,
        _ => Dir::North,
    }
}

/// East and south point along a positive axis: their front edge belongs to the next tile.
const fn positive(d: Dir) -> bool {
    matches!(d, Dir::East | Dir::South)
}

const fn horizontal(d: Dir) -> bool {
    matches!(d, Dir::East | Dir::West)
}

/// `t` moved `n` tiles along `d`.
const fn ahead(t: TilePos, d: Dir, n: i32) -> TilePos {
    let (dx, dy) = step(d);
    TilePos::new(t.x + dx * n, t.y + dy * n)
}

/// The coordinate (on `d`'s axis) of tile `t`'s edge facing `d`.
const fn edge(t: TilePos, d: Dir) -> i32 {
    match d {
        Dir::East => (t.x + 1) * 256,
        Dir::West => t.x * 256,
        Dir::South => (t.y + 1) * 256,
        Dir::North => t.y * 256,
    }
}

/// Lane `lane`'s centre across a tile of a belt facing `d`, from the tile's min corner on the cross
/// axis (lane 0 is [`LANE_INSET`] from the left edge).
const fn lane_cross(d: Dir, lane: u8) -> i32 {
    let left_on_min = matches!(d, Dir::East | Dir::North);
    if (lane == 0) == left_on_min {
        LANE_INSET
    } else {
        256 - LANE_INSET
    }
}

// ---------------------------------------------------------------------------------------------
// Rules (entity reads only: shared with `apply`, `?` on every read)

/// Which neighbours feed a belt facing `dir` on `at` (back, its own left, its own right).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Inputs {
    pub back: bool,
    pub left: bool,
    pub right: bool,
}

/// What a belt's front hands its items to (C1-C4).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Link {
    /// Nothing accepts: items stop at the front (C4).
    DeadEnd,
    /// The front belt's lanes, lane for lane: its back (C2) or a curve whose sole input this is.
    Next,
    /// The side of a straight front belt: both lanes onto its lane `near` (0 when this belt is on
    /// the target's left), the lane `near` of this belt at +64 and the other at +192 (C3).
    SideLoad { near: u8 },
    /// A despawner (M53b): its lines delete what leaves their front (`Output::Sink`).
    Sink,
}

/// The live belt on `at` (not `removing`), if any.
pub fn live_belt(w: &dyn WorldRead<RefGame>, at: TilePos) -> Result<Option<Belt>, Unknown> {
    let Some(id) = w.entity_at(at)? else {
        return Ok(None);
    };
    Ok(w.entity(id)?.and_then(RefEntity::as_live_belt).copied())
}

/// A live belt on `from` whose front is `into` and which hands items on (a despawner sinks them;
/// an underground entrance hands its items to its hidden line, never to the surface: M55).
fn feeds(w: &dyn WorldRead<RefGame>, from: TilePos, into: TilePos) -> Result<bool, Unknown> {
    Ok(live_belt(w, from)?.is_some_and(|b| {
        !matches!(b.kind, BeltKind::Despawner | BeltKind::UndergroundIn)
            && ahead(from, b.dir, 1) == into
    }))
}

/// The kind of the live belt on `at`, a plain belt when there is none (placement asks for the tile
/// it is about to fill: [`shape_of_kind`]).
fn kind_on(w: &dyn WorldRead<RefGame>, at: TilePos) -> Result<BeltKind, Unknown> {
    Ok(live_belt(w, at)?.map_or(BeltKind::Belt, |b| b.kind))
}

/// [`Inputs`] of a belt of `kind` facing `dir` on `at`: none for a spawner (M53b), a splitter (M54:
/// its shape never changes; what feeds its halves is [`output_of`]'s) or an underground end (M55:
/// always straight).
pub fn inputs_of(
    w: &dyn WorldRead<RefGame>,
    at: TilePos,
    dir: Dir,
    kind: BeltKind,
) -> Result<Inputs, Unknown> {
    if matches!(kind, BeltKind::Spawner | BeltKind::Splitter) || kind.is_underground() {
        return Ok(Inputs::default());
    }
    Ok(Inputs {
        back: feeds(w, ahead(at, opposite(dir), 1), at)?,
        left: feeds(w, ahead(at, ccw(dir), 1), at)?,
        right: feeds(w, ahead(at, dir.cw(), 1), at)?,
    })
}

/// [`Inputs`] of a belt facing `dir` on `at`, of the kind standing there (a plain belt if none).
pub fn inputs(w: &dyn WorldRead<RefGame>, at: TilePos, dir: Dir) -> Result<Inputs, Unknown> {
    inputs_of(w, at, dir, kind_on(w, at)?)
}

/// R1-R5: the shape an input set gives.
pub const fn shape_for(i: Inputs) -> BeltShape {
    match (i.back, i.left, i.right) {
        (false, true, false) => BeltShape::CurveLeft,
        (false, false, true) => BeltShape::CurveRight,
        _ => BeltShape::Straight,
    }
}

/// The shape of a belt facing `dir` on `at`, of the kind standing there (a plain belt if none).
pub fn shape_of(w: &dyn WorldRead<RefGame>, at: TilePos, dir: Dir) -> Result<BeltShape, Unknown> {
    Ok(shape_for(inputs(w, at, dir)?))
}

/// The shape of a belt of `kind` facing `dir` on `at` (`apply`'s, before the belt stands there).
pub fn shape_of_kind(
    w: &dyn WorldRead<RefGame>,
    at: TilePos,
    dir: Dir,
    kind: BeltKind,
) -> Result<BeltShape, Unknown> {
    Ok(shape_for(inputs_of(w, at, dir, kind)?))
}

/// The output of the belt `b` standing on `at` (C1-C4, R6, R7; M53b: a despawner sinks, a spawner
/// in front accepts nothing; M54: a splitter half on `at` outputs like a belt, and a splitter in
/// front accepts only from behind one of its halves; M55: an underground entrance hands nothing to
/// the surface (its lanes go to its hidden line: [`underground_partner`]), an exit in front accepts
/// nothing from behind, and a side-load onto either end lands through its hood: [`outputs_into`]).
pub fn output_of(w: &dyn WorldRead<RefGame>, at: TilePos, b: Belt) -> Result<Link, Unknown> {
    if b.kind == BeltKind::Despawner {
        return Ok(Link::Sink);
    }
    if b.kind == BeltKind::UndergroundIn {
        return Ok(Link::DeadEnd);
    }
    let front = ahead(at, b.dir, 1);
    let Some(f) = live_belt(w, front)? else {
        return Ok(Link::DeadEnd);
    };
    if f.kind == BeltKind::Spawner {
        return Ok(Link::DeadEnd);
    }
    if f.kind == BeltKind::Splitter && f.dir != b.dir {
        return Ok(Link::DeadEnd); // its long side or its front (q15_splitter_long_side)
    }
    if f.dir == b.dir {
        // Into an exit's back: it accepts only from its hidden line (M55).
        return Ok(if f.kind == BeltKind::UndergroundOut {
            Link::DeadEnd
        } else {
            Link::Next
        });
    }
    if f.dir == opposite(b.dir) {
        return Ok(Link::DeadEnd); // head-on (R6)
    }
    // `b` stands on a side of `f`: on its left exactly when `b` travels along `f`'s right.
    Ok(match shape_of(w, front, f.dir)? {
        BeltShape::Straight => Link::SideLoad {
            near: if b.dir == f.dir.cw() { 0 } else { 1 },
        },
        _ => Link::Next,
    })
}

// ---------------------------------------------------------------------------------------------
// Geometry

/// Which end of an underground (M55).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum End {
    /// The entrance: its back half, from the midline back.
    In,
    /// The exit: its front half, from the front edge to the midline.
    Out,
}

/// A line's form, read back from its segment.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Form {
    Run(Dir),
    Curve(Dir, BeltShape),
    /// An underground end's visible half (M55): a straight [`UNDERGROUND_HALF`] segment, the
    /// entrance's starting on the midline, the exit's on the front edge.
    Underground(Dir, End),
}

impl Form {
    const fn dir(self) -> Dir {
        match self {
            Form::Run(d) | Form::Curve(d, _) | Form::Underground(d, _) => d,
        }
    }
}

/// The lane length of `form`'s lane `lane` on one tile.
const fn lane_len(form: Form, lane: u8) -> u32 {
    match form {
        Form::Run(_) => STRAIGHT_LEN,
        Form::Underground(..) => UNDERGROUND_HALF,
        Form::Curve(_, shape) => {
            if (lane == 0) == matches!(shape, BeltShape::CurveLeft) {
                INNER_LEN
            } else {
                OUTER_LEN
            }
        }
    }
}

const fn wp(x: i32, y: i32) -> WorldPos {
    WorldPos { x, y }
}

/// Lane `lane` of a straight run facing `dir`, `tiles` long, whose front tile is `front` (the edge
/// rule in the module doc).
fn run_segment(front: TilePos, dir: Dir, tiles: u32, lane: u8) -> Segment {
    let len = tiles * STRAIGHT_LEN;
    let (dx, dy) = step(dir);
    let along = edge(front, dir) - i32::from(positive(dir));
    let cross = lane_cross(dir, lane);
    let from = if horizontal(dir) {
        wp(along, front.y * 256 + cross)
    } else {
        wp(front.x * 256 + cross, along)
    };
    let back = len as i32;
    Segment {
        len,
        geometry: Geometry::Straight {
            from,
            to: wp(from.x - dx * back, from.y - dy * back),
        },
    }
}

/// Lane `lane` of a curve facing `dir` on `at`: a quarter arc about the corner between the front
/// edge and the input side, from the front edge (position 0) back to the input edge.
fn curve_segment(at: TilePos, dir: Dir, shape: BeltShape, lane: u8) -> Segment {
    let left = matches!(shape, BeltShape::CurveLeft);
    let inner = (lane == 0) == left;
    let side = if left { ccw(dir) } else { dir.cw() };
    let along = edge(at, dir) - i32::from(positive(dir));
    let centre = if horizontal(dir) {
        wp(along, edge(at, side))
    } else {
        wp(edge(at, side), along)
    };
    Segment {
        len: if inner { INNER_LEN } else { OUTER_LEN },
        geometry: Geometry::Arc {
            centre,
            radius_q8: if inner { INNER_RADIUS } else { OUTER_RADIUS },
            start_turn_q8: turn(if left { dir.cw() } else { ccw(dir) }),
            sweep_q8: if left { 64 } else { -64 },
        },
    }
}

/// What a segment says about the tile `at` it enters: its form and lane. A straight half-tile
/// segment is an underground end's (M55; a splitter half's four lines are never classified as a
/// tile's two: [`splitter_lanes`] reads its own direction from it), the exit's when it starts on the
/// front edge.
fn classify(seg: Segment, at: TilePos) -> Option<(Form, u8)> {
    match seg.geometry {
        Geometry::Straight { from, to } => {
            let (dir, cross) = if from.y == to.y {
                let d = if from.x > to.x { Dir::East } else { Dir::West };
                (d, from.y - at.y * 256)
            } else {
                let d = if from.y > to.y {
                    Dir::South
                } else {
                    Dir::North
                };
                (d, from.x - at.x * 256)
            };
            let lane = if cross == lane_cross(dir, 0) { 0 } else { 1 };
            if seg.len == UNDERGROUND_HALF {
                let along = if horizontal(dir) { from.x } else { from.y };
                let end = if along == edge(at, dir) - i32::from(positive(dir)) {
                    End::Out
                } else {
                    End::In
                };
                return Some((Form::Underground(dir, end), lane));
            }
            Some((Form::Run(dir), lane))
        }
        Geometry::Arc {
            radius_q8,
            start_turn_q8,
            sweep_q8,
            ..
        } => {
            let left = sweep_q8 > 0;
            let start = from_turn(start_turn_q8);
            let (dir, shape) = if left {
                (ccw(start), BeltShape::CurveLeft)
            } else {
                (start.cw(), BeltShape::CurveRight)
            };
            let inner = radius_q8 == INNER_RADIUS;
            Some((Form::Curve(dir, shape), u8::from(inner != left)))
        }
    }
}

/// The two lanes mapped on a tile: their lines, the tile's first position on them (the same for
/// both lanes), the lines' `len` and their form.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Mapped {
    lane: [LineId; 2],
    off: u32,
    len: u32,
    form: Form,
}

impl Mapped {
    /// Tiles on the line (a run's; 1 for a curve).
    const fn tiles(&self) -> u32 {
        match self.form {
            Form::Run(_) => self.len / STRAIGHT_LEN,
            Form::Curve(..) | Form::Underground(..) => 1,
        }
    }
}

/// A tile's two lanes as the tile index reports them: lane 0 (the belt's left) and lane 1, the tile's
/// first position on them (the same on both) and the lines' `len` (a run's whole length). For tests and
/// M53's spawners.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TileLanes {
    pub lane: [LineId; 2],
    pub off: u32,
    pub len: u32,
}

/// The lanes mapped on `at`, `None` when no belt line enters it (a splitter half's are
/// [`splitter_lanes`]).
pub fn lanes_at(tr: &dyn TransportRead, at: TilePos) -> Option<TileLanes> {
    mapped(tr, at).map(|m| TileLanes {
        lane: m.lane,
        off: m.off,
        len: m.len,
    })
}

/// The lines on `at`, read back from the tile index (every line keeps its segments, module doc).
fn mapped(tr: &dyn TransportRead, at: TilePos) -> Option<Mapped> {
    let mut found = [(LineId::NONE, 0u32); 2];
    let mut n = 0usize;
    tr.lines_at(at, &mut |l, o| {
        if n < 2 {
            found[n] = (l, o);
        }
        n += 1;
    })
    .ok()?;
    debug_assert!(
        n == 0 || n == 2 || (n == 4 && splitter_lanes(tr, at).is_some()),
        "tile {at:?}: {n} lines, not one belt's two lanes or a splitter half's four"
    );
    if n != 2 {
        return None;
    }
    let mut lane = [LineId::NONE; 2];
    let mut form = None;
    for (l, _) in found {
        let mut seg = None;
        tr.segments(l, &mut |s| {
            if seg.is_none() {
                seg = Some(s);
            }
        })
        .ok()?;
        let (f, k) = classify(seg?, at)?;
        form = Some(f);
        lane[usize::from(k)] = l;
    }
    debug_assert!(lane[0] != lane[1], "tile {at:?}: one lane read twice");
    Some(Mapped {
        lane,
        off: found[0].1,
        len: tr.len(lane[0]).ok()?,
        form: form?,
    })
}

// ---------------------------------------------------------------------------------------------
// Splitters (M54)

/// A splitter's halves, left then right seen along its `dir` (the footprint's min corner is
/// `origin`): facing east the north tile is the left half, facing west the south tile, facing north
/// the west tile, facing south the east tile.
pub const fn splitter_halves(b: &Belt) -> [TilePos; 2] {
    let o = b.origin.tile();
    let (x, y) = (o.x, o.y);
    match b.dir {
        Dir::East => [TilePos::new(x, y), TilePos::new(x, y + 1)],
        Dir::West => [TilePos::new(x, y + 1), TilePos::new(x, y)],
        Dir::North => [TilePos::new(x, y), TilePos::new(x + 1, y)],
        Dir::South => [TilePos::new(x + 1, y), TilePos::new(x, y)],
    }
}

/// The tiles a belt covers: its own, or a splitter's two halves (left, right). The count is 1 or 2.
fn footprint_tiles(b: &Belt) -> ([TilePos; 2], usize) {
    if b.kind == BeltKind::Splitter {
        (splitter_halves(b), 2)
    } else {
        let o = b.origin.tile();
        ([o, o], 1)
    }
}

/// A splitter half's four lines as the tile index reports them (M54): the direction they run, and
/// per lane (0 the left seen along `dir`) the input line (from the midline back) and the output line
/// (from the front edge to the midline).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SplitterLanes {
    /// The direction the lines run (the splitter's `dir`).
    pub dir: Dir,
    /// Per lane, the input line: from the half's midline back to its back edge.
    pub input: [LineId; 2],
    /// Per lane, the output line: from the half's front edge back to its midline.
    pub output: [LineId; 2],
}

/// The splitter lines on the half `at`, `None` unless exactly a splitter half's four lines enter it.
/// A line is an output when its segment starts on the half's front edge (the edge rule), else an
/// input (it starts on the midline).
pub fn splitter_lanes(tr: &dyn TransportRead, at: TilePos) -> Option<SplitterLanes> {
    let mut found = [LineId::NONE; 4];
    let mut n = 0usize;
    tr.lines_at(at, &mut |l, _| {
        if n < 4 {
            found[n] = l;
        }
        n += 1;
    })
    .ok()?;
    if n != 4 {
        return None;
    }
    let mut input = [LineId::NONE; 2];
    let mut output = [LineId::NONE; 2];
    let mut dir = Dir::East;
    for l in found {
        let mut seg = None;
        tr.segments(l, &mut |s| {
            if seg.is_none() {
                seg = Some(s);
            }
        })
        .ok()?;
        let seg = seg?;
        let Geometry::Straight { from, .. } = seg.geometry else {
            return None;
        };
        let (form, k) = classify(seg, at)?;
        let d = form.dir();
        let along = if horizontal(d) { from.x } else { from.y };
        let side = if along == edge(at, d) - i32::from(positive(d)) {
            &mut output
        } else {
            &mut input
        };
        side[usize::from(k)] = l;
        dir = d;
    }
    let all = input[0] != LineId::NONE
        && input[1] != LineId::NONE
        && output[0] != LineId::NONE
        && output[1] != LineId::NONE;
    debug_assert!(all, "tile {at:?}: four lines, not a splitter half's");
    all.then_some(SplitterLanes { dir, input, output })
}

/// Lane `lane` of a splitter half on `half` facing `dir`: the output line from the front edge (the
/// edge rule) to the midline, or the input line from the midline to the back edge.
fn splitter_segment(half: TilePos, dir: Dir, lane: u8, input: bool) -> Segment {
    let (dx, dy) = step(dir);
    let len = SPLITTER_LEN as i32;
    let front = edge(half, dir) - i32::from(positive(dir));
    let along = if input {
        front - (dx + dy) * len
    } else {
        front
    };
    let cross = lane_cross(dir, lane);
    let from = if horizontal(dir) {
        wp(along, half.y * 256 + cross)
    } else {
        wp(half.x * 256 + cross, along)
    };
    Segment {
        len: SPLITTER_LEN,
        geometry: Geometry::Straight {
            from,
            to: wp(from.x - dx * len, from.y - dy * len),
        },
    }
}

/// A splitter's eight lines (both halves, segments registered, the input forks set); at a full cap
/// none of them (counted: two tiles).
fn create_splitter(tr: Tx<'_>, b: Belt) {
    let halves = splitter_halves(&b);
    // Index `half * 4 + side * 2 + lane`, side 0 the input and 1 the output.
    let mut ids = [LineId::NONE; 8];
    for i in 0..8 {
        let Some(l) = ok(tr.create(SPLITTER_LEN, SPEED), "create(splitter)") else {
            drop_pair(tr, &ids[..i], 2);
            return;
        };
        ids[i] = l;
    }
    for (i, &line) in ids.iter().enumerate() {
        let seg = splitter_segment(halves[i / 4], b.dir, (i % 2) as u8, (i % 4) < 2);
        if ok(tr.set_segments(line, &[seg]), "set_segments(splitter)").is_none() {
            drop_pair(tr, &ids, 2);
            return;
        }
    }
    for i in [0, 1, 4, 5] {
        let k = i % 2;
        set_out(
            tr,
            ids[i],
            Output::Fork {
                a: ids[2 + k],
                b: ids[6 + k],
            },
        );
    }
}

/// Destroys a splitter half's four lines (pick-up and rotation destroy its items).
fn destroy_splitter_half(tr: Tx<'_>, s: SplitterLanes) {
    for l in s.input.into_iter().chain(s.output) {
        kill(tr, l, "destroy(splitter)");
    }
}

/// Phase 2 for a splitter tile (`true` when `at` is one: a live splitter's half, or a half whose
/// splitter is gone and whose lines are still there): a gone splitter's half lines are destroyed; a
/// live splitter whose halves do not both hold lines running its way (placed, turned, or dropped by
/// a full cap) has whatever is there destroyed and its eight lines created.
fn reform_splitter(cx: &mut TickCx<'_, RefGame>, at: TilePos) -> bool {
    let sp = live_belt(cx, at)
        .ok()
        .flatten()
        .filter(|b| b.kind == BeltKind::Splitter);
    let Some(tr) = tx(cx) else {
        return sp.is_some();
    };
    let Some(b) = sp else {
        let Some(here) = splitter_lanes(tr, at) else {
            return false;
        };
        destroy_splitter_half(tr, here);
        return true;
    };
    let lanes = splitter_halves(&b).map(|h| splitter_lanes(tr, h));
    if lanes.iter().all(|l| l.is_some_and(|l| l.dir == b.dir)) {
        return true;
    }
    for l in lanes.into_iter().flatten() {
        destroy_splitter_half(tr, l);
    }
    create_splitter(tr, b);
    true
}

// ---------------------------------------------------------------------------------------------
// What a tile should be

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Want {
    dir: Dir,
    form: Form,
    /// Straight, and the back tile is a straight live belt facing the same way (one run).
    join_back: bool,
    /// Straight, and the front tile is a live belt facing the same way (it is straight: R2).
    join_front: bool,
}

fn want(w: &dyn WorldRead<RefGame>, at: TilePos) -> Option<Want> {
    let b = live_belt(w, at).ok()??;
    if b.kind == BeltKind::Splitter {
        return None; // its own eight lines (`reform_splitter`), never in a run.
    }
    if b.kind.is_underground() {
        // Its own half-tile pair, never in a run (M55).
        let end = if b.kind == BeltKind::UndergroundIn {
            End::In
        } else {
            End::Out
        };
        return Some(Want {
            dir: b.dir,
            form: Form::Underground(b.dir, end),
            join_back: false,
            join_front: false,
        });
    }
    let shape = shape_of_kind(w, at, b.dir, b.kind).ok()?;
    let straight = shape == BeltShape::Straight;
    let same = |t: TilePos| live_belt(w, t).ok().flatten().filter(|o| o.dir == b.dir);
    let back = ahead(at, opposite(b.dir), 1);
    Some(Want {
        dir: b.dir,
        form: if straight {
            Form::Run(b.dir)
        } else {
            Form::Curve(b.dir, shape)
        },
        // A spawner joins nothing, in front or behind; a despawner is no run's back part (it feeds
        // nothing) and joins nothing in front (module doc); nothing joins a splitter (M54) or an
        // underground end (M55).
        join_back: straight
            && b.kind != BeltKind::Spawner
            && same(back).is_some_and(|k| k.kind == BeltKind::Belt)
            && shape_of(w, back, b.dir).ok() == Some(BeltShape::Straight),
        join_front: straight
            && b.kind == BeltKind::Belt
            && same(ahead(at, b.dir, 1)).is_some_and(|f| {
                !matches!(f.kind, BeltKind::Spawner | BeltKind::Splitter)
                    && !f.kind.is_underground()
            }),
    })
}

// ---------------------------------------------------------------------------------------------
// Transport writes (each counted; `len` changes re-register segments at once)

type Tx<'c> = &'c mut dyn TransportWrite;

fn tx<'c>(cx: &'c mut TickCx<'_, RefGame>) -> Option<Tx<'c>> {
    cx.transport_mut().ok()
}

/// `destroy(line)`, its items counted in [`belts_destroyed_items`] (every item-destroying put of
/// this module goes through here).
fn kill(tr: Tx<'_>, line: LineId, what: &str) {
    let _n = ok(tr.destroy(line, &mut |_| {}), what);
    #[cfg(debug_assertions)]
    if let Some(n) = _n {
        DESTROYED.with(|c| c.set(c.get() + u64::from(n)));
    }
}

/// Counts the write; a refusal other than a full cap (`Full`, or `NoRoom` from a rescale that would
/// put two items on one position) is a bug in this module, asserted in debug builds. At a full cap
/// a pair is mapped whole or not at all ([`drop_pair`], counted by [`belts_unmapped`]): a world
/// without caps (the large-save bench) maps nothing (0079 §5 sizes the caps far above any world).
fn ok<T>(r: Result<T, TransportError>, what: &str) -> Option<T> {
    bump();
    debug_assert!(
        matches!(
            r,
            Ok(_) | Err(TransportError::Full | TransportError::NoRoom)
        ),
        "topology: {what}: {r:?}",
        r = r.as_ref().err()
    );
    r.ok()
}

/// Destroys a pair of lines a full cap left unfinished (both lanes, never one), counting its `tiles`
/// as unmapped: the belts stay, the next edit beside them maps them again.
fn drop_pair(tr: Tx<'_>, lines: &[LineId], tiles: u32) {
    for &l in lines {
        if l != LineId::NONE {
            kill(tr, l, "destroy(unmapped)");
        }
    }
    unmapped(tiles);
}

/// Registers both lanes' segments; a refusal (a full index or segment pool) drops the pair, since
/// a line without segments is out of the tile index and could never be found again.
fn register(tr: Tx<'_>, lane: [LineId; 2], segs: [Segment; 2], tiles: u32) -> bool {
    let a = ok(tr.set_segments(lane[0], &segs[0..1]), "set_segments").is_some();
    let b = ok(tr.set_segments(lane[1], &segs[1..2]), "set_segments").is_some();
    if !(a && b) {
        drop_pair(tr, &lane, tiles);
    }
    a && b
}

/// Both lanes of a run of `tiles` whose front tile is `front`.
fn run_pair(tr: Tx<'_>, lane: [LineId; 2], front: TilePos, dir: Dir, tiles: u32) -> bool {
    let segs = [
        run_segment(front, dir, tiles, 0),
        run_segment(front, dir, tiles, 1),
    ];
    register(tr, lane, segs, tiles)
}

/// Destroys a tile's lines (a pick-up, an underground end's rotation and a refused rotation's
/// rescale destroy the tile's items); an underground entrance's hidden lines first (M55: else they
/// would leak, reached from nothing).
fn destroy(tr: Tx<'_>, m: Mapped) {
    if let Form::Underground(_, End::In) = m.form {
        for h in hidden_of(tr, m.lane).into_iter().flatten() {
            kill(tr, h, "destroy(hidden)");
        }
    }
    for l in m.lane {
        kill(tr, l, "destroy");
    }
}

/// Two new lines of `form` on `at`, segments registered; at the line cap neither (counted).
fn create(tr: Tx<'_>, at: TilePos, form: Form) {
    let Some(a) = ok(tr.create(lane_len(form, 0), SPEED), "create") else {
        unmapped(1);
        return;
    };
    let Some(b) = ok(tr.create(lane_len(form, 1), SPEED), "create") else {
        drop_pair(tr, &[a], 1);
        return;
    };
    let segs = match form {
        Form::Run(dir) => [run_segment(at, dir, 1, 0), run_segment(at, dir, 1, 1)],
        Form::Curve(dir, shape) => [
            curve_segment(at, dir, shape, 0),
            curve_segment(at, dir, shape, 1),
        ],
        Form::Underground(dir, end) => {
            let input = end == End::In;
            [
                splitter_segment(at, dir, 0, input),
                splitter_segment(at, dir, 1, input),
            ]
        }
    };
    register(tr, [a, b], segs, 1);
}

/// Splits both lanes of run `m` at `cut`, registering the front part (front tile `front`) and the
/// new back part (front tile `back_front`). At the line cap (a refused split) the whole run's lines
/// go, both lanes: no tile is left with one lane or in a run it should have left.
fn split_pair(tr: Tx<'_>, m: Mapped, cut: u32, front: TilePos, back_front: TilePos, dir: Dir) {
    let tiles = m.len / STRAIGHT_LEN;
    let Some(b0) = ok(tr.split(m.lane[0], cut), "split") else {
        drop_pair(tr, &m.lane, tiles);
        return;
    };
    let Some(b1) = ok(tr.split(m.lane[1], cut), "split") else {
        drop_pair(tr, &[m.lane[0], b0, m.lane[1]], tiles);
        return;
    };
    run_pair(tr, m.lane, front, dir, cut / STRAIGHT_LEN);
    run_pair(tr, [b0, b1], back_front, dir, (m.len - cut) / STRAIGHT_LEN);
}

/// Cuts the run through `at` in front of the tile: `at` is the front of the back part.
fn cut_front(tr: Tx<'_>, at: TilePos, dir: Dir, m: Mapped) {
    let front = ahead(at, dir, (m.off / STRAIGHT_LEN) as i32);
    split_pair(tr, m, m.off, front, at, dir);
}

/// Cuts the run through `at` behind the tile: `at` is the back of the front part.
fn cut_back(tr: Tx<'_>, at: TilePos, dir: Dir, m: Mapped) {
    let front = ahead(at, dir, (m.off / STRAIGHT_LEN) as i32);
    split_pair(
        tr,
        m,
        m.off + STRAIGHT_LEN,
        front,
        ahead(at, opposite(dir), 1),
        dir,
    );
}

// ---------------------------------------------------------------------------------------------
// The tick rule

/// The tiles whose shape, run or lines an edit on `p` can change: `p` and its four neighbours.
const fn around(p: TilePos) -> [TilePos; 5] {
    [
        p,
        TilePos::new(p.x, p.y - 1),
        TilePos::new(p.x + 1, p.y),
        TilePos::new(p.x, p.y + 1),
        TilePos::new(p.x - 1, p.y),
    ]
}

/// A woken belt (placed, rotated, `removing`, or reshaped in `apply`): reconciles the lines on its
/// tile and its neighbours (module doc), puts every changed shape, and despawns a `removing` belt.
pub fn on_wake(cx: &mut TickCx<'_, RefGame>, id: EntityId, belt: Belt) {
    let p = belt.origin.tile();
    // A splitter (M54) reconciles around both halves: each tile once, in order.
    let (tiles, count) = footprint_tiles(&belt);
    let tiles = &tiles[..count];
    let mut near_buf = [p; 10];
    let mut n = 0;
    for &h in tiles {
        for t in around(h) {
            if !near_buf[..n].contains(&t) {
                near_buf[n] = t;
                n += 1;
            }
        }
    }
    let near = &near_buf[..n];
    let before = mapped(cx.transport(), p).map(|m| m.lane);
    for &t in near {
        cut(cx, t);
    }
    for &t in near {
        reform(cx, t);
    }
    for &t in near {
        join(cx, t);
    }
    // A run that got shorter may now fit beside a run it was held apart from at `MAX_LINE_TILES`:
    // the two end tiles of every run within two tiles of `p` try again. Every piece `cut` left has a
    // tile there (a neighbour's run, or the run behind or beside a neighbour that became a curve),
    // and its far end is the one that matters (far from `p` only when a run passes the limit).
    for &h in tiles {
        for dy in -2i32..=2 {
            let r = 2 - dy.abs();
            for dx in -r..=r {
                let t = TilePos::new(h.x + dx, h.y + dy);
                if let Some(m) = mapped(cx.transport(), t)
                    && let Form::Run(dir) = m.form
                {
                    let front = ahead(t, dir, (m.off / STRAIGHT_LEN) as i32);
                    let back = ahead(front, opposite(dir), m.tiles() as i32 - 1);
                    join(cx, front);
                    join(cx, back);
                }
            }
        }
    }
    // Outputs: every belt within two tiles (its front is within one of `p`); a splitter's two
    // diamonds overlap, and a second visit changes nothing.
    for &h in tiles {
        for dy in -2i32..=2 {
            let r = 2 - dy.abs();
            for dx in -r..=r {
                fix_output(cx, TilePos::new(h.x + dx, h.y + dy));
            }
        }
    }
    // A splitter whose lines a neighbour's wake (re)created (after a full cap dropped them): its
    // halves and the tiles behind them may lie outside the diamonds above, so their outputs (the
    // feeders' `Next` into its inputs, its own outputs and forks) are set here too.
    for &t in near {
        if let Some(b) = live_belt(cx, t).ok().flatten()
            && b.kind == BeltKind::Splitter
        {
            for h in splitter_halves(&b) {
                fix_output(cx, h);
                fix_output(cx, ahead(h, opposite(b.dir), 1));
            }
        }
    }
    // Pairing (M55), once every tile's lines exist.
    pair_around(cx, near, p, belt.kind);
    for &t in near {
        put_shape(cx, t);
    }
    if belt.removing {
        cx.despawn(id);
    } else if belt.kind == BeltKind::Spawner
        && let Some(tr) = tx(cx)
        && let Some(m) = mapped(tr, p)
        && before == Some(m.lane)
    {
        // Lines kept: a `SetSpawner` or a rotation (M59: its lines rescaled, items kept) woke it;
        // both restart the schedules at zero credit (question 13). Lines `reform` re-created were
        // scheduled there.
        schedule(tr, m.lane, belt);
    }
}

/// The engine schedule `cfg` asks of a spawner lane (`None`: the lane makes nothing). A rate index
/// past [`content::SPAWN_RATES`] (refused by `SetSpawner`) makes nothing.
pub fn schedule_for(cfg: Option<crate::SpawnCfg>) -> Option<Schedule> {
    let cfg = cfg?;
    let period = *content::SPAWN_RATES.get(usize::from(cfg.rate))?;
    Some(Schedule {
        period,
        acc: 0,
        kinds: 0,
        next: Item(u16::from(cfg.item) + 1),
    })
}

/// A spawner's lane schedules (M53b), both lanes from `b.spawn` (`None` for an unset lane): run by
/// `reform` whenever it creates a spawner's lines (placed, re-mapped beside an edit after a full cap
/// dropped them, or re-created after a refused rotation's rescale) and by `on_wake` after a
/// `SetSpawner` or a rotation that kept the lines (M59). Both lanes every time (the entity does not say which lane changed, and two `SetSpawner`s
/// in one tick give one wake): the unchanged lane restarts at `acc` 0 and loses at most one period of
/// credit. A refusal (`Full` at the forecast tracker's pool, or anything else) leaves the lane making
/// nothing and is counted ([`spawners_unscheduled`]); one other than `Full` is a bug (debug assert).
fn schedule(tr: Tx<'_>, lane: [LineId; 2], b: Belt) {
    for (k, &line) in lane.iter().enumerate() {
        bump();
        let r = tr.set_spawner(line, schedule_for(b.spawn[k]));
        debug_assert!(
            matches!(r, Ok(()) | Err(TransportError::Full)),
            "topology: set_spawner: {r:?}"
        );
        if r.is_err() {
            unscheduled();
        }
    }
}

/// Phase 1: splits the runs through `at` where the tile must leave them or change form.
fn cut(cx: &mut TickCx<'_, RefGame>, at: TilePos) {
    let Some(m) = mapped(cx.transport(), at) else {
        return;
    };
    let Form::Run(dir) = m.form else {
        return; // a curve is a line pair of its own.
    };
    let w = want(cx, at).filter(|w| w.form == m.form);
    let keep_front = w.is_some_and(|w| w.join_front);
    let keep_back = w.is_some_and(|w| w.join_back);
    let Some(tr) = tx(cx) else { return };
    let m = if m.off > 0 && !keep_front {
        cut_front(tr, at, dir, m);
        match mapped(tr, at) {
            Some(m) => m,
            None => return,
        }
    } else {
        m
    };
    if m.off + STRAIGHT_LEN < m.len && !keep_back {
        cut_back(tr, at, dir, m);
    }
}

/// Phase 2: the tile's own lines: destroyed when its belt is gone, created (or a run extended) for a
/// new belt, rescaled for a reshape or a rotation (items kept; destroyed and re-created only when a
/// rescale is refused, and for an underground end's rotation).
fn reform(cx: &mut TickCx<'_, RefGame>, at: TilePos) {
    if reform_splitter(cx, at) {
        return;
    }
    let w = want(cx, at);
    let spawner = live_belt(cx, at)
        .ok()
        .flatten()
        .filter(|b| b.kind == BeltKind::Spawner);
    let Some(tr) = tx(cx) else { return };
    let before = mapped(tr, at).map(|m| m.lane);
    reform_lines(tr, at, w);
    // A spawner whose lines this made afresh gets its schedules now (its own wake or a neighbour's).
    if let Some(b) = spawner
        && let Some(m) = mapped(tr, at)
        && before != Some(m.lane)
    {
        schedule(tr, m.lane, b);
    }
}

fn reform_lines(tr: Tx<'_>, at: TilePos, w: Option<Want>) {
    match (w, mapped(tr, at)) {
        (None, None) => {}
        (None, Some(m)) => destroy(tr, m),
        (Some(w), None) => attach(tr, at, w),
        (Some(w), Some(m)) if w.form != m.form => {
            debug_assert!(m.tiles() == 1, "cut left {at:?} in a run");
            // A run or a curve before and after keeps its lines and items, whatever the direction
            // (M59: a reshape, and a rotation since Tyler's 2026-10-13 answer); a refused rescale
            // falls back to destroy and re-create. An underground end is never rescaled (M55: it
            // only changes by rotation, which destroys its items).
            let rescalable = matches!(
                (w.form, m.form),
                (
                    Form::Run(_) | Form::Curve(..),
                    Form::Run(_) | Form::Curve(..)
                )
            );
            if rescalable && reshape(tr, at, w.form, m) {
                return;
            }
            destroy(tr, m);
            create(tr, at, w.form);
        }
        (Some(_), Some(_)) => {}
    }
}

/// Rescales a lone tile's two lines to `form` (straight <-> curve, a curve's side, or a new
/// direction: M59), keeping their items at `floor(pos x new / old)`, lane `k` staying lane `k`, and
/// lays the lines along `form`'s path; `false` (nothing changed beyond what the caller destroys) if
/// a rescale is refused (`NoRoom`).
fn reshape(tr: Tx<'_>, at: TilePos, form: Form, m: Mapped) -> bool {
    for lane in 0..2u8 {
        let line = m.lane[usize::from(lane)];
        if ok(tr.rescale(line, lane_len(form, lane)), "rescale").is_none() {
            return false;
        }
    }
    let segs = match form {
        Form::Run(dir) => [run_segment(at, dir, 1, 0), run_segment(at, dir, 1, 1)],
        Form::Curve(dir, shape) => [
            curve_segment(at, dir, shape, 0),
            curve_segment(at, dir, shape, 1),
        ],
        Form::Underground(..) => unreachable!("an underground end is never rescaled"),
    };
    register(tr, m.lane, segs, 1);
    true
}

/// A new belt's lines: the run in front grows at its back, or the run behind at its front (while
/// the run stays within [`MAX_LINE_TILES`]: a longer chain is several runs linked by `Next`), else
/// two new lines (the join phase links what is left).
fn attach(tr: Tx<'_>, at: TilePos, w: Want) {
    let Form::Run(dir) = w.form else {
        create(tr, at, w.form);
        return;
    };
    if w.join_front {
        let f = ahead(at, dir, 1);
        if let Some(mf) = mapped(tr, f)
            && mf.form == w.form
            && mf.off + STRAIGHT_LEN == mf.len
            && mf.tiles() < MAX_LINE_TILES
        {
            let front = ahead(f, dir, (mf.off / STRAIGHT_LEN) as i32);
            for line in mf.lane {
                ok(tr.extend_back(line, STRAIGHT_LEN), "extend_back");
            }
            run_pair(tr, mf.lane, front, dir, mf.tiles() + 1);
            return;
        }
    }
    if w.join_back {
        let b = ahead(at, opposite(dir), 1);
        if let Some(mb) = mapped(tr, b)
            && mb.form == w.form
            && mb.off == 0
            && mb.tiles() < MAX_LINE_TILES
        {
            for line in mb.lane {
                ok(tr.extend_front(line, STRAIGHT_LEN), "extend_front");
            }
            run_pair(tr, mb.lane, at, dir, mb.tiles() + 1);
            return;
        }
    }
    create(tr, at, w.form);
}

/// Phase 3: joins the tile's run with the run in front and the run behind where they belong
/// together (`set_out(Next)`, then `join`, then the joined line's segment).
fn join(cx: &mut TickCx<'_, RefGame>, at: TilePos) {
    let Some(w) = want(cx, at) else { return };
    let Form::Run(dir) = w.form else { return };
    let Some(tr) = tx(cx) else { return };
    if w.join_front
        && let Some(m) = mapped(tr, at)
        && m.form == w.form
        && m.off == 0
    {
        let f = ahead(at, dir, 1);
        if let Some(mf) = mapped(tr, f)
            && mf.form == w.form
            && mf.off + STRAIGHT_LEN == mf.len
        {
            link(
                tr,
                ahead(f, dir, (mf.off / STRAIGHT_LEN) as i32),
                dir,
                mf,
                m,
            );
        }
    }
    if w.join_back
        && let Some(m) = mapped(tr, at)
        && m.form == w.form
        && m.off + STRAIGHT_LEN == m.len
    {
        let b = ahead(at, opposite(dir), 1);
        if let Some(mb) = mapped(tr, b)
            && mb.form == w.form
            && mb.off == 0
        {
            link(
                tr,
                ahead(at, dir, (m.off / STRAIGHT_LEN) as i32),
                dir,
                m,
                mb,
            );
        }
    }
}

/// Joins run `back` onto run `front` (whose front tile is `front_tile`), lane for lane, unless the
/// joined run would pass [`MAX_LINE_TILES`] (the tile index's limit on one line): then the two stay
/// separate runs and the output phase links them with `Next` (a run boundary inside a straight chain).
fn link(tr: Tx<'_>, front_tile: TilePos, dir: Dir, front: Mapped, back: Mapped) {
    let tiles = front.tiles() + back.tiles();
    if tiles > MAX_LINE_TILES {
        return;
    }
    for lane in 0..2usize {
        let (f, b) = (front.lane[lane], back.lane[lane]);
        if tr.out(b) != Ok(Output::Next(f)) {
            ok(tr.set_out(b, Output::Next(f)), "set_out(join)");
        }
        ok(tr.join(f, b), "join");
    }
    run_pair(tr, front.lane, front_tile, dir, tiles);
}

/// Phase 4: the output of the line pair `at` fronts, from its front tile ([`output_of`]); on a
/// splitter half (M54) its output lines' and its input lines' forks.
fn fix_output(cx: &mut TickCx<'_, RefGame>, at: TilePos) {
    let Some(b) = live_belt(cx, at).ok().flatten() else {
        return;
    };
    if b.kind == BeltKind::UndergroundIn {
        return; // its lanes' outputs are the pairing's (`pair_entrance`).
    }
    let Ok(link) = output_of(cx, at, b) else {
        return;
    };
    let Some(tr) = tx(cx) else { return };
    let lanes = if b.kind == BeltKind::Splitter {
        let Some(s) = splitter_lanes(tr, at) else {
            return;
        };
        let [l, r] = splitter_halves(&b).map(|h| splitter_lanes(tr, h));
        if let (Some(l), Some(r)) = (l, r) {
            for k in 0..2 {
                let fork = Output::Fork {
                    a: l.output[k],
                    b: r.output[k],
                };
                set_out(tr, s.input[k], fork);
            }
        }
        s.output
    } else {
        let Some(m) = mapped(tr, at) else { return };
        if m.off != 0 {
            return; // inside a run: the line carries on.
        }
        m.lane
    };
    let outs = outputs_into(tr, link, ahead(at, b.dir, 1));
    for (lane, out) in outs.into_iter().enumerate() {
        set_out(tr, lanes[lane], out);
    }
}

/// `set_out` when the line's output differs (an equal one would be a no-op anyway: the fork toggle
/// is kept either way).
fn set_out(tr: Tx<'_>, line: LineId, out: Output) {
    if tr.out(line) != Ok(out) {
        ok(tr.set_out(line, out), "set_out");
    }
}

/// The two lanes' outputs for `link` into the tile `front`: `Next` onto a curve, the back of a run, a
/// splitter half's input lines (M54) or an underground entrance's (M55), `Merge` onto a straight
/// belt's near lane (on an underground end only where the landing is on its visible half: the hood
/// filter, module doc), `Sink`, or a dead end when the target is not mapped.
fn outputs_into(tr: &dyn TransportRead, link: Link, front: TilePos) -> [Output; 2] {
    match link {
        Link::Sink => [Output::Sink; 2],
        Link::DeadEnd => [Output::DeadEnd; 2],
        Link::Next => {
            if let Some(s) = splitter_lanes(tr, front) {
                return [Output::Next(s.input[0]), Output::Next(s.input[1])];
            }
            match mapped(tr, front) {
                Some(t)
                    if matches!(t.form, Form::Curve(..) | Form::Underground(_, End::In))
                        || (matches!(t.form, Form::Run(_)) && t.off + STRAIGHT_LEN == t.len) =>
                {
                    [Output::Next(t.lane[0]), Output::Next(t.lane[1])]
                }
                _ => [Output::DeadEnd; 2],
            }
        }
        Link::SideLoad { near } => match mapped(tr, front) {
            Some(t) => {
                let line = t.lane[usize::from(near)];
                // Each feeder lane's landing behind the target tile's front edge.
                let out = |lane: u8| {
                    let l = if lane == near { SIDE_FRONT } else { SIDE_BACK };
                    match t.form {
                        Form::Underground(_, End::In) if l >= UNDERGROUND_HALF => Output::Merge {
                            line,
                            at: l - UNDERGROUND_HALF,
                        },
                        Form::Underground(_, End::Out) if l < UNDERGROUND_HALF => {
                            Output::Merge { line, at: l }
                        }
                        Form::Underground(..) => Output::DeadEnd,
                        _ => Output::Merge {
                            line,
                            at: t.off + l,
                        },
                    }
                };
                [out(0), out(1)]
            }
            None => [Output::DeadEnd; 2],
        },
    }
}

// ---------------------------------------------------------------------------------------------
// Undergrounds (M55)

/// The partner of an underground entrance facing `dir` on `at`: the first underground on `dir`'s
/// axis within [`UNDERGROUND_MAX_GAP`] + 1 tiles ahead ends the search, and it is the partner iff it
/// is an exit facing `dir`: `Some((exit tile, gap))`. Undergrounds on the other axis and anything
/// else between are passed over (question 14 (b)'s default). A pure function of the layout.
pub fn underground_partner(
    w: &dyn WorldRead<RefGame>,
    at: TilePos,
    dir: Dir,
) -> Result<Option<(TilePos, u32)>, Unknown> {
    for k in 1..=UNDERGROUND_MAX_GAP + 1 {
        let t = ahead(at, dir, k as i32);
        if let Some(b) = live_belt(w, t)?
            && b.kind.is_underground()
            && horizontal(b.dir) == horizontal(dir)
        {
            return Ok((b.kind == BeltKind::UndergroundOut && b.dir == dir).then_some((t, k - 1)));
        }
    }
    Ok(None)
}

/// The hidden lines an entrance's lanes lead into (a `Next` to a line without segments), per lane.
fn hidden_of(tr: &dyn TransportRead, lane: [LineId; 2]) -> [Option<LineId>; 2] {
    lane.map(|l| match tr.out(l) {
        Ok(Output::Next(h)) => {
            let mut segs = 0u32;
            let _ = tr.segments(h, &mut |_| segs += 1);
            (segs == 0).then_some(h)
        }
        _ => None,
    })
}

/// The hidden lines (lane 0, lane 1) of the paired entrance on `at`: `None` unless `at` holds an
/// entrance whose lanes both lead into hidden lines (tests, the oracle and the item hook).
pub fn hidden_lanes(tr: &dyn TransportRead, at: TilePos) -> Option<[LineId; 2]> {
    let m = mapped(tr, at)?;
    let Form::Underground(_, End::In) = m.form else {
        return None;
    };
    match hidden_of(tr, m.lane) {
        [Some(a), Some(b)] => Some([a, b]),
        _ => None,
    }
}

/// Reconciles the entrance facing `dir` on `at` with its partner ([`underground_partner`]).
/// Unpaired: its hidden lines are destroyed (their items with them; the redirect dead-ends its lanes)
/// and its lanes dead-end at the hood. Paired across `gap`: its lanes lead into hidden lines of
/// `(gap + 1) x 256` (kept when both already have that length, else destroyed and created afresh,
/// their items lost) whose outputs are the exit's lanes, lane for lane. Writes only what differs, so
/// a second call changes nothing. At a full line cap neither hidden line is made (counted by
/// [`belts_unmapped`]) and the entrance dead-ends.
fn pair_entrance(cx: &mut TickCx<'_, RefGame>, at: TilePos, dir: Dir) {
    let Ok(partner) = underground_partner(cx, at, dir) else {
        return;
    };
    let Some(tr) = tx(cx) else { return };
    let Some(me) = mapped(tr, at).filter(|m| m.form == Form::Underground(dir, End::In)) else {
        return; // unmapped (a full cap): nothing to pair.
    };
    let exit = partner.and_then(|(t, gap)| {
        mapped(tr, t)
            .filter(|m| m.form == Form::Underground(dir, End::Out))
            .map(|m| (m.lane, gap))
    });
    let hidden = hidden_of(tr, me.lane);
    let Some((x, gap)) = exit else {
        for (h, lane) in hidden.into_iter().zip(me.lane) {
            match h {
                Some(h) => {
                    kill(tr, h, "destroy(hidden)");
                }
                None => set_out(tr, lane, Output::DeadEnd),
            }
        }
        return;
    };
    let len = (gap + 1) * STRAIGHT_LEN;
    let h = match hidden {
        [Some(a), Some(b)] if tr.len(a) == Ok(len) && tr.len(b) == Ok(len) => [a, b],
        _ => {
            for h in hidden.into_iter().flatten() {
                kill(tr, h, "destroy(hidden)");
            }
            let Some(a) = ok(tr.create(len, SPEED), "create(hidden)") else {
                unmapped(gap + 1);
                return;
            };
            let Some(b) = ok(tr.create(len, SPEED), "create(hidden)") else {
                drop_pair(tr, &[a], gap + 1);
                return;
            };
            [a, b]
        }
    };
    for k in 0..2 {
        set_out(tr, h[k], Output::Next(x[k]));
        set_out(tr, me.lane[k], Output::Next(h[k]));
    }
}

/// The pairing phase of a wake (M55), after every tile's lines exist: for each tile of `near` that
/// is the woken underground (`kind` on `woken`, also when it is being picked up) or holds a live one
/// (its lines may have been re-created after a full cap), every entrance on it or up to five tiles
/// behind it along a direction, facing that direction (both axes: a rotation changes the axis), is
/// reconciled ([`pair_entrance`]). An edit anywhere else changes no pairing (tiles between an
/// entrance and its exit may hold anything).
fn pair_around(cx: &mut TickCx<'_, RefGame>, near: &[TilePos], woken: TilePos, kind: BeltKind) {
    const DIRS: [Dir; 4] = [Dir::East, Dir::South, Dir::West, Dir::North];
    for &t in near {
        let here = (t == woken && kind.is_underground())
            || live_belt(cx, t)
                .ok()
                .flatten()
                .is_some_and(|b| b.kind.is_underground());
        if !here {
            continue;
        }
        for d in DIRS {
            for k in 0..=(UNDERGROUND_MAX_GAP + 1) as i32 {
                let e = ahead(t, d, -k);
                if let Some(b) = live_belt(cx, e).ok().flatten()
                    && b.kind == BeltKind::UndergroundIn
                    && b.dir == d
                {
                    pair_entrance(cx, e, d);
                }
            }
        }
    }
}

/// Phase 5: one put when the tile's stored shape is not its derived one (the authoritative write;
/// `apply` derived the edited tile's own already).
fn put_shape(cx: &mut TickCx<'_, RefGame>, at: TilePos) {
    let Ok(Some(id)) = cx.entity_at(at) else {
        return;
    };
    let Some(b) = cx
        .entity(id)
        .ok()
        .flatten()
        .and_then(RefEntity::as_live_belt)
        .copied()
    else {
        return;
    };
    let Ok(shape) = shape_of_kind(cx, at, b.dir, b.kind) else {
        return;
    };
    if shape != b.shape {
        cx.put_entity(id, RefEntity::Belt(Belt { shape, ..b }));
    }
}

/// `test-hooks` only (M52): serves a `TestInsertItem` request (`insert_at` on the tile's lane, its
/// result ignored: a refused insert is the test's to see) and despawns it.
#[cfg(feature = "test-hooks")]
pub fn test_insert(cx: &mut TickCx<'_, RefGame>, id: EntityId, r: crate::TestInsert) {
    if let Some(tr) = tx(cx) {
        let at = r.at.tile();
        // M54: a splitter half's lanes 0 and 1 are its input lines, 2 and 3 its output lines.
        let target = if let Some(s) = splitter_lanes(tr, at) {
            [s.input[0], s.input[1], s.output[0], s.output[1]]
                .get(usize::from(r.lane))
                .map(|&l| (l, 0))
        } else if r.lane >= 2 {
            // M55: a paired entrance's hidden lanes, from their front.
            hidden_lanes(tr, at)
                .and_then(|h| h.get(usize::from(r.lane - 2)).copied())
                .map(|l| (l, 0))
        } else {
            mapped(tr, at).and_then(|m| m.lane.get(usize::from(r.lane)).map(|&l| (l, m.off)))
        };
        if let Some((line, off)) = target {
            bump();
            let _ = tr.insert_at(line, off + u32::from(r.pos), Item(r.item));
        }
    }
    cx.despawn(id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::transport::Transport;

    /// M59's fallback: a rotation whose `rescale` is refused destroys and re-creates the tile's
    /// lines. Play reaches it only through many rescales of a squashed pair at rest (module doc,
    /// **Rotation**), so the pair is built with the engine's own surgery: two items 128 apart on a 25,600 line rescaled to one tile
    /// (256) sit at 0 and 1; a rotation that makes lane 0 a curve's inner lane (106) would put both
    /// at 0 (`NoRoom`). The tile's three items are counted destroyed and its lanes are two fresh
    /// lines of the new form. Fails if a refused rescale keeps the old lines or leaves the tile
    /// unmapped.
    #[test]
    fn topology_rotate_no_room_falls_back() {
        let mut t = Transport::new(16, 16);
        let at = TilePos::new(5, 5);
        let a = t.create(100 * STRAIGHT_LEN, SPEED).unwrap();
        t.insert_at(a, 0, Item(1)).unwrap();
        t.insert_at(a, 128, Item(2)).unwrap();
        t.rescale(a, STRAIGHT_LEN).unwrap();
        let b = t.create(STRAIGHT_LEN, SPEED).unwrap();
        t.insert_at(b, 64, Item(3)).unwrap();
        assert!(run_pair(&mut t, [a, b], at, Dir::East, 1));
        let mut pos = [0u32; 2];
        let mut n = 0;
        t.items_in(a, &mut |_, p| {
            pos[n] = p;
            n += 1;
        })
        .unwrap();
        assert_eq!(pos, [0, 1], "a squashed pair one position apart");
        let m = mapped(&t, at).expect("mapped");
        assert_eq!((m.lane, m.form), ([a, b], Form::Run(Dir::East)));

        let form = Form::Curve(Dir::South, BeltShape::CurveLeft);
        assert_eq!(lane_len(form, 0), INNER_LEN, "lane 0 is the inner lane");
        let destroyed = belts_destroyed_items();
        let w = Want {
            dir: Dir::South,
            form,
            join_back: false,
            join_front: false,
        };
        reform_lines(&mut t, at, Some(w));
        assert_eq!(belts_destroyed_items(), destroyed + 3, "the tile's items");
        assert!(t.len(a).is_err() && t.len(b).is_err(), "the old lines gone");
        let m = mapped(&t, at).expect("re-created");
        assert_eq!(m.form, form);
        assert!(!m.lane.contains(&a) && !m.lane.contains(&b), "fresh ids");
        assert_eq!((t.count(m.lane[0]), t.count(m.lane[1])), (Ok(0), Ok(0)));
    }
}
