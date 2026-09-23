# M16f: Bound the harness waits, test the `gen` yield lead, attribute the sibling-burst `main` rise

Status: not started · After: 16e · Tyler-dependent: no

## Goal

Every wait in the engine's test harness fails within a bound, with M16e's per-worker message. No
hang can end as a bare Playwright timeout again. M16e's leading candidate for a stuck worker
(`gen.ts` draining its whole request ring without checking `W_YIELD`) is proven or disproven with
a synthetic backlog. The local hardware slow tier is green again, and the `connected-terrain`
`main` rise under a sibling burst is attributed by function first.

## The evidence

- **M16e** (`docs/plan/16e-park-timeout-diagnosis.md` Deviations) instrumented `pollUntil` and the
  spin-waits and caught two real occurrences:
  - `parkWorkers` named `gen0`: its ack had caught up but its wake counter never moved.
  - A bare 30 s timeout on `gc-loop clean`, inside the M03 harness (`src/test/harness.ts`), whose
    `resume`/`park`/`hash`/`admit`/`memoryBytes`/`memGrows` waits have no time bound and whose
    `awaitAck` spin is bounded only by iteration count.
  - Its candidate, not applied as a guess-fix: `src/worker/gen.ts`'s `body()` drains the whole
    request ring in one `for (;;)` with no `W_YIELD` check.
- **Slow tier, hardware mode, local only:** `pnpm test:slow -t "connected-terrain neg burst"` fails
  3/3. The burst isolate trips correctly (40,134-80,075 B/frame). `main` reads **111.07-111.74
  B/frame against its strict hardware budget of 111** whenever a *sibling* isolate (`client`,
  `sim` or `gen0`) bursts. M16e reports the same on its base. CI's slow tier is software mode and
  green. That is the shape of M15f, where a sibling burst starved `main`'s JIT and exposed a real
  allocation (`stepSimTickSync`'s closure). **It is not known when this started.** Bisect it in a
  separate git worktree (`git worktree add`), never by checking old paths into the main tree.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/16e-park-timeout-diagnosis.md` (Deviations)
3. `docs/plan/15f-step-sim-tick-sync-allocation.md` (the sibling-burst precedent and its method)
4. the `gc-test` skill
Rules: `.claude/rules/hot-paths.md`.

## Scope
1. **Bound every harness wait** in `src/test/harness.ts` (and any other `engine/test` wait M16e
   left unbounded), failing with M16e's per-worker message format. Keep the success path
   allocation-free, prove the `gc-loop` page's controls still trip, and paste a forced timeout.
2. **Test the `gen` yield lead.** Build a synthetic backlog (many `genRequest`s queued, then
   `parkWorkers`) and measure how long `gen0` takes to park. If a long drain delays parking, add a
   `W_YIELD` check between requests, with a test that fails without it. If it does not, record the
   measurement and leave `gen.ts` alone.
3. **Attribute the `connected-terrain` sibling-burst `main` rise.** Force the budget to 1 to dump
   `windowByFn.main` for clean and for each sibling burst, and diff them. Bisect in a worktree to
   the commit where the rise appeared. Fix the allocation if it is avoidable, as M15f did. Only if
   it is inherent, re-derive with ADR 0029's check on both sides. Never widen the budget to clear it.

## Non-scope
The 10 s `pollUntil` bound, Playwright's 30 s, `budgets.json` upward, the 600-frame windows.

## Files, packages and crates touched
`packages/engine/src/test/{harness,client}.ts`, `src/worker/gen.ts` (step 2 only, if proven),
`tests/browser/**`, whatever step 3's attribution names.

## Seams
**Provides:** bounded harness waits with M16e's message format. **Consumes:** M03 harness, M04
`zeroGcSuite`, M08b gen worker, M16e message format.

## Order of work
1, 2, 3, each committed `M16f step k: …`.

## Tests added
Step 2's backlog test (if the lead holds) and whatever step 3's fix needs.

## Exit criteria
- [ ] Every `src/test/harness.ts` wait is time-bounded, with a forced timeout's message pasted.
- [ ] The `gen` yield lead is proven (fix plus failing-then-passing test) or disproven (measurement
      recorded).
- [ ] `pnpm test:slow -t "connected-terrain"` is green in hardware mode, and the cause is attributed
      in Deviations with `windowByFn` and the bisected commit.
- [ ] No `budgets.json` number raised; every zero-GC control still trips.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test:slow -t <pattern>` · `pnpm gc -t <page>` · `pnpm test browser -t <pattern>`.

## Budgets
none raised.

## Context artifacts
The `gc-test` skill, if the harness message or a debugging step changes.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
