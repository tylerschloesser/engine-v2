//! Collect rules (docs/plan/20-reference-game-v0.md Tests added). Uses `common::RefScenario`
//! throughout.

mod common;

use common::RefScenario;
use engine::game::PlayerId;
use engine::world::{Tile, TilePos, WorldPos};
use reference_sim::rules::collect::in_range;
use reference_sim::{RefAction, RefReject, WorldXY, content};

const P1: PlayerId = PlayerId(1);
const P2: PlayerId = PlayerId(2);

/// The iron tile at `(0, 0)` for `TEST_SEED` (`tests/fixtures/landmarks.json`), the closest
/// resource to the origin -- a witness `from` placed at the tile's own centre is always in range
/// regardless of `RANGE_Q8`'s exact value.
fn iron_tile() -> TilePos {
    TilePos::new(0, 0)
}

fn centre_of(tile: TilePos) -> WorldXY {
    let c = WorldPos::from_tile(tile);
    WorldXY {
        x: c.x + 128,
        y: c.y + 128,
    }
}

#[test]
fn collect_completes_and_depletes() {
    let mut s = RefScenario::new();
    s.join(P1);
    let tile = iron_tile();
    s.dispatch(
        P1,
        RefAction::StartCollect {
            tile: reference_sim::TileXY::from_tile(tile),
            from: centre_of(tile),
        },
    )
    .expect("in range, resource present, not busy");

    s.step_ticks(content::COLLECT.0);

    let player = s.player(P1);
    assert!(
        player.collecting.is_none(),
        "collect finished, timer clears"
    );
    assert_eq!(player.inventory.iron, 1);
    let t = s.tile(tile);
    assert_eq!(t.resource(), content::IRON);
    assert_eq!(t.aux(), content::UNITS_PER_TILE - 1);
}

/// A test for the boundary must actually be able to fail both ways: exactly `RANGE` is accepted,
/// one Q24.8 unit past it is rejected (orchestrator ruling).
#[test]
fn collect_out_of_range_rejected() {
    let tile = iron_tile();
    let centre = WorldPos::from_tile(tile);
    let at_range = WorldXY {
        x: centre.x + 128 + content::RANGE_Q8,
        y: centre.y + 128,
    };
    let one_past = WorldXY {
        x: centre.x + 128 + content::RANGE_Q8 + 1,
        y: centre.y + 128,
    };

    let mut accepted = RefScenario::new();
    accepted.join(P1);
    assert_eq!(
        accepted.dispatch(
            P1,
            RefAction::StartCollect {
                tile: reference_sim::TileXY::from_tile(tile),
                from: at_range,
            },
        ),
        Ok(()),
        "exactly RANGE away must be accepted (<=, not <)"
    );

    let mut rejected = RefScenario::new();
    rejected.join(P1);
    assert_eq!(
        rejected.dispatch(
            P1,
            RefAction::StartCollect {
                tile: reference_sim::TileXY::from_tile(tile),
                from: one_past,
            },
        ),
        Err(RefReject::OutOfRange),
        "one Q24.8 unit past RANGE must be rejected"
    );
}

#[test]
fn collect_busy_rejected() {
    let mut s = RefScenario::new();
    s.join(P1);
    let tile = iron_tile();
    s.dispatch(
        P1,
        RefAction::StartCollect {
            tile: reference_sim::TileXY::from_tile(tile),
            from: centre_of(tile),
        },
    )
    .unwrap();
    let result = s.dispatch(
        P1,
        RefAction::StartCollect {
            tile: reference_sim::TileXY::from_tile(tile),
            from: centre_of(tile),
        },
    );
    assert_eq!(result, Err(RefReject::Busy));
}

/// A near-depleted tile (`aux = 1`, set directly rather than waiting nine real collects) loses its
/// resource id *and* its `aux` together once the last unit is taken -- "overlay is canonical": no
/// leftover non-zero `aux` on a resource-less tile (a fresh `set_tile` with a stray `aux` would
/// still pass a test that only checked `resource() == 0`, which is why both are asserted).
#[test]
fn collect_last_unit_clears_resource_and_overlay_is_canonical() {
    let mut s = RefScenario::new();
    s.join(P1);
    let tile = iron_tile();
    let base = s.tile(tile).base();
    s.set_tile(tile, Tile::new(base, content::IRON, 1));

    s.dispatch(
        P1,
        RefAction::StartCollect {
            tile: reference_sim::TileXY::from_tile(tile),
            from: centre_of(tile),
        },
    )
    .unwrap();
    s.step_ticks(content::COLLECT.0);

    let t = s.tile(tile);
    assert_eq!(t.resource(), 0, "resource id cleared at zero");
    assert_eq!(t.aux(), 0, "aux cleared alongside it, not left dangling");
    assert_eq!(s.player(P1).inventory.iron, 1, "the last unit still counts");
}

