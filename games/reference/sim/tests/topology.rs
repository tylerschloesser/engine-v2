//! Belt topology on the host (M52 Tests added, README "Belts": Shape, Side-loading, Lanes): placed
//! belts mapped onto transport lines by `rules::belts::topology` (R1-R8, C1-C4), runs and curves,
//! joins and splits, the edge rule and the cost of an edit. The item cases (rescale, rotation) are in
//! `topology_items.rs` (`test-hooks`).

mod common;

use common::RefScenario;
use engine::game::PlayerId;
use engine::transport::{Geometry, LineId, Output, Segment};
use engine::world::{TilePos, WorldPos};
use reference_sim::rules::belts::topology::{self, TileLanes, lanes_at};
use reference_sim::{BeltKind, BeltShape, Dir};

const P1: PlayerId = PlayerId(1);
const DIRS: [Dir; 4] = [Dir::East, Dir::South, Dir::West, Dir::North];

fn world() -> RefScenario {
    let mut s = RefScenario::new();
    s.join(P1);
    s.clear_area(TilePos::new(30, 30), 40, 40);
    s
}

const fn step(d: Dir) -> (i32, i32) {
    match d {
        Dir::East => (1, 0),
        Dir::South => (0, 1),
        Dir::West => (-1, 0),
        Dir::North => (0, -1),
    }
}

const fn ccw(d: Dir) -> Dir {
    d.cw().cw().cw()
}

fn ahead(t: TilePos, d: Dir, n: i32) -> TilePos {
    let (dx, dy) = step(d);
    TilePos::new(t.x + dx * n, t.y + dy * n)
}

fn put(s: &mut RefScenario, at: TilePos, dir: Dir) {
    s.place_belt(P1, at, dir, BeltKind::Belt)
        .unwrap_or_else(|r| panic!("place {at:?}: {r:?}"));
}

fn lanes(s: &RefScenario, at: TilePos) -> TileLanes {
    lanes_at(s.read().transport(), at).unwrap_or_else(|| panic!("{at:?} is mapped"))
}

fn len(s: &RefScenario, l: LineId) -> u32 {
    s.read().transport().len(l).expect("line")
}

fn out(s: &RefScenario, l: LineId) -> Output {
    s.read().transport().out(l).expect("line")
}

fn outs(s: &RefScenario, at: TilePos) -> [Output; 2] {
    let m = lanes(s, at);
    [out(s, m.lane[0]), out(s, m.lane[1])]
}

fn segs(s: &RefScenario, l: LineId) -> Vec<Segment> {
    let mut v = Vec::new();
    s.read()
        .transport()
        .segments(l, &mut |g| v.push(g))
        .expect("line");
    v
}

fn at_pos(s: &RefScenario, l: LineId, pos: u32) -> (i32, i32) {
    let p = s
        .read()
        .transport()
        .pos_to_world(l, pos)
        .expect("line")
        .expect("on the line");
    (p.x, p.y)
}

fn index(s: &RefScenario, at: TilePos) -> Vec<(LineId, u32)> {
    let mut v = Vec::new();
    s.read()
        .transport()
        .lines_at(at, &mut |l, o| v.push((l, o)))
        .expect("reserved");
    v
}

fn shape(s: &RefScenario, at: TilePos) -> BeltShape {
    s.belt_at(at).expect("a belt").shape
}

const fn straight(len: u32, from: (i32, i32), to: (i32, i32)) -> Segment {
    Segment {
        len,
        geometry: Geometry::Straight {
            from: WorldPos {
                x: from.0,
                y: from.1,
            },
            to: WorldPos { x: to.0, y: to.1 },
        },
    }
}

const fn arc(len: u32, centre: (i32, i32), r: u32, start: u16, sweep: i16) -> Segment {
    Segment {
        len,
        geometry: Geometry::Arc {
            centre: WorldPos {
                x: centre.0,
                y: centre.1,
            },
            radius_q8: r,
            start_turn_q8: start,
            sweep_q8: sweep,
        },
    }
}

