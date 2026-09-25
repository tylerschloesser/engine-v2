//! docs/plan/22-persistence-log-and-snapshots.md Tests added, `camera_walk_changes_no_log`: two
//! `testkit::Loopback` runs of the same action script, each under a *different* scripted camera
//! path, must seal byte-identical write-ahead log frames -- camera reports are never logged
//! (spec `simulation.md`; the engine's own camera/viewport is deliberately non-mutating and no
//! part of the sim, `docs/spec/overview.md`). Needs `Host::sim_seal_frame` wired for real (step 4
//! of this brief); steps 1-3 left this test for the second implementer (Deviations).

use engine::abi::Instance;
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::wire::CameraReport;
use engine::world::{CacheCapacity, ChunkDims};
use engine::worldgen::Pristine;
use fx_persist::{Action, FlatWorldgen, Persist, Pos};

fn params() -> WorldParams<Persist> {
    WorldParams {
        seed: 7,
        worldgen: (),
        max_entities: 64,
        max_modified_tiles: 64,
        max_action_growth: 64,
    }
}

fn source() -> Box<dyn engine::world::PristineSource> {
    Box::new(Pristine::<FlatWorldgen>::new(7, ()))
}

/// Runs `n` ticks, sealing (and returning) every non-empty frame `Host::sim_seal_frame` produces,
/// in order -- called *before* `Loopback::step`'s own `Host::tick()`, matching the ABI's own
/// write-ahead order (`sim_seal_frame()` -> `logSink(view)` -> `sim_tick()`).
fn run_and_seal(lb: &mut Loopback<Persist>, n: u32) -> Vec<u8> {
    let mut buf = vec![0u8; 8192];
    let mut log = Vec::new();
    for _ in 0..n {
        let n = lb
            .host
            .sim_seal_frame(&mut buf)
            .expect("sim_seal_frame must succeed once genesis has run");
        if n > 0 {
            log.extend_from_slice(&buf[..n as usize]);
        }
        lb.step();
    }
    log
}

#[test]
fn camera_walk_changes_no_log() {
    let mut lb_a = Loopback::<Persist>::new(params());
    let (client_a, player_a) =
        lb_a.add_client(0, ChunkDims::new(5), source(), CacheCapacity::Unlimited);
    let mut lb_b = Loopback::<Persist>::new(params());
    let (client_b, player_b) =
        lb_b.add_client(0, ChunkDims::new(5), source(), CacheCapacity::Unlimited);
    assert_eq!(
        player_a, player_b,
        "identical params/seed must connect the same PlayerId"
    );

    // `Loopback::add_client` connects immediately (`Host::connect`, queuing `Record::Player
    // {Joined}`), so both runs already share one logged record before any script line below --
    // exactly the "connection events are logged, camera reports are not" contrast this test needs.
    let mut log_a = run_and_seal(&mut lb_a, 1);
    let mut log_b = run_and_seal(&mut lb_b, 1);

    // Two deliberately different scripted camera walks (Consumes: "scripted camera paths"): run A
    // walks the camera east one tile per tick, run B walks it in a small square. If a camera report
    // ever leaked into `sim_seal_frame`'s bytes, these two logs would diverge from here on.
    for t in 0..40u32 {
        lb_a.set_camera(
            client_a,
            CameraReport {
                center_x: t as i32,
                center_y: 0,
                half_w: 16,
                half_h: 16,
                vel_x: 1,
                vel_y: 0,
            },
        );
        let bx = match t % 4 {
            0 => (0, 0),
            1 => (5, 0),
            2 => (5, 5),
            _ => (0, 5),
        };
        lb_b.set_camera(
            client_b,
            CameraReport {
                center_x: bx.0,
                center_y: bx.1,
                half_w: 8,
                half_h: 8,
                vel_x: -1,
                vel_y: 1,
            },
        );

        if t == 3 {
            lb_a.action(
                player_a,
                Action::PlaceTimer {
                    at: Pos { x: 1, y: 1 },
                    period: 5,
                },
            );
            lb_b.action(
                player_b,
                Action::PlaceTimer {
                    at: Pos { x: 1, y: 1 },
                    period: 5,
                },
            );
        }
        if t == 10 || t == 20 {
            lb_a.action(player_a, Action::Roll);
            lb_b.action(player_b, Action::Roll);
        }

        log_a.extend_from_slice(&run_and_seal(&mut lb_a, 1));
        log_b.extend_from_slice(&run_and_seal(&mut lb_b, 1));
    }

    assert!(
        !log_a.is_empty(),
        "the script above must produce at least one logged frame"
    );
    assert_eq!(
        log_a, log_b,
        "camera reports must never change the write-ahead log (spec simulation.md: the camera \
         never mutates the world and is not an action)"
    );

    // `on_player`'s `Joined` -> `put_player` write means both runs are equally non-idle at the
    // very first tick, so this isn't a trivial "nothing was ever logged" pass.
    assert!(
        log_a.len() > 4,
        "expected more than just the Joined connection frame"
    );
}
