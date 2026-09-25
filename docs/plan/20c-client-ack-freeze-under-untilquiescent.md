# M20c: the client worker stops acking under `stepTick` on a connected manual-clock page

Status: done · After: 20b · Tyler-dependent: no

Written by the orchestrator at M20b's gate, from a deterministic reproduction that M20b worked
around in its zero-GC page.

## Goal

Name why the client worker's `W_ACK` freezes while its `W_WAKE` keeps climbing when
`engine/test`'s `stepTick` runs on a connected, manual-clock page, and fix it where it lives. Answer
whether a **production** client worker can reach the same state (for example with rAF stopped
because the tab is hidden, 0018 §8), because that is the question that decides how serious it is.

## The evidence, gathered by the orchestrator

- **M20b's report** (`docs/plan/20b-reference-player-and-collect-ui.md` Deviations, search
  "deadlock"; `games/reference/src/gc-entry.ts`'s comment above its priming loop): on
  `host: { kind: 'local', connect: true }` driven by `asHarness` and a manual clock with no real
  frame loop, `engine/test.stepTick` (`stepSimTickSync` + `untilQuiescent`,
  `packages/engine/src/test/client.ts:272` and `:422`) hangs for `untilQuiescent`'s full timeout
  the first time it follows a run of plain `stepFrame` calls. The client's `W_ACK` stays at its last
  `stepFrame` ack while `W_WAKE` climbs from the sim's downlink pushes. It reproduced
  deterministically. M20b worked around it with `stepSimTickSync` plus a drain-to-empty of
  `uploadRing` (`drainUploadsFully`) and never calls `stepTick` in priming.
- The same comment says `untilQuiescent` waits for **every** ring, `uploadRing` included, to reach
  `pushed === popped`, and that undrained upload records left by earlier `stepFrame`s make it spin.
  **Orchestrator guess, to be tested:** on a page with no real frame loop nothing drains
  `uploadRing` on the main thread, the client worker blocks or stalls behind a full upload ring, and
  so it stops acking wakes. If that is right, the question is whether the client worker *waits* on a
  full `uploadRing` (which a hidden tab with rAF stopped would also produce), or drops and counts
  like `inputRing` does.
