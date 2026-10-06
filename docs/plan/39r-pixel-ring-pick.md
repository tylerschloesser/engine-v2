# M39r: M18-pick lands on the Pixel, and a tap's target is recorded

Status: not started · After: 39q · Tyler-dependent: no

## Goal
Finding 7 of the driven rounds: M18-pick passes on the iPhone (9 rings, 0 misses) and fails on the Pixel 5. In every Android round the act "finishes" in 0.6 s, five minutes of silence follow, and the result is a fail with `rings_tapped 0`. The evidence JSON holds only `{ready, actTimedOut: true}`: no tap coordinates, no pick results, no event targets. A read-only diagnosis (2026-10-06) cleared the driver's coordinate mapping (`drive/android.mjs` `toScreen`, `adb shell input tap`, calibrated by `learnChin`; the same mapping serves tap-tile and M18-touch-ghost) and the engine's pick (`input/pick.ts`). The likely cause, **unproven** because no round logged where the events landed: at 40 tiles across a 392 px viewport a ring is about 12 px across, and its 14 px button sits directly against it (`RING_BUTTON_CSS` in the device page, `overlay/anchors.ts`). Chrome Android's touch adjustment snaps a tap near a `<button>` onto the button; WebKit doesn't. The driver's nudge (`person.mjs`, 4 px under the button) is inside the snap radius. The only Pixel probe (39j Deviations) fits: 11 px under the anchor picks the ring, 9 px hits the button.

When this is done the evidence says where each tap landed, the cause is measured, and M18-pick passes on the Pixel without hiding a real-finger problem.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0019-camera-input-and-overlay.md` §4 (pick, overlay anchors)
3. `docs/plan/39j-device-driver.md` Deviations (Android driving, `learnChin`, act coverage, finding 12)

## Order of work
1. **Record targets.** The M18 collector or the device page logs capture-phase `pointerdown`, `pointerup` and `click` (target tag or id, `clientX`/`clientY`, `pointerType`) per tap into the evidence. On an act timeout it writes the last events seen instead of only `actTimedOut`. Unit-test the evidence shape.
2. **Measure.** Don't drive the phone yourself. Give the orchestrator one command (`pnpm device:walk --auto --drive android --tunnel --round m39r-probe --only M18-pick`) and stop with a report. The orchestrator runs it and sends you the evidence. The diagnosis's hypothesis stands or falls on whether the `pointerdown` target is the button.
3. **Fix at the cause.** If it is touch adjustment: in the fixture page, give each ring's button at least 24 px clearance from its ring at every zoom the item uses. Keep the ring its real size, and don't use `pointer-events: none` during the ring phase (that hides what a real finger meets). Make the driver's `tap-ring` choose the point inside the ring with the most clearance from every button box. Below about 12 px clearance it reports `NotDrivable: ring too close to a button at this zoom` at once instead of hanging for five minutes. If step 2 shows something else, stop and report.
4. **Tests**: a unit test that the chosen tap point keeps at least the clearance from every button box (red on today's `bottom + 4` rule at 9.8 px per tile), and one that a too-tight layout yields `NotDrivable` with no wait.

## Non-scope
Engine pick and overlay code (stop and report if step 2 implicates it); CDP touch for single taps (it would bypass the touch adjustment a finger meets); the reference game's own button layout (note it in Deviations if it shows the same geometry).

## Files touched
The device fixture page (`packages/engine/tests/browser/pages/src/device.ts`), `scripts/lib/device-walk/{agent/collect-*.js,drive/person.mjs,drive/android.mjs}` and their tests under `scripts/lib/`.

## Exit criteria
- [ ] The tap evidence records event targets, and the cause is named from the probe round in Deviations.
- [ ] The step 4 tests exist, pass, and were seen red.
- [ ] Existing anchors/overlay browser tests stay green; no golden, budget or baseline changed.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t device-walk` · `pnpm test browser -t "anchors|overlay|device"` (targeted, foreground).

## Manual device checks
After landing, the orchestrator runs M18-pick driven on the Pixel and on the iPhone (the iPhone once its passcode is off). Pass: 9 taps recorded with their targets, 0 misses.

## Deviations
(filled in during Phase 3)