/// Two players racing the same tile's last unit: the second finisher gets nothing (Planning
/// decisions "Collects are not reservations"; `0003` Consequences). Both `apply` before the tile is
/// touched (so both are admitted -- a reservation scheme would instead reject the second `apply`
/// outright, which this test would still pass under, so it also checks the first player *did* get
/// the item, proving the second's empty hands are the race, not a blanket rejection).
#[test]
fn collect_second_finisher_gets_nothing() {
    let mut s = RefScenario::new();
    s.join(P1);
    s.join(P2);
    let tile = iron_tile();
    let base = s.tile(tile).base();
    s.set_tile(tile, Tile::new(base, content::IRON, 1));

    s.dispatch(
        P1,
        RefAction::StartCollect {
            tile: reference_sim::TileXY::from_tile(tile),
            from: centre_of(tile),
        },
    )
    .unwrap();
    s.dispatch(
        P2,
        RefAction::StartCollect {
            tile: reference_sim::TileXY::from_tile(tile),
            from: centre_of(tile),
        },
    )
    .unwrap();

    s.step_ticks(content::COLLECT.0);

    assert_eq!(
        s.player(P1).inventory.iron,
        1,
        "first finisher gets the last unit"
    );
    assert_eq!(
        s.player(P2).inventory.iron,
        0,
        "second finisher gets nothing"
    );
    assert!(s.player(P1).collecting.is_none());
    assert!(s.player(P2).collecting.is_none());
}

#[test]
fn cancel_collect_clears_timer() {
    let mut s = RefScenario::new();
    s.join(P1);
    let tile = iron_tile();
    s.dispatch(
        P1,
        RefAction::StartCollect {
            tile: reference_sim::TileXY::from_tile(tile),
            from: centre_of(tile),
        },
    )
    .unwrap();
    assert!(s.player(P1).collecting.is_some());

    s.dispatch(P1, RefAction::CancelCollect).unwrap();
    assert!(s.player(P1).collecting.is_none());

    s.step_ticks(content::COLLECT.0 + 5);
    assert_eq!(
        s.player(P1).inventory.iron,
        0,
        "cancelled collect never completes"
    );
}

#[test]
fn durations_at_20_and_30_hz() {
    use engine::time::{TickRate, Ticks};
    assert_eq!(content::collect_ticks(TickRate::hz(20)), Ticks(40));
    assert_eq!(content::collect_ticks(TickRate::hz(30)), Ticks(60));
}

#[test]
fn replay_equals_live_hash() {
    let mut live = RefScenario::new();
    live.join(P1);
    let tile = iron_tile();
    live.dispatch(
        P1,
        RefAction::StartCollect {
            tile: reference_sim::TileXY::from_tile(tile),
            from: centre_of(tile),
        },
    )
    .unwrap();
    live.step_ticks(content::COLLECT.0);
    let live_hash = live.hash();

    let mut replay = RefScenario::new();
    replay.join(P1);
    replay
        .dispatch(
            P1,
            RefAction::StartCollect {
                tile: reference_sim::TileXY::from_tile(tile),
                from: centre_of(tile),
            },
        )
        .unwrap();
    replay.step_ticks(content::COLLECT.0);
    assert_eq!(live_hash, replay.hash());
}

/// `in_range`'s own boundary, exercised directly (not just through `apply`): exactly `RANGE`
/// accepts, one Q24.8 unit further rejects.
#[test]
fn in_range_boundary_is_inclusive() {
    let tile = TilePos::new(5, 5);
    let centre = WorldPos::from_tile(tile);
    let at_range = WorldPos {
        x: centre.x + 128 + content::RANGE_Q8,
        y: centre.y + 128,
    };
    let one_past = WorldPos {
        x: centre.x + 128 + content::RANGE_Q8 + 1,
        y: centre.y + 128,
    };
    assert!(in_range(at_range, tile));
    assert!(!in_range(one_past, tile));
}
