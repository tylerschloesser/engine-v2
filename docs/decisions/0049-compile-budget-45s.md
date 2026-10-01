# 0049: The incremental-rebuild budget is 45 s

Status: Accepted (2026-10-01). Amends [0020](0020-testing-strategy.md) §3 ("Compilation is budgeted separately: ≤ 30 s"). Answers Q17 (`docs/plan/questions-for-tyler.md`).

## Context

[0020](0020-testing-strategy.md) §3 budgets a one-line Rust edit to tests starting at 30 s, from Tyler's Requirement in [`docs/spec/testing.md`](../spec/testing.md). M36b measured it with `pnpm measure:rebuild` (five reps each, flat, Tyler's Mac, [ADR 0048](0048-fast-tier-budgets-dev-loop-and-wire-measurements.md)): a game-crate edit 17.0 s, an engine-crate edit 37.6 s. Both levers short of a re-architecture are pulled: `debug = "line-tables-only"` ([0045](0045-build-profiles-measured.md)) and `split-debuginfo = "packed"` ([0048](0048-fast-tier-budgets-dev-loop-and-wire-measurements.md), which also stopped the `.rcgu.o` build-up that drifted rebuilds to 58 s and to minutes). The remaining lever was splitting the engine crate.

## Decision

Tyler chose a higher budget over a crate split (2026-10-01): **≤ 45 s from a one-line Rust edit to tests starting**, for any crate. 45 s is about 20 % over the measured engine edit, so a real regression (the 58 s drift M36b found) still shows, while machine noise on the shared Mac does not. `scripts/measure-rebuild.mjs` flags a median over 45 s; `docs/spec/testing.md` records Tyler's figure.

## Alternatives rejected

- **Split the engine crate** along its most-edited module boundary: a re-architecture with its own milestone and ADR, for ~8 s on engine edits only; agents mostly edit game crates, already at 17 s.
- **40 s:** ~6 % headroom; a loaded machine would flag good builds.
- **60 s:** a ~50 % regression would go unflagged.

## Consequences

No crate split is planned. If the engine-edit median passes 45 s, the crate split is the next lever and needs its own milestone. Cold builds stay outside the budget (0020 §3).

## Sources

M36b Deviations (`docs/plan/36b-suite-audit-and-measurements.md`), ADR 0048, Q17.
