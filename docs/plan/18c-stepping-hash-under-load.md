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
(filled in during Phase 3)
