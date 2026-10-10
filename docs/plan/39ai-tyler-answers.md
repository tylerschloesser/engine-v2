# M39ai: Tyler's answers (Q15, Q16, R1, R2, R4)

Status: open · After: 39ah · Tyler-dependent: no

## Goal
On 2026-10-10 Tyler answered the open questions in `docs/plan/questions-for-tyler.md`. Five answers change the code. They are already recorded in the Requirements of `docs/spec/reference-game.md` and `docs/spec/testing.md`. When this is done, the code and the ADRs match them:

1. **Q15:** the subscription cap is **144** chunks per client, not 128.
2. **Q16:** the `browser` fast-tier budget is **60 s**, not 48 s. The fast tier may take about 70 s.
3. **R1:** a furnace may be placed over a resource tile. A covered resource cannot be collected (no collect button, and the sim refuses `StartCollect`) until the furnace is picked up; then it is collectable again with its remaining units.
4. **R2:** `FurnaceTake` is predicted like every other action. The engine's prediction opt-out keeps its fixture-only coverage.
5. **R4:** "Export world" is offered in the game UI at all times, as well as on the status screen for a save that cannot be loaded.

## Read first
1. `docs/spec/overview.md`
2. `docs/spec/reference-game.md` (Crafting and building, Furnace, UI) and `docs/spec/testing.md` (first bullets)
3. `docs/decisions/0010-rates-and-subscriptions.md` ("Cap") and `docs/decisions/0036-browser-fast-tier-budget-48s.md` §1 (the 48 s budget)
4. `games/reference/CLAUDE.md`
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/prediction.md`, `.claude/rules/hot-paths.md`.

## Scope
1. **Q15.** `CAP_CHUNKS` in `packages/engine/crates/engine/src/host/subs.rs`, the `WorldConfig.view.maxChunks` default (`host/mod.rs`; also its test at about line 3990), and every doc comment, TS default and test that says 128 for this cap. Grep `128` in `packages/engine/budgets.json`, too: any bandwidth or memory row derived from the cap gets re-derived by its own formula, never just bumped. Write an ADR that amends 0010 "Cap" (and 0007's "hard cap 128 subscribed = 512 KiB" line by reference) with the `write-adr` skill. The why is Q15's evidence: churn at max zoom-out over dense chunks was ~50 KB/s against a 48 KB/s chunk budget, and about 16x less at 144.
2. **Q16.** `budgetMs` of `browser` in `scripts/suites.mjs` becomes `60_000`; rewrite its comment. Write an ADR that amends 0036 §1.
3. **R1.** In `games/reference/sim/src/content.rs`, resources are no longer `NOT_BUILDABLE`. A resource tile under a furnace footprint is not collectable: in the sim's `StartCollect` validation (and any tick-time check of an in-flight collect), in the predicted path, and in the client's in-range list that drives the collect buttons (`sim/src/client.rs`). Decide whether the covered state is derived from the furnace's footprint or stored, and say why in Deviations. It must be deterministic and correct after load and after a pick-up. Bump the content/rules version if the codebase versions rule changes (see the numbered list near `sim/src/lib.rs:431`), and update the `NotBuildable` doc comment.
4. **R2.** Remove `FurnaceTake`'s prediction opt-out in the reference game. Update `games/reference/sim/tests/furnace_predict.rs` and anything else that asserts it is not predicted. Grep `docs/plan/acceptance/` and `docs/plan/coverage*.md` for rows that cite `FurnaceTake` as the game's use of the opt-out, and point them at the engine fixture tests that cover it.
5. **R4.** An "Export world" control in the reference game's normal UI, calling the same export path `games/reference/src/ui/status.ts` uses. Keep it out of the per-frame path.

## Non-scope
Other questions (Q9, Q12 and Q13 need no code). Any other budget. Raising any zero-GC budget.

## Files touched
`packages/engine/crates/engine/src/host/{subs,mod}.rs` and their tests; TS defaults or tests that name the cap; `packages/engine/budgets.json` (only rows derived from the cap); `scripts/suites.mjs`; `games/reference/sim/src/**`, `games/reference/sim/tests/**`, `games/reference/src/**`, `games/reference/tests/**`; two new ADRs under `docs/decisions/` plus their lines under "Plan-level decisions" in `PLAN.md`; `docs/plan/acceptance/*.md` and `docs/plan/coverage*.md` rows for R2.

## Tests added
- Rust (engine): a client whose view wants more than 144 chunks holds exactly 144 (an existing cap test moved to the new number is fine if it would fail at 128 or at 160: show both by injection).
- Rust (reference sim): placing a furnace over a resource is `Confirmed`; `StartCollect` on a covered resource is refused (name the error); after `PickUpFurnace` the same tile collects again with its units intact; the same three checks through the predicted path; one save-load round trip with a covered resource.
- Rust (reference sim): `FurnaceTake` is predicted (the state is `Predicted`, then `Confirmed`).
- Browser or unit (reference game): the Export control is present in the normal game UI and starts a download of `<worldId>.world`.
Do an inject-fail-revert for each and paste the red line.

## Exit criteria
- [ ] `CAP_CHUNKS` and the `maxChunks` default are 144; the cap test fails at 128 (pasted).
- [ ] The `browser` budget is 60,000 ms.
- [ ] R1: placement over a resource confirmed; covered resource refused and hidden; collectable again after pick-up; deterministic across save/load (tests named, reds pasted).
- [ ] R2: `FurnaceTake` predicted; the acceptance/coverage rows no longer cite it as the opt-out's coverage.
- [ ] R4: Export world in the normal game UI (test named).
- [ ] Two ADRs written (amending 0010 and 0036) and indexed in `PLAN.md`.
- [ ] Changed goldens listed with why (the orchestrator approves them through `pnpm gate`).
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test rust -t subs`, `pnpm test rust -t <reference test>`, `pnpm test browser -t <name>`, `pnpm golden <fixture>` only if a golden must move (list it). Foreground, bounded; check `uptime` first.

## Manual device checks
None. M39-full-game-touch and M39-sign-off (Tyler's) cover the feel.

## Deviations
