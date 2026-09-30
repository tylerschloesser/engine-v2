//! Furnace operation on the host (docs/plan/33b-reference-furnace-operation.md Tests added): deposit,
//! take, pick-up and the smelting rule. The prediction and two-player-replica cases are in
//! `furnace_predict.rs`.

mod common;

use common::RefScenario;
use engine::game::PlayerId;
use engine::world::TilePos;
use reference_sim::content::{self, ItemId};
use reference_sim::rules::place::can_place;
use reference_sim::{Furnace, RefAction, RefReject, TileXY};

const P1: PlayerId = PlayerId(1);
const P2: PlayerId = PlayerId(2);
const ORIGIN: TilePos = TilePos::new(42, 42);
const SMELT: u32 = content::SMELT.0;

/// Two players, `(40, 40)..(47, 47)` cleared, P1 holding stock of everything a test deposits and a
/// furnace placed at [`ORIGIN`].
fn scenario() -> RefScenario {
    let mut s = RefScenario::new();
    s.join(P1);
    s.join(P2);
    s.clear_area(TilePos::new(40, 40), 8, 8);
    s.give(P1, ItemId::Furnace, 1);
    for item in [ItemId::Iron, ItemId::Coal, ItemId::Wood] {
        s.give(P1, item, 50);
    }
    s.place(P1, ORIGIN).expect("free ground");
    s
}

fn furnace(s: &RefScenario) -> Furnace {
    s.furnace_at(ORIGIN).expect("the furnace is there")
}

/// Steps until `pred` holds (at most `max` ticks) and returns how many ticks that took.
fn run_until(s: &mut RefScenario, max: u32, pred: impl Fn(&Furnace) -> bool) -> u32 {
    for n in 0..=max {
        if pred(&furnace(s)) {
            return n;
        }
        s.step_ticks(1);
    }
    panic!("condition not reached within {max} ticks: {:?}", furnace(s));
}

/// The furnace holds nothing to do: no writes and no entity visits over `n` ticks.
fn assert_asleep(s: &mut RefScenario, n: u32) {
    let before = s.writes_logged();
    s.step_ticks(n);
    assert_eq!(s.writes_logged(), before, "a sleeping furnace wrote");
    assert_eq!(s.visited_last_tick(), 0, "a sleeping furnace was visited");
}

#[test]
fn deposit_validates_item_count_and_cap() {
    let at = ORIGIN;
    let raw = |item: u8, count: u32| RefAction::FurnaceDeposit {
        at: TileXY::from_tile(at),
        item,
        count,
    };
    let mut s = scenario();
    for bad in [ItemId::Stone, ItemId::Furnace, ItemId::Ingot] {
        assert_eq!(
            s.deposit(P1, at, bad, 1),
            Err(RefReject::BadItem),
            "{bad:?}"
        );
    }
    assert_eq!(s.dispatch(P1, raw(99, 1)), Err(RefReject::BadItem));
    assert_eq!(s.deposit(P1, at, ItemId::Iron, 0), Err(RefReject::BadCount));
    assert_eq!(
        s.deposit(P1, at, ItemId::Iron, 51),
        Err(RefReject::NotEnoughItems),
        "holds 50"
    );
    assert_eq!(
        s.deposit(P2, at, ItemId::Iron, 1),
        Err(RefReject::NotEnoughItems),
        "P2 holds none"
    );
    assert_eq!(furnace(&s), Furnace::new(TileXY::from_tile(ORIGIN)));
    assert_eq!(s.player(P1).inventory.get(ItemId::Iron), 50);

    // Accepts: each of the three items, moving exactly `count`.
    s.deposit(P1, at, ItemId::Iron, 7).unwrap();
    s.deposit(P1, at, ItemId::Coal, 3).unwrap();
    s.deposit(P1, at, ItemId::Wood, 2).unwrap();
    let f = furnace(&s);
    assert_eq!(
        (f.iron_in, f.coal, f.wood),
        (7, 3 - 1, 2),
        "one coal was lit at once"
    );
    let inv = s.player(P1).inventory;
    assert_eq!(inv.get(ItemId::Iron), 43);
    assert_eq!(inv.get(ItemId::Coal), 47);
    assert_eq!(inv.get(ItemId::Wood), 48);

    // The cap: 999 fits exactly, one more does not, and a rejected deposit moves nothing.
    let mut s = scenario();
    s.give(P1, ItemId::Wood, 2_000);
    assert_eq!(
        s.deposit(P1, at, ItemId::Wood, 1_000),
        Err(RefReject::SlotFull)
    );
    s.deposit(P1, at, ItemId::Wood, 999).unwrap();
    assert_eq!(furnace(&s).wood, 999);
    assert_eq!(s.deposit(P1, at, ItemId::Wood, 1), Err(RefReject::SlotFull));
    assert_eq!(furnace(&s).wood, 999);
    assert_eq!(s.player(P1).inventory.get(ItemId::Wood), 50 + 2_000 - 999);
}

