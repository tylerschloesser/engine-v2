//! `idle_world_visits_zero_entities` (docs/plan/21b-timers-wakeups-and-tickcx.md Tests added): a
//! world of 10k sleeping machines -- placed directly via `testkit::fill_world` (bypassing
//! `Authority`, so none of them is ever auto-woken, scheduled, or put on an active list) -- costs
//! zero per tick, proving tick cost is O(active entities), not O(entities) (0007 §7).

use engine::sim::{Sim, WorldParams};
use engine::testing::testkit::fill_world;
use fx_machines::Machines;

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
}
