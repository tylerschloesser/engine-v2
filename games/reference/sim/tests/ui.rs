//! `ui_in_range_lists_each_resource_once`/`ui_from_is_within_range_of_its_tile` (docs/plan/
//! 20b-reference-player-and-collect-ui.md Tests added, step 3): `RefClient::ui`'s own bounding-box
//! scan + tracked-set diff, driven directly (never through `FrameCx`, `extract_golden.rs`'s own
//! precedent: `FrameCx::new` is `pub(crate)` to the engine crate).

use std::collections::BTreeMap;

use engine::client::{ClientSide, FrameView, RemotePresences};
use engine::game::{PlayerId, Unknown, WorldRead};
use engine::world::{Registry, Tile, TilePos, TileRect, TraitSet};
use reference_sim::{RefClient, RefEntity, RefGame, RefGlobal, RefPlayer};

/// A tiny fixed world: a stone tile at `(1, 0)` (within `RANGE` of the origin), an iron tile at
/// `(10, 10)` (far outside it), everything else void/grass (no resource).
struct StubWorld {
    player: RefPlayer,
}

impl WorldRead<RefGame> for StubWorld {
    fn tick(&self) -> engine::time::Tick {
        engine::time::Tick(0)
    }
    fn tile(&self, p: TilePos) -> Result<Tile, Unknown> {
        if p == TilePos::new(1, 0) {
            Ok(Tile::new(0, reference_sim_content_stone(), 10))
        } else if p == TilePos::new(10, 10) {
            Ok(Tile::new(0, reference_sim_content_iron(), 10))
        } else {
            Ok(Tile::new(0, 0, 0))
        }
    }
    fn traits_at(&self, _p: TilePos) -> Result<TraitSet, Unknown> {
        Ok(TraitSet(0))
    }
    fn entity_at(&self, _p: TilePos) -> Result<Option<engine::game::EntityId>, Unknown> {
        Ok(None)
    }
    fn entity(&self, _id: engine::game::EntityId) -> Result<Option<&RefEntity>, Unknown> {
        Ok(None)
    }
    fn player(&self, _who: PlayerId) -> Result<&RefPlayer, Unknown> {
        Ok(&self.player)
    }
    fn global(&self) -> &RefGlobal {
        &RefGlobal
    }
}

// `content::{STONE, IRON}` are private to `reference_sim` (a game-internal id, not part of its
// public surface) -- these two free functions read them back out through the crate's own public
// `TileXY`/`WorldXY`-shaped surface is not an option (ids aren't exposed there either), so this
// test crate re-derives the same numbers `content.rs` documents instead of depending on a
// non-`pub` item across the crate boundary.
fn reference_sim_content_stone() -> u8 {
    22
}
fn reference_sim_content_iron() -> u8 {
    16
}

fn view<'a>(
    world: &'a StubWorld,
    entities: &'a BTreeMap<engine::game::EntityId, RefEntity>,
    registry: &'a Registry,
    remote: &'a RemotePresences<RefGame>,
) -> FrameView<'a, RefGame> {
    FrameView::new(
        world as &dyn WorldRead<RefGame>,
        Default::default(),
        PlayerId(1),
        entities,
        registry,
        TileRect::new(TilePos::new(-20, -20), TilePos::new(20, 20)),
        20.0,
        40.0,
        None,
        TilePos::new(0, 0),
        0.0,
        reference_sim::PlayerPresence::default(),
        remote,
    )
}

#[test]
fn ui_in_range_lists_each_resource_once() {
    // Player standing at the origin: `(1, 0)`'s stone tile is well within `RANGE` (3 tiles); the
    // far iron tile at `(10, 10)` is not.
    let client = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    let world = StubWorld {
        player: RefPlayer::default(),
    };
    let entities = BTreeMap::new();
    let registry = Registry::new();
    let remote = RemotePresences::<RefGame>::new();
    let v = view(&world, &entities, &registry, &remote);
    let mut out = reference_sim::RefUi::default();
    client.ui(&v, &mut out);

    assert_eq!(out.in_range.len(), 1, "only the near tile is in range");
    let entry = out.in_range[0];
    assert_eq!(entry.tile.x, 1);
    assert_eq!(entry.tile.y, 0);
    assert_eq!(entry.resource, reference_sim_content_stone());

    // Calling `ui` again with the player unmoved must not duplicate the entry.
    let mut out2 = reference_sim::RefUi::default();
    client.ui(&v, &mut out2);
    assert_eq!(out2.in_range.len(), 1, "still exactly one entry, not two");
}

#[test]
fn ui_from_is_within_range_of_its_tile() {
    let client = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    let world = StubWorld {
        player: RefPlayer::default(),
    };
    let entities = BTreeMap::new();
    let registry = Registry::new();
    let remote = RemotePresences::<RefGame>::new();
    let v = view(&world, &entities, &registry, &remote);
    let mut out = reference_sim::RefUi::default();
    client.ui(&v, &mut out);

    assert_eq!(out.in_range.len(), 1);
    let entry = out.in_range[0];
    // `from`, in Q24.8 raw units, must be within `RANGE_Q8` of the tile's own centre -- exactly the
    // invariant `admit`'s tolerance relies on (Planning decisions "Where `from` comes from").
    let tile_centre_x = entry.tile.x * 256 + 128;
    let tile_centre_y = entry.tile.y * 256 + 128;
    let dx = (entry.from.x - tile_centre_x) as i64;
    let dy = (entry.from.y - tile_centre_y) as i64;
    let dist_sq = dx * dx + dy * dy;
    let range = 3_i64 * 256;
    assert!(
        dist_sq <= range * range,
        "from ({}, {}) is farther than RANGE from tile centre ({}, {})",
        entry.from.x,
        entry.from.y,
        tile_centre_x,
        tile_centre_y
    );
}

