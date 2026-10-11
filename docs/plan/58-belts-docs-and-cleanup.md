# M58: Docs and clean-up

Status: not started · After: 57 · Tyler-dependent: no

Later-phase brief: goal, exit criteria and open questions. Filled in at the start of its phase.

## Goal
The repo describes belts as they are: a new `docs/architecture/transport.md` (lines, runs, advance, surgery, geometry, forecasts, drawing, budgets, tests, gotchas), every architecture doc a belts commit made wrong fixed, nested `CLAUDE.md` files current, a `.claude/rules/transport.md` only if an invariant emerged that tests cannot hold alone, 0077 and 0078 Accepted with their amendments, a "belts decisions" ADR holding every decision the plan's Deviations made that no ADR holds (the 0063-0068 shape), and the planning files (`PLAN.md`, `docs/plan/`, `PROMPT.md`) deleted after their content is folded, with the tag `belts-complete`.

## Read first
1. `docs/architecture/README.md`
2. `docs/context-architecture.md` and `docs/decisions/0021-context-architecture.md` (§1, §3)
3. `docs/decisions/0070-phase-3-tooling-retired.md` (how Phase 4 folded and deleted its plan)
4. `PLAN.md` and every brief's Deviations (the material to fold)
Skills: `write-adr`.

## Scope (sketch)
- `docs/architecture/transport.md` and its row in `docs/architecture/README.md`'s index; `simulation.md` (the advance step), `sync-and-netcode.md` (sections 12 and 13, the chunk-hash rule, the forecast counters and budget), `renderer.md` (`draw_items`, the belts frame bench), `world-and-worldgen.md` (the transport store and its two counts), `testing-and-tooling.md` (`fx-belts`, the baselines), `games/reference/README.md` ("Belts": the **(assumed)** lines answered or still marked; "Not implemented" line removed), `games/reference/CLAUDE.md` (belt modules), `crates/engine/CLAUDE.md`, `fixtures/CLAUDE.md`, `fixtures/belts/CLAUDE.md`, `wire/CLAUDE.md`.
- The decisions ADR; the 0077/0078 status check; root `CLAUDE.md` ADR range and the context map row for `transport` if the doc list changes.
- Delete `PLAN.md`, `docs/plan/`, `PROMPT.md`; a `unit` test (`context-artifacts`) still passes; tag `belts-complete`.

## Exit criteria
- [ ] Every doc above is updated in the same commit series; `grep -rn "PLAN.md\|docs/plan/" docs/ CLAUDE.md games/ packages/ --include=*.md` finds only historical references resolvable at a tag.
- [ ] Each ADR link in the new and changed docs resolves (`docs/` is not linted: checked by eye and by a one-off script in the scratchpad).
- [ ] `pnpm test`, `pnpm lint` and the full `pnpm test:slow` are green; tag `belts-complete` on the pushed commit; CI green.

## Open questions (answered by earlier phases)
- Every open question of M46-M57 is closed by then, or recorded in the decisions ADR as deferred with its trigger.

## Deviations
(filled in during execution)
