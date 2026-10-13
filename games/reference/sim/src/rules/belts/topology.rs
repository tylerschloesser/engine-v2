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
//! a tile's lines when its belt is gone, create or extend them for a new belt, rescale for a straight
//! <-> curve reshape keeping items, destroy and re-create for a rotation: its items are destroyed,
//! Tyler's question 10 default), join (`set_out(Next)` then `join` for neighbours of one run), outputs
//! (every live belt within two tiles of P whose line it fronts: its output is a function of its front
//! tile, whose shape P can change), shapes (one `put_entity` per changed shape) and, for a `removing`
//! belt, the despawn. Every op that changes a line's `len` is followed by `set_segments` on that line,
//! so every line is always in the tile index and the mapping is read back from `lines_at`
//! ([`mapped`]): the entity stores no line id (0076 §4). Each phase is idempotent, so a tile woken
//! twice, or two edits in one tick, end in the same structure. No `HashMap`, no float, no allocation.

use engine::game::{EntityId, TickCx, Unknown, WorldRead, WorldWrite};
#[cfg(feature = "test-hooks")]
use engine::transport::Item;
use engine::transport::{
    Geometry, LineId, MAX_LINE_TILES, Output, Segment, TransportError, TransportRead,
    TransportWrite,
};
use engine::world::{TilePos, WorldPos};

use crate::{Belt, BeltShape, Dir, RefEntity, RefGame};

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
}

/// The live belt on `at` (not `removing`), if any.
pub fn live_belt(w: &dyn WorldRead<RefGame>, at: TilePos) -> Result<Option<Belt>, Unknown> {
    let Some(id) = w.entity_at(at)? else {
        return Ok(None);
    };
    Ok(w.entity(id)?.and_then(RefEntity::as_live_belt).copied())
}

fn feeds(w: &dyn WorldRead<RefGame>, from: TilePos, into: TilePos) -> Result<bool, Unknown> {
    Ok(live_belt(w, from)?.is_some_and(|b| ahead(from, b.dir, 1) == into))
}

/// [`Inputs`] of a belt facing `dir` on `at` (whatever stands on `at` itself).
pub fn inputs(w: &dyn WorldRead<RefGame>, at: TilePos, dir: Dir) -> Result<Inputs, Unknown> {
    Ok(Inputs {
        back: feeds(w, ahead(at, opposite(dir), 1), at)?,
        left: feeds(w, ahead(at, ccw(dir), 1), at)?,
        right: feeds(w, ahead(at, dir.cw(), 1), at)?,
    })
}

/// R1-R5: the shape an input set gives.
pub const fn shape_for(i: Inputs) -> BeltShape {
    match (i.back, i.left, i.right) {
        (false, true, false) => BeltShape::CurveLeft,
        (false, false, true) => BeltShape::CurveRight,
        _ => BeltShape::Straight,
    }
}

/// The shape of a belt facing `dir` on `at`.
pub fn shape_of(w: &dyn WorldRead<RefGame>, at: TilePos, dir: Dir) -> Result<BeltShape, Unknown> {
    Ok(shape_for(inputs(w, at, dir)?))
}

/// The output of the belt `b` standing on `at` (C1-C4, R6, R7).
pub fn output_of(w: &dyn WorldRead<RefGame>, at: TilePos, b: Belt) -> Result<Link, Unknown> {
    let front = ahead(at, b.dir, 1);
    let Some(f) = live_belt(w, front)? else {
        return Ok(Link::DeadEnd);
    };
    if f.dir == b.dir {
        return Ok(Link::Next);
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

/// A line's form, read back from its segment.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Form {
    Run(Dir),
    Curve(Dir, BeltShape),
}

/// The lane length of `form`'s lane `lane` on one tile.
const fn lane_len(form: Form, lane: u8) -> u32 {
    match form {
        Form::Run(_) => STRAIGHT_LEN,
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

/// What a segment says about the tile `at` it enters: its form and lane.
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
            Form::Curve(..) => 1,
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

/// The lanes mapped on `at`, `None` when no belt line enters it.
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
        n == 0 || n == 2,
        "tile {at:?}: {n} lines, not one belt's two lanes"
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
    let shape = shape_of(w, at, b.dir).ok()?;
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
        join_back: straight
            && same(back).is_some()
            && shape_of(w, back, b.dir).ok() == Some(BeltShape::Straight),
        join_front: straight && same(ahead(at, b.dir, 1)).is_some(),
    })
}

// ---------------------------------------------------------------------------------------------
// Transport writes (each counted; `len` changes re-register segments at once)

type Tx<'c> = &'c mut dyn TransportWrite;

