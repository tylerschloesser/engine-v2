//! M26 steps 4-6, Tests added: `own_timer_no_jump_at_
//! ack`, `own_timer_correction_eases` (k = 2 of 20, as the spike), `completion_gap_measured`.
//! `lead_converges_to_exact` (Open gate failures item 2, gate round 1) joins them: the same real
//! `Loopback` round trip, pinning the measured exact figure (`delay + 1`) rather than the brief's
//! own must-knows figure (`2 * delay + 1`, which `Loopback`'s asymmetric uplink never produces --
//! `Self::round_trip`'s own doc comment).
//!
//! All three drive a real `ClientCore<Predict>` through `Loopback`'s real dispatch/ack round trip
//! (`LeadEstimator`/`ClientCore::on_ack_sample` are exercised for real, not reimplemented), but
//! `started_at`/`done_at` are computed here from `ClientCore::predicted_tick()` at dispatch time
//! plus `fx_predict::COLLECT_TICKS`, the same arithmetic `Predict::apply`'s own `Collect` handler
//! performs -- never read back out of `Player::collecting` itself. That deliberately sidesteps a
//! separate question these tests do not answer: `Collecting::started_at`/`done_at` themselves
//! differ between the client's own frozen-predicted-tick value and the host's real-tick value
//! once the ack lands (a property of *this game's own timer storage*, not of `Clocks::own_progress`
//! -- 0012's own text describes the *clock*'s continuity guarantee, given a stable `(started_at,
//! done_at)` pair, which is exactly what a fixed, externally-tracked pair gives these tests; M20b's
//! interim call stands until a real game adopts `own_progress` for its own stored timer, M33/34).

use engine::client::Clocks;
use engine::game::{Game, PlayerId, WorldRead};
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::time::Ticks;
use engine::wire::CameraReport;
use engine::world::{CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Tile};
use engine::worldgen::Worldgen;
use fx_predict::{Action, COLLECT_TICKS, Pos, Predict, PredictWorldgen};

struct GenSource;
impl PristineSource for GenSource {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        PredictWorldgen::generate(0, &(), chunk, out);
    }
}

fn dims() -> ChunkDims {
    ChunkDims::new(Predict::CHUNK_BITS)
}

fn params(seed: u64) -> WorldParams<Predict> {
    WorldParams {
        seed,
        worldgen: (),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
    }
}

fn loopback(seed: u64) -> Loopback<Predict> {
    Loopback::new(params(seed))
}

fn add_client(lb: &mut Loopback<Predict>, delay: u32) -> (usize, PlayerId) {
    lb.add_client(
        delay,
        dims(),
        Box::new(GenSource),
        CacheCapacity::Chunks(1024),
    )
}

/// Covers the `COLLECTABLE` patch (8..12 x 8..12, `PredictWorldgen::generate`) with a comfortable
/// subscription margin (same shape as `texel.rs`'s own `camera`).
fn camera(cx: i32, cy: i32) -> CameraReport {
    CameraReport {
        center_x: cx,
        center_y: cy,
        half_w: 20,
        half_h: 20,
        vel_x: 0,
        vel_y: 0,
    }
}

/// `Clocks` built by hand from client `i`'s own real `ClientCore` state (the same fields
/// `game_instance.rs`'s two production call sites assemble) -- `tick_fraction`/`predicted` are not
/// this file's concern (`Loopback` has no wall clock, `testkit::Loopback::frame_view`'s own
/// Deviations), only `authoritative`/`lead`/`correction`, which `own_progress`/`progress` read.
fn clocks_now(lb: &Loopback<Predict>, i: usize) -> Clocks {
    let core = lb.client(i);
    Clocks {
        authoritative: core.view().tick(),
        predicted: core.predicted_tick(),
        tick_fraction: 0.0,
        ticks_per_second: 20,
        lead: core.lead(),
        correction: core.own_correction(),
    }
}

