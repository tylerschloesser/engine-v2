# M39ai: Tyler's answers (Q15, Q16, R1, R2, R4)

Status: done (2026-10-10) · After: 39ah · Tyler-dependent: no

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
- [x] `CAP_CHUNKS` and the `maxChunks` default are 144; the cap test fails at 128 (pasted).
- [x] The `browser` budget is 60,000 ms.
- [x] R1: placement over a resource confirmed; covered resource refused and hidden; collectable again after pick-up; deterministic across save/load (tests named, reds pasted).
- [x] R2: `FurnaceTake` predicted; the acceptance/coverage rows no longer cite it as the opt-out's coverage.
- [x] R4: Export world in the normal game UI (test named).
- [x] Two ADRs written (amending 0010 and 0036) and indexed in `PLAN.md`.
- [x] Changed goldens listed with why (the orchestrator approves them through `pnpm gate`).
- [x] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test rust -t subs`, `pnpm test rust -t <reference test>`, `pnpm test browser -t <name>`, `pnpm golden <fixture>` only if a golden must move (list it). Foreground, bounded; check `uptime` first.

## Manual device checks
None. M39-full-game-touch and M39-sign-off (Tyler's) cover the feel.

## Deviations

- **Commit layout.** The Q16 edits (ADR 0060, `scripts/suites.mjs`, `scripts/lib/repo-config.test.mjs`) landed in the step 1 commit with Q15; R1 and R2 share the step 3 commit (they share `lib.rs` and `furnace_predict.rs`); step 4 is R4.
- **Q15.** `CAP_CHUNKS` and the `view.maxChunks` default are 144 (ADR 0059, amends 0010 "Cap" and 0007's 512 KiB line by reference). No `budgets.json` row is derived from the cap by a formula (the `128` hits are the 128 KB burst, the 128-tile half-extent and prose in `source` strings; the `zoomout*Cap144*` rows already measured 144), so none changed. Existing tests that implicitly relied on the old default were pinned to 128 explicitly, not re-measured: `zoomout.test.ts` (`shared(cap)` now always passes `maxChunks`, so the "cap 128" scenarios keep their recorded numbers as the risk-3 baseline) and `rates/teleport-drops-queued-enters` (`denseWorld(3108, 2, undefined, 128)`; at 144 more of the old queue stays inside the cap and `teleportWastedEnterBytes` read 80,547 against a 35,736 ceiling). Six test constructors passing `CacheCapacity::Chunks(128)` became 144 (the replica asserts cache >= `CAP_CHUNKS`). Cap test: `subs_cap_evicts_farthest_first` now asserts `len() == 144` and `CAP_CHUNKS == 144`; red at 128 (`left: 128`, "trimmed back to the 144-chunk cap") and at 160 (`subs.rs:402`, "test needs eviction to bite"); `host::tests` asserts `view_max_chunks == 144` too.
- **Q16.** `repo-config: the fast tier is budgeted ...` pinned browser at 48,000 and the sum under 60,000: changed to 60,000, sum 63,000 and `< 70_000` (ADR 0060 and Tyler's "about 70 s"). This is an existing test changed by necessity of the budget change.
- **R1 design (derived, not stored).** New trait `content::COVERS_RESOURCE` (`1 << 2`) on the furnace prototype (`NOT_BUILDABLE | COVERS_RESOURCE`); resources are `COLLECTABLE` only. A covered tile is whatever `traits_at` reports through its occupant term, so it is right after load, after a pick-up and in the predicted path with no bookkeeping and no encoded-state change. `collect::collectable(traits)` is used by `StartCollect` (`RefReject::NoResource`; no new reject, so no binding change) and by `complete_one` (a furnace landing on a tile mid-collect ends the collect with no item and no depletion). `RefClient::ui` skips a tile whose raw-replica `traits_at` has `COVERS_RESOURCE`; that is the confirmed state, so after a predicted placement the button stays until the ack (a hint, then it goes). `SCHEMA_VERSION` 5 -> 6 (test-hooks 6 -> 7); no golden moved.
- **R1 tests.** `tests/furnace_covers.rs` (`place_over_resource_confirmed`, `covered_resource_refuses_start_collect`, `collectable_again_after_pick_up_with_units_intact`, `a_collect_in_flight_ends_empty_when_a_furnace_lands_on_it`, `covered_state_survives_save_and_load`, via the new `RefScenario::save_and_load`), `furnace_predict::covered_resource_predicted_and_confirmed`, `ui::ui_in_range_hides_a_covered_resource`. Reds: resources `NOT_BUILDABLE` again fails 6 (`place_over_resource_confirmed`, `covered_resource_refuses_start_collect`, `collectable_again...`, `a_collect_in_flight...`, `covered_state_survives_save_and_load`, `covered_resource_predicted_and_confirmed`, plus `place::browser_fixture_tiles_hold`); `collectable` ignoring the cover fails 4; no tick check fails `a_collect_in_flight...`; no UI skip fails `ui_in_range_hides_a_covered_resource`. Existing tests changed because R1 overrides their default: `place::place_on_resource_rejected` removed (replaced by `place_over_resource_confirmed`), `place::browser_fixture_tiles_hold` overIron now `true`, `place-mouse.spec.ts` overIron ghost is `valid`.
- **R2.** `RefGame::predict` is `true` for everything (the `test-hooks` poison craft still opts out). `furnace_predict::take_is_not_predicted` became `take_is_predicted` (`Applied`, overlay entry, ingot shows at once, ack leaves the same state); red with the opt-out restored: `furnace_predict.rs:300 assertion left == right failed: FurnaceTake { .. }`. `games/reference/tests/netcode/races.test.ts` `reference_race_same_ingots` asserted the opt-out (no ghost, `NotPredictable` then verdict): now no ghost check (`Ui` is the confirmed replica) and results are `['Confirmed']` / `[{ Rejected: ... }]`. `docs/plan/reference-coverage.md` row for the opt-out now points at the engine tests `predict_opt_out_declines`/`predict_not_predictable_event`; R1, R2, R4 removed from its question table. No `docs/plan/acceptance/` or `coverage*.md` row cited `FurnaceTake`.
- **R4.** `src/ui/export.ts` (`createExportUi`), wired in `game.ts`'s `startGame` for a local world, shown after `client.ready` (a refused start never gets it, so `persistence.spec.ts`'s "no `[data-export-world]` on a refused second tab" holds; its attribute is `data-game-export`). It calls `exportWorldFile` (new export of `ui/status.ts`, the code the `save-incompatible` screen now also uses). Test `reference_export_control_in_game_ui` (`persistence.spec.ts`): visible, click starts a download named `reference.world`. Fast tier: 339 ms measured. Red with the `show()` call removed: `expect(locator).toBeVisible() failed ... unexpected value "hidden"`.
- **Goldens moved: none.** `pnpm test rust`, `wasm`, `unit`, `netcode` green; `pnpm test browser -t reference_` 30 pass. Flake seen once on a loaded machine (load average 15 to 23): `reference: status walks every event` timed out in `resumeWorkers`; it passes alone and with the change reverted, three runs of `-t status` pass after.
- **Gate (orchestrator):** accepted. `pnpm gate 1fc00cb2`: 42 files, no goldens, no markers. `pnpm test` green (rust 812, unit 409, tools 285, wasm 172, netcode 147, browser 257 in 52 s of the new 60 s); `pnpm lint` green. Decision: the collect button for a resource covered by a *predicted* furnace stays until the placement is acked (one round trip). Accepted: the in-range list reads the confirmed replica, a predicted status is a hint (`.claude/rules/prediction.md`), and a `StartCollect` sent in that window is refused by the host. The changed existing tests each follow from a Tyler answer (repo-config 60 s / 70 s bounds, 128 pinned where a test measured the old default, placement over iron now valid, `FurnaceTake` predicted).
