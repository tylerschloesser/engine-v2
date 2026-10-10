//! Crafting rules (M32 Tests added). `common::RefScenario` throughout.

mod common;

use common::RefScenario;
use engine::game::{Game as _, PlayerId};
use engine::time::{TickRate, Ticks};
use engine::world::{TilePos, WorldPos};
use reference_sim::content::{ItemId, RECIPE_FURNACE, RECIPES};
use reference_sim::{RefAction, RefGame, RefReject, TileXY, WorldXY, content};

const P1: PlayerId = PlayerId(1);
const P2: PlayerId = PlayerId(2);

/// The nearest stone tile to the origin for `TEST_SEED` (`tests/fixtures/landmarks.json`).
const STONE: TilePos = TilePos::new(-1, 2);

fn collect_stone(s: &mut RefScenario, who: PlayerId, n: u32) {
    let c = WorldPos::from_tile(STONE);
    for _ in 0..n {
        s.dispatch(
            who,
            RefAction::StartCollect {
                tile: TileXY::from_tile(STONE),
                from: WorldXY {
                    x: c.x + 128,
                    y: c.y + 128,
                },
            },
        )
        .expect("stone collect admitted");
        s.step_ticks(content::COLLECT.0);
    }
}

fn craft(s: &mut RefScenario, who: PlayerId) -> Result<(), RefReject> {
    s.dispatch(
        who,
        RefAction::StartCraft {
            recipe: RECIPE_FURNACE,
        },
    )
}

fn craft_ticks() -> u32 {
    RECIPES[0].ticks(RefGame::TICK_RATE).0
}

/// A player with the furnace unlocked (5 stone mined) and `extra` more stone in hand.
fn unlocked(extra: u32) -> RefScenario {
    let mut s = RefScenario::new();
    s.join(P1);
    collect_stone(&mut s, P1, 5);
    s.give(P1, ItemId::Stone, extra);
    s
}

#[test]
fn unlock_on_threshold_stone_not_before() {
    let mut s = RefScenario::new();
    s.join(P1);
    collect_stone(&mut s, P1, 4);
    assert_eq!(s.player(P1).stone_mined, 4);
    assert_eq!(s.player(P1).unlocks, 0, "4 stone is below the threshold");
    collect_stone(&mut s, P1, 1);
    assert_eq!(s.player(P1).stone_mined, 5);
    assert_eq!(
        s.player(P1).unlocks,
        1 << RECIPE_FURNACE,
        "the 5th stone unlocks"
    );
}

#[test]
fn unlock_is_per_player() {
    let mut s = RefScenario::new();
    s.join(P1);
    s.join(P2);
    collect_stone(&mut s, P1, 5);
    assert_eq!(s.player(P1).unlocks, 1);
    assert_eq!(s.player(P2).unlocks, 0, "P2 mined nothing");
}

#[test]
fn craft_rejected_when_locked() {
    let mut s = RefScenario::new();
    s.join(P1);
    s.give(P1, ItemId::Stone, 5);
    assert_eq!(craft(&mut s, P1), Err(RefReject::Locked));
    assert_eq!(
        s.dispatch(P1, RefAction::StartCraft { recipe: 200 }),
        Err(RefReject::UnknownRecipe)
    );
}

#[test]
fn craft_rejected_when_unaffordable() {
    let mut s = unlocked(0);
    assert_eq!(s.player(P1).inventory.get(ItemId::Stone), 5);
    craft(&mut s, P1).unwrap();
    s.step_ticks(craft_ticks() + 1);
    assert_eq!(s.player(P1).inventory.get(ItemId::Stone), 0);
    assert_eq!(craft(&mut s, P1), Err(RefReject::Unaffordable));
}

#[test]
fn craft_rejected_when_busy() {
    let mut s = unlocked(5);
    craft(&mut s, P1).unwrap();
    assert_eq!(craft(&mut s, P1), Err(RefReject::Busy), "no queue");
}

#[test]
fn craft_deducts_cost_then_completes_on_time() {
    let mut s = unlocked(0);
    craft(&mut s, P1).unwrap();
    let p = s.player(P1);
    assert_eq!(p.inventory.get(ItemId::Stone), 0, "cost paid at StartCraft");
    assert_eq!(
        p.inventory.get(ItemId::Furnace),
        0,
        "output not yet granted"
    );
    let done_at = p.crafting.expect("crafting").done_at;

    // The exact boundary, both sides: the tick simulated just before `done_at` leaves it running,
    // the tick numbered `done_at` completes it (`tick()` is the next tick to simulate).
    while s.tick().0 < done_at.0 {
        s.step_ticks(1);
    }
    assert!(s.player(P1).crafting.is_some(), "not done a tick early");
    assert_eq!(s.player(P1).inventory.get(ItemId::Furnace), 0);
    s.step_ticks(1);
    let p = s.player(P1);
    assert!(p.crafting.is_none());
    assert_eq!(p.inventory.get(ItemId::Furnace), 1);
    assert_eq!(
        p.inventory.get(ItemId::Stone),
        0,
        "cost is not refunded or paid twice"
    );
}

