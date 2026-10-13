//! Undergrounds on the host (M55; README "Belts", Undergrounds and Numbers; `belts/docs/03` §4.2, §6,
//! `belts/docs/07` §3, §8): pairing (the nearest same-facing exit within four empty tiles, a nearer
//! end stealing, perpendicular undergrounds transparent), the lines per lane (the entrance's back half,
//! a hidden `(gap + 1) x 256` line without segments, the exit's front half), the unpaired ends, the
//! hood filter on side-loads, rotation flipping both ends with their items mirrored (M60), pick-up
//! destroying the hidden items, and items through a pair: the surface belt's travel time and
//! capacity. Items come from spawners (the game's own path),
//! so these run in the fast suite; the `test-hooks` case checks the item hook's hidden-lane
//! addressing.

mod common;

use common::RefScenario;
use engine::game::PlayerId;
use engine::transport::{LineId, Output, TransportRead};
use engine::world::TilePos;
use reference_sim::content::ItemId;
use reference_sim::rules::belts::topology::{hidden_lanes, lanes_at, underground_partner};
use reference_sim::{BeltKind, BeltShape, Dir, RefAction, TileXY};

const P1: PlayerId = PlayerId(1);
const IN: BeltKind = BeltKind::UndergroundIn;
const OUT: BeltKind = BeltKind::UndergroundOut;
const IRON: u8 = ItemId::Iron as u8;
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

fn t(x: i32, y: i32) -> TilePos {
    TilePos::new(x, y)
}

fn tr(s: &RefScenario) -> &dyn TransportRead {
    s.read().transport()
}

fn lanes(s: &RefScenario, at: TilePos) -> [LineId; 2] {
    lanes_at(tr(s), at)
        .unwrap_or_else(|| panic!("{at:?} is mapped"))
        .lane
}

fn outs(s: &RefScenario, l: [LineId; 2]) -> [Output; 2] {
    [tr(s).out(l[0]).unwrap(), tr(s).out(l[1]).unwrap()]
}

fn next(l: [LineId; 2]) -> [Output; 2] {
    [Output::Next(l[0]), Output::Next(l[1])]
}

fn count(s: &RefScenario, l: LineId) -> u32 {
    tr(s).count(l).expect("line")
}

fn sunk(s: &RefScenario, at: TilePos) -> [u64; 2] {
    let l = lanes(s, at);
    [tr(s).sunk(l[0]).unwrap(), tr(s).sunk(l[1]).unwrap()]
}

/// The pair from the entrance on `e` to the exit on `x`: the entrance's lanes lead into hidden lines
/// of `(gap + 1) x 256` without segments, each leading into the exit's lane of its index; returns the
/// hidden lines. Panics (naming `what`) otherwise.
fn assert_paired(s: &RefScenario, e: TilePos, x: TilePos, gap: u32, what: &str) -> [LineId; 2] {
    let h = hidden_lanes(tr(s), e).unwrap_or_else(|| panic!("{what}: {e:?} has no hidden lines"));
    assert_eq!(
        outs(s, lanes(s, e)),
        next(h),
        "{what}: entrance into hidden"
    );
    assert_eq!(
        outs(s, h),
        next(lanes(s, x)),
        "{what}: hidden into the exit"
    );
    for l in h {
        assert_eq!(tr(s).len(l), Ok((gap + 1) * 256), "{what}: hidden len");
        let mut n = 0;
        tr(s).segments(l, &mut |_| n += 1).unwrap();
        assert_eq!(n, 0, "{what}: the hidden line has no segments");
    }
    h
}

fn assert_unpaired(s: &RefScenario, e: TilePos, what: &str) {
    assert_eq!(hidden_lanes(tr(s), e), None, "{what}: {e:?} hidden");
    assert_eq!(
        outs(s, lanes(s, e)),
        [Output::DeadEnd; 2],
        "{what}: {e:?} dead-ends at the hood"
    );
}

