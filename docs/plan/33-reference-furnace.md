# M33: Reference game: furnace entity and predicted placement

Status: not started · After: 32, 26 · Tyler-dependent: R1 (may a furnace cover a resource tile? unanswered; default assumed: no), see `docs/plan/questions-for-tyler.md`

Split during planning: the PLAN.md row for M33 (entity, ghost, three actions, smelting, two UIs) was about 2,000 lines with five files to read. This brief is the entity and its placement; `33b-reference-furnace-operation.md` is deposit, take, smelting and the furnace panel.

## Goal
With a furnace in the inventory the player opens a construction mode, sees a 2x2 ghost that follows the mouse (or sits where they tapped) tinted by the same `can_place` rule the host runs, and places it. The placement is predicted: the furnace appears at once and the ghost-to-real swap takes one frame. Water and other furnaces refuse placement because the tiles say so, not because the rule names them.

## Read first
1. `docs/spec/overview.md`
2. `docs/spec/reference-game.md` (Crafting and building)
3. `docs/decisions/0007-world-model.md` (§5 multi-tile entities, §6 traits)
4. `docs/decisions/0019-camera-input-and-overlay.md` (§4: events, cursor tile and ghost, touch flow, input over DOM)

Look up at the step: addressing rule and provisional ids `docs/decisions/0022-entity-ids-and-provisional-ids.md` §5–§6; `Unknown` reads and correction without snapping `0012`; `Draw.flags` and `ghost` `0018` §2; sprite manifest `0018` §4.
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`, `games/reference/CLAUDE.md`. Skill: `add-action-type`.

## Scope
- `Furnace` entity: the fields of `PRE-PLAN.md` §4 (Entity row) plus `origin: TilePos` for the `Game::anchor` hook M12 added. `Game::prototype` returns the one furnace prototype, registered with a 2x2 footprint and `NOT_BUILDABLE`. Resource ids also get `NOT_BUILDABLE` (R1). Bump `SCHEMA_VERSION`.
- Shared rule `rules::place::can_place(w: &dyn WorldRead<RefGame>, origin) -> Result<bool, Unknown>`: every footprint tile lacks `NOT_BUILDABLE` through `traits_at`. It names no terrain and no entity type.
- `Action::PlaceFurnace { origin }`: validate (has a furnace item, `can_place`), then `spawn` and one `put_player`. Furnaces are addressed by tile everywhere.
- `RefClient`: `placing: bool`; in `extract`, when placing, one `ghost` record with `ANCHOR_CURSOR_TILE`, coloured valid / invalid / unknown from `can_place` over the `View`; furnace sprites for every furnace in view, with reduced alpha when the record is `PREDICTED`; `pick_id` = the entity id. `Ui` grows `placing` and `can_build` (has a furnace item).
- Asset script: furnace sprite (2x2 tiles, two frames: idle, lit) in `sprites.png` / `sprites.json`.
- DOM `src/ui/build.ts`: a Build button shown when `can_build`; toggles construction mode; Escape and a second press leave it. Mouse: a `tap` while placing dispatches `PlaceFurnace { origin: tap.tile }`. Touch: a `tap` moves the cursor tile (engine) and shows a Confirm button anchored to the ghost with `client.overlay.anchor`; Confirm dispatches. Mouse or touch is read from `pointerType` on the tap event (M11's `InputEventTs`). Rejections flash the ghost's Confirm/Build control with the reason.

## Non-scope
Deposit, take, smelting, the furnace panel, picking a furnace (M33b). Removing a furnace (M33b: pick up an empty furnace). Rotation.

## Files, packages and crates touched
`games/reference/` only (`sim/src/{types,content,client}.rs`, `sim/src/rules/place.rs`, `scripts/gen-assets.mjs`, `assets/`, `src/ui/build.ts`, tests).

## Seams
**Provides:** `Furnace`, `FURNACE_PROTO`, `can_place`, `local::{PLACE_MODE, CLOSE_PANEL}` event codes, browser helpers `craftFurnace(page)` and `placeFurnace(page, origin)`, `RefScenario::place(player, origin)`.
**Consumes:** prototypes, footprints, occupancy, `entity_at`, state-budget check (M21); `Predicting`, pending queue, `NotPredictable`, provisional ids (M25); `PREDICTED` flag and one-frame swap (M26); `DrawList::{sprite, ghost}` (M17); sprite atlas loading, `sprites.json` (M17b); cursor tile, `tap`/`hover`, input events in `FrameCx`, `client.input.emit` with `InputEvent` kind 7, `client.overlay.anchor` (M18); everything M20–M32 provide.
**From M18 (in its brief; 0024 §7c):** `client.input.emit(code: number, a = 0, b = 0): boolean`, the TypeScript-to-`ClientSide` channel for client-local UI intent: one record of kind 7 ("game") in M11's 32-byte `inputRing` layout, surfacing in `FrameCx::input()` like any other `InputEvent`. It is how the game's Rust learns that construction mode is on, so it can emit the ghost.

## Planning decisions
- **Construction mode is client-local state in `RefClient`**, switched by `local::PLACE_MODE`. It is not sim state (a logged action per menu click would pollute the log) and not `client.input.setMode('tool')` (that turns one-finger drags into tool drags and would break "drags still pan" in the touch flow of `0019` §4).
- **Tint has three states.** `can_place` over the `View` returns `Unknown` at the subscription edge; the ghost then uses a neutral colour and the action is still sent (`0012`: a local verdict is a hint).
- **`origin` is the min-corner tile and equals the cursor tile.** No centring offset, so mouse and touch agree.
- **Placement has no range requirement.** The spec gives none; a player may place anywhere they can see. No witness is carried.
- **Entity size.** `origin` makes the furnace about 20 B encoded rather than the 12 B estimate in `0003` Consequences; the engine's nominal 128 B per entity (`0007` §8) is unaffected.

## Order of work
1. `Furnace`, prototype registration, trait on resources, `SCHEMA_VERSION`, bindings.
2. `can_place`, `PlaceFurnace`, native tests (incl. chunk-border and prediction cases).
3. Sprite in the asset script; furnace drawing in `extract`.
4. Local-intent channel, `placing`, ghost with tint.
5. `build.ts`: mouse flow, then touch flow with the anchored Confirm.
6. Browser tests; `games/reference/CLAUDE.md`.

## Tests added
- Rust native: `place_ok_consumes_item_and_occupies_four_tiles`, `place_on_water_rejected`, `place_on_resource_rejected`, `place_overlapping_furnace_rejected` (all nine overlapping offsets), `place_without_item_rejected`, `rejected_place_wrote_nothing`, `place_across_chunk_corner_sets_occupancy_in_four_chunks` (origin at local (31, 31)), `can_place_names_no_tile_type` (register a scratch terrain with `NOT_BUILDABLE` in the test; placement refuses it with no rule change), `predicted_place_then_ack_keeps_one_furnace` and `predicted_place_at_subscription_edge_is_not_predictable` (M25's native `Sim<G>` testkit with a delayed client), `extract_hash_ghost_and_furnace`.
- Browser: `reference_place_mouse` (hover moves the ghost with the cursor tile; invalid tint over water; click places; inventory decrements), `reference_place_touch` (tap, Confirm anchored within 1 CSS px of the ghost, a drag still pans, Confirm places), `reference_ghost_swap_one_frame` (step frames across the ack; every published DrawList holds exactly one furnace record at that tile: never zero, never two).

## Exit criteria
- [ ] All tests above pass by name.
- [ ] By hand on desktop: the ghost tracks the pointer with no visible lag and changes tint crossing a shoreline.
- [ ] Assets and bindings regenerated and committed (`git diff --exit-code` clean after build and asset script).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t reference` · `pnpm test browser -t reference_place` · `pnpm test browser -t reference_ghost` · `pnpm --filter reference dev`.