/// R1-R8 (`belts/docs/03` §9): every input set (back, left, right) in every direction, the feeders
/// placed before the belt and after it. The belt's shape and lane lengths, its own output (nothing in
/// front: `DeadEnd`), the back feeder joined into its run, and each side feeder's output: `Next` lane
/// for lane into a curve, else both lanes onto the near lane at +64 (the feeder's lane on that side)
/// and +192. Fails if a rule takes the front tile into account, a side is mirrored, or the outcome
/// depends on the order the belts were placed in.
#[test]
fn topology_shape_table() {
    use BeltShape::{CurveLeft, CurveRight, Straight};
    // (back, left, right) -> shape: R1, R2, R3, R3, R4, then R2/R8.
    const TABLE: [(bool, bool, bool, BeltShape); 8] = [
        (false, false, false, Straight),
        (true, false, false, Straight),
        (false, true, false, CurveLeft),
        (false, false, true, CurveRight),
        (false, true, true, Straight),
        (true, true, false, Straight),
        (true, false, true, Straight),
        (true, true, true, Straight),
    ];
    let p = TilePos::new(50, 50);
    for d in DIRS {
        for (back, left, right, want) in TABLE {
            for p_first in [false, true] {
                let tag = format!("{d:?} back {back} left {left} right {right} p_first {p_first}");
                let mut s = world();
                let feeders = [
                    (back, ahead(p, d, -1), d),
                    (left, ahead(p, ccw(d), 1), d.cw()),
                    (right, ahead(p, d.cw(), 1), ccw(d)),
                ];
                if p_first {
                    put(&mut s, p, d);
                }
                for (on, at, dir) in feeders {
                    if on {
                        put(&mut s, at, dir);
                    }
                }
                if !p_first {
                    put(&mut s, p, d);
                }
                assert_eq!(shape(&s, p), want, "{tag}: shape");
                let m = lanes(&s, p);
                let lens = [len(&s, m.lane[0]), len(&s, m.lane[1])];
                let want_lens = match want {
                    Straight if back => [512, 512],
                    Straight => [256, 256],
                    CurveLeft => [106, 295],
                    CurveRight => [295, 106],
                };
                assert_eq!(lens, want_lens, "{tag}: lane lengths");
                assert_eq!(m.off, 0, "{tag}: the belt fronts its lines");
                assert_eq!(outs(&s, p), [Output::DeadEnd; 2], "{tag}: nothing in front");
                if back {
                    let b = lanes(&s, feeders[0].1);
                    assert_eq!(
                        (b.lane, b.off),
                        (m.lane, 256),
                        "{tag}: the back feeder is the run's back tile"
                    );
                }
                for (k, (on, at, _)) in feeders.into_iter().enumerate().skip(1) {
                    if !on {
                        continue;
                    }
                    assert_eq!(shape(&s, at), Straight, "{tag}: feeder {k}");
                    let near = k - 1; // left feeder -> lane 0, right -> lane 1
                    let want_out = if want == Straight {
                        let line = m.lane[near];
                        let at_of = |lane: usize| if lane == near { 64 } else { 192 };
                        [
                            Output::Merge { line, at: at_of(0) },
                            Output::Merge { line, at: at_of(1) },
                        ]
                    } else {
                        [Output::Next(m.lane[0]), Output::Next(m.lane[1])]
                    };
                    assert_eq!(outs(&s, at), want_out, "{tag}: feeder {k} output");
                }
                let n = usize::from(back) + usize::from(left) + usize::from(right);
                let lines = 2 * (1 + usize::from(left) + usize::from(right));
                assert_eq!(
                    s.read().transport().lines_len() as usize,
                    lines,
                    "{tag}: lines ({n} feeders)"
                );
            }
        }
    }
}