/// Gaps 0 to 4 east and every facing at gap 2: the entrance pairs (hidden lines of `(gap + 1) x 256`,
/// four lines plus two hidden in the store), gap 5 does not (four lines). A farther exit is ignored
/// (the nearer one ends the search); an exit facing the other way between ends it unpaired; a
/// perpendicular underground between is transparent (question 14 (b)'s default). Each end's two
/// lines are 128 long, one segment each, inside its tile. Fails if the span is off by one, the
/// search passes an end on its axis or stops at one across it, or a hidden line has geometry.
#[test]
fn underground_pairs_nearest_exit() {
    let e = t(40, 50);
    for gap in 0..=5u32 {
        let mut s = world();
        let x = t(41 + gap as i32, 50);
        put(&mut s, e, Dir::East, IN);
        put(&mut s, x, Dir::East, OUT);
        for at in [e, x] {
            for l in lanes(&s, at) {
                assert_eq!(tr(&s).len(l), Ok(128), "gap {gap}: {at:?} half");
            }
        }
        if gap <= 4 {
            assert_eq!(
                underground_partner(s.read(), e, Dir::East),
                Ok(Some((x, gap)))
            );
            assert_paired(&s, e, x, gap, &format!("gap {gap}"));
            assert_eq!(tr(&s).lines_len(), 6, "gap {gap}: lines");
        } else {
            assert_unpaired(&s, e, "gap 5");
            assert_eq!(tr(&s).lines_len(), 4, "gap 5: lines");
        }
        assert_eq!(s.belt_at(e).unwrap().shape, BeltShape::Straight);
        s.assert_topology();
    }
    for dir in [Dir::South, Dir::West, Dir::North] {
        let mut s = world();
        let (dx, dy) = match dir {
            Dir::South => (0, 1),
            Dir::West => (-1, 0),
            _ => (0, -1),
        };
        let x = t(e.x + 3 * dx, e.y + 3 * dy);
        put(&mut s, e, dir, IN);
        put(&mut s, x, dir, OUT);
        assert_paired(&s, e, x, 2, &format!("{dir:?}"));
        s.assert_topology();
    }

    // A farther exit is ignored.
    let mut s = world();
    put(&mut s, e, Dir::East, IN);
    put(&mut s, t(44, 50), Dir::East, OUT);
    put(&mut s, t(42, 50), Dir::East, OUT);
    assert_paired(&s, e, t(42, 50), 1, "the nearer exit");
    assert_eq!(tr(&s).lines_len(), 8);
    s.assert_topology();

    // An exit facing the other way ends the search: unpaired.
    let mut s = world();
    put(&mut s, e, Dir::East, IN);
    put(&mut s, t(44, 50), Dir::East, OUT);
    assert_paired(&s, e, t(44, 50), 3, "before the blocker");
    put(&mut s, t(42, 50), Dir::West, OUT);
    assert_unpaired(&s, e, "an exit facing west between");
    assert_eq!(tr(&s).lines_len(), 6);
    s.assert_topology();

    // A perpendicular underground (and a plain belt) between are passed over.
    let mut s = world();
    put(&mut s, e, Dir::East, IN);
    put(&mut s, t(42, 50), Dir::South, IN);
    put(&mut s, t(43, 50), Dir::North, OUT);
    put(&mut s, t(41, 50), Dir::North, BeltKind::Belt);
    put(&mut s, t(44, 50), Dir::East, OUT);
    assert_paired(&s, e, t(44, 50), 3, "across perpendicular undergrounds");
    s.assert_topology();
}

/// Steals and blocks, each undone: an entrance on (40, 50) paired with an exit at gap 4; a nearer
/// exit placed at gap 1 takes the pair (a new 512-position hidden pair, the far exit fed by
/// nothing); picking it up restores gap 4 (a new 1,280 pair); an entrance placed between at (42, 50)
/// blocks the first one (unpaired, its hidden lines destroyed) and pairs with the far exit at gap 2;
/// picking it up restores the first pair. Line ids and `Next` targets are pinned at every step, and
/// the far exit keeps its lines (3, 4) throughout (an exit's lines never change with pairing).
/// Fails if a new end does not steal, a removal does not restore, or a hidden line leaks.
#[test]
fn underground_steal() {
    let mut s = world();
    let (a, far) = (t(40, 50), t(45, 50));
    put(&mut s, a, Dir::East, IN);
    put(&mut s, far, Dir::East, OUT);
    // The far exit's lines never change with pairing (checked after every step).
    let far_lanes = |s: &RefScenario, step: &str| {
        assert_eq!(
            lanes(s, far),
            [LineId(3), LineId(4)],
            "{step}: the far exit's lines"
        );
    };
    let h = assert_paired(&s, a, far, 4, "first pair");
    far_lanes(&s, "first pair");
    assert_eq!(
        (lanes(&s, a), lanes(&s, far), h),
        (
            [LineId(1), LineId(2)],
            [LineId(3), LineId(4)],
            [LineId(5), LineId(6)]
        )
    );

    let near = t(42, 50);
    put(&mut s, near, Dir::East, OUT);
    let h = assert_paired(&s, a, near, 1, "stolen by the nearer exit");
    far_lanes(&s, "stolen by the nearer exit");
    // The near exit's lines are 7 and 8; the old hidden pair is destroyed and a new one made.
    assert_eq!(
        (lanes(&s, near), h, tr(&s).lines_len()),
        ([LineId(7), LineId(8)], [LineId(9), LineId(10)], 8)
    );
    s.assert_topology();

    s.pick_up_belt(P1, near).unwrap();
    let h = assert_paired(&s, a, far, 4, "restored");
    far_lanes(&s, "restored");
    assert_eq!((h, tr(&s).lines_len()), ([LineId(11), LineId(12)], 6));
    s.assert_topology();

    let b = t(42, 50);
    put(&mut s, b, Dir::East, IN);
    assert_unpaired(&s, a, "blocked by an entrance between");
    let h = assert_paired(&s, b, far, 2, "the new entrance");
    far_lanes(&s, "the new entrance");
    assert_eq!(
        (lanes(&s, b), h, tr(&s).lines_len()),
        ([LineId(13), LineId(14)], [LineId(15), LineId(16)], 8)
    );
    s.assert_topology();

    s.pick_up_belt(P1, b).unwrap();
    let h = assert_paired(&s, a, far, 4, "unblocked");
    far_lanes(&s, "unblocked");
    assert_eq!((h, tr(&s).lines_len()), ([LineId(17), LineId(18)], 6));
    s.assert_topology();
}

