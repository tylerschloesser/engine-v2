# 0054: A `tools` suite for the device-walk tool's tests

Status: Accepted (2026-10-07). Amends [0020](0020-testing-strategy.md) §3 (the suites-and-budgets table). Implemented by M39x in `vitest.config.ts` and `scripts/suites.mjs`.

## Context

[0020](0020-testing-strategy.md) §3 gives `unit` a 3 s budget, and it runs first and alone (`first: true`), so every second of it is paid before anything else starts. At M37 it ran in 1.3 s; at M39w's done gate it ran 646 tests in 2.9 s. Most of the growth was the device-walk tool's tests (`scripts/lib/device-walk*.test.mjs`, 244 tests, M39e-M39w). They test Mac-side tooling that drives phones, not the engine or the game, and they cost real time (fake servers, fake phones).

## Decision

**1. A `tools` suite.** A Vitest project and a `suites.mjs` row (`kind: 'vitest'`, fast and slow tiers, not `first`). It includes `scripts/lib/device-walk*.test.mjs`; `unit` excludes exactly those files. No test is deleted: `unit` plus `tools` equals the old `unit` count. Run one with `pnpm test tools -t device-walk`.

**2. Why a suite of its own.** Tooling tests stay out of the first, fast engine suite. Because `tools` is not `first`, it runs concurrently with `wasm`, `netcode` and `browser`, inside the longest of them, so the fast tier's budgeted total (`first` budget plus the longest of the rest, 51 s) does not change.

**3. Budget: 4 s.** Five runs of `pnpm test tools` alone measured 2.4, 2.3, 2.3, 2.3, 2.3 s (median 2.3 s, load average 5.9-6.9 from other sessions). 2.3 s times 1.5 is 3.45 s, rounded up to a whole second: 4 s. The rule (median of 5 runs times 1.5, rounded up) is the one to use again when the row is re-measured.

## Alternatives rejected

- Raising `unit`'s budget: it would make the first, serial suite slower for every run.
- Demoting the device-walk tests to `@slow`: they guard the tool that produces device evidence and must run on every fast pass.

## Consequences

`unit` no longer contains the tool's tests, so a failing tool test names `tools` in the runner's line. `pnpm handoff`'s ground marker keeps its four keys: `tools` is not in the marker (neither is `netcode`); the `unit=` count dropped by the 244 moved tests. Revisit the budget when `tools` passes 3 s alone.

## Sources

Measured in M39x (2026-10-07), `pnpm test tools`, five foreground runs; the M39w ledger row of 2026-10-07 for the `unit` time.
