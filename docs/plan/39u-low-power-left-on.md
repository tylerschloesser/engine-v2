# M39u: M16-low-power turns Low Power Mode back off

Status: not started · After: 39t · Tyler-dependent: no

## Goal
Finding 8 of the driven rounds (round `m39r-iphone`, 2026-10-06): after M16-low-power, the iPhone stayed in Low Power Mode for the rest of the round. Every later item then ran at the 30 Hz cap: M29-net-heap counted 17,977 of about 36,000 frames over 25 ms, and M34-remote-motion's `max_still_ms` was 134. M39-large-save's tick p95 of 13.86 ms was measured throttled too. The screenshots show the battery icon green before the item and yellow after it. The orchestrator traced the cause to two places:
- `SLICE.lowpower` (`scripts/lib/device-walk/agent/collect-life.js`, about line 161) asks "Turn Low Power Mode on", measures the second flick and returns. It never asks for Low Power Mode off again. A non-driven round leaves Tyler's phone throttled the same way.
- The iOS backend's `cleanup()` (`scripts/lib/device-walk/drive/ios.mjs`, about line 693) runs every step through `bestEffort` with a 4000 ms default. The Settings walk in `lowPower(false)` takes longer than that, so the round's log reads `ios cleanup (low power) timed out after 4000 ms` and the phone stays in Low Power Mode after the round.

iOS also caps Auto-Lock at 30 s while Low Power Mode is on. After the round, Tyler's iPhone kept sleeping until the orchestrator switched Low Power off with the backend alone: `createIosBackend()`, then `screenshot()` (which starts the session), then `setLowPower(false)`, then `cleanup()`, all in one `node -e`. A leftover Low Power Mode therefore breaks the never-sleep rule too, not only the frame rate.

When this is done, the item leaves the phone as it found it before the next item starts, and cleanup can actually turn Low Power Mode off.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39j-device-driver.md` Deviations (the device person: `HANDLERS`, `ACT_COVERAGE`, the backend interface, `fake-backend.mjs`, cleanup)
3. `docs/plan/39m-flick-frame-rate.md` Deviations (what `lowpower` measures and returns)

## Scope
1. **Collector.** After the low-power flick, `SLICE.lowpower` asks "Low Power Mode looks on. Turn it off ..." (the existing text the `low-power-off` handler matches) with `detect: { normal }`. It does this in a `finally`-shaped path, so a throw or a not-detected return also asks. The item's result is unchanged. If the cadence never returns to normal, record that in the result's notes as a fact (`low_power_restored: false`), so the next items' numbers can be read against it. The judge never decides it.
2. **Driver.** In `ios.mjs` `cleanup()`, give the low-power step a timeout that fits the measured Settings walk (measure it from the round log's `act ... done` timestamps or a fake-backend timing, and say which). Do the same for airplane if it is just as tight. Grep `android.mjs` cleanup for the same pattern.
3. **Order guard.** Before each measuring item, the walker (or the agent's `measureWindow` path, whichever already reads the rAF cadence) notes a low-power-shaped cadence (p50 over 25 ms) in the attempt as `cadence_throttled: true`, so a throttled measurement can never pass silently again. A note, not a criterion: do not change any limit.
4. **Tests.** A unit test with `fake-backend.mjs` and the vm agent harness: a driven `M16-low-power` ends with `setLowPower(false)` called and the fake's state off. A second case covers the throw path. Both are red at base (red lines pasted). A cleanup test shows the low-power step's timeout is the new value.

## Non-scope
The criteria and limits of every item; M09b and M16-coexist's iPhone hitches (finding 5, still open after this round); re-running items (the orchestrator's).

## Files touched
`scripts/lib/device-walk/agent/collect-life.js`, `scripts/lib/device-walk/drive/ios.mjs` (and `android.mjs` only if its cleanup has the same gap), the walker or `driver.js` for step 3, their tests under `scripts/lib/`.

## Exit criteria
- [ ] The two collector tests and the cleanup test exist, pass, and were seen red (red lines pasted).
- [ ] `cadence_throttled` is recorded on a throttled attempt (unit test) and changes no verdict.
- [ ] `pnpm test unit -t device-walk` green (pasted line); no budget or limit changed.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t device-walk` (targeted, foreground). No phone runs: the orchestrator re-runs the iPhone items.

## Manual device checks
After landing, the orchestrator re-runs M16-low-power, M29-net-heap, M34-remote-motion and M39-large-save driven on the iPhone, with M16-low-power first.

## Deviations
- **Collector.** `SLICE.lowpower` (`collect-life.js`) wraps everything after the "Turn Low Power Mode on" prompt in `try/finally`; the finally asks the existing `low-power-off` text with `detect: { normal }` (a throw in the second flick also asks; a throw in the first flick does not, Low Power was never asked for). The result carries `lowPower.low_power_restored` (true/false; absent on a throw, there is no result). Not a criterion.
- **Timeout sized from the in-session walk: 19 s** (log: act prompt 01:26:13, `done` 01:26:32). The 30 s standalone run includes starting WDA, which a cleanup with a live session does not. `SETTINGS_WALK_MS = 30_000` (exported from `drive/ios.mjs`), used by the low-power and airplane steps (airplane is the same kind of Settings walk). Rotation (3 s) and session delete keep their deadlines. `android.mjs` cleanup is synchronous adb with no deadlines: no gap, untouched.
- **Outside the brief's Files touched: `auto-main.mjs`.** `shutdown()` raced `backend.cleanup()` against 6000 ms and the process hard-exited at 12 s, so a 30 s step in `cleanup()` would still have been cut. Now `backend.cleanup()` gets 70 000 ms (worst case 30+30+3+3.5+0.5 s) and the hard exit is 80 000 ms. A second signal 2 s or more later still exits at once. The cleanup doc comment now says: normal cleanup is as long as the walks needed (about 20 s each), a second or two when nothing is on, worst case about 70 s (was "about 8 s"). The comments in `auto-main.mjs` follow. `deadline.mjs`'s header (10 s) and the 39j Deviations number are history, untouched.
- **Order guard.** `measureWindow` (`agent/driver.js`) sets `window.cadence_throttled: true` when the window's `raf.p50 > 25`; `auto-round.mjs` `onSeries` copies it to the `attempt {status: 'done'}` event as `cadence_throttled: true` when any object in the collected data (depth 4) carries it. No limit, criterion or verdict reads it. `lowpower` itself does not use `measureWindow` (its throttle is the point).
- **Tests** `scripts/lib/device-walk-lowpower.test.mjs` (5, vm page on a virtual clock whose cadence follows the fake backend's Low Power state, the real `devicePerson` answering prompts). Red at base (`61eeaa6^` sources): `expected Object{ detected: true, ...(10) } to match object { detected: true, ...(1) }` (driven), `expected [ true ] to deeply equal [ true, false ]` (throw path), `expected undefined to be 30000` (cleanup; red by the missing export, so the 4 s cut itself is not shown red), `expected undefined to be true` (cadence_throttled). Green after: `unit pass 234 tests` for `pnpm test unit -t device-walk`. Lint and full test not run (orchestrator is the gate).