/// An entrance alone dead-ends at its hood: a saturated spawner behind it fills its 128-position
/// half with 2 items a lane and they stay there. An exit alone accepts nothing from behind: a belt
/// behind it facing its way dead-ends (and stays straight); the exit still counts as the input of the
/// tile in front (a north belt there curves left, fed lane for lane). Fails if an unpaired entrance
/// hands items on, or an exit takes a belt from behind.
#[test]
fn underground_unpaired_ends() {
    let mut s = world();
    let (sp, e) = (t(39, 50), t(40, 50));
    put(&mut s, sp, Dir::East, BeltKind::Spawner);
    put(&mut s, e, Dir::East, IN);
    assert_eq!(outs(&s, lanes(&s, sp)), next(lanes(&s, e)));
    assert_unpaired(&s, e, "alone");
    s.set_spawner(P1, sp, 0, IRON, SATURATE).unwrap();
    s.set_spawner(P1, sp, 1, IRON, SATURATE).unwrap();
    s.step_ticks(300);
    let l = lanes(&s, e);
    assert_eq!(
        (count(&s, l[0]), count(&s, l[1])),
        (2, 2),
        "two a lane at the hood"
    );
    let mut fronts = Vec::new();
    tr(&s)
        .items_in(l[0], &mut |_, p| fronts.push(p))
        .expect("line");
    assert_eq!(fronts, [0, 64], "at rest from the hood");
    s.assert_topology();

    let mut s = world();
    let (behind, x, front) = (t(39, 50), t(40, 50), t(41, 50));
    put(&mut s, x, Dir::East, OUT);
    put(&mut s, behind, Dir::East, BeltKind::Belt);
    put(&mut s, front, Dir::North, BeltKind::Belt);
    assert_eq!(outs(&s, lanes(&s, behind)), [Output::DeadEnd; 2]);
    assert_eq!(s.belt_at(behind).unwrap().shape, BeltShape::Straight);
    assert_eq!(s.belt_at(front).unwrap().shape, BeltShape::CurveLeft);
    assert_eq!(outs(&s, lanes(&s, x)), next(lanes(&s, front)));
    s.assert_topology();
}

/// Travel takes the surface belt's time: a saturated spawner (lane 0) into an entrance, gap `g`, an
/// exit and a despawner, beside a spawner, `g + 2` plain belts and a despawner, configured in one
/// tick: the first item is sunk on the same tick on both rows, and the sunk counts agree after 200
/// ticks, for every gap 0 to 4. The pair's lanes are `(g + 2) x 256` positions end to end, `(g + 2)
/// x 256 / 24` ticks of travel (64 at gap 4) like the plain run's; the first sunk tick after the
/// configuring tick is pinned per gap. Fails if the hidden line's length or a hand-off costs or saves
/// time.
#[test]
fn underground_travel_time() {
    for gap in 0..=4i32 {
        let mut s = world();
        let (y_ug, y_plain) = (50, 53);
        put(&mut s, t(39, y_ug), Dir::East, BeltKind::Spawner);
        put(&mut s, t(40, y_ug), Dir::East, IN);
        put(&mut s, t(41 + gap, y_ug), Dir::East, OUT);
        put(&mut s, t(42 + gap, y_ug), Dir::East, BeltKind::Despawner);
        put(&mut s, t(39, y_plain), Dir::East, BeltKind::Spawner);
        for x in 40..42 + gap {
            put(&mut s, t(x, y_plain), Dir::East, BeltKind::Belt);
        }
        put(&mut s, t(42 + gap, y_plain), Dir::East, BeltKind::Despawner);
        let cfg = |y| RefAction::SetSpawner {
            at: TileXY { x: 39, y },
            lane: 0,
            item: IRON,
            rate: SATURATE,
        };
        assert_eq!(
            s.dispatch_batch(P1, &[cfg(y_ug), cfg(y_plain)]),
            [Ok(()), Ok(())]
        );
        let start = s.tick().0;
        let mut first = [None, None];
        for _ in 0..200 {
            s.step_ticks(1);
            for (i, y) in [y_ug, y_plain].into_iter().enumerate() {
                if first[i].is_none() && sunk(&s, t(42 + gap, y))[0] > 0 {
                    first[i] = Some(s.tick().0 - start);
                }
            }
        }
        assert_eq!(first[0], first[1], "gap {gap}: the same first sunk tick");
        s.assert_topology();
        // Sunk counts over the window agree too.
        assert_eq!(
            sunk(&s, t(42 + gap, y_ug)),
            sunk(&s, t(42 + gap, y_plain)),
            "gap {gap}: sunk"
        );
        // Measured: one more gap tile adds 256 / 24 = 10.67 ticks (10 or 11 by the phase).
        assert_eq!(
            first[0],
            Some([43, 54, 65, 75, 86][gap as usize]),
            "gap {gap}: the first item's ticks"
        );
    }
}

