//! `idle_world_visits_zero_entities` (docs/plan/21b-timers-wakeups-and-tickcx.md Tests added): a
//! world of 10k sleeping machines -- placed directly via `testkit::fill_world` (bypassing
//! `Authority`, so none of them is ever auto-woken, scheduled, or put on an active list) -- costs
//! zero per tick, proving tick cost is O(active entities), not O(entities) (0007 §7).

use engine::game::{PlayerEvent, PlayerId};
use engine::sim::{Record, Sim, WorldParams};
use engine::testing::testkit::fill_world;
use fx_machines::{Action, Machines, Pos};

#[test]
fn idle_world_visits_zero_entities() {
    let mut sim = Sim::<Machines>::genesis(WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 20_000,
        max_modified_tiles: 20_000,
        max_action_growth: 4096,
    });
    fill_world(&mut sim, 10_000, 0);
    assert_eq!(sim.authority().store().entity_count(), 10_000);

    let mut out = Vec::new();
    for _ in 0..50 {
        sim.step(&[], &mut out);
        assert_eq!(
            sim.authority().entities_visited_per_tick(),
            0,
            "a world of never-fed, never-activated machines must visit nothing per tick"
        );
    }
    // Nothing was ever scheduled: the timer wheel and every active list stay empty throughout.
    assert_eq!(sim.authority().store().timers_pending(), 0);

    // Anti-vacuity for the assertion above: `entities_visited_per_tick` must be a real counter,
    // not a stub that always reads 0 (which would make every assertion above pass no matter what
    // the tick rule actually visits). One `Place` (a real apply-time put, auto-woken the same
    // tick) must make the very next tick's own count nonzero.
    let p1 = PlayerId(1);
    sim.step(
        &[
            Record::Player {
                who: p1,
                ev: PlayerEvent::Joined,
            },
            Record::Action {
                who: p1,
                seq: 1,
                action: Action::Place {
                    origin: Pos { x: 500, y: 500 },
                },
            },
        ],
        &mut out,
    );
    assert!(
        sim.authority().entities_visited_per_tick() >= 1,
        "a freshly placed machine must be visited (woken) the same tick it was placed"
    );
}
