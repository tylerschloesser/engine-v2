# 0036: `browser` fast-tier budget, 35,000 → 48,000 ms

Status: Accepted (2026-09-25). Amends [0033](0033-fast-tier-budget-after-build-fix.md) §2 (the
`browser` suite budget only; §1 and §3 stand). Decided by the orchestrator with Tyler.

## Context

[0033](0033-fast-tier-budget-after-build-fix.md) §2 set `browser`'s budget to 35,000 ms so that
build (10 s, §1) + browser (35 s) = 45 s left 15 s of margin under Tyler's one-minute requirement
(`docs/spec/testing.md`), and recorded that "if a future milestone's browser suite content pushes
past ~35 s quiet, the next re-division is this ADR's job to redo, not a silent budget bump."

Measured at M20b-M21 (2026-09-25, Tyler's Mac): `browser` is 185 tests at 28-29 s quiet and 36-39 s
under `node scripts/repeat.mjs browser 15 --load 10` -- a WARN against the 35,000 budget (1.5x FAIL
line is 52,500, `scripts/lib/report.mjs`'s `classifyBudget`), not a fail, but consistently close to
budget rather than comfortably under it.

At M15c all 110 browser tests then existing were ranked against [0020](0020-testing-strategy.md)
§4's demotion rule: longest single test 1.79 s against the ≤ 3 s p95 ceiling, summed work 58.6 s. The
demotion ladder (§4's ordered list: multi-engine repeats, real-socket repeats, large-world/soak/
long-replay variants, heavy mode, wall-clock measurement) has no remaining rung -- `PROMPT.md` notes
it as exhausted. Under a full 35,000 budget the only levers left were harmful: M20 moved the only
test of a feature (`reference_depletion_visible`) to `@slow`, which then went red on CI because a
feature needs its fast-tier coverage, not a slow-tier substitute; the alternatives are squeezing
assertions until they stop testing anything, or telling implementers to find time in a suite that has
none. Remaining milestones -- persistence (M22-M24), netcode (M25-M31), the reference game
(M32-M34) -- each need a few browser tests of their own.

**Tyler's stated preference (recorded verbatim, 2026-09-25):** "I would prefer to delegate optimal
test execution to Claude as much as possible." Consequence for this budget: the full fast suite is
the *gate's* instrument -- the orchestrator at every `done` gate, and CI -- not a constraint on
anyone's edit-loop. Iteration during a milestone is a targeted run (`pnpm test <suite> -t <pattern>`),
chosen by the implementing agent, not the full `browser` leg.

## Decision

**1. `budgetMs` for the `browser` suite (`scripts/suites.mjs`): 35,000 → 48,000.** With `buildBudgetMs`
unchanged at 10,000 ([0033](0033-fast-tier-budget-after-build-fix.md) §1), build (10 s) + browser
(48 s) = 58 s, under Tyler's one-minute requirement with a 2 s margin at both budgets' own ceiling
simultaneously; `rust`, `unit` and `wasm` run in parallel with `browser` ([0033](0033-fast-tier-budget-after-build-fix.md)
§2's own reasoning, unchanged) so they do not add to this total. Today's measured 28-29 s quiet /
36-39 s under load sits well inside 48,000 with room for the browser tests M22-M34 still need to add.

**2. The per-test p95 rule is what actually protects iteration speed, and it is unchanged.**
[0020](0020-testing-strategy.md) §4's ≤ 3 s p95 (browser) / ≤ 0.5 s (Rust/Node) stays binding. The
`@slow` tier remains for tests slow by nature -- zero-GC burst controls ([0026](0026-zero-gc-burst-controls-in-slow-tier.md)),
WebKit/Firefox repeats, real-time/wall-clock and hardware benchmarks -- not for overflow from a full
fast tier. Raising the suite budget does not relax what any one test is allowed to cost.

**3. WARN/FAIL classification is unchanged.** `scripts/lib/report.mjs`'s `classifyBudget` still WARNs
at budget and FAILs at 1.5x budget (72,000 for `browser`); only the budget number moves.

**4. When 48,000 fills (≈ 45 s quiet), the next step is sharding or a re-division, recorded as an
ADR, never a silent bump.** Sharding means per-area commands the orchestrator can run alone (for
example a `reference` or `netcode` leg), splitting the one `browser` suite's wall time across more
than one gate rather than raising this number again. Going past the one-minute total needs Tyler to
change the requirement in `docs/spec/testing.md`.

## Alternatives rejected

- **Leaving the budget at 35,000 and demoting more tests.** The demotion ladder (0020 §4) is already
  exhausted (measured at M15c, reconfirmed here); the only remaining moves shrink real coverage
  (M20's `reference_depletion_visible` demotion, which went red on CI) or make assertions weaker
  in place, not free time.
- **Splitting the freed one-minute margin across `rust`/`unit`/`wasm` instead.** None of the three is
  near its own budget and they run in parallel with `browser`, so raising their budgets would not
  change fast-tier wall time -- the same reasoning [0033](0033-fast-tier-budget-after-build-fix.md)
  §2's own Alternatives rejected gave for the previous re-division.
- **Sharding now, instead of raising the number.** Measured margin (28-29 s / 36-39 s against a new
  48,000 ceiling) does not yet require it; premature sharding adds orchestration complexity before
  the suite actually needs it. Deferred to whenever headroom (~45 s quiet, Decision §4) is reached.
- **Raising the budget past 48,000 now, to bank more headroom.** Nothing measured justifies a larger
  number today, and 0033's own lesson is that a budget re-division should follow measurement, not
  precede it.

## Consequences

- `scripts/suites.mjs`'s `browser` entry cites this ADR in its comment in place of 0033.
- `docs/spec/testing.md` Requirements gains Tyler's verbatim preference (§Context) as the record of
  why the fast suite, not the edit-loop, is what this budget governs.
- `PROMPT.md`'s ground-figures and warning text move from "35 s" to "48 s"; the "must keep them very
  few and short" instruction softens to citing 0020 §4's p95 rule directly and naming the ~45 s quiet
  headroom point from Decision §4.
- Saturation (the `parkWorkers` watch item, [0031](0031-browser-suite-five-workers.md)) depends on
  test count and worker parallelism, not on this budget number; the repeat loops (`scripts/repeat.mjs`)
  keep measuring it independently of this change.
- Open, same as 0033 left it: whether `crates/engine`'s test-file count should be consolidated
  (`questions-for-tyler.md` Q14) is unaffected by this ADR, which touches only the `browser` suite's
  own budget.

## Sources

- `test-results/` timings referenced in `PROMPT.md`'s State line (M20b-M21, 2026-09-25, Tyler's Mac):
  `browser` 185 tests, 28-29 s quiet, 36-39 s under `node scripts/repeat.mjs browser 15 --load 10`.
- M15c's full-suite ranking against [0020](0020-testing-strategy.md) §4 (110 tests, longest 1.79 s,
  summed 58.6 s), cited in `PROMPT.md`/`docs/plan/deferred-ledger.md` as the point the demotion
  ladder was exhausted.
- M20's Deviations: `reference_depletion_visible` demoted to `@slow`, then red on CI.
- [0033](0033-fast-tier-budget-after-build-fix.md) §1-§2 (the build fix and the prior re-division this
  ADR amends). [0020](0020-testing-strategy.md) §4 (the demotion rule and per-test p95, unchanged).
  [0031](0031-browser-suite-five-workers.md) (the suite's own quiet/under-load measurement method,
  unchanged by this ADR).
- Tyler, conversation with the orchestrator, 2026-09-25 (the delegation-preference quotation, §Context).