/// Capacity: a saturated spawner (both lanes) into an entrance, gap 4, an exit with nothing in front:
/// once full, each lane holds 2 on the entrance's half, 4 x (4 + 1) = 20 on the hidden line and 2 on
/// the exit's half, 24 a lane (`belts/docs/12` §4a: 4 a tile a lane, no loss at a boundary; the
/// wiki's "44 at gap 4" counts both lanes of the entrance entity, 4 + 40). Fails if a hand-off loses
/// a slot or the hidden line has the wrong length.
#[test]
fn underground_capacity() {
    let mut s = world();
    let (sp, e, x) = (t(39, 50), t(40, 50), t(45, 50));
    put(&mut s, sp, Dir::East, BeltKind::Spawner);
    put(&mut s, e, Dir::East, IN);
    put(&mut s, x, Dir::East, OUT);
    s.set_spawner(P1, sp, 0, IRON, SATURATE).unwrap();
    s.set_spawner(P1, sp, 1, IRON, SATURATE).unwrap();
    s.step_ticks(600);
    let h = hidden_lanes(tr(&s), e).expect("paired");
    let (el, xl) = (lanes(&s, e), lanes(&s, x));
    let per_lane = |k: usize| (count(&s, el[k]), count(&s, h[k]), count(&s, xl[k]));
    assert_eq!(
        (per_lane(0), per_lane(1)),
        ((2, 20, 2), (2, 20, 2)),
        "entrance, hidden, exit per lane"
    );
    s.assert_topology();
}

/// The hood filter, east (a positive direction: the edge rule's one-position offset) and west: a
/// belt pointing into either side of an entrance lands its lane nearer the target's back (+192) on
/// the entrance's visible back half at 64 and dead-ends its other lane (+64, inside the hood); onto
/// an exit the +64 lane lands at 64 and the +192 lane dead-ends. The near lane is the target's lane
/// on the feeder's side. Fails if a landing inside the hidden half connects, or a visible landing is
/// off by the half's 128.
#[test]
fn underground_sideload_hood() {
    for dir in [Dir::East, Dir::West] {
        for kind in [IN, OUT] {
            let mut s = world();
            let at = t(45, 50);
            put(&mut s, at, dir, kind);
            // From the north (a south belt) and from the south (a north belt).
            let (north, south) = (t(45, 49), t(45, 51));
            put(&mut s, north, Dir::South, BeltKind::Belt);
            put(&mut s, south, Dir::North, BeltKind::Belt);
            let l = lanes(&s, at);
            // Lane 0 is the target's left: north when it faces east, south when it faces west.
            let (left, right) = if dir == Dir::East {
                (north, south)
            } else {
                (south, north)
            };
            for (feeder, near) in [(left, 0usize), (right, 1)] {
                // The feeder's lane `near` is the one on the near side (lane 0 is its left: a south
                // belt's left is east).
                let f = lanes(&s, feeder);
                let got = outs(&s, f);
                // Feeder lane k lands at +64 when k == the target's near lane index, else +192.
                let want = |k: usize| {
                    let land = if k == near { 64 } else { 192 };
                    match kind {
                        IN if land >= 128 => Output::Merge {
                            line: l[near],
                            at: land - 128,
                        },
                        OUT if land < 128 => Output::Merge {
                            line: l[near],
                            at: land,
                        },
                        _ => Output::DeadEnd,
                    }
                };
                assert_eq!(got, [want(0), want(1)], "{dir:?} {kind:?} from {feeder:?}");
                // Exactly one lane lands.
                assert_eq!(
                    got.iter()
                        .filter(|o| matches!(o, Output::Merge { .. }))
                        .count(),
                    1
                );
            }
            assert_eq!(s.belt_at(at).unwrap().shape, BeltShape::Straight);
            s.assert_topology();
        }
    }
}

