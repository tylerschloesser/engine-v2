//! Furnace placement rules (docs/plan/33-reference-furnace.md Tests added). The prediction cases
//! are in `place_predict.rs`.

mod common;

use common::RefScenario;
use engine::game::{PlayerId, Unknown, WorldRead};
use engine::world::{Registry, Tile, TilePos, TileRect, TraitSet};
use reference_sim::content::{self, ItemId};
use reference_sim::rules::place::can_place;
use reference_sim::{RefAction, RefEntity, RefGame, RefReject};

const P1: PlayerId = PlayerId(1);

/// A player holding one furnace item, standing in a fresh world; `(40, 40)..(47, 47)` is cleared.
fn scenario() -> RefScenario {
    let mut s = RefScenario::new();
    s.join(P1);
    s.give(P1, ItemId::Furnace, 1);
    s.clear_area(TilePos::new(40, 40), 8, 8);
    s
}

#[test]
fn place_ok_consumes_item_and_occupies_four_tiles() {
    let mut s = scenario();
    let origin = TilePos::new(42, 42);
    s.place(P1, origin).expect("free ground, has the item");
    assert_eq!(s.player(P1).inventory.get(ItemId::Furnace), 0);
    let id = s.entity_at(origin).expect("anchor tile occupied");
    for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
        assert_eq!(
            s.entity_at(TilePos::new(42 + dx, 42 + dy)),
            Some(id),
            "footprint tile ({dx},{dy}) holds the same furnace"
        );
    }
    for (x, y) in [(41, 42), (44, 42), (42, 41), (42, 44), (41, 41), (44, 44)] {
        assert_eq!(
            s.entity_at(TilePos::new(x, y)),
            None,
            "({x},{y}) is outside"
        );
    }
    assert_eq!(s.furnace_count(), 1);
}

#[test]
fn place_on_water_rejected() {
    // Each footprint tile in turn, both water ids: the far corner must refuse as well as the anchor.
    for base in [content::WATER, content::DEEP_WATER] {
        for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            let mut s = scenario();
            s.set_tile(TilePos::new(42 + dx, 42 + dy), Tile::new(base, 0, 0));
            assert_eq!(
                s.place(P1, TilePos::new(42, 42)),
                Err(RefReject::NotBuildable),
                "base {base}, tile ({dx},{dy})"
            );
            assert_eq!(s.player(P1).inventory.get(ItemId::Furnace), 1);
            assert_eq!(s.furnace_count(), 0);
        }
    }
}

#[test]
fn place_overlapping_furnace_rejected() {
    // All nine offsets at which two 2x2 footprints overlap, plus the four nearest non-overlapping
    // ones (the test must be able to fail both ways).
    for dy in -2i32..=2 {
        for dx in -2i32..=2 {
            let mut s = scenario();
            s.give(P1, ItemId::Furnace, 1);
            s.place(P1, TilePos::new(43, 43)).expect("first furnace");
            let second = s.place(P1, TilePos::new(43 + dx, 43 + dy));
            if dx.abs() <= 1 && dy.abs() <= 1 {
                assert_eq!(second, Err(RefReject::NotBuildable), "offset ({dx},{dy})");
                assert_eq!(s.furnace_count(), 1);
                assert_eq!(s.player(P1).inventory.get(ItemId::Furnace), 1);
            } else {
                assert_eq!(second, Ok(()), "offset ({dx},{dy}) only touches");
                assert_eq!(s.furnace_count(), 2);
            }
        }
    }
}

#[test]
fn place_without_item_rejected() {
    let mut s = RefScenario::new();
    s.join(P1);
    s.clear_area(TilePos::new(40, 40), 4, 4);
    assert_eq!(s.place(P1, TilePos::new(41, 41)), Err(RefReject::NoFurnace));
    assert_eq!(s.furnace_count(), 0);
}

/// A rejected placement leaves the world byte-for-byte as a no-write action would (the hash covers
/// per-action bookkeeping, so the twin dispatches `CancelCollect`, as `rejected_craft_wrote_nothing`
/// does). Both rejection reasons; fails if `place_furnace` spawns or puts before validating.
#[test]
fn rejected_place_wrote_nothing() {
    let origin = TilePos::new(42, 42);

    // NotBuildable: has the item, one footprint tile is water.
    let mut blocked = scenario();
    let mut twin = scenario();
    for w in [&mut blocked, &mut twin] {
        w.set_tile(TilePos::new(43, 43), Tile::new(content::WATER, 0, 0));
    }
    assert_eq!(blocked.place(P1, origin), Err(RefReject::NotBuildable));
    twin.dispatch(P1, RefAction::CancelCollect).unwrap();
    assert_eq!(
        blocked.hash(),
        twin.hash(),
        "blocked rejection wrote something"
    );
    assert_eq!(blocked.furnace_count(), 0);

    // NoFurnace: free ground, no item.
    let fresh = || {
        let mut s = RefScenario::new();
        s.join(P1);
        s.clear_area(TilePos::new(40, 40), 8, 8);
        s
    };
    let mut no_item = fresh();
    let mut twin = fresh();
    assert_eq!(no_item.place(P1, origin), Err(RefReject::NoFurnace));
    twin.dispatch(P1, RefAction::CancelCollect).unwrap();
    assert_eq!(
        no_item.hash(),
        twin.hash(),
        "no-item rejection wrote something"
    );
    assert_eq!(no_item.furnace_count(), 0);
}

