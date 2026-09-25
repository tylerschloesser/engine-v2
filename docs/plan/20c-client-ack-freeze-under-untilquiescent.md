# M20c: the client worker stops acking under `stepTick` on a connected manual-clock page

Status: pending · After: 20b · Tyler-dependent: no

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
- [ ] The cause is named from a stack or counter reading, and fixed with a test that fails without
      the fix (red output pasted).
- [ ] Whether a production client worker can reach the frozen-ack state is answered in writing,
      with a test if the answer is yes.
- [ ] `games/reference/src/gc-entry.ts` no longer needs the workaround, or Deviations say why it
      still does; `budgets.json` unchanged.
- [ ] The `parkWorkers` watch item's ledger row says whether this explains it.
- [ ] `pnpm test` and `pnpm lint` are green.

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