- **It may be the standing `parkWorkers` watch item** (`PROMPT.md` Blockers): at M17's gate a
  `parkWorkers: timed out after 10000 ms` named `client` as the stuck worker with `W_PARKED` 0,
  `W_WAKE` 1776 against `W_ACK` 1500. That is the same shape: a client that stops acking while
  wakes keep arriving. That item has only ever been intermittent. This one is deterministic.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/20b-reference-player-and-collect-ui.md` Deviations, the "deadlock" and gc-page parts
3. `docs/plan/16e-park-timeout-diagnosis.md` Deviations (how a stuck worker's state is reported)
4. `docs/plan/17c-client-park-stall.md` Deviations (the two wait-loop fixes; the `Debugger.pause`
   stack technique)

## Scope
1. Reproduce deterministically: a minimal case (an engine test page, or the reference `gc.html`
   with `stepTick` restored in priming) that hangs every time. Take the client worker's stack while
   it is stuck (17c's `Debugger.pause` technique) and read `uploadRing`'s `pushed`/`popped` and
   capacity at that moment.
2. Name the cause from that stack, not from the guess above.
3. Fix it where it lives, with a test that fails without the fix (red output pasted, re-run against
   the reverted fix). If the cause is that the client worker blocks on a full `uploadRing`, decide
   in writing whether production must drop-and-count or keep backpressure, and check the
   hidden-tab case (rAF stopped, 0018 §8) with a browser test that stops the frame loop.
4. Remove M20b's workaround from `games/reference/src/gc-entry.ts` if the fix makes `stepTick` safe
   there, and confirm the `gc-reference` page's numbers did not move (`budgets.json` unchanged).
5. Say whether this explains the `parkWorkers` watch item. If it does, say so in the ledger row;
   if not, say what differs.

## Non-scope
Lengthening any timeout. Any zero-GC budget. The `stepping` hash watch item (M18c).

## Files, packages and crates touched
`packages/engine` (`src/test/client.ts`, `src/worker/client*.ts`, `src/render/upload.ts`,
`src/sab/*` only if the cause is there, a test page and spec under `tests/browser/`);
`games/reference/src/gc-entry.ts` for step 4.

## Seams
**Provides** nothing new. `stepTick`/`untilQuiescent`/`parkWorkers` keep their contracts.

## Order of work
1. Deterministic repro plus stack. 2. Cause. 3. Fix plus failing-first test (and the hidden-tab
check if the cause is upload backpressure). 4. Remove the workaround. 5. Ledger.

## Tests added
The regression test from step 3; the hidden-tab browser test if step 3 calls for it.

## Exit criteria
- [x] The cause is named from a stack or counter reading, and fixed with a test that fails without
      the fix (red output pasted).
- [x] Whether a production client worker can reach the frozen-ack state is answered in writing,
      with a test if the answer is yes.
- [x] `games/reference/src/gc-entry.ts` no longer needs the workaround, or Deviations say why it
      still does; `budgets.json` unchanged.
- [x] The `parkWorkers` watch item's ledger row says whether this explains it.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t <pattern>` · `node scripts/repeat.mjs browser <n> [--load 10]` (foreground,
bounded, a per-run kill timeout, no background load generators).

## Budgets
none changed.

## Context artifacts
One line in the `gc-test` skill or `packages/engine/CLAUDE.md` ("Adding a browser spec"): what a
manual-clock page must do about `uploadRing`, if the fix leaves that a page's job.

## Manual device checks
none

## Deviations

Base `2478973`; `pnpm test && pnpm lint` green there. Commits `46bca6c`..`ee99e43`.

**Repro and cause (steps 1-2, not separately committed: no repo change results from diagnosis
alone).** Reproduced by temporarily restoring `await stepTick(client, 5)` in `gc-entry.ts`'s
priming loop (in place of the workaround) and running `pnpm exec playwright test --project
gc-reference`: all 9 tests failed identically with the page error `untilQuiescent: timed out after
10000 ms (turns=2003, elapsedMs=10002.8, longestGapMs=6.1)
workers=[{"isolate":"client","W_YIELD":0,"W_PARKED":0,"W_WAKE":58,"W_ACK":20,"dead":false},
{"isolate":"sim",...,"W_WAKE":10,"W_ACK":10,...},{"isolate":"gen0",...,"W_WAKE":36,"W_ACK":36,...}]`.
`W_ACK(20) === CB_FRAME_REQ(20)` (the client's own ack condition, satisfied) rules out the client
worker itself being stuck -- the timeout is entirely from `untilQuiescent`'s other half, the
ring-quiescence check. A standalone Playwright/CDP script driving the same built `gc.html` (with a
temporary `window.__uploadStats` hook reading `new RingConsumer(client.uploadRing).stats()`)
measured `uploadRing`'s own counters **frozen at `{"pushed":33,"popped":17}` for the entire ~13 s
hang window** (four readings, 4 s apart, byte-identical) -- a real, permanent 16-record gap
(exactly `UPLOAD_BATCH_MAX`), never draining. `worker/client-upload.ts`'s `createUploadPump.pump()`
asks for `min(ring.freeSlots(), 16)` and returns immediately when that is 0 or when
`upload_stage` has nothing left to stage, so a full or merely-undrained `uploadRing` never blocks a
wake -- confirmed by code reading, not merely inferred. `page.workers()[i].evaluate()` also timed
out repeatedly against the client worker during the hang, but this is expected of a healthy
worker cycling on real wakes via `Atomics.wait` (`packages/engine/CLAUDE.md`'s own "a blocked
worker receives none"), not evidence of a stuck realm -- not used as the cause. **Named cause:**
`test/client.ts`'s `ringSabs()` included `uploadRing` in `untilQuiescent`'s "every ring drained"
check, but nothing in `engine/test` or `Client` ever constructs a consumer for that ring -- only a
page's own renderer or test code does, on whatever cadence it chooses. Confirmed independently:
every other `connect: true` page that ever calls the async `stepTick`/`untilQuiescent` already
works around exactly this (`connected.ts`'s own `uploadDiscard` interval, `connected-terrain.ts`'s
background drain, both with their own doc comments naming the same gap; `gc-connected-terrain.ts`
avoids the async `stepTick` entirely, using only `stepSimTickSync`/`asHarness.stepTick`, neither of
which touches rings at all). Not the M06b-era "negative control on a sibling isolate" theory, not a
lost wake, not a park-protocol defect (17c's own class): a contract bug in `untilQuiescent` itself.

**Fix (step 3):** `ringSabs()` (`packages/engine/src/test/client.ts`) no longer includes
`sabs.uploadRing`; `untilQuiescent` now settles the ack condition plus every ring a worker or
`Client` itself actually drains (`actionRing`/`inputRing`/`uiRing`/`uplink`/`downlink`/
`genRequest[]`/`genResult[]`). No public seam changed (`ringSabs` is a private helper); `stepTick`/
`untilQuiescent`/`parkWorkers` keep their exact exported signatures, per the brief's own Seams.
Added `upload-quiescence.html`/`.ts` + `tests/browser/upload-quiescence.spec.ts` (a minimal
`connect: true`, manual-clock, no-drain-anywhere topology): **red on the base commit** (pasted
above, same error shape, reproduced a second time against this exact page before the fix landed:
`page.evaluate: Error: untilQuiescent: timed out after 10000 ms (turns=1990, elapsedMs=10000.4,
longestGapMs=6.1) workers=[{"isolate":"client",...,"W_WAKE":29,"W_ACK":1,...},...]`, at
`packages/engine/tests/browser/upload-quiescence.spec.ts:24`); green after the fix, resolving in
~1.6 s with `uploadRing` measured left genuinely undrained (`pushed > popped`, asserted in the spec
via `__uploadStats`) the whole time -- proof this is a deliberate contract change, not an accident
of an already-empty ring.

**Production question (also step 3):** answered **no** -- a production client worker cannot reach
a frozen-ack state from an undrained `uploadRing`, hidden tab or not, because
`worker/client-upload.ts`'s `pump()` is capacity-checked and returns immediately regardless of ring
state (code-level proof above); the only thing that ever waited on that ring was `engine/test`'s
own `untilQuiescent`, which no production code path calls. Verified empirically, not just by code
reading: `hidden-tab-upload.html`/`.ts` + `tests/browser/hidden-tab-upload.spec.ts` (`@slow`, ~4 s)
is production wiring verbatim (no `ClientOptions.test` at all -- the sim paces itself for real, the
client frames for real off `systemClock`/`systemScheduler`), with `attachVisibilityHandling`'s own
`doc` parameter faked so the test can flip "hidden" deterministically without CDP. It hides the tab
for 2 real seconds (during which the sim's own real-time-paced ticks keep landing via downlink,
independent of this client's own visibility, and `pushed` measurably grows past `popped` and stays
there -- the scenario is real, not vacuous), then shows it again and polls (`expect.poll`, 5 s) for
`pushed === popped`: it always converges, proving the client is never stuck and the real frame
loop's own "upload" phase (`frame-loop.ts`) resumes and catches up cleanly.

**`gc-entry.ts` (step 4):** the workaround (`stepSimTickSync` + manual `drainUploadsFully` in place
of `stepTick`) is removed; `await stepTick(client, 5)` is restored, followed by
`await resumeWorkers(client)` (`stepTick`'s own trailing `untilQuiescent`/`parkWorkers` leaves
every worker parked, and the next loop's bare `stepFrame` cannot reach a parked worker --
`connected.ts`'s own `__advance` precedent; missing this in my own first draft of the
`upload-quiescence.ts` page's `__advanceNoWait` hook produced exactly this same failure locally,
caught before commit). Verified: `pnpm exec playwright test --project gc-reference`, all 9 tests
pass (7.0 s total; previously hung/timed out identically on all 9 with the workaround removed and
no fix). `budgets.json` is untouched (`git status`/`git diff --stat` both empty for it) -- the
gc-reference numbers did not move.

**Found live, fixed as a direct consequence (not a separate milestone item): `connected-terrain.ts`
had the same undrained-`uploadRing` dependency `gc-entry.ts` did, in reverse.** `node
scripts/repeat.mjs browser 8` (quiet) after step 3 landed measured **2/8 failures** of
`overlay_tile_reaches_screen`: `expectPixel(8, 8) channel g: got 32, want 139 (tol 2)`. Cause:
`connected-terrain.spec.ts`'s `pumpFrames`/`overlay_tile_reaches_screen` call `__advance(...,
ticks: 0)` purely for `stepTick`'s own trailing `untilQuiescent` settle before reading pixels; that
page's own upload draining was a 16 ms background `setInterval` (its own doc comment already named
the gap: "nothing else here drives a render loop that would drain it"), and before this fix,
`untilQuiescent`'s own wait on `uploadRing` incidentally gave that interval enough real macrotask
time to fire at least once before resolving -- removing `uploadRing` from the check let
`untilQuiescent` resolve before the interval ever ran, so a just-staged chunk sometimes wasn't on
the GPU yet when the pixel probe read it. Fixed in `connected-terrain.ts` (not the spec: the test
itself is unchanged and never weakened): `bgUploadDrain` hoisted to module scope, and `__advance`
now drains it to empty, synchronously, itself, every call (`gc-connected-terrain.ts`'s own
`drainUploadsFully` shape) -- deterministic, no dependency on the interval's timing at all. Verified:
`pnpm exec playwright test tests/browser/connected-terrain.spec.ts --project chromium
--repeat-each 8`, 16/16 pass; `node scripts/repeat.mjs browser 10` (quiet), **10/10 pass, 0
failures, 0 hangs** (committed separately: `ee99e43`, "M20c: connected-terrain.ts drains
uploadRing itself after `__advance`" -- not one of the brief's five numbered steps, so `M20c: ...`
per the commit-subject convention). Audited every other `connect: true` page for the same class of
dependency (`slice.ts`'s own settle -- `untilTileEvent` -- already stopped relying on
`untilQuiescent` for this exact reason at M16d, per its own doc comment, and reads pixels through an
independent per-real-frame poll instead; `gc-connected-terrain.ts` never calls the async `stepTick`
at all; `connected.ts`/`puts-ui.ts`/`puts-dispatch.ts`/`presence-worker-path.ts`/
`connected-paced.ts` build no renderer and read no pixels): none of the others were affected.

**`parkWorkers` watch item (step 5):** does not explain it. Recorded in
`docs/plan/deferred-ledger.md`'s own row: the watch item is intermittent, under real suite
saturation, `W_YIELD: 1` (a park request already sent, not yet observed) with the error
`parkWorkers: timed out`; M20c's own hang is deterministic, needs no load, and its error is
`untilQuiescent: timed out` with `W_YIELD: 0` -- `parkWorkers` was never even reached, since
`untilQuiescent`'s own ring-quiescence check never returned true. Different code path, different
signature.

**Context artifact:** one line added to `packages/engine/CLAUDE.md`'s "Adding a browser spec"
section, naming the contract (`stepTick`/`untilQuiescent` never wait on `client.uploadRing`; a page
drains it itself) and pointing at this brief.

**Final numbers.** `pnpm test`: `rust` 404, `unit` 232, `wasm` 57, `browser` 185 (184 -> 185: the
new fast `upload-quiescence` test; `hidden-tab-upload` is `@slow`) at 29 s of 35 s. `pnpm test:slow
browser`: 52 (51 -> 52). `pnpm lint`: all four checks green. Loops (foreground, bounded, after the
`connected-terrain.ts` fix): `repeat.mjs browser 10` quiet, **10/10 pass, 0 fail, 0 hang, slowest
28 s**; `repeat.mjs browser 8 --load 10`, **8/8 pass, 0 fail, 0 hang, slowest 40 s** (over the 35 s
fast-tier budget under load, matching the established "WARN, not a fail" precedent, M20b's own gate
notes). No background processes left running.

**Not fixed here, out of scope:** the `stepping` hash watch item (M18c) and the M06b sibling-isolate
theory (`deferred-ledger.md`'s own open row) -- neither named by this brief's evidence and neither
touched.

### Orchestrator gate notes

Re-ran the failing-first test against the reverted fix: with `sabs.uploadRing` restored to `ringSabs()`, `upload_quiescence: stepTick resolves without draining uploadRing` fails with `untilQuiescent: timed out after 10000 ms` (client `W_WAKE` 29 / `W_ACK` 1); removed again, it passes. `repeat.mjs browser` 15 quiet (slowest 28 s) and 15 under `--load 10` (slowest 39 s, a WARN) all passed. The orchestrator's brief framed this as "the client stops acking"; the measurement showed the client was never stuck (`W_ACK` equalled `CB_FRAME_REQ`): the harness's own wait included a ring only the page drains.