/// Rotating either end of a pair flips both (M60, Tyler's 2026-10-13 answer: README "Belts",
/// Rotating an underground): an entrance paired east across gap 2, rotated, is an exit facing west
/// and its partner an entrance facing west, still paired across gap 2 the other way (the hidden
/// lines `3 x 256`, the same six lines: each end's two and the two hidden, ids kept). Rotated again
/// at the other tile (now the entrance) the pair is back as placed; rotated at its exit it flips
/// again, and at the new exit back once more. Fails if a rotation turns 90 degrees, turns one end
/// only, keeps the kind, unpairs the pair, or re-creates its lines.
#[test]
fn underground_rotate_flips_both_ends() {
    let mut s = world();
    let (e, x) = (t(40, 50), t(43, 50));
    put(&mut s, e, Dir::East, IN);
    put(&mut s, x, Dir::East, OUT);
    let h = assert_paired(&s, e, x, 2, "placed");
    let (le, lx) = (lanes(&s, e), lanes(&s, x));
    assert_eq!(tr(&s).lines_len(), 6);
    let ends = |s: &RefScenario| {
        let (a, b) = (s.belt_at(e).unwrap(), s.belt_at(x).unwrap());
        [(a.dir, a.kind), (b.dir, b.kind)]
    };
    // Rotated at the entrance (e), the new entrance (x), the exit (x) and the new exit (e): each a
    // flip of the whole pair.
    for (i, at) in [e, x, x, e].into_iter().enumerate() {
        s.rotate_belt(P1, at).unwrap();
        let flipped = i % 2 == 0;
        let what = format!("rotation {i} at {at:?}");
        if flipped {
            assert_eq!(ends(&s), [(Dir::West, OUT), (Dir::West, IN)], "{what}");
            assert_eq!(assert_paired(&s, x, e, 2, &what), h, "{what}: hidden kept");
        } else {
            assert_eq!(ends(&s), [(Dir::East, IN), (Dir::East, OUT)], "{what}");
            assert_eq!(assert_paired(&s, e, x, 2, &what), h, "{what}: hidden kept");
        }
        assert_eq!(
            (lanes(&s, e), lanes(&s, x)),
            (le, lx),
            "{what}: end lines kept"
        );
        assert_eq!(tr(&s).lines_len(), 6, "{what}: lines");
        s.assert_topology();
    }
}

/// The items of a pair along its whole path, per lane: `(item, position)` from the exit's front
/// edge (the exit's half 0..128, the hidden line from 128, the entrance's half from `128 + hidden`),
/// front to back.
fn path_items(s: &RefScenario, e: TilePos, x: TilePos) -> [Vec<(u16, u32)>; 2] {
    let h = hidden_lanes(tr(s), e).expect("paired");
    let (le, lx) = (lanes(s, e), lanes(s, x));
    let hl = tr(s).len(h[0]).unwrap();
    let mut out = [Vec::new(), Vec::new()];
    for (k, v) in out.iter_mut().enumerate() {
        for (line, base) in [(lx[k], 0), (h[k], 128), (le[k], 128 + hl)] {
            tr(s)
                .items_in(line, &mut |i, p| v.push((i.0, base + p)))
                .unwrap();
        }
    }
    out
}

/// A flip keeps the pair's items (M60): a spawner feeds a pair across gap 2 (path 1,024 per lane)
/// iron on lane 0 and coal on lane 1 at a lower rate for 40 ticks, is switched off, and the items
/// jam at the exit's dead end (15 and 4, from position 0, 64 apart). Rotating the entrance mirrors
/// every item along the whole path (`1,023 - pos`, the path reversed), on its own lane index, and
/// in the same tick they move one tick's travel (24) toward the new exit, which dead-ends head-on
/// into the spawner: nothing is destroyed, the count per lane is the same. Fails if a flip destroys
/// or drops items, mirrors them about the wrong point (`1,024 - pos` puts the front item off the
/// path and collides the next), or swaps lanes.
#[test]
fn underground_rotate_keeps_items_mirrored() {
    let mut s = world();
    let (f, e, x) = (t(39, 50), t(40, 50), t(43, 50));
    put(&mut s, f, Dir::East, BeltKind::Spawner);
    put(&mut s, e, Dir::East, IN);
    put(&mut s, x, Dir::East, OUT);
    s.set_spawner(P1, f, 0, IRON, SATURATE).unwrap();
    s.set_spawner(P1, f, 1, ItemId::Coal as u8, 1).unwrap();
    s.step_ticks(40);
    for lane in 0..2 {
        s.set_spawner(P1, f, lane, reference_sim::content::SPAWN_OFF, 0)
            .unwrap();
    }
    s.step_ticks(300);
    let before = path_items(&s, e, x);
    let (n0, n1) = (before[0].len(), before[1].len());
    assert_eq!((n0, n1), (15, 4), "jammed from the exit's front, 64 apart");
    let destroyed = reference_sim::rules::belts::topology::belts_destroyed_items();
    s.rotate_belt(P1, e).unwrap();
    // Now the entrance is on `x` and the exit on `e`.
    let after = path_items(&s, x, e);
    for k in 0..2 {
        let iron_or_coal = if k == 0 {
            ItemId::Iron as u16 + 1
        } else {
            ItemId::Coal as u16 + 1
        };
        let mut want: Vec<(u16, u32)> =
            before[k].iter().map(|&(i, p)| (i, 1023 - p - 24)).collect();
        want.reverse();
        assert_eq!(after[k], want, "lane {k}: mirrored, then one tick on");
        assert!(
            after[k].iter().all(|&(i, _)| i == iron_or_coal),
            "lane {k} kept"
        );
    }
    assert_eq!(
        reference_sim::rules::belts::topology::belts_destroyed_items(),
        destroyed,
        "nothing destroyed"
    );
    s.assert_topology();
}