## Budgets
Allocation per isolate (`PRE-PLAN.md` §7): re-run the M20b allocation criterion with construction mode on and the pointer moving (the ghost path runs every frame).

## Context artifacts
`games/reference/CLAUDE.md`: "shared rule helpers take `&dyn WorldRead` and return `Result<_, Unknown>`; never name a tile or entity type in a placement rule".

## Manual device checks
None of its own. `docs/plan/device-checks.md` M39 includes the touch placement flow.

## Deviations
Steps 1-3 done (commits `e9b9369`, `965dc42`, `b620fe7`; base `55e7f61`). Steps 4-6 pending.

**Seams as landed (for step 4).**
- `Furnace { origin: TileXY, iron_in: u16, coal: u16, wood: u16, burn_left: u16, ingots_out: u16, smelt_done_at: Option<Tick> }` (`lib.rs`; `Default`, `Furnace::new(origin)`; serde only, no `TS`). `pub type RefEntity = Furnace` keeps the name `ui.rs`/`extract_golden.rs` import (their code is untouched). `Game::Entity = Furnace`, `prototype` = `content::FURNACE_PROTO`, `anchor` = `origin.tile()`. `SCHEMA_VERSION` 3.
- `content::FURNACE_PROTO: PrototypeId = PrototypeId(0)` (registered first, `register` asserts it), `FURNACE_FOOTPRINT: Footprint { w: 2, h: 2 }`, `SPRITE_FURNACE: u16 = 0`. Prototype traits `NOT_BUILDABLE`; resource ids are now `COLLECTABLE | NOT_BUILDABLE` (R1 default).
- `rules::place::can_place(w: &dyn WorldRead<RefGame>, origin: TilePos) -> Result<bool, Unknown>` (reads `traits_at` over the footprint, `?` on each; early `Ok(false)` at the first blocked tile) and `rules::place::place_furnace(w, who, origin: TilePos) -> Result<(), RefReject>`.
- `RefAction::PlaceFurnace { origin: TileXY }`; `RefReject` gained `NoFurnace` (no item) and `NotBuildable`, inserted before `ImplausiblePosition`. `admit` accepts it. Bindings `RefAction.ts`/`RefReject.ts` regenerated and committed. No new `TS` type, so no new ts-rs export test (0).
- `extract` (`client.rs`): furnace loop first, before the player-size cull: for each `(id, furnace, origin)` in `view.entities()` (overlay-merged) one `out.sprite(LAYER_FURNACE = 0, WorldPos::from_tile(origin), SpriteId(0))` with `param` = 1.0 if `burn_left > 0` else 0.0 (frame lit/idle), `pick_id = id.0`, `color = 0xffffffff`; when `view.is_predicted(id)`: `flags |= PREDICTED` and `color = 0xffffff99` (alpha 0.6; the sprite shader multiplies `in.color.a`). `pick_id` of a predicted furnace is the provisional id (display only).
- Sprite atlas: `sprites.json` has one entry, key `"0"`: `rect [2,2,32,32]`, `pivot [0,0]` (top-left = min-corner tile), `size [2,2]`, `frames 2` (frame 0 idle, frame 1 lit, left to right, 32 px each); `sprites.png` is 68x36, fully opaque, 2 px extruded padding. `gen-assets.mjs` writes the manifest's number arrays on one line (the layout Biome writes) so `pnpm format` cannot drift it.
- Test helpers: `RefScenario::{place(who, origin), entity_at(pos), furnace_count(), clear_area(min, w, h)}`.

