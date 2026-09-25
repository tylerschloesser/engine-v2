//! `.wasm`-authoritative golden for `fixtures/machines/golden/scenario.json` ("place-border": a
//! 2x2 footprint straddling a chunk boundary, fed, moved, removed, then re-placed) -- `golden/
//! golden.json` is written by `pnpm golden machines`, from the `.wasm` run under Node (0002). This
//! native run drives `Sim<Machines>` directly (the same call sequence `Host<Machines>`'s
//! `sim_genesis`/`sim_tick` make) and is compared against that same file, matching `fx-puts`'s own
//! `puts_script_a_golden` convention.

use engine::game::{PlayerEvent, PlayerId};
use engine::sim::{Record, Sim, WorldParams};
use engine::testing::testkit::run_script;
use engine::time::Tick;
use fx_machines::{Action, Machines, Pos};

fn new_sim(seed: u64, max_entities: u32) -> Sim<Machines> {
    Sim::genesis(WorldParams {
        seed,
        worldgen: (),
        max_entities,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
    })
}

/// Mirrors `golden/scenario.json`'s script exactly (`connect: true` at tick 1 is `Host::connect`'s
/// own `Record::Player{Joined}` -- assigning `PlayerId(1)` to `sim_connect(0)`, `host/mod`
/// Deviations).
fn script_place_border() -> Vec<(Tick, Record<Machines>)> {
    vec![
        (
            Tick(1),
            Record::Player {
                who: PlayerId(1),
                ev: PlayerEvent::Joined,
            },
        ),
        (
            Tick(1),
            Record::Action {
                who: PlayerId(1),
                seq: 1,
                action: Action::Place {
                    origin: Pos { x: 63, y: 5 },
                },
            },
        ),
        (
            Tick(2),
            Record::Action {
                who: PlayerId(1),
                seq: 2,
                action: Action::Feed {
                    at: Pos { x: 63, y: 5 },
                },
            },
        ),
        (
            Tick(3),
            Record::Action {
                who: PlayerId(1),
                seq: 3,
                action: Action::Move {
                    at: Pos { x: 63, y: 5 },
                    to: Pos { x: 100, y: 100 },
                },
            },
        ),
        (
            Tick(4),
            Record::Action {
                who: PlayerId(1),
                seq: 4,
                action: Action::Remove {
                    at: Pos { x: 100, y: 100 },
                },
            },
        ),
        (
            Tick(5),
            Record::Action {
                who: PlayerId(1),
                seq: 5,
                action: Action::Place {
                    origin: Pos { x: 63, y: 5 },
                },
            },
        ),
    ]
}

#[test]
fn machines_place_border_golden() {
    let mut sim = new_sim(1, 4096);
    let hash = run_script(&mut sim, &script_place_border());
    engine::testing::assert_golden(env!("CARGO_MANIFEST_DIR"), &[hash]);
}

#[test]
fn replay_equals_live() {
    let mut live = new_sim(1, 4096);
    let live_hash = run_script(&mut live, &script_place_border());

    let mut replay = new_sim(1, 4096);
    let replay_hash = run_script(&mut replay, &script_place_border());

    assert_eq!(live_hash, replay_hash);
}

#[test]
fn truncated_log_differs() {
    let full_script = script_place_border();
    let mut full = new_sim(1, 4096);
    let full_hash = run_script(&mut full, &full_script);

    let mut truncated = new_sim(1, 4096);
    let truncated_hash = run_script(&mut truncated, &full_script[..full_script.len() - 1]);

    assert_ne!(full_hash, truncated_hash);
}

/// Mirrors `golden/scenario-full-world.json` (`maxEntities: 1`): Place, Place (rejected, full),
/// Remove, Place (accepted again) -- 0023 Consequences' own "second half" of the scripted budget
/// test.
fn script_full_world() -> Vec<(Tick, Record<Machines>)> {
    vec![
        (
            Tick(1),
            Record::Player {
                who: PlayerId(1),
                ev: PlayerEvent::Joined,
            },
        ),
        (
            Tick(1),
            Record::Action {
                who: PlayerId(1),
                seq: 1,
                action: Action::Place {
                    origin: Pos { x: 2, y: 2 },
                },
            },
        ),
        (
            Tick(2),
            Record::Action {
                who: PlayerId(1),
                seq: 2,
                action: Action::Place {
                    origin: Pos { x: 10, y: 10 },
                },
            },
        ),
        (
            Tick(3),
            Record::Action {
                who: PlayerId(1),
                seq: 3,
                action: Action::Remove {
                    at: Pos { x: 2, y: 2 },
                },
            },
        ),
        (
            Tick(4),
            Record::Action {
                who: PlayerId(1),
                seq: 4,
                action: Action::Place {
                    origin: Pos { x: 10, y: 10 },
                },
            },
        ),
    ]
}

#[test]
fn machines_full_world_golden() {
    let mut sim = new_sim(2, 1);
    let hash = run_script(&mut sim, &script_full_world());
    engine::testing::assert_golden_named(
        env!("CARGO_MANIFEST_DIR"),
        "golden-full-world.json",
        &[hash],
    );
}
