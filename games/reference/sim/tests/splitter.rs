//! Splitters on the host (M54; README "Belts", Splitters; `belts/docs/03` §4.2, §7): the 2x1 entity's
//! placement, 180-degree rotation and pick-up, its eight lines and four forks, what connects to it
//! (from behind a half; never into a long side) and what its halves feed (C1-C4), and items through
//! it: one input alternating 50/50 per lane, a blocked side taking nothing, two inputs sharing the
//! outputs. Items come from spawners (the game's own path), so these run in the fast suite; the
//! `test-hooks` case checks the item hook's splitter addressing.

mod common;

use common::RefScenario;
use engine::game::PlayerId;
use engine::transport::{Geometry, LineId, Output, TransportRead};
use engine::world::{Tile, TilePos, WorldPos};
use reference_sim::content::{self, ItemId};
use reference_sim::rules::belts::topology::{
    SplitterLanes, lanes_at, splitter_halves, splitter_lanes,
};
use reference_sim::{Belt, BeltKind, BeltShape, Dir, RefReject, TileXY};

const P1: PlayerId = PlayerId(1);
const DIRS: [Dir; 4] = [Dir::East, Dir::South, Dir::West, Dir::North];
const IRON: u8 = ItemId::Iron as u8;
const COAL: u8 = ItemId::Coal as u8;
/// `content::SPAWN_RATES`' saturation rate (7.5 items a second per lane).
const SATURATE: u8 = 3;

fn world() -> RefScenario {
    let mut s = RefScenario::new();
    s.join(P1);
    s.clear_area(TilePos::new(30, 30), 40, 40);
    s
}

fn put(s: &mut RefScenario, at: TilePos, dir: Dir, kind: BeltKind) {
    s.place_belt(P1, at, dir, kind)
        .unwrap_or_else(|r| panic!("place {kind:?} {at:?}: {r:?}"));
}

fn tr(s: &RefScenario) -> &dyn TransportRead {
    s.read().transport()
}

fn lanes(s: &RefScenario, at: TilePos) -> [LineId; 2] {
    lanes_at(tr(s), at)
        .unwrap_or_else(|| panic!("{at:?} is mapped"))
        .lane
}

fn sp(s: &RefScenario, half: TilePos) -> SplitterLanes {
    splitter_lanes(tr(s), half).unwrap_or_else(|| panic!("{half:?}: a splitter half"))
}

fn outs(s: &RefScenario, l: [LineId; 2]) -> [Output; 2] {
    [tr(s).out(l[0]).unwrap(), tr(s).out(l[1]).unwrap()]
}

fn sunk(s: &RefScenario, at: TilePos) -> [u64; 2] {
    let l = lanes(s, at);
    [tr(s).sunk(l[0]).unwrap(), tr(s).sunk(l[1]).unwrap()]
}

fn count(s: &RefScenario, l: LineId) -> u32 {
    tr(s).count(l).expect("line")
}

fn splitter(s: &RefScenario, origin: TilePos) -> Belt {
    let b = s.belt_at(origin).expect("a splitter");
    assert_eq!(b.kind, BeltKind::Splitter);
    b
}

/// The point at position `pos` of `l`.
fn at_pos(s: &RefScenario, l: LineId, pos: u32) -> (i32, i32) {
    let p = tr(s).pos_to_world(l, pos).expect("line").expect("on it");
    (p.x, p.y)
}

