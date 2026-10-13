//! Belt topology with items on the lines (M52 Tests added): a reshape keeps them (rescale), a
//! rotation and a pick-up destroy the tile's (Tyler's question 10 default; README Placement). Items
//! reach a line only through the `test-hooks` action `TestInsertItem` until M53's spawners, so this
//! file builds only with the feature: `cargo nextest run -p reference-sim --features test-hooks
//! --test topology_items`.
#![cfg(feature = "test-hooks")]

mod common;

use common::RefScenario;
use engine::game::PlayerId;
use engine::transport::LineId;
use engine::world::TilePos;
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

/// A rotation re-creates the tile's lines and destroys its items (question 10's default); a pick-up
/// destroys the lines and items with the belt. Fails if a rotation keeps a line (its items would sit
/// on lanes facing the old way) or a pick-up leaves one.
#[test]
fn topology_rotate_destroys_items() {
    let mut s = world();
    let p = TilePos::new(50, 50);
    put(&mut s, p, Dir::East);
    let before = lanes(&s, p);
    insert(&mut s, p, 0, 0, 7);
    insert(&mut s, p, 1, 128, 8);
    assert_eq!(items(&s, before[0]), [(7, 0)]);
    assert_eq!(items(&s, before[1]), [(8, 104)], "128, moved one tick");

    s.rotate_belt(P1, p).unwrap();
    let after = lanes(&s, p);
    assert_eq!(after, [LineId(3), LineId(4)], "re-created");
    let tr = s.read().transport();
    assert!(
        tr.len(before[0]).is_err() && tr.len(before[1]).is_err(),
        "destroyed"
    );
    assert_eq!(tr.lines_len(), 2);
    assert_eq!((items(&s, after[0]), items(&s, after[1])), (vec![], vec![]));

    insert(&mut s, p, 1, 0, 9);
    assert_eq!(items(&s, after[1]), [(9, 0)]);
    s.pick_up_belt(P1, p).unwrap();
    assert_eq!(s.read().transport().lines_len(), 0, "lines and items gone");
}
