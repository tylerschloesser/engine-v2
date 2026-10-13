//! Belt placement on the host (M51 Tests added, README "Belts", Placement): `PlaceBelt`'s trait
//! rules, `RotateBelt` and `PickUpBelt`, and 0079 §20 (b) (no reference entity changes its anchor).
//! The prediction cases are in `belt_predict.rs`.

mod common;

use std::collections::BTreeMap;

use common::RefScenario;
use engine::game::{EntityId, PlayerId};
use engine::world::{Tile, TilePos};
use reference_sim::content::{self, ItemId};
use reference_sim::rules::belts::topology::{lanes_at, shape_of};
use reference_sim::{Belt, BeltKind, BeltShape, Dir, RefEntity, RefReject, TileXY};

const P1: PlayerId = PlayerId(1);
const KINDS: [BeltKind; 3] = [BeltKind::Belt, BeltKind::Spawner, BeltKind::Despawner];

/// A player with one furnace item in a fresh world; `(40, 40)..(47, 47)` is cleared grass.
fn scenario() -> RefScenario {
    let mut s = RefScenario::new();
    s.join(P1);
    s.give(P1, ItemId::Furnace, 1);
    s.clear_area(TilePos::new(40, 40), 8, 8);
    s
}

/// Land takes a belt of every kind (straight, no spawner configuration, nothing spent); water (both
/// ids), a resource, a furnace tile and a belt tile refuse `NotBuildable` having written nothing,
/// and a furnace refuses a belt tile. Fails if `PlaceBelt` forgets `COLLECTABLE` (a resource), drops
/// the occupant term (a furnace or belt), or writes before it validates.
#[test]
fn place_belt_rules() {
    for kind in KINDS {
        let mut s = scenario();
        let inv = s.player(P1).inventory;
        let at = TilePos::new(41, 41);
        s.place_belt(P1, at, Dir::North, kind)
            .expect("land takes a belt");
        assert_eq!(
            s.belt_at(at),
            Some(Belt {
                origin: TileXY { x: 41, y: 41 },
                dir: Dir::North,
                kind,
                shape: BeltShape::Straight,
                spawn: [None, None],
                removing: false,
            }),
            "{kind:?}"
        );
        assert_eq!(s.player(P1).inventory, inv, "{kind:?}: belts are free");
        assert_eq!(s.entities().len(), 1);
        for (x, y) in [(40, 41), (42, 41), (41, 40), (41, 42)] {
            assert_eq!(s.entity_at(TilePos::new(x, y)), None, "one tile only");
        }

        // Refusals, each on its own tile.
        s.set_tile(TilePos::new(43, 41), Tile::new(content::WATER, 0, 0));
        s.set_tile(TilePos::new(44, 41), Tile::new(content::DEEP_WATER, 0, 0));
        s.set_tile(
            TilePos::new(45, 41),
            Tile::new(content::GRASS, content::IRON, 10),
        );
        s.set_tile(
            TilePos::new(46, 41),
            Tile::new(content::DIRT, content::COAL, 1),
        );
        s.place(P1, TilePos::new(43, 44)).expect("a furnace");
        let refused = [
            (43, 41, "water"),
            (44, 41, "deep water"),
            (45, 41, "iron"),
            (46, 41, "coal, one unit left"),
            (43, 44, "the furnace's anchor"),
            (44, 45, "the furnace's far corner"),
            (41, 41, "the belt"),
        ];
        for (x, y, what) in refused {
            let writes = s.writes_logged();
            let count = s.entities().len();
            assert_eq!(
                s.place_belt(P1, TilePos::new(x, y), Dir::East, kind),
                Err(RefReject::NotBuildable),
                "{kind:?} on {what}"
            );
            assert_eq!(
                s.writes_logged(),
                writes,
                "{kind:?} on {what}: nothing written"
            );
            assert_eq!(s.entities().len(), count);
        }
        // A furnace may stand on a resource but not on a belt.
        s.give(P1, ItemId::Furnace, 1);
        assert_eq!(
            s.place(P1, TilePos::new(40, 40)),
            Err(RefReject::NotBuildable)
        );
        assert_eq!(s.player(P1).inventory.get(ItemId::Furnace), 1);
        // Land next to everything still takes one.
        s.place_belt(P1, TilePos::new(42, 41), Dir::West, kind)
            .expect("the free neighbour");
    }
}