/// C1-C4 (`belts/docs/03` §5) for an east belt at (50, 50), one front case at a time: nothing, a
/// furnace and a head-on belt stop it (`DeadEnd`, the head-on belt too: R6); a belt facing the same
/// way joins it into one run; a curve hands to the straight in front from behind (`Next`); a belt
/// whose sole input it is curves and takes it lane for lane (`Next`); a straight front with a back
/// input takes it on the near lane at the tile's offset in its line + 64 / + 192, from either side.
/// Fails if a head-on pair connects, a side-load lands on the far lane or at the wrong offset, or a
/// curve front is side-loaded.
#[test]
fn topology_outputs_c1_c4() {
    let p = TilePos::new(50, 50);
    let f = TilePos::new(51, 50);
    let dead = [Output::DeadEnd; 2];

    // C4: nothing.
    let mut s = world();
    put(&mut s, p, Dir::East);
    assert_eq!(outs(&s, p), dead, "empty front");

    // C4: a furnace.
    let mut s = world();
    s.give(P1, reference_sim::content::ItemId::Furnace, 1);
    s.place(P1, f).expect("a furnace");
    put(&mut s, p, Dir::East);
    assert_eq!(outs(&s, p), dead, "a furnace");

    // C4 / R6: head-on.
    let mut s = world();
    put(&mut s, p, Dir::East);
    put(&mut s, f, Dir::West);
    assert_eq!(outs(&s, p), dead, "head-on");
    assert_eq!(outs(&s, f), dead, "head-on, the other way");
    assert_eq!(
        (shape(&s, p), shape(&s, f)),
        (BeltShape::Straight, BeltShape::Straight)
    );
    assert_ne!(lanes(&s, p).lane, lanes(&s, f).lane, "two pairs");

    // C2 inside a run: one pair of 512.
    let mut s = world();
    put(&mut s, p, Dir::East);
    put(&mut s, f, Dir::East);
    let (mp, mf) = (lanes(&s, p), lanes(&s, f));
    assert_eq!((mp.lane, mp.off, mp.len), (mf.lane, 256, 512));
    assert_eq!((mf.off, outs(&s, f)), (0, dead));

    // C2: a curve (fed from its left, north) into a straight from behind: lanes kept.
    let mut s = world();
    put(&mut s, TilePos::new(50, 49), Dir::South);
    put(&mut s, p, Dir::East);
    put(&mut s, f, Dir::East);
    assert_eq!(shape(&s, p), BeltShape::CurveLeft);
    let mf = lanes(&s, f);
    assert_eq!(
        outs(&s, p),
        [Output::Next(mf.lane[0]), Output::Next(mf.lane[1])]
    );
    assert_eq!(
        (mf.off, mf.len),
        (0, 256),
        "the straight is a run of its own"
    );

    // C1/C2: into a curve whose sole input it is (the front faces north; `p` is on its left).
    let mut s = world();
    put(&mut s, p, Dir::East);
    put(&mut s, f, Dir::North);
    assert_eq!(shape(&s, f), BeltShape::CurveLeft);
    let mf = lanes(&s, f);
    assert_eq!(
        outs(&s, p),
        [Output::Next(mf.lane[0]), Output::Next(mf.lane[1])]
    );

    // C3: side-load onto a north run of four, the front tile third from the back (offset 256).
    for (feeder, dir, near, want) in [
        (p, Dir::East, 0usize, [256 + 64, 256 + 192]),
        (TilePos::new(52, 50), Dir::West, 1, [256 + 192, 256 + 64]),
    ] {
        let mut s = world();
        for y in [52, 51, 50, 49] {
            put(&mut s, TilePos::new(51, y), Dir::North);
        }
        put(&mut s, feeder, dir);
        let mf = lanes(&s, f);
        assert_eq!((mf.off, mf.len), (256, 1024), "{dir:?}: the run");
        assert_eq!(shape(&s, f), BeltShape::Straight);
        assert_eq!(
            outs(&s, feeder),
            [
                Output::Merge {
                    line: mf.lane[near],
                    at: want[0]
                },
                Output::Merge {
                    line: mf.lane[near],
                    at: want[1]
                },
            ],
            "{dir:?} feeder"
        );
    }
}

