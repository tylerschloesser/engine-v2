//! docs/plan/24-recovery-and-migration.md step 2/3: `progress_cursor_written_before_each_phase`.
//! Proves, per phase, that `Host<G>` writes a `ProgressCursor` before starting that phase's own
//! risky work -- for `Admit`/`ApplyRecord`/`Tick` by triggering a *real* panic (via `panicky`'s own
//! actions) and inspecting `Host::progress()` (the last write standing) once `catch_unwind` catches
//! it; for `BuildFrame`/`Snapshot`/`Replay` (none of which panic in this fixture) via `Host::
//! start_progress_log`/`take_progress_log`, which records every write in order. Native only: no
//! ABI/`.wasm` involved (`Host<G>`'s own inherent/`Instance` trait methods, `testkit::Loopback`).

use std::panic::AssertUnwindSafe;

use engine::abi::{Instance, Status};
use engine::persist::Phase;
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use fx_panicky::{Action, Panicky};

fn params() -> WorldParams<Panicky> {
    WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 64,
        max_modified_tiles: 64,
        max_action_growth: 64,
    }
}

#[test]
fn progress_cursor_written_before_each_phase() {
    // Admit: `PanicInAdmit` panics inside `Game::admit`, before the record is even queued.
    {
        let mut lb = Loopback::<Panicky>::new(params());
        let player = lb.host.connect(0);
        lb.host.start_progress_log();
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            lb.action(player, Action::PanicInAdmit);
        }));
        assert!(result.is_err(), "PanicInAdmit must panic");
        let log = lb.host.take_progress_log();
        assert!(
            log.iter().any(|c| c.phase == Phase::Admit),
            "Admit phase never written before the panic: {log:?}"
        );
    }

    // ApplyRecord: `PanicInApply` admits cleanly, panics inside `Game::apply` at `Host::tick()`.
    {
        let mut lb = Loopback::<Panicky>::new(params());
        let player = lb.host.connect(0);
        lb.action(player, Action::PanicInApply);
        lb.host.start_progress_log();
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            lb.host.tick();
        }));
        assert!(result.is_err(), "PanicInApply must panic at tick");
        let log = lb.host.take_progress_log();
        assert!(
            log.iter().any(|c| c.phase == Phase::ApplyRecord),
            "ApplyRecord phase never written before the panic: {log:?}"
        );
    }

    // Tick: `ArmTickPanic { at: 0 }` admits and applies cleanly (only arms a flag), then panics
    // inside `Game::tick` itself, the same `Host::tick()` call.
    {
        let mut lb = Loopback::<Panicky>::new(params());
        let player = lb.host.connect(0);
        lb.action(player, Action::ArmTickPanic { at: 0 });
        lb.host.start_progress_log();
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            lb.host.tick();
        }));
        assert!(
            result.is_err(),
            "ArmTickPanic{{ at: 0 }} must panic at tick"
        );
        let log = lb.host.take_progress_log();
        assert!(
            log.iter().any(|c| c.phase == Phase::Tick),
            "Tick phase never written before the panic: {log:?}"
        );
    }

    // BuildFrame: never panics in this fixture -- proved via the full log instead (this
    // implementer's own anti-vacuity hunt, Deviations, removed this write by hand and watched a
    // sibling assertion fail).
    {
        let mut lb = Loopback::<Panicky>::new(params());
        lb.host.connect(0);
        lb.host.start_progress_log();
        let mut buf = vec![0u8; 8192];
        let _ = lb.host.sim_build_frame(0, &mut buf);
        let log = lb.host.take_progress_log();
        assert!(
            log.iter().any(|c| c.phase == Phase::BuildFrame),
            "BuildFrame phase never written: {log:?}"
        );
    }

    // Snapshot.
    {
        let mut lb = Loopback::<Panicky>::new(params());
        lb.host.connect(0);
        lb.host.start_progress_log();
        assert_eq!(lb.host.sim_snapshot_begin(0, 0), Status::Ok);
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let n = lb
                .host
                .sim_snapshot_next(&mut buf)
                .expect("a freshly-begun snapshot must drain");
            if n == 0 {
                break;
            }
        }
        let log = lb.host.take_progress_log();
        assert!(
            log.iter().any(|c| c.phase == Phase::Snapshot),
            "Snapshot phase never written: {log:?}"
        );
    }

    // Replay: `sim_replay_begin`/`sim_replay_push` mark this phase before decoding, even over an
    // empty push (nothing to apply, still risky container code by this milestone's own framing).
    {
        let mut lb = Loopback::<Panicky>::new(params());
        lb.host.start_progress_log();
        assert_eq!(lb.host.sim_replay_begin(0, 0), Status::Ok);
        assert_eq!(lb.host.sim_replay_push(&[]), Status::Ok);
        let log = lb.host.take_progress_log();
        assert!(
            log.iter().any(|c| c.phase == Phase::Replay),
            "Replay phase never written: {log:?}"
        );
    }
}
