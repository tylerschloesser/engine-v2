//! `admit_rejects_far_witness`, `admit_rejects_without_sample`, `admit_accepts_within_tolerance`
//! (docs/plan/20b-reference-player-and-collect-ui.md Tests added): `Game::admit`'s own
//! `StartCollect` witness check (0001 "Witness-carrying actions" step 1), against a hand-built
//! `PresenceTable` -- `admit` runs host-only and is never replayed (0001 Consequences), so it needs
//! its own unit tests rather than scenario coverage.

use engine::game::{PlayerId, PresenceTable};
use engine::time::Tick;
use engine::world::WorldPos;
use reference_sim::RefReject;
use reference_sim::client::PlayerPresence;
use reference_sim::content::ADMIT_TOLERANCE_Q8;
use reference_sim::rules::collect::admit;

fn presence_at(x: i32, y: i32) -> PlayerPresence {
    PlayerPresence {
        pos: [x, y],
        vel: [0, 0],
    }
}

#[test]
fn admit_rejects_without_sample() {
    let table = PresenceTable::<reference_sim::RefGame>::empty();
    let who = PlayerId(1);
    let from = WorldPos { x: 0, y: 0 };
    assert_eq!(
        admit(&table, who, from),
        Err(RefReject::ImplausiblePosition)
    );
}

#[test]
fn admit_rejects_far_witness() {
    let mut table = PresenceTable::<reference_sim::RefGame>::empty();
    let who = PlayerId(1);
    table.on_sample(who, presence_at(0, 0), Tick(0));
    // One raw unit past the tolerance, on one axis.
    let from = WorldPos {
        x: ADMIT_TOLERANCE_Q8 + 1,
        y: 0,
    };
    assert_eq!(
        admit(&table, who, from),
        Err(RefReject::ImplausiblePosition)
    );
}

#[test]
fn admit_accepts_within_tolerance() {
    let mut table = PresenceTable::<reference_sim::RefGame>::empty();
    let who = PlayerId(1);
    // The witness stands over a water tile: players may float over water (Tests added's own
    // wording) -- `admit` checks only distance, never `traits_at`, so a sample directly over what
    // would be water is fine to use here (no tile is even read).
    table.on_sample(who, presence_at(0, 0), Tick(0));
    let from = WorldPos {
        x: ADMIT_TOLERANCE_Q8,
        y: 0,
    };
    assert_eq!(admit(&table, who, from), Ok(()));
}
