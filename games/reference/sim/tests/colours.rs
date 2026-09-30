//! Colour assignment (docs/plan/34-reference-multiplayer.md Scope, Tests added): `on_player(Joined)`
//! draws a free palette index with `w.rng()` and does one `put_global`; nothing else writes `Global`.

mod common;

use common::{RefScenario, TEST_SEED};
use engine::game::PlayerId;
use reference_sim::RefAction;
use reference_sim::content::{self, PALETTE};

fn joined(n: u32) -> RefScenario {
    let mut s = RefScenario::new();
    for id in 1..=n {
        s.join(PlayerId(id));
    }
    s
}

#[test]
fn joined_assigns_distinct_colours() {
    let s = joined(8);
    let g = s.global();
    let mut seen: Vec<u8> = (1..=8).map(|id| g.colour(PlayerId(id))).collect();
    assert!(seen.iter().all(|&c| (1..=PALETTE.len() as u8).contains(&c)));
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), 8, "eight joins, eight distinct indices: {g:?}");

    // A ninth player has no free colour left: it still gets a valid one (a repeat).
    let mut s = s;
    s.join(PlayerId(9));
    assert!((1..=PALETTE.len() as u8).contains(&s.global().colour(PlayerId(9))));
    // An id past the table stays unassigned and draws the default green.
    s.join(PlayerId(content::MAX_PLAYERS as u32 + 5));
    assert_eq!(
        s.global().colour(PlayerId(content::MAX_PLAYERS as u32 + 5)),
        0
    );
}

#[test]
fn colour_assignment_replays_identically() {
    let script = |s: &mut RefScenario| {
        for id in 1..=5 {
            s.join(PlayerId(id));
            s.step_ticks(3);
        }
        s.disconnect(PlayerId(2));
        s.connect(PlayerId(2));
        s.join(PlayerId(6));
    };
    let mut a = RefScenario::new();
    let mut b = RefScenario::new();
    script(&mut a);
    script(&mut b);
    assert_eq!(a.hash(), b.hash(), "state hash (Global included) replays");
    assert_eq!(a.global(), b.global());
    // The RNG is consumed by the draw and is host state: equal across runs, and moved off its seed.
    assert_eq!(
        a.rng(),
        b.rng(),
        "RNG state replays (it is in the snapshot)"
    );
    assert_ne!(
        a.rng(),
        RefScenario::new().rng(),
        "joining drew from the RNG"
    );
    let _ = TEST_SEED;
}

#[test]
fn global_written_only_on_join() {
    let mut s = RefScenario::new();
    let base = s.global_puts_logged();
    s.join(PlayerId(1));
    s.join(PlayerId(2));
    assert_eq!(s.global_puts_logged(), base + 2, "one put_global per join");
    let after_joins = s.global_puts_logged();
    let g = s.global();

    s.disconnect(PlayerId(1));
    s.connect(PlayerId(1));
    s.step_ticks(50);
    let _ = s.dispatch(PlayerId(2), RefAction::CancelCollect);
    let _ = s.dispatch(PlayerId(1), RefAction::StartCraft { recipe: 0 });
    assert_eq!(
        s.global_puts_logged(),
        after_joins,
        "no other event writes Global"
    );
    assert_eq!(s.global(), g);

    // A rejoin keeps the colour and writes nothing.
    s.join(PlayerId(1));
    assert_eq!(s.global_puts_logged(), after_joins);
    assert_eq!(s.global(), g);
}