/// Four rotations cycle east, south, west, north and back, each one put of the same entity at the
/// same anchor; a rotate of an empty tile or a furnace is `NoBeltHere` and writes nothing. Fails if
/// `RotateBelt` respawns (a new id), moves the anchor, turns the wrong way or touches a furnace.
#[test]
fn rotate_keeps_entity() {
    let mut s = scenario();
    let at = TilePos::new(44, 44);
    s.place_belt(P1, at, Dir::East, BeltKind::Spawner).unwrap();
    let id = s.entity_at(at).expect("placed");
    let before = s.belt_at(at).unwrap();
    for want in [Dir::South, Dir::West, Dir::North, Dir::East] {
        let puts = s.entity_puts_logged();
        s.rotate_belt(P1, at).expect("a belt is there");
        assert_eq!(s.entity_puts_logged(), puts + 1, "one put per rotate");
        assert_eq!(s.entity_at(at), Some(id), "same entity");
        let b = s.belt_at(at).unwrap();
        assert_eq!(
            b,
            Belt {
                dir: want,
                ..before
            },
            "only the direction turns"
        );
    }
    assert_eq!(s.entities().len(), 1);

    s.place(P1, TilePos::new(40, 40)).expect("a furnace");
    for (x, y) in [(46, 46), (40, 40), (41, 41)] {
        let writes = s.writes_logged();
        assert_eq!(
            s.rotate_belt(P1, TilePos::new(x, y)),
            Err(RefReject::NoBeltHere),
            "({x},{y})"
        );
        assert_eq!(s.writes_logged(), writes);
    }
}

/// A pick-up despawns the belt and returns nothing; the tile is free again; a second pick-up, a
/// pick-up of a furnace, and the furnace actions on a belt are refused. Fails if `PickUpBelt` adds
/// to the inventory, leaves the entity, or a furnace action reads a belt as a furnace.
#[test]
fn pickup_despawns() {
    let mut s = scenario();
    let at = TilePos::new(45, 45);
    s.give(P1, ItemId::Iron, 3);
    s.place_belt(P1, at, Dir::South, BeltKind::Despawner)
        .unwrap();
    let xy = TileXY::from_tile(at);
    let writes = s.writes_logged();
    for (action, want) in [
        (
            reference_sim::RefAction::FurnaceDeposit {
                at: xy,
                item: ItemId::Iron as u8,
                count: 1,
            },
            RefReject::NoFurnaceHere,
        ),
        (
            reference_sim::RefAction::FurnaceTake { at: xy },
            RefReject::NoFurnaceHere,
        ),
        (
            reference_sim::RefAction::FurnacePickUp { at: xy },
            RefReject::NoFurnaceHere,
        ),
    ] {
        assert_eq!(s.dispatch(P1, action), Err(want), "{action:?} on a belt");
    }
    assert_eq!(s.writes_logged(), writes, "the refusals wrote nothing");

    let inv = s.player(P1).inventory;
    s.pick_up_belt(P1, at).expect("a belt is there");
    assert_eq!(s.entity_at(at), None, "despawned");
    assert!(s.entities().is_empty());
    assert_eq!(s.player(P1).inventory, inv, "nothing returned");
    assert_eq!(s.pick_up_belt(P1, at), Err(RefReject::NoBeltHere));

    s.place(P1, TilePos::new(40, 40)).expect("a furnace");
    assert_eq!(
        s.pick_up_belt(P1, TilePos::new(41, 40)),
        Err(RefReject::NoBeltHere),
        "a furnace is not a belt"
    );
    assert!(s.furnace_at(TilePos::new(40, 40)).is_some());
    s.place_belt(P1, at, Dir::North, BeltKind::Belt)
        .expect("the tile is free again");
}

