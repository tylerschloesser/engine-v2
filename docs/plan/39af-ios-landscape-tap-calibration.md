# M39af: the iPhone driver calibrates taps in landscape

Status: not started · After: 39ad · Tyler-dependent: no

## Goal
M18-touch-ghost failed in the driven iPhone round `m39ad-iphone-driven` with every criterion null. Diagnosis (reproduced on the iPhone, round `docs/plan/device-rounds/m39ad-touch-ghost-diag.jsonl`, with `IOS_TRACE=1`): the item before it, M18-fill-rate-with-anchors, leaves the phone in landscape. `placement()` in `scripts/lib/device-walk/drive/ios.mjs` (~l.376-415) calibrates the page offset by tapping the screen point (`screen.width/2`, `screen.height/2`) = (195, 422). iOS Safari does not swap `screen.width/height` in landscape, so y=422 is off the 844×390 screen. WDA clamps it to the bottom edge, and the calibration `pointerdown` comes back at page y=280 = `innerHeight`. The computed offset is 142 pt instead of the true 110 (the tab strip above the page), so `tap()` (~l.646) sends every page point 32 pt low. The tile tap landed on the walk bar, the page counted no tap, and the act timed out. When this is done, calibration is right in both orientations, and a clamped calibration hit can't pass silently.

## Read first
1. `docs/spec/overview.md`
2. `.claude/skills/device-round/SKILL.md` (sections 1b, 1c)
3. `scripts/lib/device-walk/drive/ios.mjs` (`placement`, `tap`, and every caller of the placement offset)

## Scope
1. **Orientation-aware calibration point.** In `placement()`, take the screen size of the current orientation (landscape when `innerWidth > innerHeight`: `(max(sw, sh), min(sw, sh))`) and aim the calibration tap inside the page area of that screen.
2. **A clamped hit is rejected.** If the calibration `pointerdown` lands at or beyond the page edge (within 1 pt of `innerWidth`/`innerHeight`, or at 0), retry once at a point well inside the page. If it is still at an edge, fail the act loudly (`calibration clamped at the page edge`), never with a silently wrong offset.
3. **Check the other gestures.** List every iOS gesture that uses the placement offset (drag, pan, pinch, double-tap, ring taps) and confirm in Deviations that each now gets the corrected offset. No gesture-specific offsets.
4. **Phone proof**, one run, foreground: `IOS_TRACE=1 timeout 1500 pnpm device:walk --auto --drive ios --round m39af-proof --only M18-fill-rate-with-anchors,M18-touch-ghost --timeout 1400` (the order reproduces the landscape start). M18-touch-ghost must reach its "drag" prompt and get a non-null result. Paste the trace's `calibrated` line (expect an offset of about 110 pt in landscape) and the item's result. The pacing numbers of this driven run are not judged (ADR 0056); ignore them. Afterwards, `pgrep -fl "device-walk|appium|xcodebuild|cloudflared|vite preview"` must be empty, and the phone must be back in portrait (check with `pymobiledevice3 developer dvt screenshot <png>`: width < height).

## Non-scope
The page, collectors and criteria; Android; the driverless `--open ios` path (it never taps); rotation cleanup timing (note in Deviations if the 3 s rotation timeout fires again).

## Files touched
`scripts/lib/device-walk/drive/ios.mjs`, its tests in the `tools` suite.

## Tests added
In `pnpm test tools` (fake WDA/page, no phone): a landscape placement (screen 390×844 reported, page 844×280 with the page top at 110) computes an offset of 110, not 142; a calibration hit at the page edge is retried, then fails loudly; portrait is unchanged. Each seen red against the current code (paste the red lines).

## Exit criteria
- [ ] The three tests exist, pass, and were seen red.
- [ ] Step 3's gesture list is in Deviations.
- [ ] The phone proof: M18-touch-ghost reached "drag" and has a result; the `calibrated` trace line is pasted; cleanup is empty and the phone is portrait.
- [ ] `pnpm test tools` green (pasted line).
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test tools` (targeted, foreground), then the one phone proof. Never lock, sleep or Low-Power the phone. Do not run `pnpm device:walk --help` (it starts a round).

## Manual device checks
The orchestrator re-runs M18-touch-ghost on the iPhone afterwards.

## Deviations
(filled in during Phase 3)
