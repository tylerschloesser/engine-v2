# M18c: `stepping`'s hash mismatch under suite load

Status: not started · After: 18 · Tyler-dependent: no

Written by the orchestrator at M18's gate, from one occurrence.

## Goal

Find out why `stepping: 1,000 stepTick() in one task match a plain reference` (M03,
`packages/engine/tests/browser/stepping.spec.ts`) once returned a sim hash different from the
reference, and fix it. The test compares the hash after 1,000 harness `stepTick()` calls with 1,000
plain `sim_tick` calls on the same `hash` fixture config. So a mismatch means the harness lost or
repeated a tick, or hashed while the worker was still working. Either is a defect in the
instrument every browser determinism claim rests on.

## The evidence, gathered by the orchestrator

- Seen **once**, in run 1 of `node scripts/repeat.mjs browser 15` (quiet) at M18's gate, on `main`
  after M18's last fix round. The failure message was only `expect(actual).toBe(expected)`: the
  test prints neither hash nor tick count, so nothing else is known.
- **0 of 40** isolated runs reproduced it (`pnpm test browser -t stepping`, same machine, same hour).
  It needs the full suite's parallel contention.
- Never recorded before in any brief, the ledger or `PROMPT.md`.
- M18 touched none of the path: not `src/test/harness*.ts`, `test/harness-worker.ts`, `worker/sim.ts`,
  `src/sab/` or `fixtures/hash`. M18 did raise the fast `browser` suite from 145 to 168 tests, which
  adds contention. The same quiet batches also showed one `park('sim'): timed out after 10000 ms` on
  `gc: flat transport parity` (the standing `parkWorkers` watch item). Whether the two share a
  cause is unknown.
- M17c found two `Atomics.wait` loops that checked their park flag only *after* waiting
  (`worker/shell.ts` `runBlockingLoop` and `test/harness-worker.ts` `armedLoop`). A lost or duplicated
  step request under contention would be the same family: a guess, not a finding.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/03-browser-harness.md` (Seams: the `stepTick`/`park`/`resume`/`hash` contract) and its Deviations
3. `docs/plan/17c-client-park-stall.md` Deviations (the two wait-loop fixes and the `Debugger.pause` technique)
4. `docs/plan/16e-park-timeout-diagnosis.md` Deviations (how a harness timeout was made to name its state)

## Scope
1. Make the failure explain itself first (the rule from M16e and M17d: *make a failure that needs
   contention explain itself before guessing at it*). On a mismatch, the test's message carries
   both hashes, the sim worker's own count of ticks run (read through the harness, not inferred),
   the step-request and ack words, and whether the worker was parked when `hash` was read.
2. Try to reproduce, bounded: `node scripts/repeat.mjs browser 20` and `... 15 --load 10`, foreground.
   Also try `--js-flags=--no-opt --no-sparkplug` on the project that runs `stepping` (a diagnostic,
   never committed; M15f's technique).
3. If it is reproduced: name the cause (function plus the condition that let a tick be lost,
   repeated or raced), fix it, and add a deterministic test that fails without the fix. Re-run
   that test red against the unfixed code and paste the output.
4. If it is not reproduced within step 2's runs: commit step 1's diagnostic and stop. The next
   occurrence names the cause. That is an acceptable end state (as for M16e).

## Non-scope
The `parkWorkers` timeout itself, unless step 1's data shows it has the same cause. Suite-time
budgets. Any zero-GC budget.

## Files, packages and crates touched
`packages/engine` (`src/test/harness*.ts`, `src/test/harness-worker.ts`, `tests/browser/stepping.spec.ts`,
`tests/browser/pages/src/stepping.ts`; `src/worker/shell.ts` and `src/worker/sim.ts` only if the cause
is there).

## Seams
**Provides** nothing new. The harness contract in M03's brief is unchanged. If it must change,
stop and report.

## Order of work
1. Diagnostic message. 2. Bounded reproduction. 3. Fix plus a test that fails without it, or stop.

## Tests added
The regression test named by step 3, if the cause is found. `stepping.spec.ts`'s existing assertions
keep their meaning; the diagnostic only adds to the failure message.

## Exit criteria
- [ ] A `stepping` hash mismatch prints both hashes, ticks run, the step-request and ack words, and
      parked state.
- [ ] The cause is named and fixed with a test that fails without the fix, **or** step 2's bounded
      attempt is recorded in Deviations with its run counts and the diagnostic is committed.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t stepping` · `node scripts/repeat.mjs browser <n> [--load 10]` (foreground,
bounded, a per-run kill timeout, no background load generators).

## Budgets
none changed.

## Context artifacts
If a cause is found: one line in `packages/engine/CLAUDE.md`'s "Adding a browser spec" paragraph, or
in the `run-tests` skill, naming the trap.

## Manual device checks
none

## Deviations

### Step 1: the diagnostic (Provides, exact shape)

**A hash mismatch now `throw`s a plain `Error`, not just `expect(actual).toBe(expected)`** --
mirroring M03's own lesson (Deviations, `no_ambient_random`): the JSON-reporter-based runner does
not reliably carry a matcher's own Expected/Received diff into the failure message it captures,
which is the likeliest explanation for the evidence table's own one-line capture. Message shape:

```
stepping hash mismatch: expected=<hex> actual=<hex> ticksRun=<n> req=<n> ack=<n> state=<n> yield=<n>
```