/// A chain of 20 east tiles placed back to front is two lines of 5,120 (ids 1 and 2, one segment
/// each, from one position behind the front edge to the back edge); picking up the 11th splits it
/// into two pairs (front 9 tiles on 1/2, back 10 on new ids 5/6: the split's 3/4 held the removed
/// tile and were destroyed), the back pair `DeadEnd`; placing it again joins them back onto 1/2.
/// Fails if a chain is cut per tile, a split keeps the removed tile's lines, or a join loses a run.
#[test]
fn topology_run_join_split() {
    let mut s = world();
    for x in 40..60 {
        put(&mut s, TilePos::new(x, 50), Dir::East);
    }
    let one = |lane: u8, tiles: u32| {
        let y = 50 * 256 + if lane == 0 { 68 } else { 188 };
        straight(
            tiles * 256,
            (60 * 256 - 1, y),
            (60 * 256 - 1 - tiles as i32 * 256, y),
        )
    };
    let pair = |s: &RefScenario, x: i32| {
        let m = lanes(s, TilePos::new(x, 50));
        (m.lane, m.len)
    };
    assert_eq!(s.read().transport().lines_len(), 2);
    assert_eq!(pair(&s, 40), ([LineId(1), LineId(2)], 5120));
    assert_eq!(segs(&s, LineId(1)), [one(0, 20)]);
    assert_eq!(segs(&s, LineId(2)), [one(1, 20)]);
    assert_eq!(at_pos(&s, LineId(1), 5119), (40 * 256, 50 * 256 + 68));

    let mid = TilePos::new(50, 50);
    s.pick_up_belt(P1, mid).unwrap();
    assert_eq!(s.read().transport().lines_len(), 4);
    assert_eq!(pair(&s, 51), ([LineId(1), LineId(2)], 9 * 256));
    assert_eq!(pair(&s, 49), ([LineId(5), LineId(6)], 10 * 256));
    assert_eq!(index(&s, mid), [], "nothing on the removed tile");
    assert_eq!(outs(&s, TilePos::new(49, 50)), [Output::DeadEnd; 2]);
    let back = |lane: u8| {
        let y = 50 * 256 + if lane == 0 { 68 } else { 188 };
        straight(2560, (50 * 256 - 1, y), (40 * 256 - 1, y))
    };
    assert_eq!(segs(&s, LineId(5)), [back(0)]);
    assert_eq!(segs(&s, LineId(6)), [back(1)]);
    assert_eq!(
        segs(&s, LineId(1)),
        [straight(2304, (60 * 256 - 1, 12868), (51 * 256 - 1, 12868))]
    );

    put(&mut s, mid, Dir::East);
    assert_eq!(s.read().transport().lines_len(), 2);
    assert_eq!(pair(&s, 40), ([LineId(1), LineId(2)], 5120));
    assert_eq!(lanes(&s, mid).off, 9 * 256);
    assert_eq!(segs(&s, LineId(1)), [one(0, 20)]);
    assert_eq!(segs(&s, LineId(2)), [one(1, 20)]);
}

/// A curve's lanes (README Numbers; 0076 §4): a north belt fed from its right (east) curves right;
/// its inner lane is lane 1 (106, radius 68), its outer lane 0 (295, radius 188), both one arc
/// about the north-east corner from angle 128 sweeping -64, both indexed on the tile at offset 0. The
/// feeder hands over lane for lane, and the arcs meet the straight lanes: an exit on the north edge
/// at the north lanes' x, an entry at the west-going feeder's lane y. An east curve (fed from the
/// north, its left) has its centre one position behind the east edge. Fails if a lane's side, radius
/// or length is swapped, or an arc is not continuous with the lanes it joins.
#[test]
fn topology_curve_lanes() {
    let p = TilePos::new(50, 50);
    let mut s = world();
    put(&mut s, TilePos::new(51, 50), Dir::West);
    put(&mut s, p, Dir::North);
    assert_eq!(shape(&s, p), BeltShape::CurveRight);
    let m = lanes(&s, p);
    let (outer, inner) = (m.lane[0], m.lane[1]);
    let c = (51 * 256, 50 * 256);
    assert_eq!(segs(&s, inner), [arc(106, c, 68, 128, -64)]);
    assert_eq!(segs(&s, outer), [arc(295, c, 188, 128, -64)]);
    let mut at = index(&s, p);
    at.sort();
    let mut want = vec![(outer, 0), (inner, 0)];
    want.sort();
    assert_eq!(at, want, "both lanes from offset 0");
    // Exits on the north edge at the north lanes' x (68 and 188 into the tile).
    assert_eq!(at_pos(&s, outer, 0), (50 * 256 + 68, 50 * 256));
    assert_eq!(at_pos(&s, inner, 0), (50 * 256 + 188, 50 * 256));
    // The last positions are just short of the east edge, at the feeder's lane y.
    assert_eq!(at_pos(&s, inner, 105), (13054, 12867));
    assert_eq!(at_pos(&s, outer, 294), (13055, 12987));
    let feeder = lanes(&s, TilePos::new(51, 50));
    assert_eq!(
        [out(&s, feeder.lane[0]), out(&s, feeder.lane[1])],
        [Output::Next(outer), Output::Next(inner)],
        "lane for lane"
    );
    // The west-going feeder's lanes: lane 0 (its left, the south side) at y 188, lane 1 at 68.
    assert_eq!(at_pos(&s, feeder.lane[0], 0), (51 * 256, 50 * 256 + 188));
    assert_eq!(at_pos(&s, feeder.lane[1], 0), (51 * 256, 50 * 256 + 68));

    let mut s = world();
    put(&mut s, TilePos::new(50, 49), Dir::South);
    put(&mut s, p, Dir::East);
    assert_eq!(shape(&s, p), BeltShape::CurveLeft);
    let m = lanes(&s, p);
    let c = (51 * 256 - 1, 50 * 256);
    assert_eq!(segs(&s, m.lane[0]), [arc(106, c, 68, 64, 64)]);
    assert_eq!(segs(&s, m.lane[1]), [arc(295, c, 188, 64, 64)]);
    assert_eq!(at_pos(&s, m.lane[0], 0), (51 * 256 - 1, 50 * 256 + 68));
}

