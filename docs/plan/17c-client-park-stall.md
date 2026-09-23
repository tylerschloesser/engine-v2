# M17c: The client worker that never parks on `zero_gc_action`

Status: not started · After: 17b · Tyler-dependent: no

Written by the orchestrator at M17b's gate, from two instrumented occurrences.

## Goal

Find out why the client worker on the `zero_gc_action` page sometimes never parks, and fix it.
The symptom is the `parkWorkers: timed out after 10000 ms` watch item (`deferred-ledger.md`). It
now fails with the same state every time, which points at a deterministic stall rather than
machine saturation.

## The evidence, gathered by the orchestrator

M16e's instrumentation (`pollUntil` in `packages/engine/src/test/client.ts`, format in the
`gc-test` skill) captured two occurrences at the M17 and M17b gates. **The counters are identical
in both, byte for byte:**

```
parkWorkers: timed out after 10000 ms (turns=2022..2034, elapsedMs=10000.8..10004.5, longestGapMs=6.0)
workers=[{"isolate":"client","W_YIELD":1,"W_PARKED":0,"W_WAKE":1776,"W_ACK":1500,"dead":false},
         {"isolate":"sim","W_YIELD":1,"W_PARKED":1,"W_WAKE":3261,"W_ACK":3260,"dead":false},
         {"isolate":"gen0","W_YIELD":1,"W_PARKED":1,"W_WAKE":1589,"W_ACK":1588,"dead":false}]
```

| gate | condition | test |
|---|---|---|
| M17 (repeat loop) | quiet, 1 in 30 | `zero_gc_action neg object sim` |
| M17b (full `pnpm test`) | load 5.7, 1 of 3 full runs | `zero_gc_action neg object main` |

What this rules out, and what it leaves open:
- **Not (c), main starved:** `turns` ≈ 2,030 and `longestGapMs` 6.0. Main polled steadily for 10 s.
- **Not (d), dead:** `dead: false`.
- **`sim` and `gen0` parked** (`W_WAKE - W_ACK` = 1). **Only `client` did not:** it saw
  `W_YIELD = 1` but never set `W_PARKED`.
- **The same `W_WAKE`/`W_ACK` in two different tests** means the client stops at one fixed point in
  the page's scripted workload. 1,500 acknowledged passes is a round number; check whether it
  equals the frames the harness drives before `parkWorkers`.
- Earlier occurrences on this page (M16 through M16b, `deferred-ledger.md`, M16e's table) predate
  the instrumentation, so their state is unknown. They are probably the same defect.
- M16e's own occurrence was a different shape (`gen0` not parked, wake == ack, on `terrain`).
  Treat it as separate unless this milestone's cause explains it too.

**The orchestrator's guess, not a finding:** `parkWorkers` parks every worker, and `sim` parks
first. If the client is inside `body()` waiting for, or retrying against, something only the sim
provides, it never gets back to `runBlockingLoop`'s `W_YIELD` check. Examples: a full ring and
`RingConnection.pumpRetries()`, an uplink/downlink handshake, or M17's new
`worker/client-drawlist.ts` pump, which runs in the same `body()`. That would be a park-ordering
deadlock. Measure before believing it.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/16e-park-timeout-diagnosis.md` (Goal, the (a)-(d) cases, Deviations)
3. `docs/plan/06b-workers-and-spawn.md` Deviations (park/resume protocol)
4. the `gc-test` skill ("Production-topology pages": how to read the message)
Rules: `.claude/rules/hot-paths.md`.

## Scope
1. **Reproduce on demand.** Start with the `gc` project running
   `zero_gc_action neg object {main,sim,client}` with `--repeat-each`, quiet, then under load.
   Try forced interpreter (`--no-opt --no-sparkplug` in the `gc` project's `--js-flags`; a
   diagnostic, reverted). Identical counters suggest a fixed trigger point, so also try making
   the race wide on purpose: a temporary delay in the sim's park path, or in the client's `body()`,
   either reverted. Record which reproduces it and at what rate.
2. **Find where the client is.** When it reproduces, get the client worker's stack or its
   position in `body()`. A plain `Runtime.evaluate` does not run on a worker blocked in
   `Atomics.wait` (M17b Deviations), so use `Debugger.pause` over CDP on that worker target, or a
   temporary, reverted per-phase breadcrumb word in the control block written by `body()`. Name
   the function and the condition it waits on. Say what `W_ACK` counts and why it trails
   `W_WAKE` by 276.
3. **Fix the named cause** in the worker protocol or the pump that holds the client, with a test
   that fails without the fix. For a park-ordering deadlock, the fix is in the protocol (for
   example, a pump that returns to the loop when `W_YIELD` is set, or a park order), never in the
   harness's timeout. Consider every pump in the client's `body()` and say which ones can block on
   another worker.
4. If step 1 cannot reproduce it in a bounded effort (about 100 targeted runs plus two loaded
   suite batches), commit the strongest diagnostic you have (for example, a permanent
   zero-allocation breadcrumb reported in the timeout message) and record the attempt.

## Non-scope
Lengthening any timeout; changing `budgets.json`; the `gen0` shape of M16e unless the same cause
explains it; the fast suite's time budget (a separate ledger row).

## Files, packages and crates touched
`packages/engine/src/worker/` (`shell.ts`, `client.ts`, `client-net.ts`, `client-drawlist.ts`,
`sim.ts`), `src/sab/control.ts`, `src/test/client.ts`, their tests, and `tests/browser/gc/` if a
harness change is needed.

## Seams
**Provides:** nothing new unless step 4 lands a breadcrumb (record its exact word and format).
**Consumes:** M06b park/resume, M15b `RingConnection`, M16 `gc-slice.ts`, M16e's timeout message,
M17 `client-drawlist.ts`.

## Order of work
Steps 1-4 in order, each committed `M17c step k: …`.

## Tests added
A test for the step-3 fix that fails on the base commit. Say how you checked that it fails there.

## Exit criteria
- [ ] The client's stall is reproduced and its location named (function + awaited condition), or
      step 4's bounded attempt is recorded and a diagnostic is committed.
- [ ] If named: fixed, with a test that fails without the fix. `node scripts/repeat.mjs browser 15`
      and `... 15 --load 10` show no `parkWorkers` timeout.
- [ ] `zero_gc_action`'s negative controls still trip and every budget is unchanged.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm gc -t "zero_gc_action"` · `pnpm test browser -t <pattern>` ·
`node scripts/repeat.mjs browser <n> [--load 10]` (foreground, bounded, a per-run kill timeout, no
background load generators).

## Budgets
none changed.

## Context artifacts
The `gc-test` skill's debugging section: how to find a stalled worker's position (step 2's
technique).

## Manual device checks
none

## Deviations
(filled in during Phase 3)
