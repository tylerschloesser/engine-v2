# M39v: attribute the iPhone's rAF gaps, and a driver mode with the inspector detached

Status: not started · After: 39u · Tyler-dependent: no

## Goal
Finding 5 is still open after M39p. In round `m39r-iphone`, the iPhone failed M09b-fill-rate and M16-coexist:
- M09b-fill-rate: rAF p95 18 ms (limit 17.5), 13 frames over 20 ms per 10 s (limit 5), GPU exec p95 2.8 ms.
- M16-coexist: 74 gaps over 25 ms. The Pixel shows 0.

A read-only diagnosis (2026-10-06, `test-results/finding5-iphone-hitch-diagnosis.md`, not committed) found:
- The driver sends nothing to the phone during a window. But the Appium/WDA session and the Web Inspector attachment stay up: `web()` (`drive/ios.mjs`, about line 318) is entered and `native()` is never called around a window.
- M09b's gaps are rAF timestamp jitter, not dropped frames. 331 of 336 are 20-30 ms, about 3,592 frames per window regardless, with no phase lock to any page timer.
- Coexist's gaps cluster 350-400 ms after each scripted Paint and grow worse late in the run. The gap ring keeps only the newest 256.
- One driverless manual run (`m39-auto`) was 2 to 12 times better, which is suggestive but a single window.
- Cause confidence is low: about 45 % the attached automation stack, about 30 % heat or iOS 27.0.1, about 25 % page compositing.

This milestone builds the measurement, not a fix. When it is done, each long gap carries what ran before it, and a driven round can detach the inspector during windows. The orchestrator then runs the three-way comparison on the phone, and the fix (or an ADR on the iOS limit) is a later brief.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39p-quiet-measuring-windows.md` (all: `backend.quiet`, the quiet test's allowed calls, the per-gap ring in evidence)
3. `docs/plan/39j-device-driver.md` Deviations (the iOS backend, `web()`/`native()` contexts, the session)

## Scope
1. **Per-gap attribution** in the agent's rAF recorder (`scripts/lib/device-walk/agent/`, where M39p's per-gap ring lives). For each gap over 20 ms, record:
   - its `Date.now()` stamp;
   - callback lateness (`performance.now()` at callback minus the rAF timestamp);
   - the longest stall seen by a ~4 ms `MessageChannel` heartbeat in the preceding 100 ms;
   - the names of the last tasks from a small ring of named page and agent tasks (sample, HUD, paint, mem park, worker message, agent post) in the preceding 50 ms.
   Grow the gap ring from 256 to 2048 entries. The heartbeat runs only inside a measuring window and must not allocate per frame on the page (`.claude/rules/hot-paths.md` applies to the page side). Put a per-window summary in the attempt's evidence, for example gaps with heartbeat stall over 16 ms against gaps without, and the top task names before gaps. It is evidence only: no criterion reads it, and no limit changes.
2. **Inspector-detached windows.** Add an opt-in drive flag, `--detach-inspector` (iOS only; Android ignores it with a log line). Before a measuring window the loop switches the session to `native()` and back to `web()` after the window's end marker, using the existing quiet handshake. Record which mode ran on the attempt (`inspector: 'attached' | 'detached'`). If the page needs the webview context inside the window, report it, so the orchestrator can redesign.
3. **Tests.** Unit tests with the fake backend and the vm agent harness:
   - attribution fields appear on a synthetic gap, red at base;
   - `--detach-inspector` produces `native` before and `web` after each window, and nothing in between, red at base;
   - the heartbeat stops outside windows.
   Update the M39p quiet test's allowed-calls list only for the two context switches, and say so in Deviations.

## Non-scope
Any limit or criterion; fixing the gaps; heat cool-downs; the three-way phone comparison (the orchestrator runs it after this lands: driverless QR run, driven attached, driven detached, rotated order, with a cool-down).

## Files touched
`scripts/lib/device-walk/agent/*.js` (recorder, `driver.js`), `scripts/lib/device-walk/drive/ios.mjs`, the drive loop (`drive/loop.mjs`) and argument parsing (`auto-main.mjs` or wherever drive flags live), their tests under `scripts/lib/`.

## Exit criteria
- [ ] The three unit tests exist, pass, and were seen red (red lines pasted).
- [ ] Attribution and `inspector` mode appear in an attempt's evidence: a loopback `walk-life` or fake-backend run whose pasted evidence shows them.
- [ ] `pnpm test:slow browser -t walk-life` green (pasted line); no limit, budget or golden changed.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t device-walk` · `pnpm test:slow browser -t walk-life` (targeted, foreground). Loops run in the foreground, bounded, with a per-run kill timeout, and no background load generators. No phone runs.

## Manual device checks
After landing, the orchestrator runs M09b-fill-rate and M16-coexist on the iPhone three ways (driverless via QR with Tyler, driven attached, driven `--detach-inspector`), three times each where time allows, then writes the fix brief or an ADR.

## Deviations
(filled in during Phase 3)