/// The edge rule: in every direction, a two-tile run and a curve (fed from its left) put index
/// entries on their own tiles only: the tile in front, the tile behind and every other neighbour
/// report none of their lines (`WorldPos::tile` floors, so an east or south front edge would be the
/// next tile's). Fails if a segment starts on the front edge of an east or south belt.
#[test]
fn topology_front_edge_indexes_nothing() {
    let p = TilePos::new(50, 50);
    for d in DIRS {
        let mut s = world();
        put(&mut s, ahead(p, d, -1), d);
        put(&mut s, p, d);
        let run = lanes(&s, p).lane;
        for t in [
            ahead(p, d, 1),
            ahead(p, d, -2),
            ahead(p, ccw(d), 1),
            ahead(p, d.cw(), 1),
        ] {
            assert_eq!(index(&s, t), [], "{d:?} run: {t:?}");
        }
        assert_eq!(
            index(&s, p).len(),
            2,
            "{d:?} run: both lanes on the front tile"
        );

        let mut s = world();
        let feeder = ahead(p, ccw(d), 1);
        put(&mut s, feeder, d.cw());
        put(&mut s, p, d);
        assert_eq!(shape(&s, p), BeltShape::CurveLeft, "{d:?}");
        let curve = lanes(&s, p).lane;
        assert_ne!(curve, run);
        for dy in -1..=1 {
            for dx in -1..=1 {
                let t = TilePos::new(p.x + dx, p.y + dy);
                if t == p {
                    continue;
                }
                assert!(
                    index(&s, t).iter().all(|(l, _)| !curve.contains(l)),
                    "{d:?} curve: {t:?} {:?}",
                    index(&s, t)
                );
            }
        }
    }
}

/// Picking a belt up unmaps it within the tick of the action: its lines are destroyed, the entity is
/// gone, and the edit wrote one entity put (`removing`) and one despawn, both in that tick, and
/// nothing after (the chunk's version moves once). Fails if the pick-up waits a tick, leaves a line
/// or a `removing` belt behind, or writes in a later tick.
#[test]
fn topology_pickup_unmaps_in_one_tick() {
    let mut s = world();
    let p = TilePos::new(50, 50);
    put(&mut s, p, Dir::South);
    assert_eq!(s.read().transport().lines_len(), 2);
    let (writes, puts) = (s.writes_logged(), s.entity_puts_logged());
    s.pick_up_belt(P1, p).unwrap();
    assert_eq!(s.read().transport().lines_len(), 0, "no line survives");
    assert_eq!(s.entity_at(p), None, "despawned");
    assert_eq!(index(&s, p), []);
    assert_eq!(s.entity_puts_logged(), puts + 1, "the removing put");
    assert_eq!(s.writes_logged(), writes + 2, "and the despawn");
    s.step_ticks(3);
    assert_eq!(s.writes_logged(), writes + 2, "nothing after");
    put(&mut s, p, Dir::South);
    assert_eq!(
        s.read().transport().lines_len(),
        2,
        "the tile takes a belt again"
    );
}

