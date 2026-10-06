# M39m: A flick's distance does not depend on the frame rate, and the check can fail

Status: not started · After: 39l · Tyler-dependent: no

## Goal
Finding 3 of the driven rounds (`docs/plan/device-rounds/m39j-ios-lp.jsonl`, iPhone 12): with Low Power Mode on (rAF p50 33.4 ms against 16.7 ms) the scripted flick of M16-low-power travelled 0.768 as far (15.829 against 20.605 tiles). A read-only diagnosis (2026-10-06) found that the camera glide is time-based: `applyInertia` (`packages/engine/src/camera/camera.ts`) decays analytically, `exp(-dt/tau)`, with no dt clamp. The likely cause is the instrument. The page's `check.act.flick` (`packages/engine/tests/browser/pages/src/slice.ts`) stamps each injected sample with `performance.now()` after a `setTimeout(16)`, so the release velocity is 60 px divided by the *real timer spacing*. Low Power Mode probably stretches that spacing (a guess, unmeasured: the evidence has no sample times). The criterion `flick_distance_ratio` (`scripts/lib/device-walk/checks.mjs`) has `limit: null`, so it can never fail. On the way the diagnosis found one small engine defect: the drag delta between the last frame and `pointerup` is never applied (`applyPointers` only moves the camera for an active slot; `recordPointerUp` writes the final position and deactivates it). That costs about `v*dt/2`, more at 30 Hz.

When this is done the flick act measures the engine (fixed sample times, release velocity recorded), the criterion fails outside 0.95–1.05, the release tail is applied, and a unit test pins equal glide distance at 60 and 30 Hz.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0019-camera-input-and-overlay.md` §2-3 (inertia, time-based motion)
3. `docs/plan/39f-device-auto-runner.md` Deviations (criteria shape in `checks.mjs`: `source`, `op`, `limit`, `judge`; the Pass hash)
Rules: `.claude/rules/hot-paths.md`.

## Scope
1. **Engine, release tail.** On a pointer's release with no other pointer of the gesture still active, the camera applies the movement since the last applied position (`centre -= (slot.x - lastX)/ppt`, y alike) before the release velocity takes over. Find the one place (`updateSlotBookkeeping` / `applyPointers` in `camera/camera.ts`); no allocation.
2. **Instrument.** `check.act.flick` stamps its samples with computed times (`t0 + i * 16.667` ms, `up` at the last move's time) instead of `performance.now()`, so every flick has the same release velocity whatever the timers do. Its result adds `releaseVx` / `releaseVy` (the camera's `velocityX/Y` read right after `up`, tiles/s) and the real sample spacing it observed (`spacingMaxMs`). `collect-life.js` puts `release60`, `release30` and `spacing60/30` beside `tiles60/30` in `lowPower`.
3. **Criterion.** `flick_distance_ratio` gets `limit: 0.95` (`>=`) and a second criterion `flick_distance_ratio_max` (`<=` 1.05, same source), neither `judge: 'always'`. Update the item's Pass text in `docs/plan/device-checks.md` (M16-low-power: "flick distance at the halved rate within 5 % of the normal rate") and its Pass hash in `checks.mjs`. A new metric `flick_release_ratio` (release30/release60) is shown, so a future miss says whether the velocity or the glide differed.

## Non-scope
Inertia constants; `pointerVelocity`'s window; real-finger (WDA) flicks; driving Low Power Mode (the driver already does on the iPhone; the Pixel can't while charging).

## Files touched
`packages/engine/src/camera/camera.ts`, `camera/camera.test.ts`, `packages/engine/tests/browser/pages/src/slice.ts`, `scripts/lib/device-walk/agent/collect-life.js`, `scripts/lib/device-walk/checks.mjs` and its tests (`scripts/lib/device-walk-checks.test.mjs`), `docs/plan/device-checks.md` (M16-low-power line only).

## Tests added (each seen red, red line pasted in Deviations)
- `camera: flick glide distance is frame-rate independent` (`camera.test.ts`, no DOM): the same stamped samples (60 px per 16.667 ms, 6 steps, `up` between frames) integrated at 16.667 ms and at 33.333 ms steps for 1600 ms; the two total distances agree within 1 %, and each is within 1 % of `360/ppt + v*tau/ppt`. Red against the old tail (show it).
- `camera: release applies the movement since the last frame`: down, one frame, move +60 px, up with no frame between, one integrate: the centre moved the full `60/ppt` (plus the glide's first step). Red today.
- `device-walk checks: flick ratio fails outside 0.95-1.05` (0.768 fails, 1.0 passes, 1.06 fails). Red by setting the limit back to null.

## Exit criteria
- [ ] The three tests exist, pass, and each was seen red.
- [ ] Existing camera tests (`pnpm test unit -t camera`), `[gc] input` and the slice browser tests stay green; no golden, budget or baseline changed.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t "camera|flick"` · `node --test scripts/lib/device-walk-checks.test.mjs` (or the suite that runs it) · `pnpm test browser -t slice` (targeted, foreground).

## Manual device checks
After landing, the orchestrator re-runs M16-low-power driven on the iPhone (`pnpm device:walk --auto --drive ios --round m39m-iphone --only M16-low-power`): pass is ratio 0.95–1.05 with `flick_release_ratio` near 1.

## Deviations
(filled in during Phase 3)