/// An unpaired end flips alone (M60): an entrance fed by a spawner, with no exit ahead, holds two
/// items jammed at its hood (0 and 64 on lane 0); rotated, it is an exit facing west on the same
/// two lines, its items mirrored on its half (`127 - pos`: 127 and 63) then moved one tick (103 and
/// 39), head-on into the spawner. A lone exit five tiles below flips alone into an entrance facing
/// west. An exit six tiles ahead of the entrance (beyond the span) is untouched. Fails if a lone
/// end does not flip, re-creates its lines, loses its items, or turns a far end with it.
#[test]
fn underground_rotate_unpaired_end_flips_alone() {
    let mut s = world();
    let (f, e, far, lone) = (t(39, 50), t(40, 50), t(46, 50), t(40, 55));
    put(&mut s, f, Dir::East, BeltKind::Spawner);
    put(&mut s, e, Dir::East, IN);
    put(&mut s, far, Dir::East, OUT);
    put(&mut s, lone, Dir::East, OUT);
    assert_unpaired(&s, e, "gap 5");
    s.set_spawner(P1, f, 0, IRON, SATURATE).unwrap();
    s.step_ticks(60);
    s.set_spawner(P1, f, 0, reference_sim::content::SPAWN_OFF, 0)
        .unwrap();
    s.step_ticks(100);
    let le = lanes(&s, e);
    let items = |s: &RefScenario, l: LineId| {
        let mut v = Vec::new();
        tr(s).items_in(l, &mut |i, p| v.push((i.0, p))).unwrap();
        v
    };
    let iron = ItemId::Iron as u16 + 1;
    assert_eq!(
        items(&s, le[0]),
        [(iron, 0), (iron, 64)],
        "jammed at the hood"
    );
    let lines = tr(&s).lines_len();
    s.rotate_belt(P1, e).unwrap();
    let b = s.belt_at(e).unwrap();
    assert_eq!((b.dir, b.kind), (Dir::West, OUT));
    assert_eq!(lanes(&s, e), le, "its lines kept");
    assert_eq!(
        items(&s, le[0]),
        [(iron, 39), (iron, 103)],
        "mirrored, one tick on"
    );
    assert_eq!(items(&s, le[1]), []);
    let b = s.belt_at(far).unwrap();
    assert_eq!((b.dir, b.kind), (Dir::East, OUT), "the far exit stays");
    s.rotate_belt(P1, lone).unwrap();
    let b = s.belt_at(lone).unwrap();
    assert_eq!((b.dir, b.kind), (Dir::West, IN), "the lone exit flips");
    assert_unpaired(&s, lone, "nothing west of it");
    assert_eq!(tr(&s).lines_len(), lines);
    s.assert_topology();
}