/// The cost of an edit (0079 §14: each op is O(lines) + O(index)), counted in transport writes on a
/// chain of 20 east tiles: the 21st at its front extends both lanes (extend_front + set_segments
/// each: 4); a tile into a one-tile gap extends the run in front and joins the run behind (10); its
/// pick-up splits twice per lane and destroys the tile's two lines (14); a rotation of a mid-run tile
/// to face south splits it out (12), re-creates its pair as a curve (the run behind is now its right
/// input: 6) and points the run behind at the curve (`Next`: 2), 20. Fails if an edit
/// starts rebuilding whole runs or touching tiles beyond its neighbours.
#[test]
fn topology_surgery_count_per_edit() {
    let mut s = world();
    for x in 40..60 {
        put(&mut s, TilePos::new(x, 50), Dir::East);
    }
    let cost = |s: &mut RefScenario, f: &dyn Fn(&mut RefScenario)| {
        let before = topology::ops();
        f(s);
        topology::ops() - before
    };
    assert_eq!(
        cost(&mut s, &|s| put(s, TilePos::new(60, 50), Dir::East)),
        4,
        "at the front"
    );
    assert_eq!(
        cost(&mut s, &|s| s
            .pick_up_belt(P1, TilePos::new(50, 50))
            .unwrap()),
        14,
        "pick-up mid-run"
    );
    assert_eq!(
        cost(&mut s, &|s| put(s, TilePos::new(50, 50), Dir::East)),
        10,
        "into the gap"
    );
    assert_eq!(
        cost(&mut s, &|s| s
            .rotate_belt(P1, TilePos::new(45, 50))
            .unwrap()),
        20,
        "rotate mid-run"
    );
    assert_eq!(cost(&mut s, &|s| s.step_ticks(10)), 0, "idle");
}

/// The incremental mapping equals the from-scratch one (`RefScenario::assert_topology`) after every
/// tick of 1,500 random edits on an 8 x 8 patch (a fixed LCG): placements (M54: one in four a
/// splitter; M55: one in four an underground end, either kind; 415 placed, 68 of them splitters and
/// 117 undergrounds, a paired entrance standing on 461 of the ticks), rotations and pick-ups, one to three in a tick (two
/// edits on neighbouring tiles, or on one tile, served by the same tick). Fails if any reshape, cut or join leaves a run, a curve, an output or a shape behind what
/// the belts say, or leaks a line.
#[test]
fn topology_random_edits_stay_canonical() {
    let mut s = world();
    let mut seed: u64 = 0x5EED_0052;
    let mut next = |n: u32| {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((seed >> 33) % u64::from(n)) as u32
    };
    let (mut placed, mut rotated, mut picked, mut splitters) = (0, 0, 0, 0);
    let (mut undergrounds, mut paired) = (0, 0);
    for tick in 0..1_500 {
        let mut batch = Vec::new();
        for _ in 0..1 + next(3) {
            let at = reference_sim::TileXY {
                x: 50 + next(8) as i32,
                y: 50 + next(8) as i32,
            };
            batch.push(match next(5) {
                // M54: one placement in four is a splitter (its footprint from `at`); M55: one in
                // eight an underground entrance and one in eight an exit (the same draws).
                0 | 1 => reference_sim::RefAction::PlaceBelt {
                    at,
                    dir: DIRS[next(4) as usize],
                    kind: match next(8) {
                        0 | 1 => BeltKind::Splitter,
                        2 => BeltKind::UndergroundIn,
                        3 => BeltKind::UndergroundOut,
                        _ => BeltKind::Belt,
                    },
                },
                2 | 3 => reference_sim::RefAction::RotateBelt { at },
                _ => reference_sim::RefAction::PickUpBelt { at },
            });
        }
        for (a, r) in batch.iter().zip(s.dispatch_batch(P1, &batch)) {
            if r.is_ok() {
                match a {
                    reference_sim::RefAction::PlaceBelt { kind, .. } => {
                        placed += 1;
                        splitters += usize::from(*kind == BeltKind::Splitter);
                        undergrounds += usize::from(kind.is_underground());
                    }
                    reference_sim::RefAction::RotateBelt { .. } => rotated += 1,
                    _ => picked += 1,
                }
            }
        }
        let _ = tick;
        s.assert_topology();
        // M55: pairs exist along the way (the oracle checked each one).
        for (_, e) in s.entities() {
            if let Some(b) = e.as_belt()
                && b.kind == BeltKind::UndergroundIn
                && reference_sim::rules::belts::topology::hidden_lanes(
                    s.read().transport(),
                    b.origin.tile(),
                )
                .is_some()
            {
                paired += 1;
            }
        }
    }
    assert!(
        placed > 300
            && rotated > 300
            && picked > 100
            && splitters > 0
            && undergrounds > 0
            && paired > 0,
        "the edits ran: {placed} placed ({splitters} splitters, {undergrounds} undergrounds), {rotated} rotated, {picked} picked up, {paired} paired entrance-ticks"
    );
}