#[test]
fn deposit_by_any_footprint_tile() {
    for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
        let mut s = scenario();
        let at = TilePos::new(ORIGIN.x + dx, ORIGIN.y + dy);
        s.deposit(P1, at, ItemId::Iron, 3).unwrap();
        assert_eq!(furnace(&s).iron_in, 3, "via tile ({dx},{dy})");
    }
    let mut s = scenario();
    for (x, y) in [(41, 42), (44, 42), (42, 44), (44, 44)] {
        assert_eq!(
            s.deposit(P1, TilePos::new(x, y), ItemId::Iron, 1),
            Err(RefReject::NoFurnaceHere),
            "({x},{y}) is outside the footprint"
        );
    }
}

#[test]
fn take_empty_rejected() {
    let mut s = scenario();
    assert_eq!(s.take(P1, ORIGIN), Err(RefReject::NothingToTake));
    assert_eq!(
        s.take(P1, TilePos::new(50, 50)),
        Err(RefReject::NoFurnaceHere)
    );
    // Fuel and ore inside are not ingots: they never come back out.
    s.deposit(P1, ORIGIN, ItemId::Iron, 1).unwrap();
    s.deposit(P1, ORIGIN, ItemId::Coal, 1).unwrap();
    assert_eq!(s.take(P1, ORIGIN), Err(RefReject::NothingToTake));
}

/// Every rejecting branch leaves the world as a no-write action would (the hash covers per-action
/// bookkeeping, so the twin dispatches `CancelCollect`, as `rejected_place_wrote_nothing` does), and
/// records no write. Fails if a branch puts or despawns before it has validated.
#[test]
fn rejected_actions_wrote_nothing() {
    type Case = (
        &'static str,
        fn(&mut RefScenario),
        fn(&mut RefScenario) -> Result<(), RefReject>,
        RefReject,
    );
    let cases: [Case; 10] = [
        (
            "deposit, no furnace",
            |_| {},
            |s| s.deposit(P1, TilePos::new(50, 50), ItemId::Iron, 1),
            RefReject::NoFurnaceHere,
        ),
        (
            "deposit, bad item",
            |_| {},
            |s| s.deposit(P1, ORIGIN, ItemId::Stone, 1),
            RefReject::BadItem,
        ),
        (
            "deposit, zero",
            |_| {},
            |s| s.deposit(P1, ORIGIN, ItemId::Iron, 0),
            RefReject::BadCount,
        ),
        (
            "deposit, not held",
            |_| {},
            |s| s.deposit(P1, ORIGIN, ItemId::Iron, 51),
            RefReject::NotEnoughItems,
        ),
        (
            "deposit, slot full",
            |s| {
                s.give(P1, ItemId::Iron, 1_000);
                s.deposit(P1, ORIGIN, ItemId::Iron, 999).unwrap();
            },
            |s| s.deposit(P1, ORIGIN, ItemId::Iron, 1),
            RefReject::SlotFull,
        ),
        (
            "take, no furnace",
            |_| {},
            |s| s.take(P1, TilePos::new(50, 50)),
            RefReject::NoFurnaceHere,
        ),
        (
            "take, no ingots",
            |_| {},
            |s| s.take(P1, ORIGIN),
            RefReject::NothingToTake,
        ),
        (
            "pick up, no furnace",
            |_| {},
            |s| s.pick_up(P1, TilePos::new(50, 50)),
            RefReject::NoFurnaceHere,
        ),
        (
            "pick up, not empty",
            |s| s.deposit(P1, ORIGIN, ItemId::Iron, 1).unwrap(),
            |s| s.pick_up(P1, ORIGIN),
            RefReject::FurnaceNotEmpty,
        ),
        (
            "pick up, ingots inside",
            |s| {
                s.deposit(P1, ORIGIN, ItemId::Iron, 2).unwrap();
                s.deposit(P1, ORIGIN, ItemId::Wood, 1).unwrap();
                s.step_ticks(2 * SMELT);
            },
            |s| s.pick_up(P1, ORIGIN),
            RefReject::FurnaceNotEmpty,
        ),
    ];
    for (name, setup, act, want) in cases {
        let mut a = scenario();
        let mut b = scenario();
        setup(&mut a);
        setup(&mut b);
        let (furnace_before, player_before) = (a.furnace_at(ORIGIN), a.player(P1));
        let writes = a.writes_logged();
        assert_eq!(act(&mut a), Err(want), "{name}");
        assert_eq!(a.writes_logged(), writes, "{name}: logged a write");
        assert_eq!(
            a.furnace_at(ORIGIN),
            furnace_before,
            "{name}: furnace changed"
        );
        assert_eq!(a.player(P1), player_before, "{name}: player changed");
        b.dispatch(P1, RefAction::CancelCollect).unwrap();
        assert_eq!(a.hash(), b.hash(), "{name}: rejection wrote something");
    }
}

