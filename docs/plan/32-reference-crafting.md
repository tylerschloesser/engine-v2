# M32: Reference game: inventory, unlock and crafting

Status: done · After: 20b, 21b · Tyler-dependent: no

## Goal
A player who has mined the required stone sees a crafting menu appear, crafts a furnace with a timed progress bar while still able to collect, and ends with a furnace item in a six-item inventory. A logged `Disconnected` cancels that player's collect and leaves the craft running.

## Read first
1. `docs/spec/overview.md`
2. `docs/spec/reference-game.md` (Players; first bullet of Crafting and building)
3. `docs/decisions/0003-game-facing-api.md` (Decision: `on_player`, the author's rules in the "Deltas are engine-defined" bullet, "How the UI observes state")
4. `docs/decisions/0006-time-units.md` (Conversion rule, Where it happens, On the client)

Look up at the step: disconnect grace and what the reference game does on `Disconnected` `0013` ("A disconnected player's state"); pipeline and rejection `0004` (Pipeline per action).
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`, `games/reference/CLAUDE.md`. Skill: `add-action-type`.

## Scope
- `content.rs`: item ids (stone, iron, wood, coal, furnace, ingot); a `const` recipe table with one entry (furnace: cost, duration through `TICK_RATE.secs(..)`, unlock condition), numbers from the Requirement.
- `PlayerState` grows `unlocks` (bitset) and `crafting: Option<{ recipe, done_at }>`; inventory becomes a fixed array indexed by item id (plain data, no `Vec`). Bump `SCHEMA_VERSION`.
- `Action::StartCraft { recipe }`. `apply` validates in order: recipe id known, unlocked, not already crafting, cost affordable; then deducts the cost and sets `crafting` in one `put_player`.
- `tick`: the player scan of M20 also completes due crafts (adds the output item) and, inside collect completion, sets the unlock bit when `stone_mined` reaches the threshold.
- `on_player(Disconnected)`: clear `collecting` if set (one put); never touch `crafting`.
- `Ui` grows `unlocks`, `crafting`, and `recipes: Vec<{ recipe, cost, secs, affordable }>` listing unlocked recipes only (capacity reserved in `Default`).
- DOM: `src/ui/craft.ts` (menu hidden until `recipes` is non-empty; one button per recipe; disabled while crafting or unaffordable; the same one-shot CSS animation as the collect button, from `done_at` and `clock()`), `src/ui/inventory.ts` extended to all items. A rejected craft flashes its button with the reason.

## Non-scope
Construction UI and placement (M33). Cancelling a craft (no Requirement). A craft queue (excluded by the Requirement). More recipes.

## Files, packages and crates touched
`games/reference/` only (`sim/src/{content,types,client}.rs`, `sim/src/rules/craft.rs`, `sim/src/rules/collect.rs`, `src/ui/`, `src/bindings/`, tests).

## Seams
**Provides:** `rules::craft`, `content::{ItemId, RECIPES}`, `RefScenario::{disconnect, connect, give}` (`give` grants inventory with a direct player put through the native host's test access, because later native tests should not replay hundreds of collect ticks to get a furnace), browser helper `collectN(page, resource, n)`.
**Consumes:** everything M20 and M20b provide; `PlayerEvent` injection in the native host harness (M12/M16); the state-budget check (M21) and full `TickCx` (M21b); no call in this brief depends on either, the order is PLAN.md's.

## Planning decisions
- **Cost is paid at `StartCraft`, output is granted at completion.** Validate first, write after (`0003`); a craft in flight cannot be starved by a later action.
- **The unlock is sim state, set by the tick rule**, not derived in `ui()`: it must survive a snapshot and be per player (`reference-game.md`, Players).
- **`Disconnected` handling is one line and lives in `on_player`**, which is logged (`0004`), so replay cancels the same collect at the same tick.
- **Collect and craft are independent slots** in `PlayerState`; `Busy` is per slot.
- **`give` is test-only and native-only.** It is not an action and does not exist in the `.wasm`; browser and netcode tests reach states by playing.

## Order of work
1. Items, recipe table, `PlayerState` change, `SCHEMA_VERSION` bump, bindings.
2. `StartCraft` in `apply`; tick completion; unlock; native tests.
3. `on_player(Disconnected)` with a native test.
4. `Ui` fields, `craft.ts`, inventory readout.
5. Browser test; update `games/reference/CLAUDE.md`.

## Tests added
- Rust native: `unlock_on_threshold_stone_not_before`, `unlock_is_per_player`, `craft_rejected_when_locked`, `craft_rejected_when_unaffordable`, `craft_rejected_when_busy`, `craft_deducts_cost_then_completes_on_time`, `collect_and_craft_run_together`, `disconnect_cancels_collect_keeps_craft`, `rejected_craft_wrote_nothing` (state hash unchanged), `craft_duration_at_20_and_30_hz`, `replay_equals_live_hash` extended with a craft.
- Browser: `reference_craft_flow` (collect to the threshold with `collectN`, the menu appears on the step the unlock lands, craft, step the duration, inventory shows one furnace and stone reduced by the cost).

## Exit criteria
- [x] All tests above pass by name.
- [x] By hand: the menu is absent on a fresh world and appears without a reload when the threshold is reached.
- [x] Bindings regenerated and committed (`git diff --exit-code games/reference/src/bindings` clean after a build).
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t reference` · `pnpm test browser -t reference_craft` · `pnpm --filter reference dev`.

## Budgets
None new. The browser test steps about 300 ticks; it must stay under the 3 s p95 rule of `0020` §4 (stepping, never real time).

## Context artifacts
`games/reference/CLAUDE.md`: "adding an item or recipe" in three lines.

## Manual device checks
None.

## Deviations
Steps 1-5 done. Base `3792287`.

**Seams.** `content::{ItemId (Stone=0,Iron=1,Wood=2,Coal=3,Furnace=4,Ingot=5), ITEM_COUNT=6, Recipe{output,cost,secs,unlock_stone_mined}, RECIPES:[Recipe;1], RECIPE_FURNACE=0}`; `Recipe::ticks(rate)`. `Inventory(pub [u32;6])` (`get/add/add_resource`; TS `[number x6]`, replaces the named-field struct, so `ui.inventory.stone` became `inventory[ITEM.stone]`). `RefPlayer{.., unlocks:u32, crafting:Option<Crafting{recipe:u8,done_at:Tick}>}`. `RefAction::StartCraft{recipe:u8}`; `RefReject` gained `UnknownRecipe, Locked, Unaffordable` (already-crafting is `Busy`). `RefUi` gained `unlocks, crafting:Option<UiCrafting>, recipes:Vec<UiRecipe{recipe,cost:Inventory,secs,affordable}>`. `rules::craft::{start, affordable, update_unlocks, complete_due}`; `SCHEMA_VERSION` 2. `RefScenario::{give, disconnect, connect, tick}`; browser `collectN(page, 'stone'|'iron'|'wood', n)` (coal has no scouted tile), `ITEM`, `RESOURCE_TILE`. Collect and craft completion share one scan in `collect::tick` (one put per player per tick).

**Differences.** Step 3 has no code of its own (on_player landed in step 1-2): empty commit. `replay_equals_live_hash` is extended as a new test `replay_equals_live_hash_with_craft` (craft.rs), the old one untouched. Extra test `craft_rejected_when_locked` also covers `UnknownRecipe`. Existing tests `collect.rs`/`ui.rs` only changed their inventory accessor (`.iron` -> `.get(ItemId::Iron)`), assertions unchanged. No golden moved: none regenerated. `rejected_craft_wrote_nothing` compares against a twin that dispatched a no-write `CancelCollect` (the hash covers per-action bookkeeping, so a bare tick twin differs). Craft completes exactly `secs*rate` ticks after the dispatch step (native); the browser test adds +1 for host T+1 queuing. games/reference/CLAUDE.md was at its 60-line cap: the item/recipe note is one Conventions bullet and the header paragraph was reflowed.

**Measured.** `reference_craft_flow` 2.3s including page start (`browser pass 1 tests 2.3s/48s`); full browser 38s/48s. Repeated `-t reference`: 21 passed x3 (7.4s). Machine load average ~12 (foreign sessions): one full-suite run saw `reference_player_circle_lags_and_settles` fail and `unit` 3.1-3.2s/3s (no unit tests added); both pass alone (3x).

**Mutation checks (inject, fail, revert by hand).** craft.rs writes before validating: `rejected_craft_wrote_nothing` FAIL (4 failed of 11); collect.rs unlock line removed: `unlock_on_threshold_stone_not_before` FAIL (+5 others); on_player also clears `crafting`: `disconnect_cancels_collect_keeps_craft` FAIL (1 of 11); reverted: 11 passed. Browser: `root.hidden = false` made `reference_craft_flow` FAIL (first attempt passed because an empty menu is 'hidden' to Playwright; fixed to assert the `hidden` attribute).

**By hand.** playwright-cli on `pnpm --filter reference dev` (index.html, real time, one page, no reload): `.craft-menu` `{"hidden":true,"buttons":0}` before and after 1-4 stone, `{"hidden":false,"buttons":1}` after the 5th.

### Gate (orchestrator)
- `pnpm gate bfde444`: tree clean, 24 files (all `games/reference` plus this brief), no goldens changed or added, +970/-91. The edits to existing tests (`collect.rs`, `ui.rs`, `collect-flow.spec.ts`) only swap accessors (`.iron` -> `.get(ItemId::Iron)`, `.stone` -> `[ITEM.stone]`); the assertions are unchanged.
- `pnpm test && pnpm lint` green at load 8-9: rust 695, unit 292 (3.2 s of 3 s, WARN; the +2 are the `ts-rs` `export_bindings` tests of the new `UiCrafting`/`UiRecipe` types, not new vitest files), wasm 159, netcode 92, browser 219 (**49 s of 48 s, WARN, at load 8-9**; the implementer's earlier full run read 38 s; `reference_craft_flow` is 2.3 s).
- Orchestrator inject-fail-revert: `on_player(Disconnected)` also clearing `crafting` -> `disconnect_cancels_collect_keeps_craft` FAIL (`craft untouched`); restored -> 1 passed.
- The "by hand" criterion is met by the implementer's `playwright-cli` evidence on the dev page (Deviations): `.craft-menu` hidden with 0 buttons through 4 stone, shown with 1 button after the 5th, no reload.

- **Done-commit gate slip (orchestrator):** the `M32 done` chain piped `pnpm test` through `grep`, so a red `browser` run (87 s, `storage_conformance_opfs @engines`, load 15 rising to 86 from other sessions and `mediaanalysisd`) did not stop the commit or the push. A re-run at the same load failed `reference_player_circle_lags_and_settles`, the test the implementer saw fail under load. A re-run at 1-minute load 8 passed, exit 0: `browser pass 219 tests 51s/48s WARN over budget`. Neither failing test is touched by this milestone. `browser` wall time is now over its 48 s budget under moderate load (49-51 s at load 8-9); see Status.