/// 0079 §20 (b): over a scripted session of furnace and belt placements, rotations, pick-ups,
/// deposits and smelting, every entity's anchor at the end of every tick equals its anchor at spawn,
/// and (M52) every belt's stored shape is the one its neighbours give, curves included.
/// Fails if any rule moves an entity (a rotate that shifts the origin, a furnace put elsewhere).
#[test]
fn no_reference_entity_moves_in_a_tick() {
    let mut s = scenario();
    s.give(P1, ItemId::Furnace, 1);
    s.give(P1, ItemId::Iron, 4);
    s.give(P1, ItemId::Coal, 1);
    let mut spawned: BTreeMap<EntityId, TileXY> = BTreeMap::new();
    let curves = std::cell::Cell::new(0u32);
    let check = |s: &RefScenario, spawned: &mut BTreeMap<EntityId, TileXY>, step: &str| {
        for (id, e) in s.entities() {
            let at = e.origin();
            let first = *spawned.entry(id).or_insert(at);
            assert_eq!(at, first, "{step}: entity {id:?} moved");
            if let RefEntity::Belt(b) = e {
                assert_eq!(
                    s.entity_at(at.tile()),
                    Some(id),
                    "{step}: occupancy follows"
                );
                // M52: shapes vary; each is the one its neighbours give.
                assert_eq!(
                    Ok(b.shape),
                    shape_of(s.read(), at.tile(), b.dir),
                    "{step}: entity {id:?} shape"
                );
                assert!(!b.removing, "{step}: a removing belt outlived its tick");
                if b.shape != BeltShape::Straight {
                    curves.set(curves.get() + 1);
                }
            }
        }
    };
    let furnace = TilePos::new(46, 40);
    let belts = [
        TilePos::new(40, 40),
        TilePos::new(41, 40),
        TilePos::new(42, 40),
        TilePos::new(40, 43),
    ];
    s.place(P1, furnace).unwrap();
    check(&s, &mut spawned, "furnace placed");
    for (i, &at) in belts.iter().enumerate() {
        s.place_belt(P1, at, Dir::East, KINDS[i % 3]).unwrap();
        check(&s, &mut spawned, "belt placed");
        s.step_ticks(1);
        check(&s, &mut spawned, "tick after a placement");
    }
    s.deposit(P1, furnace, ItemId::Iron, 4).unwrap();
    s.deposit(P1, furnace, ItemId::Coal, 1).unwrap();
    for round in 0..6 {
        for &at in &belts {
            s.rotate_belt(P1, at).unwrap();
            check(&s, &mut spawned, "rotate");
        }
        if round == 3 {
            s.pick_up_belt(P1, belts[1]).unwrap();
            s.place_belt(P1, belts[1], Dir::North, BeltKind::Belt)
                .unwrap();
            check(&s, &mut spawned, "picked up and placed again");
            s.place(P1, TilePos::new(44, 44)).unwrap();
        }
        for _ in 0..40 {
            s.step_ticks(1);
            check(&s, &mut spawned, "tick");
        }
    }
    // The session did run: a smelt finished and the second furnace and the re-placed belt counted.
    assert!(
        s.furnace_at(furnace).unwrap().ingots_out > 0,
        "the furnace smelted"
    );
    assert_eq!(spawned.len(), 7, "two furnaces and five belt spawns");
    assert!(curves.get() > 0, "the rotations made curves (M52)");
    assert_eq!(s.entities().len(), 6);
}

/// Belts sleep (the furnace rule's `idle_furnaces_cost_nothing`): 1,000 belts of every kind and
/// direction, placed and rotated, cost nothing once their wakes are served: no put, no entity visit,
/// no state change over 1,000 ticks. M52: the world is mapped onto lines (its curves, side-loads and
/// runs counted), so the topology rule is what sleeps. Fails if a belt rule leaves a timer on a belt,
/// puts one from the tick (a put from the tick wakes nothing, but a wake would revisit), or keeps
/// re-mapping.
#[test]
fn idle_belts_cost_nothing() {
    let mut s = RefScenario::new();
    s.join(P1);
    s.clear_area(TilePos::new(40, 40), 40, 25);
    let dirs = [Dir::East, Dir::South, Dir::West, Dir::North];
    for i in 0..1_000 {
        let at = TilePos::new(40 + i % 40, 40 + i / 40);
        s.place_belt(P1, at, dirs[(i % 4) as usize], KINDS[(i % 3) as usize])
            .expect("free ground");
        if i % 7 == 0 {
            s.rotate_belt(P1, at).unwrap();
        }
    }
    assert_eq!(s.entities().len(), 1_000);
    s.step_ticks(2); // the last action's wake is served and finds nothing to do.

    // M52: the world is mapped, with curves, side-loads and runs (every belt's lanes indexed).
    s.assert_topology();
    let (mut curves, mut merges, mut runs) = (0, 0, 0);
    for (_, e) in s.entities() {
        let b = e.as_belt().copied().expect("belts only");
        let tr = s.read().transport();
        let m = lanes_at(tr, b.origin.tile()).expect("every belt is mapped");
        curves += usize::from(b.shape != BeltShape::Straight);
        runs += usize::from(m.off > 0);
        if m.off == 0 {
            merges += m
                .lane
                .iter()
                .filter(|&&l| matches!(tr.out(l), Ok(engine::transport::Output::Merge { .. })))
                .count();
        }
    }
    assert_eq!(
        (curves, merges, runs, s.read().transport().lines_len()),
        (108, 778, 376, 1248),
        "curves, side-loading lanes, belts inside a run, lines"
    );

    let writes = s.writes_logged();
    let hash = s.hash();
    let mut max_visited = 0;
    for _ in 0..1_000 {
        s.step_ticks(1);
        max_visited = max_visited.max(s.visited_last_tick());
    }
    assert_eq!(s.writes_logged(), writes, "puts over 1,000 idle ticks");
    assert_eq!(max_visited, 0, "entities visited over 1,000 idle ticks");
    assert_eq!(s.hash(), hash, "state hash over 1,000 idle ticks");
}