/// The real, measured round trip this harness's own `Loopback` gives one action dispatched then
/// acked, at one-way downlink delay `d`, in *steady state* (some other traffic already flowing
/// every tick -- `Host::build_frame` sends nothing on an otherwise-idle tick, 0010, so the very
/// first dispatch after a cold `add_client`/`set_camera`/warm-up always measures high: diagnostic
/// measurement, reverted, showed a uniform `4` for every delay on the very first post-warm-up
/// dispatch, settling to exactly `d + 1` from the second dispatch on for every `d` in `0..=4`).
/// **Deviation from the brief's must-knows** ("lead_converges_to_exact expects 2 × delay + 1"):
/// measured `d + 1`, not `2*d + 1` -- `Loopback`'s own uplink half has no modelled delay at all
/// (`testing::testkit`'s own doc comment on `Loopback::set_camera`: "uplink has no modelled delay
/// here"), so a dispatched action reaches the host and is admitted on the very same tick it is
/// polled, and the queueing delay is paid only once, on the way back down -- `d` ticks of queueing
/// plus one tick for the round trip's own two `Loopback::step` boundaries (dispatch is polled at
/// the *start* of a step, the frame it produces is available to drain no earlier than the *next*
/// step). Every caller of this fixture's own `round_trip` warms up with at least one throwaway
/// dispatch/ack cycle first, to land in the steady-state regime this formula describes.
fn round_trip(delay: u32) -> u32 {
    delay + 1
}

/// Ten throwaway `Roll` dispatch/ack cycles (`Roll` always sends and acks regardless of local
/// prediction outcome, 0012: "the client always sends" -- `Predicting::rng()` is always `Unknown`,
/// so this is exercised as `NotPredictable` locally on every single call, which is exactly why it
/// is chosen: no game-state write of its own to confound a measurement with).
///
/// **Why ten, not one:** the very first dispatch after a cold `add_client`/`set_camera`/warm-up
/// run measures high (diagnostic measurement, reverted -- a uniform `2*delay + 4` on that one call,
/// for every `delay` tried, i.e. leftover subscription-burst backlog draining alongside it), while
/// every dispatch from the second on measures exactly `Self::round_trip(delay)` (also reverted
/// diagnostics, both `Roll` and `SetGlobal`, every `delay` in `0..=4`). Ten cycles both clears that
/// one cold sample out of `LeadEstimator`'s own 8-deep ring (Provides: "median of the last 8
/// samples") and leaves the ring holding eight *identical*, clean `round_trip(delay)` samples --
/// median of eight identical values is that value exactly, not a blend -- so `ClientCore::lead()`
/// reads back `Ticks(round_trip(delay))` deterministically after this call, and stays there
/// (no further drift) until a caller deliberately overrides it.
fn warm_up_round_trip(lb: &mut Loopback<Predict>, i: usize, delay: u32) {
    for _ in 0..10 {
        lb.dispatch(i, Action::Roll);
        let mut acked = false;
        for _ in 0..32 {
            lb.run(1);
            if lb.pending(i).count() == 0 {
                acked = true;
                break;
            }
        }
        assert!(acked, "warm_up_round_trip: never acked within 32 ticks");
    }
    assert_eq!(
        lb.client(i).lead(),
        Ticks(round_trip(delay)),
        "warm_up_round_trip: LeadEstimator's own window did not settle on the clean steady value"
    );
}

/// `lead_converges_to_exact` (Open gate failures item 2, gate round 1): named as the brief's own
/// must-knows asked for, against a real `Loopback` round trip, pinning the *measured* exact figure
/// -- `delay + 1` (`Self::round_trip`'s own doc comment has the measurement and the reason: this
/// harness's uplink half models no delay, so the queueing cost is paid once, not twice) -- as a
/// literal, for delays 0, 1 and 3. Not `2 * delay + 1`: that was the brief's own must-knows'
/// expectation, written before this harness existed to measure against; `crate::clock::lead`'s own
/// `lead_converges_when_every_sample_agrees` still pins `2 * d + 1` as a literal, against synthetic
/// samples fed directly to `LeadEstimator` with no `Loopback` involved, so it is unaffected by this
/// harness's own asymmetric uplink and stays exactly as it was.
#[test]
fn lead_converges_to_exact() {
    for delay in [0u32, 1, 3] {
        let mut lb = loopback(200 + delay as u64);
        let (i, _who) = add_client(&mut lb, delay);
        lb.set_camera(i, camera(10, 10));
        lb.run(2 * delay + 4);
        warm_up_round_trip(&mut lb, i, delay);

        assert_eq!(
            lb.client(i).lead(),
            Ticks(round_trip(delay)),
            "lead did not converge to the measured exact round trip (delay + 1) for delay={delay}"
        );
    }
}

