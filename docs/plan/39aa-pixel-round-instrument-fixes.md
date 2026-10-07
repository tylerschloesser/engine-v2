# M39aa: three instrument and driver gaps found by the Pixel full round

Status: not started · After: 39z · Tyler-dependent: no

## Goal
The driven Pixel full round `m39y-full-pixel` (2026-10-07) failed M11-gestures, M34-remote-motion, M29-socket-resume and M29-play-through-drop. A read-only diagnosis (`test-results/m39y-pixel-fails-diagnosis.md`, not committed) traced all of them to the instrument or the driver. None is an engine defect. When this is done, each gap has a test that fails the way the round did, the fix makes it pass, and the orchestrator re-runs those items on the Pixel.

1. **M11-gestures, pan step 0:** `panMs` was 729 against the ≥ 10,000 the step needs (passing rounds: 12,077). This was the first M11 run that started in **landscape**: M09b-fill-rate passed at rung 0 this round and left the phone rotated, where its four failing rungs used to end in portrait. In landscape, the driver's pan swipe (`drive/person.mjs`) starts about 9 css px from the walk-bar sheet. Likely cause: the sheet or a `pointercancel` cuts the pointer stream. The series has no pointercancel count, so this is not yet proven.
2. **M34-remote-motion, the 64-tile jump and `max_still_ms` 167:** `check.ts world()` records the circle's `pos` relative to the draw list's window origin. The origin snaps to multiples of 64 tiles (`drawlist.rs` about line 152, ADR 0018 §2). The phone camera crossed x = 0 between frames 0 and 1, so x read 64.52 and then 0.52, exactly 64.000 apart, while the remote stood still. `stepsWhileMoving` (`checks.mjs` about line 1770) then counted frames 1-11 as "moving" because its window included the jump. Replayed without the artefact, max still is 17 ms.
3. **M29-socket-resume and M29-play-through-drop, 0 runs:** during the 300 s app-leave, the page stops pinging. The drive loop's watchdog (idle limit 180 s, added in `15bd65e`) then reopened the join URL, 0.25 s before the page became visible again. The new document re-showed "Drop 1 of 3 (app-5min)", but the loop dedups prompts on `id:n:kind:text` (`drive/loop.mjs` about line 139), so nothing answered it. It timed out after 20 min with no runs. Play-through-drop reuses that evidence, and its `all` reducer turns an empty list into `false`. Under M39q's rule an empty measurement is null, never a verdict.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39j-device-driver.md` Deviations (the device person, the loop, the watchdog, rotation)
3. `docs/plan/39q-net-heap-boot-race.md` Deviations (the empty-window rule: `nullIs`, null-on-empty reducers)
Also `docs/decisions/0018-renderer.md` §2 (the window origin).

## Scope
1. **Pan.** Make the pan independent of orientation: rotate back to portrait after any item that rotated, or have the `pan` handler start its swipe clear of the walk bar in either orientation (for example `y0 = min(0.7h, h - 190 css)`). Pick one and say why. Add a `pointercancel` count to M11's pointer block, evidence only.
2. **Window origin.** `check.ts world()` reports positions in world tiles: add the window origin back, through a small export from the engine's test surface (name it in Deviations; it is test-only, not a public API). Also make `stepsWhileMoving` ignore jumps above the snap floor when it builds its window path. Either change alone fixes this round; do both, since the second protects other recorders.
3. **Watchdog and leave-app.** In `drive/loop.mjs`, a leave-app handler (app switch, airplane, any act that backgrounds the page on purpose) resets the idle clock when it returns, so a long leave never trips the watchdog. When the page is reopened (`reopened`, or a new tab id), clear the prompt dedup for that page so its prompt is answered again. Give M29-play-through-drop null-on-empty reducers with `nullIs: 'judge'`, and make the shared evidence (`reused()`) null when `runs` is empty or `actTimedOut`.
4. **Tests** (`pnpm test tools`), each seen red first (red lines pasted):
   - (a) the pan handler's start point in landscape with the walk bar is clear of it;
   - (b) a `motionFrames` series with a 64.000 jump at frame 1 gives `max_still_ms` under 50 and no snap;
   - (c) a fake-backend loop with a 300 s leave act does not reopen;
   - (d) a reopened page's repeated prompt is answered;
   - (e) play-through-drop on 0 runs is not a fail.
   The `check.ts` change needs a test in the engine package that `world()` positions are origin-independent: a camera on either side of a 64-tile boundary gives the same `pos`. Fast tier only if it costs under 0.3 s, else `@slow`; `browser` is at 45-47 of its 48 s.

## Non-scope
Any criterion's limit; any engine runtime behaviour (the window origin itself is correct); re-running rounds (the orchestrator's).

## Files touched
`scripts/lib/device-walk/drive/{person.mjs,loop.mjs,android.mjs}` as needed, `scripts/lib/device-walk/{checks.mjs,agent/collect-touch.js,agent/collect-life.js}` as needed, `games/reference/src/check.ts`, the engine's test-surface module for the origin export, their tests.

## Exit criteria
- [ ] Tests (a) to (e) and the origin test exist, pass, and were seen red (red lines pasted).
- [ ] `pnpm test tools` green (pasted line); no limit changed.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test tools` · `pnpm test unit -t check` · the origin test's suite, targeted, in the foreground. No phone runs.

## Manual device checks
After landing, the orchestrator re-runs M11-gestures (after M09b-fill-rate, so the round starts in landscape), M16-slice-boot, M34-remote-motion and M29-socket-resume driven on the Pixel.

## Deviations
(filled in during Phase 3)
