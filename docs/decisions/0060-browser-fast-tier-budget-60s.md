# 0060: `browser` fast-tier budget, 48,000 → 60,000 ms

Status: Accepted (2026-10-10). Amends [0036](0036-browser-fast-tier-budget-48s.md) §1 (the `browser`
budget number only; §2-§4 stand). Tyler answered Q16 on 2026-10-10. Implemented by M39ai.

## Context

[0036](0036-browser-fast-tier-budget-48s.md) §1 set 48,000 ms so that build (10 s) + browser (48 s)
stayed under one minute. By M34b the suite reached 49 s, the demotion ladder of
[0020](0020-testing-strategy.md) §4 is exhausted, and each new browser test cost a demotion
([0043](0043-zero-gc-worker-object-controls-slow-on-reference-page.md)). 0036 §4 says the next step past this point is a
recorded decision, not a silent bump.

## Decision

**1. `budgetMs` for `browser` (`scripts/suites.mjs`) is 60,000.** With the 10 s build the fast tier
takes about 70 s. Tyler accepted that knowingly (Q16; `docs/spec/testing.md` Requirements now say
"about 70 s"). 0036 §3's classification is unchanged: WARN at budget, FAIL at 1.5x (90,000).

**2. The per-test rules do not move.** The ≤ 3 s p95 browser ceiling (0020 §4) and `@slow` for tests
slow by nature stay binding; the extra room is not an invitation to demote less carefully.

## Alternatives rejected

- **Keep 48 s and demote per 0043.** The fast tier would stop proving on some pages that a worker allocation trips.
- **Shard now.** Still deferred (0036 §4); revisit when 60 s fills.

## Consequences

- When `browser` reaches about 55 s quiet, shard or re-divide by ADR; going past 70 s total needs Tyler.

## Sources

- `docs/plan/questions-for-tyler.md` Q16; `docs/spec/testing.md`.