/// `own_timer_no_jump_at_ack`: a real ack that both sets `ClientCore::own_correction()` to `k` and
/// (via `LeadEstimator`, a single sample) moves `lead` by that same `k` must not move `own_progress`
/// at all *at the instant of the ack* (`Clocks::own_progress`'s own doc comment: the "Deviation"
/// paragraph's whole argument). `lead` is deliberately seeded wrong by exactly `k = 2` (Tests added:
/// "k = 2 of 20, as the spike") before dispatch, then a real `Roll` (always sent and acked
/// regardless of local prediction outcome, 0012: "the client always sends") drives one real ack.
///
/// Inject-fail-revert: reverting `own_progress` to the brief's own literal one-line formula
/// (subtracting `correction` from `done_at` alone, `lead` left raw) fails this test's own
/// no-excess-movement assertion at the exact ack step (`0 -> 0.27272728 (expected +0.18181819)`,
/// the residual `k`-tick-sized jump the "Deviation" paragraph's algebra predicts); reverted.
#[test]
fn own_timer_no_jump_at_ack() {
    let delay = 3;
    let mut lb = loopback(1);
    let (i, _who) = add_client(&mut lb, delay);
    lb.set_camera(i, camera(10, 10));
    lb.run(2 * delay + 4);
    warm_up_round_trip(&mut lb, i, delay);

    let true_lead = round_trip(delay);
    let k = 2u32;
    let wrong_lead = true_lead - k; // predicted_tick undershoots by k -> ack.tick - predicted_tick = k
    lb.client_mut(i).set_lead(Ticks(wrong_lead));

    let predicted_tick_at_dispatch = lb.client(i).predicted_tick();
    let started_at = predicted_tick_at_dispatch;
    let done_at = started_at + COLLECT_TICKS;

    lb.dispatch(i, Action::Roll);
    let start_clocks = clocks_now(&lb, i);
    let mut last = start_clocks.own_progress(started_at, done_at);
    let mut last_auth = start_clocks.authoritative.0;
    // `own_progress`'s own denominator is constant across the ack by construction (`Clocks::
    // own_progress`'s own "Deviation" doc comment: `effective_lead = lead - correction` is
    // `wrong_lead` both immediately before the ack (`lead=wrong_lead`, `correction=0`) and at the
    // instant of the ack (`lead=true_lead`, `correction=k=true_lead-wrong_lead`) -- not
    // `true_lead`, which is only what `lead` eases *toward*, not the denominator's own value.
    let denom = (done_at.0 - started_at.0 + wrong_lead) as f32;

    let mut saw_ack = false;
    for step in 0..(round_trip(delay) + 2) {
        let pending_before = lb.pending(i).count();
        lb.run(1);
        let pending_after = lb.pending(i).count();
        let clocks = clocks_now(&lb, i);
        let now = clocks.own_progress(started_at, done_at);
        // No non-empty frame arrived between two consecutive `lb.run(1)` calls in an otherwise
        // idle world (0010: "idle ticks send nothing") -- `authoritative` (and so `own_progress`)
        // simply does not move at all until the next one does, real ticks elapsed or not. The
        // no-jump property this test pins is about *excess* movement beyond however many real
        // ticks actually elapsed, not about the raw per-`run(1)`-call delta.
        let elapsed = clocks.authoritative.0 - last_auth;
        if !saw_ack && pending_before == 1 && pending_after == 0 {
            saw_ack = true;
            assert_eq!(
                clocks.lead,
                Ticks(true_lead),
                "the ack must have moved lead to the clean steady value"
            );
            let expected_delta = elapsed as f32 / denom;
            assert!(
                ((now - last) - expected_delta).abs() <= 0.01,
                "own_progress moved more than {elapsed} real ticks' worth at the ack (step \
                 {step}): {last} -> {now} (expected +{expected_delta}), correction={}",
                clocks.correction
            );
            assert!(
                (clocks.correction - k as f32).abs() < 0.5,
                "own_correction should read back ~k={k} right at the ack, got {}",
                clocks.correction
            );
        }
        last = now;
        last_auth = clocks.authoritative.0;
    }
    assert!(saw_ack, "Roll's own ack never landed within the run window");
}

