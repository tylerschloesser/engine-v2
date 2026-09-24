# M19b: `park('sim')` times out while the worker is armed

Status: not started · After: 19 · Tyler-dependent: no

Written by the orchestrator at M19's gate, from three occurrences with the same signature.

## Goal

Find out why `park('sim')` sometimes times out on `gc: flat transport parity`
(`packages/engine/tests/browser/gc-loop.spec.ts`) while the `sim` worker is **armed** (blocked in
`Atomics.wait` on `Req`, nothing outstanding), and fix it. This is the standing `parkWorkers` watch
item. M17c fixed two loops that checked their park flag only *after* waiting. This occurrence has a
different signature and is now the most frequent failure in the fast tier.

## The evidence, gathered by the orchestrator

- **Three occurrences, one signature**, all on `gc: flat transport parity`, all in quiet full-suite
  loops, never under load:
  - M18's gate: `park('sim'): timed out after 10000 ms workers=[{"name":"sim","Req":1500,"Ack":1500,"State":1,"Yield":1,"armed":true}]`.
  - M19's gate, quiet batch of 15: the same with `Req` 3000 / `Ack` 3000.
  - The rate is about 1 in 15 quiet runs. It was **0 in 58 runs under `--load 10`** across the same two
    gates. A failure that load *hides* points at a lost notify, whose window load makes less likely,
    rather than at saturation: a guess, not a finding.
- `State` 1 is `WorkerState.Armed` (`src/test/step-block.ts`: "blocked in `Atomics.wait` on `Req`,
  ready for the next request"). So the worker is waiting and caught up (`Req` = `Ack`) when the
  park request goes unseen for 10 s.
- The test is unusual in three ways. It opens `/gc-loop.html` **twice in one tab**, measuring once per
  CDP transport. The second `measure` attaches through `flatAttachForThisWorker`
  (`tests/browser/gc/cdp-flat.ts`) rather than the tunnel sessions. And `Req` = 1500 in one occurrence
  and 3000 in the other, which is one or two 1,500-tick measure windows. So the park that fails may be
  after the first measure or after the second.
- M17c's fix (`docs/plan/17c-client-park-stall.md` Deviations): `test/harness-worker.ts`'s `armedLoop`
  now checks the park flag before every wait, because `parkOne`'s notify never changes `Req` and is
  lost when no waiter is present. A waiter *is* present here (`Armed`), so either the notify never
  reaches this wait, or it is sent on a different word or index, or the woken loop re-arms without
  checking the flag.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/17c-client-park-stall.md` Deviations (the two wait-loop fixes; the `Debugger.pause` stack technique, also in the `gc-test` skill)
3. `docs/plan/16e-park-timeout-diagnosis.md` Deviations (how the timeout names its worker and state)
4. `docs/plan/04-zero-gc-harness.md` Deviations, only the parts on `measure`, the two CDP transports and `parkOne`

## Scope
1. Read `armedLoop` and `parkOne`/`park` against this signature and write down every path by which
   an armed worker can miss a park. That is a list of candidates, not a fix.
2. Reproduce, bounded: `pnpm test browser -t "flat transport parity"` in a foreground loop (it is one
   short test), then the quiet full suite (`node scripts/repeat.mjs browser 15`) if isolation
   does not reproduce it. On a reproduction, take the stuck worker's stack (`Debugger.pause`, 17c's
   technique) and add to the timeout message whichever words it lacks: the park flag, the
   wait's index, and which of the two `measure`s it follows.
3. Fix the named cause with a deterministic test that fails without the fix. Re-run that test red
   against the unfixed code and paste the output.
4. If step 2 does not reproduce within 20 isolated-loop runs of 20 plus two quiet batches, commit
   the added diagnostic words and stop. The next occurrence names the cause (the M16e and M18c outcome).

## Non-scope
Lengthening the 10 s timeout (it is the only thing measuring this). Any zero-GC budget. The
`stepping` hash watch item (M18c), unless the data shows a shared cause.

## Files, packages and crates touched
`packages/engine` (`src/test/harness-worker.ts`, `src/test/harness.ts`, `src/test/step-block.ts`,
`tests/browser/gc-loop.spec.ts`, `tests/browser/gc/*.ts`; `src/worker/shell.ts` only if the cause is
there).

## Seams
**Provides** nothing new. `park`/`resume` keep M03's contract.

## Order of work
1. Candidate list. 2. Bounded reproduction plus diagnostic words. 3. Fix plus a failing-first test, or stop.

## Tests added
The regression test named by step 3, if the cause is found.

## Exit criteria
- [ ] The timeout message names the park flag, the wait index and which `measure` it follows.
- [ ] The cause is named and fixed with a test that fails without the fix, **or** step 4's bounded
      attempt is recorded in Deviations with its run counts.
- [ ] If fixed: `node scripts/repeat.mjs browser 15` quiet shows no `park('sim')` timeout.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t "flat transport parity"` · `node scripts/repeat.mjs browser <n> [--load 10]`
(foreground, bounded, a per-run kill timeout, no background load generators).

## Budgets
none changed.

## Context artifacts
If a cause is found: one line in the `gc-test` skill's debugging section.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