/// The exit's scan back (M60, `underground_other_end`) obeys pairing's own rules: (a) an entrance
/// east at x = 40, an entrance facing west at x = 42 and an exit east at x = 43: the same-axis end
/// at 42 ends the exit's scan (the entrance at 40 is not its partner: unpaired, it dead-ends), so
/// rotating the exit flips it alone and the two entrances stay as placed; (b) an entrance six tiles
/// behind an exit (x = 40 and 46, gap 5, one past the span): rotating the exit flips it alone.
/// Fails if the scan passes a same-axis underground or reaches past `UNDERGROUND_MAX_GAP` + 1
/// tiles (the far entrance would flip with the exit).
#[test]
fn underground_rotate_exit_scan_bounds() {
    let ends = |s: &RefScenario, at: &[TilePos]| -> Vec<(Dir, BeltKind)> {
        at.iter()
            .map(|&t| {
                let b = s.belt_at(t).unwrap();
                (b.dir, b.kind)
            })
            .collect()
    };
    // (a) A blocking same-axis underground between.
    let mut s = world();
    let (e, y, x) = (t(40, 50), t(42, 50), t(43, 50));
    put(&mut s, e, Dir::East, IN);
    put(&mut s, y, Dir::West, IN);
    put(&mut s, x, Dir::East, OUT);
    assert_unpaired(&s, e, "(a) blocked by the end at 42");
    s.rotate_belt(P1, x).unwrap();
    assert_eq!(
        ends(&s, &[e, y, x]),
        [(Dir::East, IN), (Dir::West, IN), (Dir::West, IN)],
        "(a) the exit flips alone"
    );
    s.assert_topology();
    // (b) An entrance one tile past the span.
    let mut s = world();
    let (e, x) = (t(40, 50), t(46, 50));
    put(&mut s, e, Dir::East, IN);
    put(&mut s, x, Dir::East, OUT);
    assert_unpaired(&s, e, "(b) gap 5");
    s.rotate_belt(P1, x).unwrap();
    assert_eq!(
        ends(&s, &[e, x]),
        [(Dir::East, IN), (Dir::West, IN)],
        "(b) the exit flips alone"
    );
    s.assert_topology();
}

/// A world view holding only the columns `held` (a client's subscription edge), over a scenario's
/// host state; it counts the puts `apply` makes (they go nowhere).
struct Edge<'a> {
    inner: &'a dyn engine::game::WorldRead<reference_sim::RefGame>,
    held: std::ops::Range<i32>,
    puts: usize,
}

impl engine::game::WorldRead<reference_sim::RefGame> for Edge<'_> {
    fn tick(&self) -> engine::time::Tick {
        self.inner.tick()
    }
    fn tile(&self, p: TilePos) -> Result<engine::world::Tile, engine::game::Unknown> {
        if !self.held.contains(&p.x) {
            return Err(engine::game::Unknown);
        }
        self.inner.tile(p)
    }
    fn traits_at(&self, p: TilePos) -> Result<engine::world::TraitSet, engine::game::Unknown> {
        if !self.held.contains(&p.x) {
            return Err(engine::game::Unknown);
        }
        self.inner.traits_at(p)
    }
    fn entity_at(
        &self,
        p: TilePos,
    ) -> Result<Option<engine::game::EntityId>, engine::game::Unknown> {
        if !self.held.contains(&p.x) {
            return Err(engine::game::Unknown);
        }
        self.inner.entity_at(p)
    }
    fn entity(
        &self,
        id: engine::game::EntityId,
    ) -> Result<Option<&reference_sim::RefEntity>, engine::game::Unknown> {
        self.inner.entity(id)
    }
    fn player(&self, who: PlayerId) -> Result<&reference_sim::RefPlayer, engine::game::Unknown> {
        self.inner.player(who)
    }
    fn global(&self) -> &reference_sim::RefGlobal {
        self.inner.global()
    }
    fn entities_in(
        &self,
        _rect: engine::world::TileRect,
        _f: &mut dyn FnMut(engine::game::EntityId, &reference_sim::RefEntity),
    ) -> Result<(), engine::game::Unknown> {
        Err(engine::game::Unknown)
    }
}

impl engine::game::WorldWrite<reference_sim::RefGame> for Edge<'_> {
    fn set_tile(&mut self, _p: TilePos, _t: engine::world::Tile) {
        self.puts += 1;
    }
    fn spawn(&mut self, _e: reference_sim::RefEntity) -> engine::game::EntityId {
        self.puts += 1;
        engine::game::EntityId(u32::MAX)
    }
    fn put_entity(&mut self, _id: engine::game::EntityId, _e: reference_sim::RefEntity) {
        self.puts += 1;
    }
    fn despawn(&mut self, _id: engine::game::EntityId) {
        self.puts += 1;
    }
    fn put_player(&mut self, _who: PlayerId, _p: reference_sim::RefPlayer) {
        self.puts += 1;
    }
    fn put_global(&mut self, _g: reference_sim::RefGlobal) {
        self.puts += 1;
    }
    fn rng(&mut self) -> Result<&mut engine::rng::SimRng, engine::game::Unknown> {
        Err(engine::game::Unknown)
    }
}