/// `own_timer_correction_eases` (Tests added: "k = 2 of 20, as the spike"): the same k=2 ack as
/// above, but this test watches `ClientCore::own_correction()` itself ease from `k` to `0.0` over
/// the ease window (`ClientCore::own_correction`'s own doc comment: ~200 ms, `G::TICK_RATE.
/// millis(200)` -- 4 ticks at 20 Hz) rather than `own_progress`'s continuity.
///
/// Inject-fail-revert: hardcoding `own_correction`'s `frac` to `1.0` (never easing) fails this
/// test's own "reads ~0 well after the window" assertion (`left: 2.0, right: <0.1`); reverted.
#[test]
fn own_timer_correction_eases() {
    let delay = 3;
    let mut lb = loopback(2);
    let (i, _who) = add_client(&mut lb, delay);
    lb.set_camera(i, camera(10, 10));
    // A second, unrelated client whose own `SetGlobal` (broadcast to every connection
    // regardless of subscription, unlike a tile/entity delta) keeps client `i`'s own
    // authoritative clock advancing one real tick per `lb.run(1)` call for the rest of this test
    // -- without *client `i`* ever dispatching anything more itself, so no further ack of its own
    // ever re-fires `on_ack_sample` and overwrites the one correction this test means to watch
    // decay (0012 "idle ticks send nothing", 0010: an otherwise-idle world would freeze
    // `own_correction`'s own elapsed-ticks decay exactly as it freezes everything else).
    let (filler, _filler_who) = add_client(&mut lb, 0);
    lb.run(2 * delay + 4);
    warm_up_round_trip(&mut lb, i, delay);

    let true_lead = round_trip(delay);
    let k = 2u32;
    let wrong_lead = true_lead - k;
    lb.client_mut(i).set_lead(Ticks(wrong_lead));
    lb.dispatch(i, Action::Roll);

    let mut ack_step = None;
    let mut correction_at_ack = 0.0f32;
    for step in 0..(round_trip(delay) + 2) {
        lb.dispatch(filler, Action::SetGlobal { value: step as i32 });
        let pending_before = lb.pending(i).count();
        lb.run(1);
        let pending_after = lb.pending(i).count();
        if ack_step.is_none() && pending_before == 1 && pending_after == 0 {
            ack_step = Some(step);
            correction_at_ack = lb.client(i).own_correction();
        }
    }
    let ack_step = ack_step.expect("Roll's own ack never landed within the run window");
    assert!(
        (correction_at_ack - k as f32).abs() < 0.5,
        "correction at the ack should read back k={k}, got {correction_at_ack}"
    );

    // 0012 "the displayed offset eases to zero over ~200 ms": at 20 Hz that is
    // `G::TICK_RATE.millis(200) = 4` ticks -- run comfortably past it (with real ticks still
    // flowing, per the filler client above) and check it has (almost) fully decayed.
    for n in 0..8i32 {
        lb.dispatch(filler, Action::SetGlobal { value: 1000 + n });
        lb.run(1);
    }
    let after = lb.client(i).own_correction();
    assert!(
        after.abs() < 0.1,
        "correction should have eased close to zero well after the window, got {after}"
    );
    let _ = ack_step;
}