/// Every facing: a splitter anchored at (50, 50) has its halves where `dir` says (east: left north,
/// west: left south, north: left west, south: left east), eight 128-position straight lines and
/// nothing else in the store; per half and lane an output line from the front edge (the edge rule:
/// one position inside on east and south) and an input line from the midline, each on the lane's
/// cross position and inside its half; each input lane forks onto the left then the right half's
/// output lane of the same index; the outputs dead-end (nothing in front). East's eight segments are
/// pinned by coordinates. Fails if the halves are mirrored, a lane crosses over, an input and an
/// output swap, a fork targets the wrong half or lane, or a line leaks.
#[test]
fn splitter_maps_eight_lines() {
    let o = TilePos::new(50, 50);
    let halves = [
        (Dir::East, [(50, 50), (50, 51)]),
        (Dir::South, [(51, 50), (50, 50)]),
        (Dir::West, [(50, 51), (50, 50)]),
        (Dir::North, [(50, 50), (51, 50)]),
    ];
    for (dir, want) in halves {
        let mut s = world();
        put(&mut s, o, dir, BeltKind::Splitter);
        let b = splitter(&s, o);
        assert_eq!(b.origin, TileXY { x: 50, y: 50 }, "{dir:?}: anchor");
        let h = splitter_halves(&b);
        assert_eq!(
            h,
            want.map(|(x, y)| TilePos::new(x, y)),
            "{dir:?}: halves (left, right)"
        );
        assert_eq!(tr(&s).lines_len(), 8, "{dir:?}: eight lines");
        let l = h.map(|t| sp(&s, t));
        for (half, lanes) in h.into_iter().zip(l) {
            assert_eq!(lanes.dir, dir);
            for k in 0..2 {
                for line in [lanes.input[k], lanes.output[k]] {
                    assert_eq!(tr(&s).len(line), Ok(128), "{dir:?} {half:?}");
                    let mut segs = Vec::new();
                    tr(&s).segments(line, &mut |g| segs.push(g)).unwrap();
                    assert_eq!(segs.len(), 1);
                    assert!(matches!(segs[0].geometry, Geometry::Straight { .. }));
                    // Every point inside the half (the tile index sees it there alone).
                    for pos in [0, 127] {
                        let (x, y) = at_pos(&s, line, pos);
                        assert_eq!(
                            WorldPos { x, y }.tile(),
                            half,
                            "{dir:?} {half:?} lane {k} pos {pos}"
                        );
                    }
                }
                // The output's back meets the input's front: one lane through the half.
                let (ox, oy) = at_pos(&s, lanes.output[k], 127);
                let (ix, iy) = at_pos(&s, lanes.input[k], 0);
                assert_eq!(
                    (ox - ix).abs() + (oy - iy).abs(),
                    1,
                    "{dir:?}: lane {k} meets"
                );
                assert_eq!(
                    tr(&s).out(lanes.input[k]),
                    Ok(Output::Fork {
                        a: l[0].output[k],
                        b: l[1].output[k],
                        // M61: the two halves' input lane k name each other.
                        partner: Some(l[usize::from(lanes.input[k] == l[0].input[k])].input[k]),
                    }),
                    "{dir:?} {half:?} lane {k}: fork (a the left half)"
                );
                assert_eq!(tr(&s).out(lanes.output[k]), Ok(Output::DeadEnd));
            }
        }
        if dir == Dir::East {
            // Left (north) half lane 0 (north side, y 50 * 256 + 68), lane 1 (y + 188); right half
            // one tile south. Output from x 51 * 256 - 1 = 13,055 to the midline 12,927; input on.
            let seg = |line: LineId| {
                let mut v = Vec::new();
                tr(&s).segments(line, &mut |g| v.push(g.geometry)).unwrap();
                match v[0] {
                    Geometry::Straight { from, to } => ((from.x, from.y), (to.x, to.y)),
                    _ => unreachable!(),
                }
            };
            let want = [
                (l[0].output[0], ((13_055, 12_868), (12_927, 12_868))),
                (l[0].input[0], ((12_927, 12_868), (12_799, 12_868))),
                (l[0].output[1], ((13_055, 12_988), (12_927, 12_988))),
                (l[0].input[1], ((12_927, 12_988), (12_799, 12_988))),
                (l[1].output[0], ((13_055, 13_124), (12_927, 13_124))),
                (l[1].input[0], ((12_927, 13_124), (12_799, 13_124))),
                (l[1].output[1], ((13_055, 13_244), (12_927, 13_244))),
                (l[1].input[1], ((12_927, 13_244), (12_799, 13_244))),
            ];
            for (line, w) in want {
                assert_eq!(seg(line), w, "east segment of {line:?}");
            }
        }
        s.assert_topology();
    }
}