**Finding for step 4-6.** `src/game.ts` passes `assets: { tiles: '/tiles.json' }` only and there is no `sprites` load anywhere in `games/reference/src`: the browser cannot draw a sprite yet. Step 4 or 5 must add `sprites: '/sprites.json'` and whatever loads the atlas into the drawables renderer (`loadSpriteAtlas`, as `gc-drawables.ts` does); step 3 only makes the data and the records exist.

**Goldens.** None moved, none created: `extract_hash_player_circle` is unchanged (no entities in its view), the worldgen goldens do not depend on entities or traits. The full run at the end of step 3 showed no golden drift.

**Tests (all native, `sim/tests/`).** `place.rs`: `place_ok_consumes_item_and_occupies_four_tiles`, `place_on_water_rejected` (both waters, every footprint tile), `place_on_resource_rejected` (four resources), `place_overlapping_furnace_rejected` (all nine overlapping offsets refuse, the sixteen touching-or-apart offsets place), `place_without_item_rejected`, `rejected_place_wrote_nothing` (both reasons, hash twin), `place_across_chunk_corner_sets_occupancy_in_four_chunks` (origin (31, 31)), `can_place_names_no_tile_type` (a stub `WorldRead` over a `Registry` in which the test registers scratch base id 200 as `NOT_BUILDABLE`; `Game::register` is not touched). `place_predict.rs` (real `Loopback<RefGame>`; the player earns the item by five collects and a craft, since the loopback host has no direct write): `predicted_place_then_ack_keeps_one_furnace` (exactly one furnace in `entities_in` at every step across the ack; id goes provisional to real once), `predicted_place_at_subscription_edge_is_not_predictable` (with an inside-the-subscription control that IS `Applied`), plus three step-3 extract tests: `extract_draws_predicted_then_real_furnace_sprite` (one sprite per step, `PREDICTED` + dim + provisional `pick_id`, then plain with the real id), `extract_with_furnace_allocates_nothing`. `extract_hash_ghost_and_furnace` is left to step 4 (needs the ghost). The lit frame (`burn_left > 0`) has no test: nothing can fuel a furnace before M33b.