/// `completion_gap_measured` (Tests added, verbatim): at delays 0, 1, 3, measures
/// `completion_gap_ticks` for the plain predicted-clock rule (`predicted_tick >= done_at`, no
/// stretch) and for stretch (`own_progress >= 1.0`) against the real tick at which the host's own
/// completion put (`Player::collecting` going from `Some` to `None`, read authoritatively --
/// `WorldRead::player`, not the overlay-merged view) actually lands on this client's replica.
/// `lead` is set to the exact round trip up front (`Self::round_trip`), not left to the estimator's
/// own convergence: this test measures the *rule*, not estimation quality (`lead_converges_to_exact`
/// covers that separately) -- expected gap is `lead` for plain, `0` for stretch, both ± the
/// discrete-tick rounding a single-tick-resolution clock cannot avoid (must-knows: "expected `lead`
/// versus 0 ± lead error").
#[test]
fn completion_gap_measured() {
    println!("delay | round_trip | gap_plain | gap_stretch");
    for delay in [0u32, 1, 3] {
        let mut lb = loopback(100 + delay as u64);
        let (i, who) = add_client(&mut lb, delay);
        lb.set_camera(i, camera(10, 10));
        // A second, unrelated client whose own `SetGlobal` (broadcast to every connection,
        // 0012/0010) keeps client `i`'s own authoritative clock -- and so `predicted`/
        // `own_progress`, both derived from it -- advancing exactly one real tick per `lb.run(1)`
        // call: an otherwise-idle world (nothing but the one `Collect` in flight) only ever
        // produces two real frames (the admit and the completion), so every clock-crossing this
        // test means to time individually would otherwise be observed on the very same iteration
        // as the completion itself (0010 "idle ticks send nothing").
        let (filler, _filler_who) = add_client(&mut lb, 0);
        lb.run(2 * delay + 6);
        warm_up_round_trip(&mut lb, i, delay);

        let lead = round_trip(delay);
        lb.client_mut(i).set_lead(Ticks(lead));

        let predicted_tick_at_dispatch = lb.client(i).predicted_tick();
        let started_at = predicted_tick_at_dispatch;
        let done_at = started_at + COLLECT_TICKS;
        lb.dispatch(
            i,
            Action::Collect {
                tile: Pos { x: 8, y: 8 },
            },
        );

        let mut plain_full_step = None;
        let mut stretch_full_step = None;
        let mut started_seen = false;
        let mut arrival_step = None;
        for step in 0..200u32 {
            lb.dispatch(filler, Action::SetGlobal { value: step as i32 });
            lb.run(1);
            let clocks = clocks_now(&lb, i);
            if plain_full_step.is_none() && clocks.predicted.0 >= done_at.0 {
                plain_full_step = Some(step);
            }
            if stretch_full_step.is_none() && clocks.own_progress(started_at, done_at) >= 1.0 {
                stretch_full_step = Some(step);
            }
            // The authoritative (not overlay-merged) `Player::collecting`: `Some` once the host's
            // own `Collect` admits, `None` again once its tick rule resolves it -- the *second*
            // transition, never the initial idle `None` every player starts in.
            let replica = lb.client(i).view();
            if let Ok(p) = replica.player(who) {
                if p.collecting.is_some() {
                    started_seen = true;
                } else if started_seen && arrival_step.is_none() {
                    arrival_step = Some(step);
                }
            }
            if plain_full_step.is_some() && stretch_full_step.is_some() && arrival_step.is_some() {
                break;
            }
        }
        let plain_full_step = plain_full_step.expect("plain rule must read full within 200 ticks");
        let stretch_full_step =
            stretch_full_step.expect("stretch rule must read full within 200 ticks");
        let arrival_step = arrival_step.expect("completion must arrive within 200 ticks");

        let gap_plain = arrival_step as i64 - plain_full_step as i64;
        let gap_stretch = arrival_step as i64 - stretch_full_step as i64;
        println!("{delay:5} | {lead:10} | {gap_plain:9} | {gap_stretch:11}");

        assert!(
            (gap_plain - lead as i64).abs() <= 1,
            "delay={delay}: gap_plain should be ~lead={lead}, got {gap_plain}"
        );
        assert!(
            gap_stretch.abs() <= 1,
            "delay={delay}: gap_stretch should be ~0, got {gap_stretch}"
        );
    }
}