/// A rotation reads the whole pairing scan before it writes (`.claude/rules/prediction.md`): with
/// the pair's partner side not held (the tiles from x = 42 on unknown, as at a client's
/// subscription edge), rotating the entrance on (40, 50) is `Unknown` (refused on the host,
/// `NotPredictable` on a client) with no put; so is rotating the exit on (43, 50) with the tiles up
/// to x = 41 unknown (its scan back). The control, everything held, writes two puts (both ends)
/// from either end. The scenario is unchanged throughout (the view's puts go nowhere). Fails if a
/// rotation guesses past an unknown tile (flips one end alone) or writes before its last read.
#[test]
fn underground_rotate_partner_unknown_is_refused() {
    use reference_sim::rules::belt::rotate;
    let mut s = world();
    let (e, x) = (t(40, 50), t(43, 50));
    put(&mut s, e, Dir::East, IN);
    put(&mut s, x, Dir::East, OUT);
    let hash = s.hash();
    let mut edge = Edge {
        inner: s.read(),
        held: i32::MIN..42,
        puts: 0,
    };
    assert_eq!(rotate(&mut edge, e), Err(reference_sim::RefReject::Unknown));
    assert_eq!(edge.puts, 0, "the entrance: nothing written");
    edge.held = 42..i32::MAX;
    assert_eq!(rotate(&mut edge, x), Err(reference_sim::RefReject::Unknown));
    assert_eq!(edge.puts, 0, "the exit: nothing written");
    edge.held = i32::MIN..i32::MAX;
    assert_eq!(rotate(&mut edge, e), Ok(()), "control: all held");
    assert_eq!(edge.puts, 2, "control: both ends");
    assert_eq!(rotate(&mut edge, x), Ok(()), "control: all held");
    assert_eq!(edge.puts, 4, "control: both ends");
    assert_eq!(s.hash(), hash, "the scenario untouched");
    s.assert_topology();
}

/// Pick-up destroys the hidden line with its items: two saturated pairs (gap 3), one entrance and the
/// other pair's exit picked up in one tick: no hidden line is left (the store holds the spawners'
/// and the remaining ends' lines only: eight), and the remaining entrance dead-ends and keeps the 2
/// items on its saturated lane 0 (lane 1 was never fed). Fails if a hidden line leaks or outlives its pair.
#[test]
fn underground_pickup_destroys_hidden() {
    let mut s = world();
    let rows = [50, 53];
    for y in rows {
        put(&mut s, t(39, y), Dir::East, BeltKind::Spawner);
        put(&mut s, t(40, y), Dir::East, IN);
        put(&mut s, t(44, y), Dir::East, OUT);
        s.set_spawner(P1, t(39, y), 0, IRON, SATURATE).unwrap();
    }
    s.step_ticks(400);
    let h: Vec<[LineId; 2]> = rows
        .iter()
        .map(|&y| hidden_lanes(tr(&s), t(40, y)).expect("paired"))
        .collect();
    for hl in &h {
        assert_eq!(count(&s, hl[0]), 16, "a full hidden lane at gap 3");
    }
    assert_eq!(tr(&s).lines_len(), 16);
    let r = s.dispatch_batch(
        P1,
        &[
            RefAction::PickUpBelt {
                at: TileXY { x: 40, y: 50 },
            },
            RefAction::PickUpBelt {
                at: TileXY { x: 44, y: 53 },
            },
        ],
    );
    assert_eq!(r, [Ok(()), Ok(())]);
    for hl in &h {
        for l in hl {
            assert!(tr(&s).len(*l).is_err(), "hidden {l:?} destroyed");
        }
    }
    assert_unpaired(&s, t(40, 53), "its exit picked up");
    let l = lanes(&s, t(40, 53));
    assert_eq!((count(&s, l[0]), count(&s, l[1])), (2, 0));
    // Two spawners, the exit left on row 50 and the entrance left on row 53: eight lines.
    assert_eq!(tr(&s).lines_len(), 8);
    s.assert_topology();
}

/// `test-hooks` (M55): the item hook's lanes 2 and 3 on a paired entrance's tile are its hidden lines
/// (position from their front), lanes 0 and 1 its own half's. Fails if the hook addresses the wrong
/// line.
#[cfg(feature = "test-hooks")]
#[test]
fn underground_test_insert_addresses_hidden_lanes() {
    let mut s = world();
    let (e, x) = (t(40, 50), t(43, 50));
    put(&mut s, e, Dir::East, IN);
    put(&mut s, x, Dir::East, OUT);
    let h = hidden_lanes(tr(&s), e).expect("paired");
    let el = lanes(&s, e);
    let batch: Vec<RefAction> = (0..4u8)
        .map(|lane| RefAction::TestInsertItem {
            at: TileXY::from_tile(e),
            lane,
            pos: 100,
            item: u16::from(lane) + 1,
        })
        .collect();
    assert!(s.dispatch_batch(P1, &batch).iter().all(Result::is_ok));
    let items = |l: LineId| {
        let mut v = Vec::new();
        tr(&s).items_in(l, &mut |i, p| v.push((i.0, p))).unwrap();
        v
    };
    // Inserted at 100 and moved one tick (24).
    assert_eq!(
        [items(el[0]), items(el[1]), items(h[0]), items(h[1])],
        [vec![(1, 76)], vec![(2, 76)], vec![(3, 76)], vec![(4, 76)]]
    );
    s.assert_topology();
}
