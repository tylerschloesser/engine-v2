//! Smelting on the host (docs/plan/33b-reference-furnace-operation.md Tests added): every test here
//! needs `advance` to have run. Deposit, take and pick-up validation is in `furnace.rs`.

mod common;

use common::RefScenario;
use engine::game::PlayerId;
use engine::time::{TickRate, Ticks};
use engine::world::TilePos;
use reference_sim::content::{self, ItemId};
use reference_sim::{Furnace, RefGame, RefReject};

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
fn one_coal_smelts_exactly_ten() {
    let mut s = scenario();
    s.deposit(P1, ORIGIN, ItemId::Iron, 11).unwrap();
    s.deposit(P1, ORIGIN, ItemId::Coal, 1).unwrap();
    run_until(&mut s, 10 * SMELT + 5, |f| f.ingots_out == 10);
    let f = furnace(&s);
    assert_eq!((f.iron_in, f.coal, f.wood, f.burn_left), (1, 0, 0, 0));
    assert_eq!(f.smelt_done_at, None, "the eleventh iron has no fuel");
    assert_asleep(&mut s, 3 * SMELT);
    assert_eq!(furnace(&s).ingots_out, 10, "no eleventh ingot");
}

#[test]
fn one_wood_smelts_exactly_two() {
    let mut s = scenario();
    s.deposit(P1, ORIGIN, ItemId::Iron, 3).unwrap();
    s.deposit(P1, ORIGIN, ItemId::Wood, 1).unwrap();
    run_until(&mut s, 2 * SMELT + 5, |f| f.ingots_out == 2);
    let f = furnace(&s);
    assert_eq!((f.iron_in, f.wood, f.burn_left), (1, 0, 0));
    assert_asleep(&mut s, 3 * SMELT);
    assert_eq!(furnace(&s).ingots_out, 2);
}

#[test]
fn smelt_takes_five_seconds_at_20_and_30_hz() {
    assert_eq!(content::smelt_ticks(TickRate::hz(20)), Ticks(100));
    assert_eq!(content::smelt_ticks(TickRate::hz(30)), Ticks(150));
    assert_eq!(
        content::SMELT,
        content::smelt_ticks(<RefGame as engine::game::Game>::TICK_RATE)
    );

    // And the rule really waits that long: the ingot lands exactly `SMELT` ticks after the deposit
    // that lit the furnace, not a tick sooner.
    let mut s = scenario();
    s.deposit(P1, ORIGIN, ItemId::Coal, 1).unwrap();
    s.deposit(P1, ORIGIN, ItemId::Iron, 1).unwrap();
    let lit_at = furnace(&s).smelt_done_at.expect("lit at once").0 - SMELT;
    assert_eq!(lit_at + 1, s.tick().0, "started on the depositing tick");
    let took = run_until(&mut s, SMELT + 5, |f| f.ingots_out == 1);
    assert_eq!(
        took, SMELT,
        "the ingot lands on the step at tick lit + SMELT"
    );
    assert_eq!(s.tick().0, lit_at + SMELT + 1, "that step has run");
}

#[test]
fn coal_before_wood() {
    let mut s = scenario();
    s.deposit(P1, ORIGIN, ItemId::Iron, 12).unwrap();
    s.deposit(P1, ORIGIN, ItemId::Wood, 1).unwrap();
    s.deposit(P1, ORIGIN, ItemId::Coal, 1).unwrap();
    let f = furnace(&s);
    // Wood was deposited first and lit the furnace; the coal waits for it to burn out.
    assert_eq!((f.coal, f.wood, f.burn_left), (1, 0, 2));

    // With both present before the first light, coal goes first.
    let mut s = scenario();
    s.deposit(P1, ORIGIN, ItemId::Wood, 1).unwrap();
    s.deposit(P1, ORIGIN, ItemId::Coal, 1).unwrap();
    s.deposit(P1, ORIGIN, ItemId::Iron, 12).unwrap();
    let f = furnace(&s);
    assert_eq!((f.coal, f.wood, f.burn_left), (0, 1, 10), "coal lit first");
    run_until(&mut s, 10 * SMELT + 5, |f| f.ingots_out == 10);
    let f = furnace(&s);
    assert_eq!(
        (f.wood, f.burn_left),
        (0, 2),
        "then the wood, on the tick the coal ran out"
    );
}

