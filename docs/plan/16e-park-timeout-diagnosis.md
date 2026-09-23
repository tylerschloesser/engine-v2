# M16e: Name the worker behind `parkWorkers: timed out`, then fix it

Status: not started · After: 16b · Tyler-dependent: no

## Goal

The `parkWorkers: timed out after 10000 ms` watch item (`deferred-ledger.md`) is explained by
a measurement and then fixed or bounded. Its failure message names which worker did not park and
what state it was in, the way `windowByFn` names zero-GC allocations. That makes the next
occurrence, locally or on CI, diagnose itself.

## The evidence, gathered by the orchestrator

Most recent occurrences are on the M16 page `zero_gc_action`, all on negative controls:

| gate | condition | test |
|---|---|---|
| M16 | quiet, 1 in 30 | `zero_gc_action neg object client` |
| M16 done | quiet, 1 in 15 | `zero_gc_action neg object client` (20/20 alone) |
| M16b done | `--load 10`, 1 in 15 | `zero_gc_action neg object main` |
| M16b done, final gate | quiet (load 6-8), 1 of 1 full run | **`gc-loop neg object sim`: no `parkWorkers` message, a 30 s Playwright test timeout inside a warm-up `window.__gc.run(n)` (`gc/instrument.ts:221`)**. 15/15 alone |

Earlier ones hit `terrain` (slow tier, load 6.9) and an M15d-era suite at 28 s. The ledger has
called it saturation, but it now appears without load, on one page, since the suite dropped to
18 s. The timeout itself is `pollUntil` in `packages/engine/src/test/client.ts`: `parkWorkers`
sets `W_YIELD = 1` and wakes each worker, then polls on `setTimeout(0)` until every `W_PARKED` is 1.
The error cannot tell these apart:
- **(a)** one worker stayed inside `body()` for 10 s and never reached the loop's `W_YIELD` check;
- **(b)** a worker was never woken (a lost wake);
- **(c)** `main`'s own poll was starved, with too few `setTimeout` turns in 10 s;
- **(d)** a worker died or is spinning.

**The `gc-loop` instance shows it is not specific to `zero_gc_action`, and that `__gc.run`'s own wait on the workers has no bounded, self-describing timeout at all.** It only surfaces as Playwright's 30 s, which names nothing. Step 1 covers that wait too. `zero_gc_action`'s page (`gc-slice.ts`) ticks the sim every frame, and M16d changed
`AtomicsTimer`, so a sim worker that is busy for a long stretch is plausible, but it is a guess.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0015-threads-memory-and-topology.md` (§2 and the `yield` protocol)
3. `docs/plan/06b-workers-and-spawn.md` Deviations (the park/resume protocol and its fix rounds)
4. the `gc-test` skill
Rules: `.claude/rules/hot-paths.md` (`parkWorkers` runs inside the measured window).

## Scope
1. **Instrument the failure, without allocating on the success path, in both places:** `parkWorkers`' `pollUntil`, and whatever `window.__gc.run` waits on (the M04 harness page side). Give the latter a bounded timeout under Playwright's 30 s that fails with the same per-worker message. On timeout only, the
   error lists, per worker: kind, index, `W_YIELD`, `W_PARKED`, `W_WAKE`, `W_ACK`, and whether it
   is dead (`shell.fatal`). It also gives the number of poll turns taken and the longest gap
   between them (case c). Build the message only in the reject branch. Check with the page's
   `object` control that the success path allocates nothing new.
2. **Reproduce, then attribute.** Use `pnpm gc -t "zero_gc_action neg object"` with
   `--repeat-each`, quiet and under `node scripts/repeat.mjs` load, or the whole `gc` project, until
   the instrumented message fires. Paste it. If forced interpreter (`--no-opt --no-sparkplug` in
   the `gc` project's `--js-flags`; a diagnostic, reverted) makes it deterministic, say so.
3. **Fix the cause the message names.** A lost wake or a body that never yields is a real
   protocol defect: fix it in `worker/shell.ts` or `worker/sim.ts` and add a test that fails
   without the fix. If it is (c), main starved by the control's own allocation, say what the
   measurement shows before choosing a remedy. **The 10 s timeout does not change** (the ledger
   row says why).
4. If it cannot be reproduced in a bounded effort (roughly 60 runs of the page's controls plus
   two loaded suite batches), land step 1 alone. The next CI or gate occurrence will name the
   cause. Record the attempt in Deviations.

## Non-scope
Lengthening any timeout; changing `budgets.json`; the 600-frame windows; demoting the controls.

## Files, packages and crates touched
`packages/engine/src/test/client.ts`, `src/worker/{shell,sim}.ts` and `src/sab/control.ts` if
the cause is there, their tests, and `tests/browser/gc/` if a harness change is needed.

## Seams
**Provides:** the enriched `parkWorkers` failure message (record its exact format).
**Consumes:** M06b park/resume, M04 `zeroGcSuite`, M16 `gc-slice.ts`, M16d `AtomicsTimer`.

## Order of work
Steps 1-4 in order, each committed `M16e step k: …`.

## Tests added
Whatever step 3's fix needs, failing without it.

## Exit criteria
- [ ] The timeout message carries the per-worker state and poll-turn data (a forced timeout's
      output pasted, for example with the limit temporarily at 1 ms, then reverted).
- [ ] Either the cause is named from a real occurrence and fixed with a failing-then-passing test,
      or step 4's bounded attempt is recorded and the instrumented message is committed.
- [ ] `zero_gc_action`'s negative controls still trip and its budgets are unchanged.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm gc -t "zero_gc_action"` · `pnpm test browser -t <pattern>` ·
`node scripts/repeat.mjs browser <n> [--load 10]` (in the foreground, bounded; no background load
generators).

## Budgets
none changed.

## Context artifacts
Add the new failure message's fields to the `gc-test` skill's debugging section.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
