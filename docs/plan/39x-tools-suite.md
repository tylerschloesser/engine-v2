# M39x: the device-walk tool's tests get their own suite

Status: done (2026-10-07) · After: 39w · Tyler-dependent: no

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
- [x] `unit` + `tools` counts equal the old `unit` count (pasted).
- [x] `tools` budget derived from 5 measured runs (pasted); the new ADR exists.
- [x] `pnpm test unit` is back under 2 s (pasted line).
- [x] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit` · `pnpm test tools` · `pnpm test tools -t device-walk` (foreground).

## Context artifacts
The ADR; any skill or `CLAUDE.md` line naming the suite for device-walk tests.

## Manual device checks
None.

## Deviations
- **Moved files:** the 35 `scripts/lib/device-walk*.test.mjs` files only (`device-walk-app` ... `device-walk-warm`; 244 tests). No other test imports `scripts/lib/device-walk/`; `scripts/lib/device-walk/` holds no test files. The tests import `../acceptance-check.mjs`, two `packages/engine/src/camera` files, `walk-preview-plugin.ts` and `games/reference/tests/helpers/script.ts`, none a gate tool.
- **Config:** `unit` gets `exclude: ['**/node_modules/**', 'scripts/lib/device-walk*.test.mjs']` (setting `exclude` replaces Vitest's default, so node_modules is restated); new project `tools` includes the same glob. `suites.mjs` row: `{ name: 'tools', kind: 'vitest', tiers: ['fast','slow'], budgetMs: 4_000 }`, placed after `unit`.
- **Counts:** before `unit` 646 tests 2.9 s (3 s budget). After `unit` 402 tests 1.4-1.5 s; `tools` 244 tests 2.3-2.4 s. 402 + 244 = 646. `pnpm test tools -t device-walk`: 244 tests 2.4 s/4 s. `pnpm test:slow tools`: `tools pass 0 tests 0.8s` (no `@slow` test in these files; the row runs, nothing to run).
- **5 timing runs of `pnpm test tools`** (foreground, load average 1 min beside each): 2.4 s (5.92), 2.3 (6.89), 2.3 (6.91), 2.3 (6.31), 2.3 (5.88). Median 2.3 s x 1.5 = 3.45 s, rounded up: 4 s.
- **ADR:** `docs/decisions/0054-tools-suite.md` (amends 0020 §3; 0020's Status line got `Amended by 0054`). Not touched, for the orchestrator: the `PLAN.md` "Plan-level decisions" line, the `PRE-PLAN.md` §1 ADR index row, and the ADR range (0001-0053) in the root `CLAUDE.md` context-map row.
- **Existing test changed (additively):** `scripts/lib/repo-config.test.mjs` pins the fast-tier budget table with `toEqual`; adding the row required adding `tools: 4_000` to it. Nothing loosened; the 51 s total is unchanged (`tools` is not `first`, and 4 s is under the 10 s concurrent maximum).
- **Handoff:** `pnpm handoff`'s check reads `rust unit wasm browser` and not `netcode`; it needs no `tools=` key, no script change. The orchestrator updates `unit=646` to `unit=402` in the `PROMPT.md` marker.
- **Docs updated:** `packages/engine/CLAUDE.md` (the `pnpm test unit` line), `.claude/skills/run-tests/SKILL.md` (the `-t` example paragraph). No other doc or skill named `unit` for device-walk tests (grep of `-t device-walk`).
- **Gate (orchestrator):** the `repo-config.test.mjs` budget-table addition (`tools: 4_000`) is accepted: a table-pinning test has to gain the row, and nothing was loosened. Bookkeeping by the orchestrator: the `PLAN.md` plan-level line, the root `CLAUDE.md` ADR range (0001-0054), and the `handoff:ground` marker (`unit=402`). `PRE-PLAN.md` §1 indexes Phase 1 ADRs only, so it is not touched.
