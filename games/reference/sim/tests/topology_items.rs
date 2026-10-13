//! Belt topology with items on the lines (M52 Tests added): a reshape and (M59) a rotation keep them
//! (rescale), a pick-up destroys the tile's (README Placement). Items
//! reach a line only through the `test-hooks` action `TestInsertItem` until M53's spawners, so this
//! file builds only with the feature: `cargo nextest run -p reference-sim --features test-hooks
//! --test topology_items`.
#![cfg(feature = "test-hooks")]

mod common;

use common::RefScenario;
use engine::game::PlayerId;
use engine::transport::LineId;
use engine::world::TilePos;
use reference_sim::content::ItemId;
use reference_sim::rules::belts::topology::lanes_at;
use reference_sim::{BeltKind, BeltShape, Dir, RefAction, TileXY};

const P1: PlayerId = PlayerId(1);

fn world() -> RefScenario {
    let mut s = RefScenario::new();
    s.join(P1);
    s.clear_area(TilePos::new(30, 30), 40, 40);
    s
}

fn put(s: &mut RefScenario, at: TilePos, dir: Dir) {
    s.place_belt(P1, at, dir, BeltKind::Belt)
        .unwrap_or_else(|r| panic!("place {at:?}: {r:?}"));
}

fn insert(s: &mut RefScenario, at: TilePos, lane: u8, pos: u16, item: u16) {
    s.dispatch(
        P1,
        RefAction::TestInsertItem {
            at: TileXY::from_tile(at),
            lane,
            pos,
            item,
        },
    )
    .expect("the hook applies");
}

fn lanes(s: &RefScenario, at: TilePos) -> [LineId; 2] {
    lanes_at(s.read().transport(), at)
        .unwrap_or_else(|| panic!("{at:?} is mapped"))
        .lane
}

fn items(s: &RefScenario, l: LineId) -> Vec<(u16, u32)> {
    let mut v = Vec::new();
    s.read()
        .transport()
        .items_in(l, &mut |i, p| v.push((i.0, p)))
        .expect("line");
    v
}

/// A north curve fed from its right (lane 0 outer 295, lane 1 inner 106) holds two items at rest on
/// each lane (0 and 64); a belt placed behind it makes it straight (R2) and its lanes are rescaled to
/// 256, the items at `floor(pos x 256 / old)`: the outer lane's 0 and 55 (a squashed pair, kept and
/// held: it is at rest behind the front item), the inner lane's 0 and 154, which then moves one tick
/// (24) to 130 in the same tick's advance. The request entities are gone. Fails if a reshape
/// re-creates the lines (items lost), scales by the wrong lengths or drops the squashed pair.
#[test]
fn topology_reshape_rescales_items() {
    let mut s = world();
    let p = TilePos::new(50, 50);
    put(&mut s, TilePos::new(51, 50), Dir::West);
    put(&mut s, p, Dir::North);
    assert_eq!(s.belt_at(p).unwrap().shape, BeltShape::CurveRight);
    let [outer, inner] = lanes(&s, p);
    for (lane, pos, item) in [(0, 0, 1), (0, 64, 2), (1, 0, 3), (1, 64, 4)] {
        insert(&mut s, p, lane, pos, item);
    }
    assert_eq!(items(&s, outer), [(1, 0), (2, 64)]);
    assert_eq!(items(&s, inner), [(3, 0), (4, 64)]);
    assert_eq!(
        s.entities().len(),
        2,
        "the requests despawned in their tick"
    );

    put(&mut s, TilePos::new(50, 51), Dir::North);
    assert_eq!(s.belt_at(p).unwrap().shape, BeltShape::Straight);
    assert_eq!(lanes(&s, p), [outer, inner], "the same lines, rescaled");
    assert_eq!(
        items(&s, outer),
        [(1, 0), (2, 55)],
        "295 -> 256: a squashed pair"
    );
    assert_eq!(
        items(&s, inner),
        [(3, 0), (4, 130)],
        "106 -> 256: 154, then a tick"
    );
    s.assert_topology();
}

/// A rotation keeps the tile's lines and items (M59, Tyler's 2026-10-13 answer to question 10):
/// the north curve of `topology_reshape_rescales_items` (lane 0 outer 295, lane 1 inner 106, two
/// items at rest on each) turned to face east is straight (the belt at (51, 50) is now head-on, no
/// input), and the same two lines are rescaled to 256, lane `k` still lane `k`: items at
/// `floor(pos x 256 / old)` (lane 0: 0 and 55, a squashed pair held behind the front item; lane 1:
/// 0 and 154, which moves one tick, 24, to 130 in the rotation's tick) and laid along east. Nothing
/// is destroyed. A pick-up still destroys the lines and their items with the belt. Fails if a
/// rotation re-creates the lines (fresh ids, items lost), swaps the lanes or scales by the wrong
/// lengths.
#[test]
fn topology_rotate_keeps_items() {
    use reference_sim::rules::belts::topology::belts_destroyed_items;
    let mut s = world();
    let p = TilePos::new(50, 50);
    put(&mut s, TilePos::new(51, 50), Dir::West);
    put(&mut s, p, Dir::North);
    assert_eq!(s.belt_at(p).unwrap().shape, BeltShape::CurveRight);
    let [outer, inner] = lanes(&s, p);
    for (lane, pos, item) in [(0, 0, 1), (0, 64, 2), (1, 0, 3), (1, 64, 4)] {
        insert(&mut s, p, lane, pos, item);
    }
    assert_eq!(items(&s, outer), [(1, 0), (2, 64)]);
    assert_eq!(items(&s, inner), [(3, 0), (4, 64)]);
    let destroyed = belts_destroyed_items();
    let lines = s.read().transport().lines_len();

    s.rotate_belt(P1, p).unwrap();
    let b = s.belt_at(p).unwrap();
    assert_eq!((b.dir, b.shape), (Dir::East, BeltShape::Straight));
    assert_eq!(
        lanes(&s, p),
        [outer, inner],
        "the same lines, lane for lane"
    );
    assert_eq!(
        items(&s, outer),
        [(1, 0), (2, 64 * 256 / 295)],
        "295 -> 256: 0 and 55"
    );
    assert_eq!(
        items(&s, inner),
        [(3, 0), (4, 64 * 256 / 106 - 24)],
        "106 -> 256: 154, then a tick"
    );
    assert_eq!(belts_destroyed_items(), destroyed, "nothing destroyed");
    assert_eq!(s.read().transport().lines_len(), lines, "no line created");
    s.assert_topology();

    s.pick_up_belt(P1, p).unwrap();
    let tr = s.read().transport();
    assert!(
        tr.len(outer).is_err() && tr.len(inner).is_err(),
        "picked up: lines gone"
    );
    assert_eq!(
        belts_destroyed_items(),
        destroyed + 4,
        "and their four items"
    );
}