/// A belt pointing into either long side of an east splitter stays a dead end (README: "connects to
/// nothing"; measured `q15_splitter_long_side`), as does one pointing head-on into a half's front;
/// a belt behind a half feeds that half's input lanes lane for lane and is straight. Fails if a
/// side feeder side-loads or curves into the splitter, or the head-on case connects.
#[test]
fn splitter_long_side_is_dead_end() {
    let mut s = world();
    let o = TilePos::new(50, 50);
    put(&mut s, o, Dir::East, BeltKind::Splitter);
    let north = TilePos::new(50, 49);
    let south = TilePos::new(50, 52);
    let head_on = TilePos::new(51, 51);
    let behind = TilePos::new(49, 50);
    put(&mut s, north, Dir::South, BeltKind::Belt);
    put(&mut s, south, Dir::North, BeltKind::Belt);
    put(&mut s, head_on, Dir::West, BeltKind::Belt);
    put(&mut s, behind, Dir::East, BeltKind::Belt);
    for t in [north, south, head_on] {
        assert_eq!(outs(&s, lanes(&s, t)), [Output::DeadEnd; 2], "{t:?}");
    }
    let left = sp(&s, o);
    assert_eq!(
        outs(&s, lanes(&s, behind)),
        [Output::Next(left.input[0]), Output::Next(left.input[1])],
        "behind the left half"
    );
    assert_eq!(s.belt_at(behind).unwrap().shape, BeltShape::Straight);
    // The right half's front is the head-on belt: its outputs dead-end too.
    let right = sp(&s, TilePos::new(50, 51));
    assert_eq!(outs(&s, right.output), [Output::DeadEnd; 2]);
    s.assert_topology();
}

/// A half's output feeds the tile in front like a belt (C1-C4), and the half counts as that tile's
/// input (§4.2): a same-way belt is fed lane for lane and stays straight (`Next`); a belt facing
/// north in front of the left half has it as its sole (left) input and curves left, fed lane for
/// lane; with a belt behind it as well it is straight and the half side-loads its near lane 0
/// (+64 for the half's lane 0, +192 its lane 1); a belt facing back (head-on) or nothing is a dead
/// end. Fails if the half is not an input of its front tile, or its output ignores the shape.
#[test]
fn splitter_output_half_feeds_front() {
    let o = TilePos::new(50, 50);
    let left = o;
    let right = TilePos::new(50, 51);
    let fl = TilePos::new(51, 50);
    let fr = TilePos::new(51, 51);

    // Next: a same-way belt in front of the left half; nothing in front of the right half.
    let mut s = world();
    put(&mut s, o, Dir::East, BeltKind::Splitter);
    put(&mut s, fl, Dir::East, BeltKind::Belt);
    let l = lanes(&s, fl);
    assert_eq!(
        outs(&s, sp(&s, left).output),
        [Output::Next(l[0]), Output::Next(l[1])]
    );
    assert_eq!(outs(&s, sp(&s, right).output), [Output::DeadEnd; 2]);
    assert_eq!(s.belt_at(fl).unwrap().shape, BeltShape::Straight);
    s.assert_topology();

    // Curve: a north belt in front of the left half (fed from its left, the half's tile).
    let mut s = world();
    put(&mut s, o, Dir::East, BeltKind::Splitter);
    put(&mut s, fl, Dir::North, BeltKind::Belt);
    assert_eq!(s.belt_at(fl).unwrap().shape, BeltShape::CurveLeft);
    let l = lanes(&s, fl);
    assert_eq!(tr(&s).len(l[0]), Ok(106), "lane 0 inner");
    assert_eq!(
        outs(&s, sp(&s, left).output),
        [Output::Next(l[0]), Output::Next(l[1])]
    );
    s.assert_topology();

    // Merge: the north belt with a belt behind it is straight; the half side-loads lane 0 (the
    // half is on its left) at its tile's first position + 64 and + 192.
    put(&mut s, fr, Dir::North, BeltKind::Belt);
    assert_eq!(s.belt_at(fl).unwrap().shape, BeltShape::Straight);
    let m = lanes_at(tr(&s), fl).unwrap();
    let near = m.lane[0];
    assert_eq!(
        outs(&s, sp(&s, left).output),
        [
            Output::Merge {
                line: near,
                at: m.off + 64
            },
            Output::Merge {
                line: near,
                at: m.off + 192
            }
        ]
    );
    // The right half fronts the belt behind (its back is (51, 52), empty): it is that belt's sole
    // (left) input, so that belt curves left and is fed lane for lane.
    assert_eq!(s.belt_at(fr).unwrap().shape, BeltShape::CurveLeft);
    let r = lanes(&s, fr);
    assert_eq!(
        outs(&s, sp(&s, right).output),
        [Output::Next(r[0]), Output::Next(r[1])]
    );
    s.assert_topology();

    // DeadEnd: head-on in front of the left half.
    let mut s = world();
    put(&mut s, o, Dir::East, BeltKind::Splitter);
    put(&mut s, fl, Dir::West, BeltKind::Belt);
    assert_eq!(outs(&s, sp(&s, left).output), [Output::DeadEnd; 2]);
    assert_eq!(outs(&s, lanes(&s, fl)), [Output::DeadEnd; 2]);
    s.assert_topology();
}

