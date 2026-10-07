# M39x: the device-walk tool's tests get their own suite

Status: not started · After: 39w · Tyler-dependent: no

## Goal
`unit` runs first and has a 3 s budget (ADR 0020 §3). At M39w's done gate it ran 646 tests in 2.9 s, against 1.3 s at M37 (ledger row of 2026-10-07). Most of the growth is the device-walk tool's tests (`scripts/lib/device-walk*.test.mjs`, about 244 tests, M39e-M39w). These test Mac-side tooling, not the engine or the game. When this is done they run in a separate suite with its own budget, `unit` is back near its M37 time, and no test is lost.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0020-testing-strategy.md` §3 (the suite table) and §4
3. `scripts/CLAUDE.md` if present, else the header comment of `scripts/suites.mjs`

## Scope
1. A new vitest project in `vitest.config.ts` that includes `scripts/lib/device-walk*.test.mjs` and every other test file that exercises only `scripts/lib/device-walk/` (grep the imports: a `scripts/lib` test that also covers `scripts/test.mjs`, `handoff` or other gate tooling stays in `unit`). The `unit` project excludes them. List the moved files in Deviations.
2. A `suites.mjs` row, `tools` (kind `vitest`, fast and slow tiers, not `first`), with a budget set from measurement: its median of 5 runs times 1.5, rounded up to a whole second. Paste the 5 times.
3. **ADR.** Amend ADR 0020 §3 with a new ADR (`write-adr` skill): the `tools` row, why it exists (tooling tests kept out of the first, fast engine suite), and its budget's derivation. Name the ADR in Deviations; the orchestrator adds its line under "Plan-level decisions" in `PLAN.md`.
4. **Counts.** Before and after: the `unit` count and time, and the `tools` count. The two counts must sum to the old `unit` count (646 at `8e3a5be`). After the move `pnpm test tools -t device-walk` replaces `pnpm test unit -t device-walk`: update every brief-independent doc, skill or `CLAUDE.md` that names `unit` for these tests (grep `-t device-walk`); leave finished briefs as they are.
5. **The `handoff` ground marker.** `PROMPT.md` carries `<!-- handoff:ground rust=... unit=... -->`, which `pnpm handoff` checks against the real counts. Do not edit `PROMPT.md`. Report the new counts so the orchestrator updates the marker, and say whether `handoff`'s check needs a `tools=` key (if it does, add that support in its script and test).

## Non-scope
Speeding up any test; any other suite's budget; Q16.

## Files touched
`vitest.config.ts`, `scripts/suites.mjs`, possibly `scripts/lib/handoff*.mjs` and its test, `.claude/skills/*` or `CLAUDE.md` files that name the suite for these tests, a new ADR.

## Exit criteria
- [ ] `unit` + `tools` counts equal the old `unit` count (pasted).
- [ ] `tools` budget derived from 5 measured runs (pasted); the new ADR exists.
- [ ] `pnpm test unit` is back under 2 s (pasted line).
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit` · `pnpm test tools` · `pnpm test tools -t device-walk` (foreground).

## Context artifacts
The ADR; any skill or `CLAUDE.md` line naming the suite for device-walk tests.

## Manual device checks
None.

## Deviations
(filled in during Phase 3)