/// A world that declares no transport caps (the large-save bench's) maps nothing and refuses nothing:
/// belts are placed, turned and picked up, their shapes derived, and no line exists; each refused
/// mapping is counted (`belts_unmapped`). Fails if a full line cap panics the tick (a debug
/// assertion on `Full`) or leaves half a tile mapped.
#[test]
fn topology_without_caps_maps_nothing() {
    let mut s = RefScenario::with_caps(0, 0);
    s.join(P1);
    s.clear_area(TilePos::new(30, 30), 40, 40);
    put(&mut s, TilePos::new(51, 50), Dir::West);
    put(&mut s, TilePos::new(50, 50), Dir::North);
    put(&mut s, TilePos::new(50, 49), Dir::North);
    assert_eq!(shape(&s, TilePos::new(50, 50)), BeltShape::CurveRight);
    s.rotate_belt(P1, TilePos::new(51, 50)).unwrap();
    s.pick_up_belt(P1, TilePos::new(50, 49)).unwrap();
    assert_eq!(shape(&s, TilePos::new(50, 50)), BeltShape::Straight);
    assert_eq!(s.read().transport().lines_len(), 0);
    assert_eq!(s.entities().len(), 2);
    // Every `create` the five edits tried (each belt in reach of an edit, once per edit) was refused.
    assert_eq!(topology::belts_unmapped(), 8, "belts the cap left unmapped");
}

/// A straight chain of 4,097 east tiles is two runs: 4,096 tiles, the most one line's path may enter
/// (`MAX_LINE_TILES`), and the back tile (placed last) on its own, handing to the long run with
/// `Next`; every tile is indexed, no line leaks (four lines). Picking up x = 0 splits the long run
/// and its back part, now short enough, joins the back tile; placing x = 0 again joins the
/// run in front and stays apart from the one behind (`Next`). Fails if a join or an extend passes
/// the limit (its `set_segments` is refused and the run drops out of the tile index) or a shortened
/// run stays apart from a neighbour it now fits beside.
#[test]
fn topology_run_boundary_at_max_line_tiles() {
    const N: i32 = 4_097;
    let x0 = -2_048;
    let mut s = RefScenario::new();
    s.join(P1);
    s.clear_area(TilePos::new(x0 - 1, 50), N + 1, 1);
    // Odd tiles first, then the gaps by their index's trailing zeros: runs merge pairwise (3, 7, 15
    // ... tiles), so each tile's segment is re-registered about log2(N) times, not N (the test stays
    // fast). The back tile (index 0) comes last.
    let mut order: Vec<i32> = (1..N).step_by(2).collect();
    let mut gaps: Vec<i32> = (0..N).step_by(2).collect();
    gaps.sort_by_key(|&i| if i == 0 { 32 } else { i.trailing_zeros() });
    order.extend(gaps);
    for i in order {
        put(&mut s, TilePos::new(x0 + i, 50), Dir::East);
    }
    let rect = engine::world::TileRect::new(TilePos::new(x0 - 2, 49), TilePos::new(x0 + N + 1, 51));
    let pair = |s: &RefScenario, x: i32| {
        let m = lanes(s, TilePos::new(x, 50));
        (m.lane, m.off, m.len)
    };
    assert_eq!(s.read().transport().lines_len(), 4);
    let long = pair(&s, x0 + 1);
    assert_eq!(
        (long.1, long.2),
        (4_095 * 256, 4_096 * 256),
        "the long run's back tile"
    );
    assert_eq!(pair(&s, x0 + N - 1).1, 0, "the long run's front tile");
    let short = pair(&s, x0);
    assert_eq!((short.1, short.2), (0, 256), "the back tile on its own");
    assert_eq!(
        outs(&s, TilePos::new(x0, 50)),
        [Output::Next(long.0[0]), Output::Next(long.0[1])]
    );
    s.assert_topology_in(rect);

    // Picking up x = 0 splits the long run; its back part (x -2,047 to -1) now fits beside the back
    // tile and joins it: two runs of 2,048.
    let mid = TilePos::new(0, 50);
    s.pick_up_belt(P1, mid).unwrap();
    assert_eq!(s.read().transport().lines_len(), 4);
    assert_eq!(
        pair(&s, x0).2,
        2_048 * 256,
        "the back part re-joined the back tile"
    );
    assert_eq!(pair(&s, 1).2, 2_048 * 256);
    s.assert_topology_in(rect);
    // Placed again, x = 0 joins the run in front (2,049) and not the one behind (4,097 > 4,096).
    put(&mut s, mid, Dir::East);
    assert_eq!(s.read().transport().lines_len(), 4);
    assert_eq!((pair(&s, 0).1, pair(&s, 0).2), (2_048 * 256, 2_049 * 256));
    assert_eq!(pair(&s, x0).2, 2_048 * 256, "held apart at the limit");
    assert_eq!(
        outs(&s, TilePos::new(-1, 50)),
        [
            Output::Next(pair(&s, 0).0[0]),
            Output::Next(pair(&s, 0).0[1])
        ]
    );
    s.assert_topology_in(rect);
    assert_eq!(topology::belts_unmapped(), 0);
}