/// A saturated spawner (lane 0 only) behind the left half of an east splitter, despawners in front
/// of both halves: over 1,000 ticks every item stays on lane 0 and the halves take turns (the
/// engine's `fork-50-50` rule, the left half first): the counts sunk on each side differ by 0 or 1
/// in the left's favour. Pinned exactly. Fails if the fork does not alternate, a lane crosses over,
/// or the right half is preferred first.
#[test]
fn splitter_50_50() {
    let mut s = world();
    let o = TilePos::new(50, 50);
    let spawner = TilePos::new(49, 50);
    put(&mut s, spawner, Dir::East, BeltKind::Spawner);
    put(&mut s, o, Dir::East, BeltKind::Splitter);
    put(&mut s, TilePos::new(51, 50), Dir::East, BeltKind::Despawner);
    put(&mut s, TilePos::new(51, 51), Dir::East, BeltKind::Despawner);
    s.set_spawner(P1, spawner, 0, IRON, SATURATE).unwrap();
    s.step_ticks(1_000);
    let a = sunk(&s, TilePos::new(51, 50));
    let b = sunk(&s, TilePos::new(51, 51));
    // 363 items in 1,000 ticks (the saturated lane's 0.375 a tick, less the trip): 182 left, 181
    // right, nothing on lane 1.
    assert_eq!((a, b), ([182, 0], [181, 0]), "sunk left, right");
    let d = a[0] as i64 - b[0] as i64;
    assert!(d == 0 || d == 1, "left {a:?} right {b:?}");
    s.assert_topology();
}

/// The same supply with the right half's output into a dead-end belt: once that belt and the right
/// half's output line are full, every item goes left, and the input fork's toggle stays on the
/// blocked side (it flips only on a delivery to the preferred side). Pinned exactly. Fails if a
/// blocked side holds the input up or the toggle flips on a delivery to the other side.
#[test]
fn splitter_blocked_side() {
    let mut s = world();
    let o = TilePos::new(50, 50);
    let spawner = TilePos::new(49, 50);
    put(&mut s, spawner, Dir::East, BeltKind::Spawner);
    put(&mut s, o, Dir::East, BeltKind::Splitter);
    put(&mut s, TilePos::new(51, 50), Dir::East, BeltKind::Despawner);
    put(&mut s, TilePos::new(51, 51), Dir::East, BeltKind::Belt);
    s.set_spawner(P1, spawner, 0, IRON, SATURATE).unwrap();
    s.step_ticks(1_000);
    let right = sp(&s, TilePos::new(50, 51));
    let blocked = lanes(&s, TilePos::new(51, 51));
    let left_sunk = sunk(&s, TilePos::new(51, 50));
    let r = (count(&s, blocked[0]), count(&s, right.output[0]));
    let toggle = tr(&s).toggle(sp(&s, o).input[0]).unwrap();
    // The right side holds 6 (4 on the belt at 64 spacing from its front, 2 on the half's output
    // line); the 50/50 run's 363 items less those 6 went left.
    assert_eq!((r, left_sunk), ((4, 2), [357, 0]), "right held, left sunk");
    assert!(toggle, "the toggle stays on the blocked (right) side");
    s.step_ticks(200);
    // Everything goes left now: 200 ticks at 0.375 items a tick.
    assert_eq!(sunk(&s, TilePos::new(51, 50)), [357 + 75, 0]);
    assert_eq!(
        (count(&s, blocked[0]), count(&s, right.output[0])),
        (4, 2),
        "the right side took nothing more"
    );
    assert!(
        tr(&s).toggle(sp(&s, o).input[0]).unwrap(),
        "still on the blocked side"
    );
    s.assert_topology();
}