#[test]
fn stops_without_iron_or_fuel_and_resumes_on_deposit() {
    let mut s = scenario();
    // Fuel but no iron: nothing lights.
    s.deposit(P1, ORIGIN, ItemId::Coal, 1).unwrap();
    assert_eq!(furnace(&s).burn_left, 0, "fuel is lit only for a smelt");
    assert_asleep(&mut s, SMELT);
    // Iron arrives: it starts.
    s.deposit(P1, ORIGIN, ItemId::Iron, 2).unwrap();
    assert!(furnace(&s).smelt_done_at.is_some());
    run_until(&mut s, 2 * SMELT + 5, |f| f.ingots_out == 2);
    let f = furnace(&s);
    assert_eq!((f.iron_in, f.burn_left, f.smelt_done_at), (0, 8, None));
    // No iron left, burn left: asleep, then more iron resumes on the lit fuel (no new coal).
    assert_asleep(&mut s, 2 * SMELT);
    s.deposit(P1, ORIGIN, ItemId::Iron, 1).unwrap();
    run_until(&mut s, SMELT + 5, |f| f.ingots_out == 3);
    assert_eq!(furnace(&s).burn_left, 7);

    // Iron but no fuel: stuck until fuel comes.
    let mut s = scenario();
    s.deposit(P1, ORIGIN, ItemId::Iron, 1).unwrap();
    assert_asleep(&mut s, 2 * SMELT);
    assert_eq!(furnace(&s).ingots_out, 0);
    s.deposit(P1, ORIGIN, ItemId::Wood, 1).unwrap();
    run_until(&mut s, SMELT + 5, |f| f.ingots_out == 1);
}

