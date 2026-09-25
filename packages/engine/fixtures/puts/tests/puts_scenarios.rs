//! Golden and replay scenarios for `fx-puts` (docs/plan/12b-world-access-and-sim-driver.md Tests
//! added). Both goldens here are `.wasm`-authoritative (`assert_golden`/`assert_golden_named`):
//! `puts_idle_100` since M13, `puts_script_a` since M16 (docs/plan/16-action-round-trip.md step
//! 5) -- it was native-blessed (`assert_golden_hash!`) until then, since no sim ABI admit path
//! existed to drive `golden/scenario-script-a.json`'s real `sim_connect`/`sim_admit` traffic.

use engine::game::{PlayerEvent, PlayerId};
use engine::sim::{Record, Sim, WorldParams};
use engine::testing::testkit::run_script;
use engine::time::Tick;
use fx_puts::{Action, Pos, Puts};

fn new_sim(seed: u64) -> Sim<Puts> {
    Sim::genesis(WorldParams {
        seed,
        worldgen: (),
        max_entities: 262_144,
        max_modified_tiles: 1_048_576,
        max_action_growth: 4_096,
    })
}

/// A script exercising every handler (docs/plan/12b-world-access-and-sim-driver.md Scope): a
/// join, one put of each scope kind, both rejecting handlers (`Bump`/`Remove`, always `NotFound`
/// this milestone -- see `fx_puts`'s module doc comment), and `Roll`, spread across enough ticks
/// (idle gaps included) to also exercise `tick`'s own once-a-second walk/day bump.
fn script_a() -> Vec<(Tick, Record<Puts>)> {
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
                action: Action::Paint {
                    pos: Pos { x: 2, y: 2 },
                    base: 3,
                    resource: 0,
                },
            },
        ),
        (
            Tick(2),
            Record::Action {
                who: PlayerId(1),
                seq: 2,
                action: Action::Spawn {
                    at: Pos { x: 5, y: 5 },
                    kind: 1,
                },
            },
        ),
        (
            Tick(3),
            Record::Action {
                who: PlayerId(1),
                seq: 3,
                action: Action::Bump {
                    at: Pos { x: 5, y: 5 },
                },
            },
        ),
        (
            Tick(4),
            Record::Action {
                who: PlayerId(1),
                seq: 4,
                action: Action::Remove {
                    at: Pos { x: 5, y: 5 },
                },
            },
        ),
        (
            Tick(5),
            Record::Action {
                who: PlayerId(1),
                seq: 5,
                action: Action::SetNote { n: 42 },
            },
        ),
        (
            Tick(6),
            Record::Action {
                who: PlayerId(1),
                seq: 6,
                action: Action::SetMotd { n: 7 },
            },
        ),
        (
            Tick(7),
            Record::Action {
                who: PlayerId(1),
                seq: 7,
                action: Action::Roll,
            },
        ),
        (
            Tick(25),
            Record::Action {
                who: PlayerId(1),
                seq: 8,
                action: Action::Roll,
            },
        ),
        (
            Tick(45),
            Record::Action {
                who: PlayerId(1),
                seq: 9,
                action: Action::Paint {
                    pos: Pos { x: -3, y: 8 },
                    base: 1,
                    resource: 2,
                },
            },
        ),
    ]
}

/// `.wasm`-authoritative since M13 (docs/plan/13-sim-host-tick-loop.md exit note; M12b's own
/// note on this test): `golden/golden.json` is written by `pnpm golden puts`, from the `.wasm`
/// run over `golden/scenario.json` under Node (0002). This native run drives `Sim<Puts>` directly
/// (the same call sequence `host::Host<Puts>`'s `sim_genesis`/`sim_tick` make) and is compared
/// against that same file, so native and `.wasm` are proven equal transitively (`tests/wasm/
/// puts.test.ts`'s `wasm_idle_100_matches_native` compares the `.wasm` run against it too).
#[test]
fn puts_idle_100_golden() {
    let mut sim = new_sim(1);
    let mut out = Vec::new();
    for _ in 0..100 {
        sim.step(&[], &mut out);
    }
    assert_eq!(sim.tick(), Tick(100));
    engine::testing::assert_golden(env!("CARGO_MANIFEST_DIR"), &[sim.state_hash()]);
}

/// `.wasm`-authoritative since M16 (docs/plan/16-action-round-trip.md step 5; was native-blessed
/// via `assert_golden_hash!` reading `tests/golden/puts_script_a.hash`): `golden/golden-script-a.
/// json` is written by `pnpm golden puts`, from the `.wasm` run over `golden/scenario-script-a.
/// json` under Node (0002) -- the same script as `script_a()` below, driven through the real admit
/// pipeline (`sim_connect`/`sim_admit`, `tests/support/scenario.ts`'s `runScriptScenario`) rather
/// than this test's own direct-to-`Sim` `run_script` bypass. Both reach the identical hash
/// (`0a7cc2623a83a03e` since M21b's new `Store::encode` sections; `d5fd55ce8f13a67e` at M21;
/// `7bdddfc9c749b1fb` before): `Host::connect`'s own extra
/// `Record::Player{Connected}` (`script_a()` only ever queues `Joined`) is a no-op for `Puts::
/// on_player`, which only handles `Joined` (Deviations has the full reasoning).
#[test]
fn puts_script_a_golden() {
    let mut sim = new_sim(1);
    let hash = run_script(&mut sim, &script_a());
    engine::testing::assert_golden_named(
        env!("CARGO_MANIFEST_DIR"),
        "golden-script-a.json",
        &[hash],
    );
}

/// A replay from the same genesis, running the identical script, must reproduce the same hash
/// (0004: "replay rejects it again, identically").
#[test]
fn replay_equals_live() {
    let mut live = new_sim(1);
    let live_hash = run_script(&mut live, &script_a());

    let mut replay = new_sim(1);
    let replay_hash = run_script(&mut replay, &script_a());

    assert_eq!(live_hash, replay_hash);
}

/// What makes `replay_equals_live` meaningful: a replay of a *prefix* of the same log must differ,
/// proving the hash actually depends on the whole log rather than passing vacuously.
#[test]
fn truncated_log_differs() {
    let full_script = script_a();
    let mut full = new_sim(1);
    let full_hash = run_script(&mut full, &full_script);

    let mut truncated = new_sim(1);
    let truncated_hash = run_script(&mut truncated, &full_script[..full_script.len() - 1]);

    assert_ne!(full_hash, truncated_hash);
}
