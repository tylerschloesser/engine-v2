# M39m: A flick's distance does not depend on the frame rate, and the check can fail

Status: done (2026-10-06) · After: 39l · Tyler-dependent: no

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
- [x] The three tests exist, pass, and each was seen red.
- [x] Existing camera tests (`pnpm test unit -t camera`), `[gc] input` and the slice browser tests stay green; no golden, budget or baseline changed.
- [x] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t "camera|flick"` · `node --test scripts/lib/device-walk-checks.test.mjs` (or the suite that runs it) · `pnpm test browser -t slice` (targeted, foreground).

## Manual device checks
After landing, the orchestrator re-runs M16-low-power driven on the iPhone (`pnpm device:walk --auto --drive ios --round m39m-iphone --only M16-low-power`): pass is ratio 0.95–1.05 with `flick_release_ratio` near 1.

## Deviations
- Tail: `applyPointers` (`camera.ts`), in the `activeCount !== 2` branch: when `activeCount === 0` and the previous frame was not a two-finger one (`!wasTwo`), each slot with `wasActive===1 && !active` moves the centre by `-(slot.x-lastX)/ppt`. No allocation.
- Red lines, against the old tail (camera.ts at `de4f112`): `camera: flick glide distance is frame-rate independent` -> `expected 0.0411 to be less than 0.01` (d30 vs d60 differ 4.1 %; the test places frames at a 5 ms phase so `up` falls mid-interval); `camera: release applies the movement since the last frame` -> `expected 0.7318 to be close to 1.4818` (the 60 px, 0.75 tiles, dropped). `device-walk checks: flick ratio fails outside 0.95-1.05`: with `flick_distance_ratio` limit set to `null`, `expected 'pass' to be 'fail'` (0.768 passed).
- Instrument: `check.act.flick` result is now `{tiles, dx, dy, releaseVx, releaseVy, spacingMaxMs}`. The release velocity is derived on the frame after `up`, which also takes its first decay step, so the act waits for one rendered frame and divides `velocityX/Y` by `exp(-lastFrameDt/325)` (`FLICK_INERTIA_TAU_MS`, a copy of `INERTIA_TAU_MS`) to get the release value (tiles/s). `spacingMaxMs` is the largest real gap between the six `setTimeout(16)` wake-ups. `collect-life.js` `lowPower` adds `release60/30`, `spacing60/30`, `releaseRatio`.
- Criteria: `flick_distance_ratio` (`>=` 0.95, `ref: 'pass'`) and `flick_distance_ratio_max` (`<=` 1.05); `judge: 'always'` and the judge prompt removed; metric `flick_release_ratio` (`lowPower.releaseRatio`). M16-low-power Pass text now names 0.95 and 1.05; hash `39cfc710` -> `f2e7bbb0`.
- Gate round 1: `[gc] input` (clean, neg object client, neg object gen0) went red with the first tail (about 171 B/frame on main). My earlier claim that it failed identically at base was wrong. Cause (not attributed per function; confirmed by the fix): the tail block ran on every idle frame, calling `pxPerTile` and writing `state.centreX/Y` (`-= 0`). The block is now guarded by `wasActive[0] === 1 || wasActive[1] === 1`, so it runs only on the release frame and an idle frame does not touch the camera state. `pnpm test browser -t input` (11 tests) passed 3 of 3: `browser pass 11 tests 5.7s/48s`, `5.4s/48s`, `5.3s/48s`. Camera unit tests unchanged and green.
- I ran `git stash -- camera.ts` once (popped at once) to see the red; a process slip, no state lost.
- **Gate (orchestrator):** round 1 red: `[gc] input clean` / `neg object client` / `neg object gen0` (main about 171 B/frame); bisected by the orchestrator to `camera.ts` (base file: 11 pass; M39m's: 3 red, every run). The report's 'fails identically at base' was wrong. Fixed in `82eabd0` (the tail runs only on the release frame). Round 2: `pnpm test && pnpm lint` green (unit 589, browser 256 in 45 s). Orchestrator inject-fail-revert: tail disabled, both camera tests red (`0.0411 < 0.01`, `0.7318 close to 1.4818`), reverted. **Device re-run pending:** M16-low-power is iPhone-only (Battery Saver does not engage on the charging Pixel), and the iPhone needs its passcode off for WDA.
