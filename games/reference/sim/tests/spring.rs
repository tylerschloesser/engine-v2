//! `spring_settles_and_is_dt_independent` (docs/plan/20b-reference-player-and-collect-ui.md Tests
//! added): the closed-form critically damped spring (`reference_sim::client::spring_step`) reaches
//! (within tolerance) the same end state after the same elapsed time, regardless of how many
//! substeps that time is split into -- the whole point of a closed-form integrator over Euler
//! stepping (0001 Sources).

use reference_sim::client::spring_step;

const OMEGA: f64 = 6.0;

/// Runs the spring for `total_secs` at a fixed rate (`hz` steps per second), from `pos=0,vel=0`
/// toward a stationary `target` (`target_vel = 0`), and returns the final `(pos, vel)`.
fn run(hz: f64, total_secs: f64, target: f64) -> (f64, f64) {
    let dt = 1.0 / hz;
    let steps = (total_secs * hz).round() as u32;
    let mut pos = 0.0;
    let mut vel = 0.0;
    for _ in 0..steps {
        let (p, v) = spring_step(pos, vel, target, 0.0, OMEGA, dt);
        pos = p;
        vel = v;
    }
    (pos, vel)
}

#[test]
fn spring_settles_and_is_dt_independent() {
    let target = 10.0;
    let (pos_30, vel_30) = run(30.0, 2.0, target);
    let (pos_60, vel_60) = run(60.0, 2.0, target);
    let (pos_120, vel_120) = run(120.0, 2.0, target);

    // Settled: after 2 s at omega=6 (time constant ~0.167 s, ~12 time constants), the spring is
    // within a thousandth of a tile of the target and effectively at rest.
    for (pos, vel) in [(pos_30, vel_30), (pos_60, vel_60), (pos_120, vel_120)] {
        assert!((pos - target).abs() < 1e-2, "settled position: {pos}");
        assert!(vel.abs() < 1e-2, "settled velocity: {vel}");
    }

    // The whole point of a closed-form integrator: the same elapsed time gives (nearly) the same
    // end state whether it is stepped at 30, 60 or 120 Hz -- unlike Euler integration, whose error
    // scales with step size.
    assert!(
        (pos_30 - pos_60).abs() < 1e-4,
        "30 vs 60 Hz: {pos_30} vs {pos_60}"
    );
    assert!(
        (pos_60 - pos_120).abs() < 1e-4,
        "60 vs 120 Hz: {pos_60} vs {pos_120}"
    );
}

#[test]
fn spring_lags_a_moving_target_before_it_settles() {
    // One single 16 ms step toward a target 10 tiles away: the spring must not have arrived yet
    // (Scope: "the circle lags"), but must have moved toward it (not stayed at the origin).
    let (pos, _vel) = spring_step(0.0, 0.0, 10.0, 0.0, OMEGA, 0.016);
    assert!(pos > 0.0, "spring should move toward the target: {pos}");
    assert!(pos < 10.0, "spring should not have arrived yet: {pos}");
}

#[test]
fn spring_zero_dt_is_a_no_op() {
    let (pos, vel) = spring_step(3.0, 1.5, 10.0, 0.0, OMEGA, 0.0);
    assert_eq!(pos, 3.0);
    assert_eq!(vel, 1.5);
}