/// Two saturated inputs (iron behind the left half, coal behind the right, lane 0) with the right
/// output dead-ended: the left output carries both inputs' items into an eight-tile run ending in a
/// despawner. Question 11 (input fairness, Tyler 2026-10-13: 50/50), built in M61: the two input
/// lanes take turns at the shared output, so in steady state the run carries iron and coal
/// alternately, 18 each (before M61 the left input won every slot: 36 iron and no coal). The run
/// stays fully compressed (36 items at 64 apart on its 2,304 positions, as one saturated input
/// fills it): a waiting item lands right behind the output's rearmost item (M61 fix round 1, the
/// leader rule `Next` uses). Both input lanes stay full, two items each, waiting their turn.
/// Pinned exactly after 1,000 ticks. Fails if the fork, the feeders, the turn, the compression or
/// the share change.
#[test]
fn splitter_two_inputs() {
    let mut s = world();
    let o = TilePos::new(50, 50);
    put(&mut s, TilePos::new(49, 50), Dir::East, BeltKind::Spawner);
    put(&mut s, TilePos::new(49, 51), Dir::East, BeltKind::Spawner);
    put(&mut s, o, Dir::East, BeltKind::Splitter);
    for x in 51..59 {
        put(&mut s, TilePos::new(x, 50), Dir::East, BeltKind::Belt);
    }
    put(&mut s, TilePos::new(59, 50), Dir::East, BeltKind::Despawner);
    put(&mut s, TilePos::new(51, 51), Dir::East, BeltKind::Belt);
    s.set_spawner(P1, TilePos::new(49, 50), 0, IRON, SATURATE)
        .unwrap();
    s.set_spawner(P1, TilePos::new(49, 51), 0, COAL, SATURATE)
        .unwrap();
    s.step_ticks(1_000);
    let kinds = |l: LineId| {
        let (mut iron, mut coal) = (0u32, 0u32);
        tr(&s)
            .items_in(l, &mut |i, _| {
                if i.0 == u16::from(IRON) + 1 {
                    iron += 1;
                } else if i.0 == u16::from(COAL) + 1 {
                    coal += 1;
                }
            })
            .unwrap();
        (iron, coal)
    };
    let run = lanes(&s, TilePos::new(51, 50));
    let right_in = sp(&s, TilePos::new(50, 51)).input[0];
    let left_in = sp(&s, TilePos::new(50, 50)).input[0];
    assert_eq!(
        kinds(run[0]),
        (18, 18),
        "the run in steady state: half each"
    );
    let mut seq = Vec::new();
    tr(&s).items_in(run[0], &mut |i, _| seq.push(i.0)).unwrap();
    assert!(
        seq.windows(2).all(|w| w[0] != w[1]),
        "iron and coal alternate along the run: {seq:?}"
    );
    // Full 128-position input lines at spacing 64: two items each, at rest, waiting their turn.
    assert_eq!(
        (kinds(left_in), kinds(right_in)),
        ((2, 0), (0, 2)),
        "iron and coal wait on their halves' input lanes"
    );
    s.assert_topology();
}

/// `RotateBelt` on a placed splitter (addressed by its second tile) turns it 180 degrees in place:
/// the same entity, anchor and footprint (both tiles still its), `dir` east -> west, its halves
/// swapped, its eight lines re-created (new ids) and its items destroyed (question 10); the spawner
/// that fed it now points into its front and dead-ends. A second rotation turns it back. Fails if a
/// rotation turns a splitter 90 degrees (its footprint would move), respawns it or keeps its lines.
#[test]
fn splitter_rotate_180_in_place() {
    let mut s = world();
    let o = TilePos::new(50, 50);
    let second = TilePos::new(50, 51);
    let spawner = TilePos::new(49, 50);
    put(&mut s, spawner, Dir::East, BeltKind::Spawner);
    put(&mut s, o, Dir::East, BeltKind::Splitter);
    s.set_spawner(P1, spawner, 0, IRON, SATURATE).unwrap();
    s.step_ticks(60);
    let id = s.entity_at(o).expect("placed");
    let before = splitter(&s, o);
    let old = [sp(&s, o), sp(&s, second)];
    let held: u32 = old
        .iter()
        .flat_map(|l| l.input.into_iter().chain(l.output))
        .map(|l| count(&s, l))
        .sum();
    assert!(held > 0, "items on the splitter before the rotation");
    let puts = s.entity_puts_logged();
    s.rotate_belt(P1, second).expect("a splitter is there");
    assert_eq!(s.entity_puts_logged(), puts + 1, "one put");
    let after = splitter(&s, o);
    assert_eq!(
        after,
        Belt {
            dir: Dir::West,
            ..before
        },
        "only the direction turns, 180 degrees"
    );
    assert_eq!((s.entity_at(o), s.entity_at(second)), (Some(id), Some(id)));
    assert_eq!(splitter_halves(&after), [second, o], "halves swapped");
    let new = [sp(&s, second), sp(&s, o)];
    for (n, l) in new.iter().enumerate() {
        assert_eq!(l.dir, Dir::West);
        for line in l.input.into_iter().chain(l.output) {
            assert_eq!(count(&s, line), 0, "half {n}: items destroyed");
            for o in &old {
                assert!(!o.input.contains(&line) && !o.output.contains(&line));
            }
        }
    }
    assert_eq!(outs(&s, lanes(&s, spawner)), [Output::DeadEnd; 2]);
    assert_eq!(
        tr(&s).lines_len(),
        10,
        "the spawner's two and the splitter's eight"
    );
    s.assert_topology();
    s.rotate_belt(P1, o).unwrap();
    assert_eq!(splitter(&s, o).dir, Dir::East);
    s.assert_topology();
}

