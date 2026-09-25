//! The state-budget check's second half (docs/decisions/0023-action-growth-declaration.md
//! Consequences: "the scripted 'state budget when full' test ... gains a second half: placing is
//! rejected, removing is accepted, and placing then succeeds again") and the growth-honesty audit
//! (docs/plan/21-entities-and-timers.md Tests added), against `fx-machines`'s own real handlers.

use engine::game::PlayerId;
use engine::sim::{EngineReject, Record, Rejected, Sim, WorldParams};
use fx_machines::{Action, Machines, Pos};

fn genesis(
    seed: u64,
    max_entities: u32,
    max_modified_tiles: u32,
    max_action_growth: u32,
) -> Sim<Machines> {
    Sim::genesis(WorldParams {
        seed,
        worldgen: (),
        max_entities,
        max_modified_tiles,
        max_action_growth,
    })
}

#[test]
fn full_world_rejects_place_accepts_remove_then_place() {
    let mut sim = genesis(1, 1, 1_000_000, 4096);
    let mut out = Vec::new();

    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: Action::Place {
                origin: Pos { x: 2, y: 2 },
            },
        }],
        &mut out,
    );
    assert!(
        out[0].result.is_ok(),
        "the one free slot must accept a Place"
    );

    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 2,
            action: Action::Place {
                origin: Pos { x: 10, y: 10 },
            },
        }],
        &mut out,
    );
    assert!(
        matches!(
            out[0].result,
            Err(Rejected::Engine(EngineReject::StateBudgetFull))
        ),
        "a full world must reject a further Place"
    );

    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 3,
            action: Action::Remove {
                at: Pos { x: 2, y: 2 },
            },
        }],
        &mut out,
    );
    assert!(
        out[0].result.is_ok(),
        "a full world must still accept a Remove (Growth::NONE always passes)"
    );

    sim.step(
        &[Record::Action {
            who: PlayerId(1),
            seq: 4,
            action: Action::Place {
                origin: Pos { x: 10, y: 10 },
            },
        }],
        &mut out,
    );
    assert!(
        out[0].result.is_ok(),
        "the freed slot must accept a Place again"
    );
}

/// "Honesty is audited, not trusted" (0023): replays a script exercising every handler with the
/// audit on (`Sim::step` always runs it) and requires zero violations -- every declared `growth`
/// in `fx-machines::Machines::growth` must match what `apply` actually adds.
#[test]
fn growth_declarations_are_honest() {
    let mut sim = genesis(2, 1_000_000, 1_000_000, 4096);
    let script: Vec<Record<Machines>> = vec![
        Record::Action {
            who: PlayerId(1),
            seq: 1,
            action: Action::Place {
                origin: Pos { x: 2, y: 2 },
            },
        },
        Record::Action {
            who: PlayerId(1),
            seq: 2,
            action: Action::Feed {
                at: Pos { x: 2, y: 2 },
            },
        },
        Record::Action {
            who: PlayerId(1),
            seq: 3,
            action: Action::Move {
                at: Pos { x: 2, y: 2 },
                to: Pos { x: 10, y: 10 },
            },
        },
        Record::Action {
            who: PlayerId(1),
            seq: 4,
            action: Action::Remove {
                at: Pos { x: 10, y: 10 },
            },
        },
        Record::Action {
            who: PlayerId(1),
            seq: 5,
            action: Action::Place {
                origin: Pos { x: 2, y: 2 },
            },
        },
    ];
    let mut out = Vec::new();
    for (i, record) in script.into_iter().enumerate() {
        sim.step(&[record], &mut out);
        assert!(
            out[0].result.is_ok(),
            "script action {i} (seq {}) was rejected",
            i + 1
        );
    }
    assert_eq!(
        sim.authority().growth_violations(),
        0,
        "no handler may add more than it declared"
    );
}