/// Pick-up of an empty furnace: the entity is gone, its four tiles are buildable in the same tick,
/// the item is back, nothing is left on the wheel or the wake queue, and it can be placed again.
#[test]
fn pickup_empty_despawns_and_returns_item() {
    let mut s = scenario();
    assert_eq!(s.player(P1).inventory.get(ItemId::Furnace), 0);
    assert_eq!(s.furnace_count(), 1);
    let id = s.entity_at(ORIGIN).unwrap();
    s.pick_up(P1, ORIGIN).unwrap();
    assert_eq!(s.furnace_count(), 0);
    assert_eq!(s.player(P1).inventory.get(ItemId::Furnace), 1);
    for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
        let p = TilePos::new(ORIGIN.x + dx, ORIGIN.y + dy);
        assert_eq!(s.entity_at(p), None, "({dx},{dy}) released");
    }
    assert!(
        can_place(s.read(), ORIGIN).unwrap(),
        "the four tiles are buildable again"
    );
    assert_asleep(&mut s, 2 * SMELT);
    s.place(P1, ORIGIN).expect("placing on the same tiles");
    assert_ne!(s.entity_at(ORIGIN), Some(id), "a fresh entity");
    assert_eq!(s.player(P1).inventory.get(ItemId::Furnace), 0);

    // A furnace that has smelted and been emptied has no timer to lose either.
    s.deposit(P1, ORIGIN, ItemId::Iron, 2).unwrap();
    s.deposit(P1, ORIGIN, ItemId::Wood, 1).unwrap();
    run_until(&mut s, 2 * SMELT + 5, |f| f.ingots_out == 2);
    s.take(P1, ORIGIN).unwrap();
    s.pick_up(P1, ORIGIN).unwrap();
    assert_asleep(&mut s, 2 * SMELT);
}

#[test]
fn pickup_by_any_footprint_tile_and_any_player() {
    for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
        let mut s = scenario();
        let at = TilePos::new(ORIGIN.x + dx, ORIGIN.y + dy);
        // P2 did not place it and stands nowhere near it.
        s.pick_up(P2, at).unwrap();
        assert_eq!(s.furnace_count(), 0, "via tile ({dx},{dy})");
        assert_eq!(s.player(P2).inventory.get(ItemId::Furnace), 1);
        assert_eq!(s.player(P1).inventory.get(ItemId::Furnace), 0);
    }
}

#[test]
fn pickup_no_furnace_rejected() {
    let mut s = scenario();
    assert_eq!(
        s.pick_up(P1, TilePos::new(50, 50)),
        Err(RefReject::NoFurnaceHere)
    );
    s.pick_up(P1, ORIGIN).unwrap();
    assert_eq!(
        s.pick_up(P1, ORIGIN),
        Err(RefReject::NoFurnaceHere),
        "the second pick-up finds nothing"
    );
    assert_eq!(
        s.deposit(P1, ORIGIN, ItemId::Iron, 1),
        Err(RefReject::NoFurnaceHere),
        "so does a deposit after it"
    );
    assert_eq!(
        s.player(P1).inventory.get(ItemId::Furnace),
        1,
        "not doubled"
    );
}