`ticksRun` is new: a counter in `harness-worker.ts` (`ticksRun`, module-level), incremented once
per real `coreTick()` call (every branch that calls `sim_tick`), read back through a new
`'ticks'` protocol message (`protocol.ts`) -- **read through the harness, not inferred**: `req`/
`ack` are set unconditionally by the worker's own loop regardless of how many times it actually
ticked (`Ack = last` runs whether `coreTick` ran once, twice or zero times that pass), so they
cannot by themselves reveal a lost or duplicated tick. `req`/`ack`/`state`/`yieldFlag` are the
step block's own words (`step-block.ts`'s `StepBlockField`), read directly off shared memory (no
message needed); `state` is a `WorkerState` value and doubles as "was the worker really parked
(`WorkerState.Idle` = 0) at the moment `hash` was read".

**New surface: `HarnessDebug.debugSnapshot(worker)` (`harness.ts`), deliberately *not* folded into
the shared `Harness` interface.** `src/test/client.ts`'s `asHarness` (the production-topology
counterpart to `createHarness`'s own harness, `gc-test` skill) implements `Harness` too, and is
outside this brief's Files list; adding a method to `Harness` itself broke its typecheck
(`tsc`: "Property 'debugSnapshot' is missing in type ... required in type 'Harness'"), which is
exactly the "must change, stop and report" trip-wire in Seams. Fixed by keeping `Harness` itself
untouched and instead widening only `createHarness`'s own return type to `Promise<Harness &
HarnessDebug>`; `stepping.spec.ts` casts `window.__harness` to `Harness & HarnessDebug` locally,
inside the one test that needs it, rather than widening the page's ambient `Window.__harness` type
(shared, unchanged, with `stepping.ts`). So: **Seams above ("Provides nothing new") holds for the
`Harness` contract other milestones consume; `HarnessDebug` is a new, separate, diagnostic-only
type this milestone adds, consumed by nothing outside `stepping.spec.ts`.** Flagged here rather
than silently added, per the general escalation rule on a Provides change -- if the orchestrator
wants this undone or reshaped, nothing else depends on it yet.

**Proved with two temporary, reverted injections (both reverted; `git diff --exit-code` confirmed
clean before every commit in this session):**
- Skipping one page-side `stepTick()` call (`stepping.spec.ts`, 999 instead of 1000): `stepping
  hash mismatch: expected=c6ae33a1d472c7f6 actual=52cd0b55d863ff01 ticksRun=999 req=999 ack=999
  state=0 yield=0` -- a lost tick, all three counters agree (999), which the message shows plainly.
- Duplicating one worker-side `coreTick()` call inside `runOp`'s `Tick` branch
  (`harness-worker.ts`): `stepping hash mismatch: expected=c6ae33a1d472c7f6
  actual=c81a8403a18391c7 ticksRun=2000 req=1000 ack=1000 state=0 yield=0` -- exactly the case
  `ticksRun` exists to catch: `req`/`ack` both read 1000 (a normal-looking round trip), while
  `ticksRun=2000` names the double-tick `req`/`ack` alone would hide.

### Step 2: bounded reproduction -- not reproduced

All three configurations came back clean, well inside the brief's own bound (two named runs plus
the optional forced-interpreter diagnostic):
- `node scripts/repeat.mjs browser 20` (quiet): **`browser x20 load=0: pass=20 fail=0 hang=0
  slowestSuiteSeconds=24`**.
- `node scripts/repeat.mjs browser 15 --load 10`: **`browser x15 load=10: pass=15 fail=0 hang=0
  slowestSuiteSeconds=34`**.
- `--js-flags=--no-opt --no-sparkplug` added to the `chromium` project's `launchOptions.args`
  (`playwright.config.ts`, temporary, reverted after -- `git diff --exit-code` confirmed clean),
  then `pnpm exec playwright test --config packages/engine/playwright.config.ts --project chromium
  --grep stepping --repeat-each 40 --workers 3`: **160 passed (41.1s)**, 0 failures.

195 total runs of `stepping.spec.ts` across quiet, loaded and forced-interpreter conditions, 0
reproductions, 0 failures of any kind (including no `parkWorkers`/`park('sim')`-shaped failure
from a sibling spec in the same suite run). Per the brief's own cut line ("If it does not
reproduce... commit step 1 and stop. That is an accepted outcome"): step 1's diagnostic is
committed; step 3 (name and fix the cause) does not apply, since no occurrence was caught to name
a cause from. The next occurrence, wherever it happens, now prints its own hashes, `ticksRun`,
`req`/`ack` and `state`/`yieldFlag` instead of a bare `expect(actual).toBe(expected)`.

### Context artifacts

None written: the brief's own instruction ("If a cause is found: one line in
`packages/engine/CLAUDE.md`'s ... or in the `run-tests` skill") is conditional on a cause being
found, and step 2 did not reproduce one. `HarnessDebug`'s own doc comment (`harness.ts`) carries
the shape for the next session that reads this file directly.

### Not run

`pnpm test` and `pnpm lint` in full are the orchestrator's, per the delegation prompt; targeted
runs only (`pnpm test browser -t stepping`, `pnpm test browser -t "1,000 stepTick"`, the two
`repeat.mjs` batches, and the one forced-interpreter batch above).