/// 1,000 furnaces with nothing to do cost nothing: no puts, no entity visits, no state change.
#[test]
fn idle_furnaces_cost_nothing() {
    let mut s = RefScenario::new();
    s.join(P1);
    s.clear_area(TilePos::new(40, 40), 80, 50);
    s.give(P1, ItemId::Furnace, 1_000);
    for i in 0..1_000 {
        let origin = TilePos::new(40 + (i % 40) * 2, 40 + (i / 40) * 2);
        s.place(P1, origin).expect("free ground");
    }
    assert_eq!(s.furnace_count(), 1_000);
    // Each placement woke its furnace once; `advance` found nothing to do and put nothing, so the
    // only entity puts so far are the 1,000 spawns.
    assert_eq!(s.entity_puts_logged(), 1_000, "advance put an idle furnace");
    s.step_ticks(2); // the last placement's wake is served and finds nothing to do.

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

#[test]
fn take_all_moves_ingots() {
    let mut s = scenario();
    s.deposit(P1, ORIGIN, ItemId::Iron, 2).unwrap();
    s.deposit(P1, ORIGIN, ItemId::Wood, 1).unwrap();
    run_until(&mut s, 2 * SMELT + 5, |f| f.ingots_out == 2);
    s.take(P1, TilePos::new(43, 43)).unwrap();
    assert_eq!(furnace(&s).ingots_out, 0);
    assert_eq!(s.player(P1).inventory.get(ItemId::Ingot), 2);
    assert_asleep(&mut s, SMELT);
}

#[test]
fn any_player_can_use_any_furnace() {
    let mut s = scenario();
    s.give(P2, ItemId::Iron, 2);
    s.give(P2, ItemId::Wood, 1);
    // P2 never placed it and stands nowhere near it.
    s.deposit(P2, ORIGIN, ItemId::Iron, 2).unwrap();
    s.deposit(P2, ORIGIN, ItemId::Wood, 1).unwrap();
    run_until(&mut s, 2 * SMELT + 5, |f| f.ingots_out == 2);
    s.take(P2, ORIGIN).unwrap();
    assert_eq!(s.player(P2).inventory.get(ItemId::Ingot), 2);
    assert_eq!(s.player(P1).inventory.get(ItemId::Ingot), 0);
}

#[test]
fn same_ingots_race_second_take_rejected() {
    let mut s = scenario();
    s.deposit(P1, ORIGIN, ItemId::Iron, 3).unwrap();
    s.deposit(P1, ORIGIN, ItemId::Wood, 2).unwrap();
    run_until(&mut s, 3 * SMELT + 5, |f| f.ingots_out == 3);
    s.take(P1, ORIGIN).unwrap();
    assert_eq!(s.take(P2, ORIGIN), Err(RefReject::NothingToTake));
    assert_eq!(s.player(P1).inventory.get(ItemId::Ingot), 3);
    assert_eq!(s.player(P2).inventory.get(ItemId::Ingot), 0, "not doubled");
}

/// The same script through two fresh sims lands on one hash at each checkpoint, through a full
/// smelt, a take, a pick-up and a re-placement (extends `collect.rs::replay_equals_live_hash`).
#[test]
fn replay_equals_live_hash_with_furnace() {
    fn run() -> Vec<u64> {
        let mut s = scenario();
        let mut hashes = Vec::new();
        s.deposit(P1, ORIGIN, ItemId::Iron, 2).unwrap();
        s.deposit(P1, ORIGIN, ItemId::Wood, 1).unwrap();
        s.step_ticks(SMELT / 2);
        hashes.push(s.hash()); // mid-smelt.
        s.step_ticks(2 * SMELT);
        assert_eq!(s.furnace_at(ORIGIN).unwrap().ingots_out, 2);
        hashes.push(s.hash());
        s.take(P1, ORIGIN).unwrap();
        s.pick_up(P1, TilePos::new(43, 42)).unwrap();
        assert!(s.furnace_at(ORIGIN).is_none());
        hashes.push(s.hash());
        s.place(P1, TilePos::new(44, 44)).unwrap();
        s.step_ticks(10);
        hashes.push(s.hash());
        hashes
    }
    assert_eq!(run(), run());
}

/// One case per counter: each alone blocks the pick-up, `burn_left` included, and nothing is written.
#[test]
fn pickup_rejected_unless_empty() {
    type Setup = fn(&mut RefScenario);
    let cases: [(&str, Setup); 5] = [
        ("iron_in", |s| {
            s.deposit(P1, ORIGIN, ItemId::Iron, 1).unwrap()
        }),
        ("coal", |s| s.deposit(P1, ORIGIN, ItemId::Coal, 1).unwrap()),
        ("wood", |s| s.deposit(P1, ORIGIN, ItemId::Wood, 1).unwrap()),
        ("burn_left", |s| {
            // One iron, one coal, smelted and taken: only the lit remainder of the coal is left.
            s.deposit(P1, ORIGIN, ItemId::Iron, 1).unwrap();
            s.deposit(P1, ORIGIN, ItemId::Coal, 1).unwrap();
            run_until(s, SMELT + 5, |f| f.ingots_out == 1);
            s.take(P1, ORIGIN).unwrap();
            let f = furnace(s);
            assert_eq!(
                (f.iron_in, f.coal, f.wood, f.ingots_out, f.burn_left),
                (0, 0, 0, 0, 9)
            );
        }),
        ("ingots_out", |s| {
            s.deposit(P1, ORIGIN, ItemId::Iron, 2).unwrap();
            s.deposit(P1, ORIGIN, ItemId::Wood, 1).unwrap();
            run_until(s, 2 * SMELT + 5, |f| f.ingots_out == 2);
            let f = furnace(s);
            assert_eq!((f.iron_in, f.coal, f.wood, f.burn_left), (0, 0, 0, 0));
        }),
    ];
    for (name, setup) in cases {
        let mut s = scenario();
        setup(&mut s);
        let (f, p, w) = (furnace(&s), s.player(P1), s.writes_logged());
        assert_eq!(
            s.pick_up(P1, ORIGIN),
            Err(RefReject::FurnaceNotEmpty),
            "{name}"
        );
        assert_eq!(furnace(&s), f, "{name}: furnace untouched");
        assert_eq!(s.player(P1), p, "{name}: no item returned");
        assert_eq!(s.writes_logged(), w, "{name}: wrote");
    }
}
