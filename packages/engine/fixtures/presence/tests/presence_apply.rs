//! `apply_range_is_replayable` (docs/plan/19-presence-channel.md Tests added, step 1): `apply`'s
//! own `dist(from, tile)` check is self-contained (no `PresenceTable` in scope at all -- its
//! signature cannot name one), so `testkit::run_script` (which never touches `admit` either)
//! reproduces the same hash across two independent runs of the same script.

use engine::game::PlayerId;
use engine::sim::{Record, Sim, WorldParams};
use engine::testing::testkit;
use engine::time::Tick;
use fx_presence::{Action, Presence, TileXY, WorldXY};

fn new_sim(seed: u64) -> Sim<Presence> {
    Sim::genesis(WorldParams {
        seed,
        worldgen: (),
        max_entities: 262_144,
        max_modified_tiles: 1_048_576,
        max_action_growth: 4_096,
    })
}

#[test]
fn apply_range_is_replayable() {
    let script = vec![
        (
            Tick(1),
            Record::Player {
                who: PlayerId(1),
                ev: engine::game::PlayerEvent::Joined,
            },
        ),
        (
            Tick(2),
            Record::Action {
                who: PlayerId(1),
                seq: 1,
                action: Action::Poke {
                    tile: TileXY { x: 0, y: 0 },
                    from: WorldXY { x: 0, y: 0 },
                },
            },
        ),
        (
            Tick(2),
            Record::Action {
                who: PlayerId(1),
                seq: 2,
                action: Action::Poke {
                    tile: TileXY { x: 5, y: -3 },
                    from: WorldXY {
                        x: 4 * 256,
                        y: -3 * 256,
                    },
                },
            },
        ),
    ];
    let hash1 = testkit::run_script(&mut new_sim(7), &script);
    let hash2 = testkit::run_script(&mut new_sim(7), &script);
    assert_eq!(
        hash1, hash2,
        "the same script must reproduce the same hash with no PresenceTable in scope at all"
    );
}