fn tx<'c>(cx: &'c mut TickCx<'_, RefGame>) -> Option<Tx<'c>> {
    cx.transport_mut().ok()
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
            ok(tr.destroy(l, &mut |_| {}), "destroy(unmapped)");
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

/// Destroys a tile's lines (pick-up and rotation destroy the tile's items: nothing to count until
/// M53's items).
fn destroy(tr: Tx<'_>, m: Mapped) {
    for l in m.lane {
        ok(tr.destroy(l, &mut |_| {}), "destroy");
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
    let near = around(p);
    for t in near {
        cut(cx, t);
    }
    for t in near {
        reform(cx, t);
    }
    for t in near {
        join(cx, t);
    }
    // A run that got shorter may now fit beside a run it was held apart from at `MAX_LINE_TILES`:
    // the two end tiles of every run within two tiles of `p` try again. Every piece `cut` left has a
    // tile there (a neighbour's run, or the run behind or beside a neighbour that became a curve),
    // and its far end is the one that matters (far from `p` only when a run passes the limit).
    for dy in -2i32..=2 {
        let r = 2 - dy.abs();
        for dx in -r..=r {
            let t = TilePos::new(p.x + dx, p.y + dy);
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
    // Outputs: every belt within two tiles (its front is within one of `p`).
    for dy in -2i32..=2 {
        let r = 2 - dy.abs();
        for dx in -r..=r {
            fix_output(cx, TilePos::new(p.x + dx, p.y + dy));
        }
    }
    for t in near {
        put_shape(cx, t);
    }
    if belt.removing {
        cx.despawn(id);
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
/// new belt, rescaled for a reshape (items kept), destroyed and re-created for a rotation.
fn reform(cx: &mut TickCx<'_, RefGame>, at: TilePos) {
    let w = want(cx, at);
    let Some(tr) = tx(cx) else { return };
    match (w, mapped(tr, at)) {
        (None, None) => {}
        (None, Some(m)) => destroy(tr, m),
        (Some(w), None) => attach(tr, at, w),
        (Some(w), Some(m)) if w.form != m.form => {
            debug_assert!(m.tiles() == 1, "cut left {at:?} in a run");
            let same_dir = match (w.form, m.form) {
                (Form::Run(a) | Form::Curve(a, _), Form::Run(b) | Form::Curve(b, _)) => a == b,
            };
            if same_dir && reshape(tr, at, w.form, m) {
                return;
            }
            destroy(tr, m);
            create(tr, at, w.form);
        }
        (Some(_), Some(_)) => {}
    }
}

/// Rescales a lone tile's two lines to `form` (straight <-> curve, or a curve's side), keeping their
/// items at `floor(pos x new / old)`; `false` (nothing changed beyond what the caller destroys) if a
/// rescale is refused.
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

/// Phase 4: the output of the line pair `at` fronts, from its front tile ([`output_of`]).
fn fix_output(cx: &mut TickCx<'_, RefGame>, at: TilePos) {
    let Some(b) = live_belt(cx, at).ok().flatten() else {
        return;
    };
    let Ok(link) = output_of(cx, at, b) else {
        return;
    };
    let Some(tr) = tx(cx) else { return };
    let Some(m) = mapped(tr, at) else { return };
    if m.off != 0 {
        return; // inside a run: the line carries on.
    }
    let target = mapped(tr, ahead(at, b.dir, 1));
    let outs = match (link, target) {
        (Link::Next, Some(t))
            if matches!(t.form, Form::Curve(..)) || t.off + STRAIGHT_LEN == t.len =>
        {
            [Output::Next(t.lane[0]), Output::Next(t.lane[1])]
        }
        (Link::SideLoad { near }, Some(t)) => {
            let line = t.lane[usize::from(near)];
            let at_of = |lane: u8| t.off + if lane == near { SIDE_FRONT } else { SIDE_BACK };
            [
                Output::Merge { line, at: at_of(0) },
                Output::Merge { line, at: at_of(1) },
            ]
        }
        _ => [Output::DeadEnd; 2],
    };
    for (lane, out) in outs.into_iter().enumerate() {
        let line = m.lane[lane];
        if tr.out(line) != Ok(out) {
            ok(tr.set_out(line, out), "set_out");
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
    let Ok(shape) = shape_of(cx, at, b.dir) else {
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
    if let Some(tr) = tx(cx)
        && let Some(m) = mapped(tr, r.at.tile())
        && let Some(&line) = m.lane.get(usize::from(r.lane))
    {
        bump();
        let _ = tr.insert_at(line, m.off + u32::from(r.pos), Item(r.item));
    }
    cx.despawn(id);
}
