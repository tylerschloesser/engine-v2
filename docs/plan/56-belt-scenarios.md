# M56: Belt scenarios

Status: not started · After: 50, 54, 55 · Tyler-dependent: no

Later-phase brief: goal, exit criteria and open questions. Filled in at the start of its phase.

## Goal
Complex belt layouts are built and tested end to end: natively on `fx-belts` (mixed speeds, which the reference game lacks) and on the reference game in the browser and the netcode harness: a 4x4 balancer, closed loops, saturated splitter chains, side-loaded undergrounds, a saturated world with jams forming and clearing, edits during flow. Conservation, spacing, throughput and lap-time properties hold on every scenario, and forecasts stay under budget on each.

## Read first
1. `docs/architecture/README.md`
2. `games/reference/README.md` ("Belts")
3. `/Users/tyler/repos/belts/PLAN.md` ("Rigs" table: the scenario list G01-G33 as inspiration; its goldens are Factorio-exact and are not replayed)
4. `docs/plan/44-transport-merge-and-fork.md` Deviations (the property helpers)
Rules that apply: `.claude/rules/determinism.md`.

## Scope (sketch)
- `fx-belts` scenarios (goldens): `balancer-4x4` (six forks, undergrounds under forks, four curves), `ring` (lap time), `mixed-speeds` (24 -> 72 -> 96 -> 24: items keep spacing, throughput follows the slowest), `sideload-chain`, `jam-waves`.
- Reference game: a scripted builder (`tests/helpers/belts.ts`) placing layouts from a small text map (`>`, `<`, `^`, `v`, `S`, `D`, `U`, `u`, `=`), used by browser and netcode tests: `reference_balancer_4x4_balances` (output counts within 5 % after 30 s), `reference_loop_conserves`, `reference_edit_during_flow`.
- Properties over every scenario (`prop_*` from M44) and the forecast budget row asserted on the reference scenarios in the netcode harness.
- Each scenario's Factorio-rule deviation, if visible (no 51 buffer, geometric entries), noted in the test's doc comment with the README line it follows.

## Seams
**Provides:** the scenario goldens, `tests/helpers/belts.ts` (the text-map builder; M57 reuses it for the phone page).
**Consumes:** M44 properties, M47 budget row, M54, M55.

## Exit criteria
- [ ] Every scenario passes natively, under Node and Bun (fixture) and in the browser and netcode harness (reference), with the properties and the forecast budget asserted.
- [ ] A text-map layout of 200 tiles builds in under one virtual second of actions (the rate limit is respected by the helper).
- [ ] `pnpm test` and `pnpm lint` are green; the fast tier stays inside its budgets (large scenarios are `@slow`).

## Open questions (answered by earlier phases)
- M47/M48: which scenarios threaten the 16 KB/s row (the jam-waves cell), to be asserted, not just recorded.

## Deviations
(filled in during execution)