/// Every tile inside the scanned square (`-content::RANGE_SCAN_TILES..=RANGE_SCAN_TILES` per axis)
/// carries a resource -- the orchestrator fix's own test (docs/plan/
/// 20b-reference-player-and-collect-ui.md, step 1: "`RefClient::ui()` silently drops any in-range
/// resource past `MAX_IN_RANGE`"): with every scanned tile a candidate, `MAX_IN_RANGE` sized to the
/// scan's own tile count means none of them can be truncated.
struct AllResourceWorld {
    player: RefPlayer,
}

impl WorldRead<RefGame> for AllResourceWorld {
    fn tick(&self) -> engine::time::Tick {
        engine::time::Tick(0)
    }
    fn tile(&self, _p: TilePos) -> Result<Tile, Unknown> {
        Ok(Tile::new(0, reference_sim_content_stone(), 10))
    }
    fn traits_at(&self, _p: TilePos) -> Result<TraitSet, Unknown> {
        Ok(TraitSet(0))
    }
    fn entity_at(&self, _p: TilePos) -> Result<Option<engine::game::EntityId>, Unknown> {
        Ok(None)
    }
    fn entity(&self, _id: engine::game::EntityId) -> Result<Option<&RefEntity>, Unknown> {
        Ok(None)
    }
    fn player(&self, _who: PlayerId) -> Result<&RefPlayer, Unknown> {
        Ok(&self.player)
    }
    fn global(&self) -> &RefGlobal {
        &RefGlobal
    }
}

fn view_all<'a>(
    world: &'a AllResourceWorld,
    entities: &'a BTreeMap<engine::game::EntityId, RefEntity>,
    registry: &'a Registry,
    remote: &'a RemotePresences<RefGame>,
) -> FrameView<'a, RefGame> {
    FrameView::new(
        world as &dyn WorldRead<RefGame>,
        Default::default(),
        PlayerId(1),
        entities,
        registry,
        TileRect::new(TilePos::new(-20, -20), TilePos::new(20, 20)),
        20.0,
        40.0,
        None,
        TilePos::new(0, 0),
        0.0,
        reference_sim::PlayerPresence::default(),
        remote,
    )
}

#[test]
fn ui_in_range_fills_every_tile_in_range_without_truncation() {
    // The player sits exactly at a tile corner (`(0, 0)` in Q24.8 raw units): the one `from`
    // position that puts the most tile centres within `RANGE_Q8` at once (found by exhaustive
    // search over sub-tile offsets in this milestone's own delegation -- 32 of the scanned square's
    // 81 tiles for `RANGE_Q8 = 3` tiles), so this test exercises the real worst case, not merely a
    // typical one.
    let client = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    let world = AllResourceWorld {
        player: RefPlayer::default(),
    };
    let entities = BTreeMap::new();
    let registry = Registry::new();
    let remote = RemotePresences::<RefGame>::new();
    let v = view_all(&world, &entities, &registry, &remote);
    let mut out = reference_sim::RefUi::default();
    client.ui(&v, &mut out);

    // Independently recomputes "how many in-range tiles this exact scan should find" from the same
    // `in_range` function `apply`/`RefClient::ui` both call (Provides), rather than hard-coding the
    // number -- a change to `RANGE_Q8` or the scan's own bounding box keeps this test meaningful
    // instead of silently pinning today's constant.
    let from = engine::world::WorldPos { x: 0, y: 0 };
    let range_tiles = reference_sim::content::RANGE_SCAN_TILES;
    let mut expected = 0usize;
    for dy in -range_tiles..=range_tiles {
        for dx in -range_tiles..=range_tiles {
            if reference_sim::rules::collect::in_range(from, TilePos::new(dx, dy)) {
                expected += 1;
            }
        }
    }
    assert!(
        expected > 16,
        "the worst case should exceed the old MAX_IN_RANGE of 16"
    );
    assert_eq!(
        out.in_range.len(),
        expected,
        "every in-range tile must be reported -- none silently dropped past a too-small cap"
    );
}

#[test]
fn ui_reads_inventory_and_collecting_from_player() {
    let client = RefClient::with_spring_state([0.0, 0.0], [0.0, 0.0]);
    let mut player = RefPlayer::default();
    player.inventory.stone = 3;
    player.collecting = Some(reference_sim::Collecting {
        tile: reference_sim::TileXY { x: 1, y: 0 },
        done_at: engine::time::Tick(42),
    });
    let world = StubWorld { player };
    let entities = BTreeMap::new();
    let registry = Registry::new();
    let remote = RemotePresences::<RefGame>::new();
    let v = view(&world, &entities, &registry, &remote);
    let mut out = reference_sim::RefUi::default();
    client.ui(&v, &mut out);

    assert_eq!(out.me, 1);
    assert_eq!(out.inventory.stone, 3);
    let collecting = out.collecting.expect("collecting must be Some");
    assert_eq!(collecting.tile.x, 1);
    assert_eq!(collecting.done_at, 42);
}
