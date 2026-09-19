# M32: Reference game: inventory, unlock and crafting

Status: not started · After: 20b, 21 · Tyler-dependent: no

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
**Consumes:** everything M20 and M20b provide; `PlayerEvent` injection in the native host harness (M12/M16); full `TickCx` and the state-budget check (M21; no call in this brief depends on M21, the order is PLAN.md's).

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
- [ ] All tests above pass by name.
- [ ] By hand: the menu is absent on a fresh world and appears without a reload when the threshold is reached.
- [ ] Bindings regenerated and committed (`git diff --exit-code games/reference/src/bindings` clean after a build).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t reference` · `pnpm test browser -t reference_craft` · `pnpm --filter reference dev`.

## Budgets
None new. The browser test steps about 300 ticks; it must stay under the 3 s p95 rule of `0020` §4 (stepping, never real time).

## Context artifacts
`games/reference/CLAUDE.md`: "adding an item or recipe" in three lines.

## Manual device checks
None.

## Deviations
(filled in during Phase 3)
