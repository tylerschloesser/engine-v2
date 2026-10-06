# M39i: A flick glides with the drag, not against it

Status: not started · After: 39h · Tyler-dependent: no

## Goal
The Pixel 5 device-driver spike (`spikes/device-driver-android/RESULT.md`, 2026-10-05) saw every fast flick through real OS input glide the wrong way (5 of 5; finger left, `centre_x 33.8 → -196.9`). A read-only diagnosis traced it to a missing negation present since M11 step 3 (`926eb5b`), on every platform:
- The drag moves the camera opposite to the finger: `state.centreX -= (slot.x - lastX)/ppt` (`packages/engine/src/camera/camera.ts`, `applyPointers`).
- The release sets `state.velocityX = velScratch.x / ppt` (`updateSlotBookkeeping`). `pointerVelocity` (`input/pointers.ts`) returns the **finger's** velocity.
- `applyInertia` then does `centreX += velocityX * disp`, so the glide runs with the finger, against the drag.

A slow drag hid it (release velocity about 0). The iPhone spike's W3C flick produced no glide at all, so it didn't show there. The only inertia test (`camera: inertia decay time based`) writes `velocityX` directly and never goes through a release, so nothing ever checked a real flick's direction. When this is done the glide continues the drag's direction.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0019-camera-input-and-overlay.md` §2-3 (inertia, "the world point stays under the finger")
Rules: `.claude/rules/hot-paths.md`.

## Scope
1. Negate the release velocity in `updateSlotBookkeeping` (camera velocity = minus finger velocity / px per tile), or the equivalent at the one place that converts. Keep `pointerVelocity`'s finger convention and say so in its doc comment.
2. Check every other writer and reader of `velocityX/Y` (`grep -n velocity` in `camera/`, `input/`, `test/headless-client.ts`, the camera block, the reference game's spring) for the same convention. Change only what is wrong, and list each one checked in Deviations.

## Non-scope
Inertia constants, the sample window, coalesced events (the diagnosis ruled out coalescing: the samples are the last coalesced point and the clock is consistent).

## Tests added (each seen red against the old code, red line pasted)
- `camera: flick release glides with the drag direction`: driven through `recordPointerDown/Move/Up` and `integrate` (no direct `velocityX` write). Touch down at x 900, moves every 16 ms to x 300 by 80 ms, up. Right after release `velocityX > 0` and `centreX` keeps increasing for the next 10 frames. Same for the y axis.
- The same with an Android-like pattern: 6 events, one move jumping most of the distance (coalesced batch).
- `input: pointer velocity is the finger's`: finger-left samples give `out.x < 0` (pins the convention the camera negates).

## Exit criteria
- [ ] The tests exist, pass, and each was seen red.
- [ ] No golden, budget or baseline changed; the `[gc] input` page reads within its budget (orchestrator's gate).
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t flick` · `pnpm test unit -t camera` (targeted, foreground).

## Manual device checks
After landing, the orchestrator re-runs the spike's flick on the Pixel: `adb shell input swipe 900 1200 300 1200 80` from rest. `centre_x` 2.5 s after `pointerup` must be above its value at release.

## Deviations
- Fix: `updateSlotBookkeeping` (`camera/camera.ts`) now sets `velocityX/Y = -velScratch / ppt`. `pointerVelocity` unchanged (finger convention), doc comment says so.
- Red lines (old code): flick tests `expected -89.24638321346593 to be greater than 0` (both, x axis first). The `input: pointer velocity is the finger's` test pins existing behaviour so it passes on the old code; seen red by injecting a sign flip in `pointerVelocity`: `expected 7500 to be close to -7500`.
- Writers/readers of `velocityX/Y` checked, all in the camera convention (world tiles/s, positive = centre moves +): `camera.ts` zero-resets (lines ~367, 420, 448) and `applyInertia` (adds `velocity * disp`); `state.ts` copy; `block.ts` writes it into the shared block unchanged; `test/headless-client.ts` `advancePan` (velocity = direction towards target) and `setView` (`velX/velY` from the report); browser pages `gc-*.ts`, `gen.ts`, `terrain-client.ts`, `moving-remote.ts` and netcode `rates`/`interpolation` tests all set a positive world velocity for motion in +x. No change needed. The reference game has no `velocity` reader.
- Tests live in `camera/camera.test.ts` (two flick tests, x and y in each) and `input/gestures.test.ts` (pointer velocity).
- Verified: `pnpm test unit -t "flick|pointer velocity"` pass 3 tests; `pnpm test unit -t camera` pass 21 tests.