/// `PickUpBelt` on either tile removes the splitter in one tick: its eight lines are gone (the
/// belt behind it dead-ends again), both tiles are free, and a second pick-up is `NoBeltHere`. Fails
/// if a half's lines outlive the splitter or the footprint stays occupied.
#[test]
fn splitter_pickup_unmaps_eight_lines() {
    for (dir, tile) in [(Dir::East, (50, 51)), (Dir::North, (50, 50))] {
        let mut s = world();
        let o = TilePos::new(50, 50);
        put(&mut s, o, dir, BeltKind::Splitter);
        let behind = match dir {
            Dir::East => TilePos::new(49, 50),
            _ => TilePos::new(51, 51),
        };
        put(&mut s, behind, dir, BeltKind::Belt);
        assert_eq!(tr(&s).lines_len(), 10);
        let at = TilePos::new(tile.0, tile.1);
        s.pick_up_belt(P1, at).expect("a splitter");
        assert_eq!(tr(&s).lines_len(), 2, "{dir:?}: the belt's two lines alone");
        assert_eq!(outs(&s, lanes(&s, behind)), [Output::DeadEnd; 2]);
        let fp = content::belt_footprint(BeltKind::Splitter, dir);
        for dy in 0..fp.h as i32 {
            for dx in 0..fp.w as i32 {
                assert_eq!(s.entity_at(TilePos::new(50 + dx, 50 + dy)), None);
            }
        }
        assert_eq!(s.pick_up_belt(P1, at), Err(RefReject::NoBeltHere));
        s.assert_topology();
        put(
            &mut s,
            TilePos::new(50 + fp.w as i32 - 1, 50 + fp.h as i32 - 1),
            dir,
            BeltKind::Belt,
        );
    }
}

/// `PlaceBelt { kind: Splitter }` asks every footprint tile: water, a resource, a furnace or a belt
/// under either tile refuses `NotBuildable` having written nothing; two splitters may not overlap;
/// `SetSpawner` on a splitter is `NotASpawner`; the second tile of a placed splitter is occupied (a
/// belt there is refused). Fails if placement checks the anchor tile alone.
#[test]
fn splitter_place_rules() {
    for dir in DIRS {
        let mut s = world();
        s.give(P1, ItemId::Furnace, 1);
        let fp = content::belt_footprint(BeltKind::Splitter, dir);
        let second = |o: TilePos| TilePos::new(o.x + fp.w as i32 - 1, o.y + fp.h as i32 - 1);
        // Each refusal on its own anchor, the bad tile the second one.
        let water = TilePos::new(40, 40);
        s.set_tile(second(water), Tile::new(content::WATER, 0, 0));
        let iron = TilePos::new(43, 40);
        s.set_tile(second(iron), Tile::new(content::GRASS, content::IRON, 10));
        let furnace = TilePos::new(46, 40);
        s.place(P1, second(furnace)).expect("a furnace");
        let belt = TilePos::new(52, 40);
        put(&mut s, second(belt), Dir::East, BeltKind::Belt);
        let other = TilePos::new(55, 40);
        put(&mut s, other, dir, BeltKind::Splitter);
        for (at, what) in [
            (water, "water"),
            (iron, "a resource"),
            (furnace, "a furnace"),
            (belt, "a belt"),
            (second(other), "another splitter's second tile"),
        ] {
            let writes = s.writes_logged();
            assert_eq!(
                s.place_belt(P1, at, dir, BeltKind::Splitter),
                Err(RefReject::NotBuildable),
                "{dir:?} on {what}"
            );
            assert_eq!(
                s.writes_logged(),
                writes,
                "{dir:?} on {what}: nothing written"
            );
        }
        assert_eq!(
            s.place_belt(P1, second(other), Dir::East, BeltKind::Belt),
            Err(RefReject::NotBuildable),
            "the second tile is the splitter's"
        );
        assert_eq!(
            s.set_spawner(P1, second(other), 0, IRON, 0),
            Err(RefReject::NotASpawner)
        );
        assert_eq!(s.entity_at(second(other)), s.entity_at(other));
        s.assert_topology();
    }
}