/// At a line cap of three, a first belt maps (two lines) and a second, apart from it, cannot: its
/// lane 0 is created and its lane 1 refused, so lane 0 is destroyed again: neither lane is mapped,
/// the counter says one belt, and no line leaks. Fails if a refused `create` leaves half a pair.
#[test]
fn topology_line_cap_maps_both_lanes_or_neither() {
    let mut s = RefScenario::with_caps(3, 64);
    s.join(P1);
    s.clear_area(TilePos::new(30, 30), 40, 40);
    put(&mut s, TilePos::new(40, 40), Dir::East);
    assert_eq!(
        (s.read().transport().lines_len(), topology::belts_unmapped()),
        (2, 0)
    );
    put(&mut s, TilePos::new(50, 50), Dir::North);
    assert_eq!(index(&s, TilePos::new(50, 50)), [], "neither lane");
    assert_eq!(topology::belts_unmapped(), 1, "one belt unmapped");
    assert_eq!(s.read().transport().lines_len(), 2, "no leak");
    assert!(lanes_at(s.read().transport(), TilePos::new(40, 40)).is_some());
}

/// A run shortened at its back end re-joins the run it was held apart from: east belts at x = 0 to
/// 4,096 (relative) are R = 0..4,095 (4,096 tiles) and F = 4,096 on its own (`Next` across); a south
/// belt above x = 0 makes that tile a left curve, so R' = 1..4,095 (4,095 tiles) now fits beside F
/// and the two join into one 4,096-tile run, two tiles from the edit. Fails if the re-join pass
/// skips a run piece `cut` left beyond the edit's four neighbours (the structure would then depend
/// on edit history: `assert_topology` finds R' and F apart though they fit).
#[test]
fn topology_shortened_run_rejoins_beyond_the_neighbours() {
    const N: i32 = 4_096;
    let x0 = -2_048;
    let mut s = RefScenario::new();
    s.join(P1);
    s.clear_area(TilePos::new(x0 - 1, 48), N + 3, 3);
    // R in merge order (odd tiles, then the gaps by trailing zeros, index 0 last), then F.
    let mut order: Vec<i32> = (1..N).step_by(2).collect();
    let mut gaps: Vec<i32> = (0..N).step_by(2).collect();
    gaps.sort_by_key(|&i| if i == 0 { 32 } else { i.trailing_zeros() });
    order.extend(gaps);
    order.push(N);
    for i in order {
        put(&mut s, TilePos::new(x0 + i, 50), Dir::East);
    }
    let rect = engine::world::TileRect::new(TilePos::new(x0 - 2, 48), TilePos::new(x0 + N + 2, 51));
    let run = |s: &RefScenario, i: i32| {
        let m = lanes(s, TilePos::new(x0 + i, 50));
        (m.lane, m.off, m.len)
    };
    assert_eq!(
        (run(&s, 0).2, run(&s, N).2),
        (4_096 * 256, 256),
        "R and F apart"
    );
    assert_eq!(s.read().transport().lines_len(), 4);
    s.assert_topology_in(rect);

    put(&mut s, TilePos::new(x0, 49), Dir::South);
    assert_eq!(shape(&s, TilePos::new(x0, 50)), BeltShape::CurveLeft);
    let joined = run(&s, 1);
    assert_eq!(
        (joined.1, joined.2),
        (4_095 * 256, 4_096 * 256),
        "R' and F one run"
    );
    assert_eq!(run(&s, N).0, joined.0);
    assert_eq!(
        s.read().transport().lines_len(),
        6,
        "R'+F, the curve, the feeder"
    );
    s.assert_topology_in(rect);
}