/// A run turned into a curve keeps its lines lane for lane (M59 fix round 1): a west belt at (50,
/// 50) in front of another (one two-tile run) turned north becomes a right curve (the belt behind
/// now feeds its right side), lane 0 the outer lane (295), lane 1 the inner (106). Lane 1 holds
/// three items at rest (0, 64, 128), squashed to `floor(pos x 106 / 256)` = 0, 26, 53 and held
/// there; lane 0 one item moving from 176, rescaled to `floor(176 x 295 / 256)` = 202 and moved one
/// tick (24) to 178. Fails if the lanes are swapped (lane 1 at 295 would read 0, 64, 128 after the
/// tick, lane 0 at 106 would read 48), if either lane is scaled by the wrong length or if the lines
/// are re-created.
#[test]
fn topology_rotate_run_to_curve_keeps_lanes() {
    use reference_sim::rules::belts::topology::belts_destroyed_items;
    let mut s = world();
    let p = TilePos::new(50, 50);
    put(&mut s, TilePos::new(51, 50), Dir::West);
    put(&mut s, p, Dir::West);
    assert_eq!(s.belt_at(p).unwrap().shape, BeltShape::Straight);
    let [l0, l1] = lanes(&s, p);
    for pos in [0, 64, 128] {
        insert(&mut s, p, 1, pos, 3);
    }
    insert(&mut s, p, 0, 200, 1);
    assert_eq!(items(&s, l1), [(3, 0), (3, 64), (3, 128)], "at rest");
    assert_eq!(items(&s, l0), [(1, 176)], "200, moved one tick");
    let destroyed = belts_destroyed_items();

    s.rotate_belt(P1, p).unwrap();
    let b = s.belt_at(p).unwrap();
    assert_eq!((b.dir, b.shape), (Dir::North, BeltShape::CurveRight));
    assert_eq!(lanes(&s, p), [l0, l1], "the same lines, lane for lane");
    assert_eq!(
        items(&s, l1),
        [(3, 0), (3, 64 * 106 / 256), (3, 128 * 106 / 256)],
        "inner 106: 0, 26, 53, held"
    );
    assert_eq!(
        items(&s, l0),
        [(1, 176 * 295 / 256 - 24)],
        "outer 295: 202, then a tick"
    );
    assert_eq!(belts_destroyed_items(), destroyed, "nothing destroyed");
    s.assert_topology();
}

/// A rotated spawner keeps its lines and items and its schedule restarts at zero credit (M59;
/// question 13): a lone east spawner, lane 0 at the saturation rate (683), its credit 597 when it is
/// rotated, so that tick would take it to 853 >= 683 (one insert, item two); restarted, that tick's `advance` steps it
/// to 256 and the next insert lands two ticks later (512, then 768), one full period after the
/// rotation. Fails if the rotation re-creates the lines (fresh ids, the item destroyed) or keeps the
/// old credit (the insert in the rotation's own tick).
#[test]
fn topology_rotate_spawner_restarts_credit() {
    use reference_sim::rules::belts::topology::belts_destroyed_items;
    let mut s = world();
    let p = TilePos::new(50, 50);
    s.place_belt(P1, p, Dir::East, BeltKind::Spawner).unwrap();
    s.set_spawner(P1, p, 0, ItemId::Iron as u8, 3)
        .expect("lane 0 scheduled");
    let [l0, l1] = lanes(&s, p);
    let acc = |s: &RefScenario| {
        s.transport_store()
            .schedule(l0)
            .expect("line")
            .expect("scheduled")
            .0
            .acc
    };
    // Set with `acc` 0 and stepped once: 256, then 512, 768 -> insert (85 left), 341, 597.
    assert_eq!(acc(&s), 256);
    s.step_ticks(4);
    assert_eq!(acc(&s), 597);
    assert_eq!(items(&s, l0).len(), 1, "one insert so far");
    let destroyed = belts_destroyed_items();

    s.rotate_belt(P1, p).unwrap();
    assert_eq!(lanes(&s, p), [l0, l1], "the same lines");
    assert_eq!(items(&s, l0).len(), 1, "the item kept, no insert at 853");
    assert_eq!(acc(&s), 256, "restarted at 0, stepped once");
    assert_eq!(belts_destroyed_items(), destroyed, "nothing destroyed");
    s.step_ticks(1);
    assert_eq!(items(&s, l0).len(), 1, "512: none yet");
    s.step_ticks(1);
    assert_eq!(items(&s, l0).len(), 2, "768: one period after the rotation");
    s.assert_topology();
}