/// M54 fix round 1: at a full line cap a splitter's eight lines are dropped (counted), and the
/// belt behind its right half dead-ends. Picking up a belt beside its left half (three tiles from
/// that feeder) frees the lines and its wake re-maps the splitter: the feeder is re-linked to the
/// right half's input lanes in the same tick, and the whole structure is canonical. Fails if the
/// re-map leaves the far feeder's output stale.
#[test]
fn splitter_remapped_after_a_full_cap() {
    let mut s = RefScenario::with_caps(10, engine::transport::DEFAULT_MAX_ITEMS);
    s.join(P1);
    s.clear_area(TilePos::new(40, 40), 20, 20);
    let o = TilePos::new(50, 50);
    let feeder = TilePos::new(49, 51);
    let filler = TilePos::new(50, 49);
    put(&mut s, feeder, Dir::East, BeltKind::Belt);
    put(&mut s, filler, Dir::North, BeltKind::Belt);
    let before = reference_sim::rules::belts::topology::belts_unmapped();
    put(&mut s, o, Dir::East, BeltKind::Splitter);
    assert!(
        reference_sim::rules::belts::topology::belts_unmapped() > before,
        "the cap dropped the splitter's lines"
    );
    assert_eq!(splitter_lanes(tr(&s), o), None);
    assert_eq!(outs(&s, lanes(&s, feeder)), [Output::DeadEnd; 2]);
    s.pick_up_belt(P1, filler).unwrap();
    assert_eq!(
        tr(&s).lines_len(),
        10,
        "the feeder's two and the splitter's eight"
    );
    let right = sp(&s, TilePos::new(50, 51));
    assert_eq!(
        outs(&s, lanes(&s, feeder)),
        [Output::Next(right.input[0]), Output::Next(right.input[1])],
        "the far feeder re-linked"
    );
    s.assert_lines();
}

/// `test-hooks`: `TestInsertItem` on a splitter half addresses its input lanes as 0 and 1 and its
/// output lanes as 2 and 3, `pos` from the line's front.
#[cfg(feature = "test-hooks")]
#[test]
fn splitter_test_insert_addresses_lines() {
    use reference_sim::RefAction;
    let mut s = world();
    let o = TilePos::new(50, 50);
    put(&mut s, o, Dir::North, BeltKind::Splitter);
    let right = TilePos::new(51, 50);
    let mut batch = Vec::new();
    for lane in 0..4u8 {
        batch.push(RefAction::TestInsertItem {
            at: TileXY::from_tile(right),
            lane,
            pos: 100,
            item: u16::from(lane) + 1,
        });
    }
    for r in s.dispatch_batch(P1, &batch) {
        r.unwrap();
    }
    s.step_ticks(1);
    let l = sp(&s, right);
    let got = [l.input[0], l.input[1], l.output[0], l.output[1]].map(|line| {
        let mut v = Vec::new();
        tr(&s).items_in(line, &mut |i, _| v.push(i.0)).unwrap();
        v
    });
    // One item a line, the line's own, at 100 - 2 x 24 = 52 (the dispatch's tick inserts it before
    // that tick's advance, then one more tick).
    let pos = [l.input[0], l.input[1], l.output[0], l.output[1]].map(|line| {
        let mut v = Vec::new();
        tr(&s).items_in(line, &mut |_, p| v.push(p)).unwrap();
        v
    });
    assert_eq!(
        got,
        [vec![1], vec![2], vec![3], vec![4]],
        "items by lane code"
    );
    assert_eq!(pos, [vec![52], vec![52], vec![52], vec![52]], "positions");
}