/// `origin` at local (31, 31) of chunk (0, 0) (`CHUNK_BITS` = 5): the footprint covers one tile in
/// each of four chunks, and every one of them must answer `entity_at`.
#[test]
fn place_across_chunk_corner_sets_occupancy_in_four_chunks() {
    let mut s = RefScenario::new();
    s.join(P1);
    s.give(P1, ItemId::Furnace, 1);
    s.clear_area(TilePos::new(31, 31), 2, 2);
    s.place(P1, TilePos::new(31, 31)).expect("free ground");
    let id = s.entity_at(TilePos::new(31, 31)).expect("chunk (0,0)");
    for p in [(32, 31), (31, 32), (32, 32)] {
        assert_eq!(
            s.entity_at(TilePos::new(p.0, p.1)),
            Some(id),
            "tile {p:?} in another chunk"
        );
    }
    assert_eq!(s.entity_at(TilePos::new(33, 32)), None);
    assert_eq!(s.furnace_count(), 1);
}

/// A `WorldRead` whose only terrain is a scratch base id registered (in this test) as
/// `NOT_BUILDABLE`; everything else is plain grass.
struct ScratchWorld {
    registry: Registry,
    scratch_at: TilePos,
}

const SCRATCH_BASE: u8 = 200;

impl WorldRead<RefGame> for ScratchWorld {
    fn tick(&self) -> engine::time::Tick {
        engine::time::Tick(0)
    }
    fn tile(&self, p: TilePos) -> Result<Tile, Unknown> {
        let base = if p == self.scratch_at {
            SCRATCH_BASE
        } else {
            content::GRASS
        };
        Ok(Tile::new(base, 0, 0))
    }
    fn traits_at(&self, p: TilePos) -> Result<TraitSet, Unknown> {
        Ok(self.registry.tile_traits(self.tile(p)?))
    }
    fn entity_at(&self, _p: TilePos) -> Result<Option<engine::game::EntityId>, Unknown> {
        Ok(None)
    }
    fn entity(&self, _id: engine::game::EntityId) -> Result<Option<&RefEntity>, Unknown> {
        Ok(None)
    }
    fn player(&self, _who: PlayerId) -> Result<&reference_sim::RefPlayer, Unknown> {
        Err(Unknown)
    }
    fn global(&self) -> &reference_sim::RefGlobal {
        &reference_sim::RefGlobal::EMPTY
    }
    fn entities_in(
        &self,
        _rect: TileRect,
        _f: &mut dyn FnMut(engine::game::EntityId, &RefEntity),
    ) -> Result<(), Unknown> {
        Ok(())
    }
}

/// `can_place` refuses a terrain it has never heard of, because the tile table says `NOT_BUILDABLE`:
/// no rule change. Fails if `can_place` tests a base id (water) instead of asking `traits_at`.
#[test]
fn can_place_names_no_tile_type() {
    let mut registry = Registry::new();
    registry.set_base_traits(SCRATCH_BASE, content::NOT_BUILDABLE);
    let world = ScratchWorld {
        registry,
        scratch_at: TilePos::new(11, 11),
    };
    // The scratch tile is any of the four footprint tiles of an origin at (10, 10).
    assert_eq!(can_place(&world, TilePos::new(10, 10)), Ok(false));
    assert_eq!(can_place(&world, TilePos::new(11, 11)), Ok(false));
    assert_eq!(can_place(&world, TilePos::new(11, 10)), Ok(false));
    assert_eq!(can_place(&world, TilePos::new(10, 11)), Ok(false));
    assert_eq!(can_place(&world, TilePos::new(12, 11)), Ok(true));
    assert_eq!(
        can_place(&world, TilePos::new(9, 9)),
        Ok(true),
        "covers (9..=10)"
    );
}

/// The tiles `tests/helpers/game.ts::PLACE` hard-codes for the browser placement specs, against the
/// real worldgen at `TEST_SEED` (no `clear_area`): a free 2x2, a shore pair whose footprints differ
/// by one water tile, and an origin over the iron at (0, 0). Fails if worldgen or a rule drifts.
#[test]
fn browser_fixture_tiles_hold() {
    let cases = [
        ((-4, -1), true), // free
        ((1, -1), true),  // shoreOk
        ((2, -1), false), // shoreWater: (3, 0) is water
        ((0, -1), true),  // overIron: covers (0, 0); a furnace may stand on a resource (R1)
    ];
    for ((x, y), ok) in cases {
        let mut s = RefScenario::new();
        s.join(P1);
        s.give(P1, ItemId::Furnace, 1);
        let r = s.place(P1, TilePos::new(x, y));
        assert_eq!(r.is_ok(), ok, "origin ({x}, {y}): {r:?}");
    }
}
