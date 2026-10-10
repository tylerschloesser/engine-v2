//! R1 (Tyler, 2026-10-10; docs/plan/39ai-tyler-answers.md): a furnace may stand on a resource tile;
//! the covered resource cannot be collected until the furnace is picked up, and then it is
//! collectable again with its remaining units. The covered state is derived from the furnace's
//! footprint (`content::COVERS_RESOURCE` on the furnace prototype, read through `traits_at`), never
//! stored, so it is right after a save-load and after a pick-up with no bookkeeping.

mod common;

use common::RefScenario;
use engine::game::PlayerId;
use engine::world::{Tile, TilePos, WorldPos};
use reference_sim::content::{self, ItemId};
use reference_sim::{RefAction, RefReject, TileXY, WorldXY};

const P1: PlayerId = PlayerId(1);
const ORIGIN: TilePos = TilePos::new(43, 43);
/// The resource tile under the furnace's footprint (the furnace covers (43,43)..=(44,44)).
const COVERED: TilePos = TilePos::new(44, 44);

fn centre_of(tile: TilePos) -> WorldXY {
    let c = WorldPos::from_tile(tile);
    WorldXY {
        x: c.x + 128,
        y: c.y + 128,
    }
}

fn start(s: &mut RefScenario, tile: TilePos) -> Result<(), RefReject> {
    s.dispatch(
        P1,
        RefAction::StartCollect {
            tile: TileXY::from_tile(tile),
            from: centre_of(tile),
        },
    )
}

/// A world with a furnace item in hand and a resource (`units` left) at [`COVERED`].
fn world(resource: u8, units: u16) -> RefScenario {
    let mut s = RefScenario::new();
    s.join(P1);
    s.clear_area(TilePos::new(40, 40), 8, 8);
    s.set_tile(COVERED, Tile::new(content::GRASS, resource, units));
    s.give(P1, ItemId::Furnace, 1);
    s
}

#[test]
fn place_over_resource_confirmed() {
    for resource in [content::IRON, content::WOOD, content::STONE, content::COAL] {
        let mut s = world(resource, content::UNITS_PER_TILE);
        assert_eq!(s.place(P1, ORIGIN), Ok(()), "resource {resource}");
        assert_eq!(s.furnace_count(), 1);
        assert_eq!(s.player(P1).inventory.get(ItemId::Furnace), 0);
    }
}

#[test]
fn covered_resource_refuses_start_collect() {
    let mut s = world(content::IRON, content::UNITS_PER_TILE);
    // Collectable before the furnace goes down.
    assert_eq!(start(&mut s, COVERED), Ok(()));
    s.dispatch(P1, RefAction::CancelCollect).unwrap();
    s.place(P1, ORIGIN).unwrap();
    assert_eq!(
        start(&mut s, COVERED),
        Err(RefReject::NoResource),
        "covered: no resource to collect"
    );
    assert!(s.player(P1).collecting.is_none());
}

#[test]
fn collectable_again_after_pick_up_with_units_intact() {
    let mut s = world(content::IRON, 7);
    s.place(P1, ORIGIN).unwrap();
    s.step_ticks(30);
    assert_eq!(
        s.tile(COVERED).aux(),
        7,
        "the furnace does not touch the units"
    );
    s.pick_up(P1, ORIGIN).unwrap();
    assert_eq!(s.furnace_count(), 0);
    assert_eq!(start(&mut s, COVERED), Ok(()));
    s.step_ticks(content::COLLECT.0);
    assert_eq!(s.player(P1).inventory.get(ItemId::Iron), 1);
    assert_eq!(s.tile(COVERED).aux(), 6, "7 units, one collected");
}

#[test]
fn a_collect_in_flight_ends_empty_when_a_furnace_lands_on_it() {
    let mut s = world(content::IRON, 7);
    start(&mut s, COVERED).unwrap();
    s.place(P1, ORIGIN).unwrap();
    s.step_ticks(content::COLLECT.0 + 1);
    assert!(s.player(P1).collecting.is_none(), "the collect ended");
    assert_eq!(s.player(P1).inventory.get(ItemId::Iron), 0, "no item");
    assert_eq!(s.tile(COVERED).aux(), 7, "no depletion");
}

#[test]
fn covered_state_survives_save_and_load() {
    let mut s = world(content::IRON, 7);
    s.place(P1, ORIGIN).unwrap();
    let before = s.hash();
    s.save_and_load();
    assert_eq!(s.hash(), before, "the restored world hashes the same");
    assert_eq!(s.furnace_count(), 1);
    assert_eq!(
        start(&mut s, COVERED),
        Err(RefReject::NoResource),
        "still covered"
    );
    s.pick_up(P1, ORIGIN).unwrap();
    s.save_and_load();
    assert_eq!(
        start(&mut s, COVERED),
        Ok(()),
        "collectable after pick-up and load"
    );
    s.step_ticks(content::COLLECT.0);
    assert_eq!(s.tile(COVERED).aux(), 6);
}