#[test]
fn collect_and_craft_run_together() {
    let mut s = unlocked(5);
    let c = WorldPos::from_tile(STONE);
    craft(&mut s, P1).unwrap();
    s.dispatch(
        P1,
        RefAction::StartCollect {
            tile: TileXY::from_tile(STONE),
            from: WorldXY {
                x: c.x + 128,
                y: c.y + 128,
            },
        },
    )
    .expect("collect starts while crafting");
    let p = s.player(P1);
    assert!(
        p.collecting.is_some() && p.crafting.is_some(),
        "two independent slots"
    );
    // Craft (100 ticks) outlasts collect (40): the collect finishes first, the craft still runs.
    s.step_ticks(content::COLLECT.0);
    let p = s.player(P1);
    assert!(p.collecting.is_none() && p.crafting.is_some());
    assert_eq!(p.stone_mined, 6);
    s.step_ticks(craft_ticks());
    let p = s.player(P1);
    assert!(p.crafting.is_none());
    assert_eq!(p.inventory.get(ItemId::Furnace), 1);
    assert_eq!(
        p.inventory.get(ItemId::Stone),
        6,
        "5 mined + 5 given - 5 cost + 1 collected"
    );
}

#[test]
fn disconnect_cancels_collect_keeps_craft() {
    let mut s = unlocked(5);
    let c = WorldPos::from_tile(STONE);
    craft(&mut s, P1).unwrap();
    s.dispatch(
        P1,
        RefAction::StartCollect {
            tile: TileXY::from_tile(STONE),
            from: WorldXY {
                x: c.x + 128,
                y: c.y + 128,
            },
        },
    )
    .unwrap();
    let stone_before = s.player(P1).inventory.get(ItemId::Stone);
    let crafting_before = s.player(P1).crafting;

    s.disconnect(P1);
    let p = s.player(P1);
    assert!(p.collecting.is_none(), "collect cancelled");
    assert_eq!(p.crafting, crafting_before, "craft untouched");

    s.step_ticks(craft_ticks() + 5);
    let p = s.player(P1);
    assert_eq!(
        p.inventory.get(ItemId::Stone),
        stone_before,
        "the cancelled collect never lands"
    );
    assert_eq!(
        p.inventory.get(ItemId::Furnace),
        1,
        "the craft completed while disconnected"
    );

    s.connect(P1);
    assert!(s.player(P1).collecting.is_none());
}

/// Builds the pre-rejection state for `kind`: 0 locked, 1 unaffordable, 2 busy.
fn rejecting_setup(kind: u8) -> RefScenario {
    match kind {
        0 => {
            let mut s = RefScenario::new();
            s.join(P1);
            s.give(P1, ItemId::Stone, 5);
            s
        }
        1 => {
            let mut s = unlocked(0);
            craft(&mut s, P1).unwrap();
            s.step_ticks(craft_ticks() + 1);
            s
        }
        _ => {
            let mut s = unlocked(5);
            craft(&mut s, P1).unwrap();
            s
        }
    }
}

#[test]
fn rejected_craft_wrote_nothing() {
    // A rejected action changes nothing: its state hash equals a twin that dispatched a no-write
    // `CancelCollect` on the same tick (the hash covers per-player action bookkeeping too).
    for kind in 0..3 {
        let mut a = rejecting_setup(kind);
        let mut b = rejecting_setup(kind);
        let before = a.player(P1);
        assert!(craft(&mut a, P1).is_err(), "setup {kind} must reject");
        b.dispatch(P1, RefAction::CancelCollect).unwrap();
        assert_eq!(a.player(P1), before, "setup {kind}: player untouched");
        assert_eq!(a.hash(), b.hash(), "setup {kind}: state hash unchanged");
    }
}

#[test]
fn craft_duration_at_20_and_30_hz() {
    assert_eq!(RECIPES[0].ticks(TickRate::hz(20)), Ticks(100));
    assert_eq!(RECIPES[0].ticks(TickRate::hz(30)), Ticks(150));
}

/// The same script through two fresh sims lands on one hash, with a craft in flight and after it
/// completes (extends `collect.rs::replay_equals_live_hash`).
#[test]
fn replay_equals_live_hash_with_craft() {
    fn run() -> (u64, u64) {
        let mut s = RefScenario::new();
        s.join(P1);
        collect_stone(&mut s, P1, 5);
        craft(&mut s, P1).unwrap();
        s.step_ticks(10);
        let mid = s.hash();
        s.step_ticks(craft_ticks());
        assert_eq!(s.player(P1).inventory.get(ItemId::Furnace), 1);
        (mid, s.hash())
    }
    assert_eq!(run(), run());
}