**Inject, fail, revert (each edited and restored by hand; `cargo nextest run -E 'package(reference-sim)'`).**
- prediction.md / validate-first: `spawn` before the `can_place` check in `place_furnace`: `place_ok_consumes_item_and_occupies_four_tiles` FAIL, 8 failed of 61 (the host's no-write assertion panics). Restored: 61 passed.
- prediction.md / provisional-id path: `Game::predict` returns false for `PlaceFurnace`: `predicted_place_then_ack_keeps_one_furnace` and `predicted_place_at_subscription_edge_is_not_predictable` both FAIL, 2 of 2. Restored: 2 passed.
- prediction.md / PREDICTED hint: `d.flags |= PREDICTED` removed: `extract_draws_predicted_then_real_furnace_sprite` FAIL; dim colour removed: same test FAIL.
- determinism.md (rule shape, placement): `can_place` tests `base == WATER || DEEP_WATER` instead of traits: `can_place_names_no_tile_type` FAIL (3 failed of 61, with `place_on_resource_rejected`); furnace prototype registered with `TraitSet::EMPTY`: `place_overlapping_furnace_rejected` FAIL; resources without `NOT_BUILDABLE`: `place_on_resource_rejected` FAIL.
- hot-paths.md: `std::mem::forget(Vec::with_capacity(64))` in the extract furnace loop: `extract_with_furnace_allocates_nothing` FAIL ("predicted: live bytes moved"). Restored: passes. **Limit:** an alloc-then-free inside the window is NOT caught (`thread_high_water_bytes` is already far above it from the test's own setup; a `black_box(Vec)` dropped in the loop passed). The transient case is the browser zero-GC page's job (`gc.pages.reference`, Budgets).
- One mutation did not fail and is recorded rather than hidden: `unwrap_or_default()` on the `traits_at` read in `can_place` (swallowing `Unknown`) and reading only the first footprint column both still give `NotPredictable` at the edge, because the engine declines a spawn whose footprint touches an unheld chunk regardless of what the rule read. The `?` rule is therefore not observable through the edge test; it is enforced by the engine.

**Measured.** Full `pnpm test`: rust 707 (1.4 s), unit 292 at 3.1 s of 3 s (WARN, pre-existing, no unit tests added), wasm 159, netcode 92, browser 219 at 37 s of 48 s; `pnpm lint` pass. The first full run failed `reference_player_circle_lags_and_settles` (`x` 29.5 instead of 30) with `uptime` load 5 rising to 21 from other sessions; that test alone passed (2.3 s) and the next full run passed. It is untouched by this work and is the test M32 saw fail under load.
