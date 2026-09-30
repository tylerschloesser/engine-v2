# 0043: On `reference_single_player`, the worker `object` negative controls move to the slow tier

Status: Accepted (2026-09-30). Amends [0026](0026-zero-gc-burst-controls-in-slow-tier.md) §1 (which controls are tagged `@slow`: "`object` negatives keep no tag and stay in the fast tier for every page") and, through it, [0016](0016-zero-gc-definition.md) §3 step 8 (schedule only); cites [0020](0020-testing-strategy.md) §4, [0029](0029-zero-gc-software-mode-attribution.md) and [0036](0036-browser-fast-tier-budget-48s.md). Decided by the orchestrator at M34b's gate. Implemented in M34b.

## Context

The `browser` fast tier ran 45-46 s of its 48 s budget ([0036](0036-browser-fast-tier-budget-48s.md)) with [0020](0020-testing-strategy.md) §4's demotion ladder exhausted. M34b added the zero-GC page `reference_single_player` (`gc.reference_single_player`): five tests, 17.0 s of worker time, about 3.4 s wall, taking the suite to 49 s. Per test: `neg object client` 3.63 s, `neg object main` 3.58 s, `neg object sim` 3.55 s, `neg object gen0` 3.41 s, `clean` 2.80 s. The page passes `strict` on every isolate.

## Decision

**1. A per-page `zeroGcSuite` option tags the worker `object` controls `@slow`.** On `reference_single_player` the `neg object` controls for `client`, `sim` and `gen0` are tagged `@slow`. The option defaults off; no other page changes, and [0026](0026-zero-gc-burst-controls-in-slow-tier.md) §1-§3 otherwise stand.

**2. The fast tier keeps `clean` and `neg object main`.** `clean` keeps its discovered-isolates assertion ([0026](0026-zero-gc-burst-controls-in-slow-tier.md) §3). `main` stays because it is the isolate whose attribution is a live inlining detector ([0029](0029-zero-gc-software-mode-attribution.md)). The demoted controls run in `pnpm test:slow` and CI's slow tier. Saves about 10.6 s worker time, about 2 s wall.

**3. Later zero-GC pages default to the same split when the suite has no headroom.** Each use is listed in its milestone's Deviations.

## Alternatives rejected

- **Raising the 48 s budget.** Tyler's call, because of his one-minute requirement (build 10 s + browser 48 s); opened as a question in `docs/plan/questions-for-tyler.md`, not decided here.
- **Widening any other budget.** Forbidden by [0029](0029-zero-gc-software-mode-attribution.md).
- **Dropping the controls.** They prove the instrument per isolate; only their schedule changes.

## Consequences

- The fast tier loses no class of coverage: the same worker-side hooks are already proven per worker on earlier pages in the fast tier. It loses only this page's repetition of it.
- The fast tier no longer proves on this page that a worker allocation would trip; `pnpm test:slow` does.
- Revisit if Tyler raises the `browser` budget: the option can then be turned off.

## Sources

- M34b gate measurements, 2026-09-30 (per-test times above); `packages/engine/tests/browser/gc/suite.ts`.
