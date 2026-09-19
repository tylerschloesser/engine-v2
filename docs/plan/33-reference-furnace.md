# M33: Reference game: furnace entity and predicted placement

Status: not started · After: 32, 26 · Tyler-dependent: R1 (may a furnace cover a resource tile? default: no), see `docs/plan/reference-coverage.md` "Questions"

Split during planning: the PLAN.md row for M33 (entity, ghost, three actions, smelting, two UIs) was about 2,000 lines with five files to read. This brief is the entity and its placement; `33b-reference-furnace-operation.md` is deposit, take, smelting and the furnace panel.

## Goal
With a furnace in the inventory the player opens a construction mode, sees a 2x2 ghost that follows the mouse (or sits where they tapped) tinted by the same `can_place` rule the host runs, and places it. The placement is predicted: the furnace appears at once and the ghost-to-real swap takes one frame. Water and other furnaces refuse placement because the tiles say so, not because the rule names them.

## Read first
1. `docs/spec/overview.md`
2. `docs/spec/reference-game.md` (Crafting and building)
3. `docs/decisions/0007-world-model.md` (§5 multi-tile entities, §6 traits)
4. `docs/decisions/0019-camera-input-and-overlay.md` (§4: events, cursor tile and ghost, touch flow, input over DOM)

Look up at the step: addressing rule and provisional ids `docs/decisions/0022-entity-ids-and-provisional-ids.md` §5–§6 (numbered on acceptance); `Unknown` reads and correction without snapping `0012`; `Draw.flags` and `ghost` `0018` §2; sprite manifest `0018` §4.
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`, `games/reference/CLAUDE.md`. Skill: `add-action-type`.

## Scope
- `Furnace` entity: the fields of `PRE-PLAN.md` §4 (Entity row) plus `origin: TilePos` for the `Game::anchor` hook M12 added. `Game::prototype` returns the one furnace prototype, registered with a 2x2 footprint and `NOT_BUILDABLE`. Resource ids also get `NOT_BUILDABLE` (R1). Bump `SCHEMA_VERSION`.
- Shared rule `rules::place::can_place(w: &dyn WorldRead<RefGame>, origin) -> Result<bool, Unknown>`: every footprint tile lacks `NOT_BUILDABLE` through `traits_at`. It names no terrain and no entity type.
- `Action::PlaceFurnace { origin }`: validate (has a furnace item, `can_place`), then `spawn` and one `put_player`. Furnaces are addressed by tile everywhere.
- `RefClient`: `placing: bool`; in `extract`, when placing, one `ghost` record with `ANCHOR_CURSOR_TILE`, coloured valid / invalid / unknown from `can_place` over the `View`; furnace sprites for every furnace in view, with reduced alpha when the record is `PREDICTED`; `pick_id` = the entity id. `Ui` grows `placing` and `can_build` (has a furnace item).
- Asset script: furnace sprite (2x2 tiles, two frames: idle, lit) in `sprites.png` / `sprites.json`.
- DOM `src/ui/build.ts`: a Build button shown when `can_build`; toggles construction mode; Escape and a second press leave it. Mouse: a `tap` while placing dispatches `PlaceFurnace { origin: tap.tile }`. Touch: a `tap` moves the cursor tile (engine) and shows a Confirm button anchored to the ghost with `client.overlay.anchor`; Confirm dispatches. Mouse or touch is read from `pointerType` on the tap event (M11's `InputEventTs`). Rejections flash the ghost's Confirm/Build control with the reason.

## Non-scope
Deposit, take, smelting, the furnace panel, picking a furnace (M33b). Removing a furnace (no Requirement). Rotation.

## Files, packages and crates touched
`games/reference/` only (`sim/src/{types,content,client}.rs`, `sim/src/rules/place.rs`, `scripts/gen-assets.mjs`, `assets/`, `src/ui/build.ts`, tests).

## Seams
**Provides:** `Furnace`, `FURNACE_PROTO`, `can_place`, `local::{PLACE_MODE, CLOSE_PANEL}` event codes, browser helpers `craftFurnace(page)` and `placeFurnace(page, origin)`, `RefScenario::place(player, origin)`.
**Consumes:** prototypes, footprints, occupancy, `entity_at`, state-budget check (M21/M21b); `Predicting`, pending queue, `NotPredictable`, provisional ids (M25); `PREDICTED` flag and one-frame swap (M26); `DrawList::{sprite, ghost}`, sprite atlas loading (M17); cursor tile, `tap`/`hover`, input events in `FrameCx`, `client.overlay.anchor` (M18); everything M20–M32 provide.
**Required of M18 (check its brief before starting):** a TypeScript-to-`ClientSide` channel for client-local UI intent. Proposed seam: `client.input.emit(code: number, a?: number, b?: number)` writes one record of a new kind (7, "game") into M11's 32-byte `inputRing` layout, surfacing in `FrameCx`'s `InputQueue` like any other `InputEvent`. Without it the game's Rust cannot know that construction mode is on, so it cannot emit the ghost. No ADR names such a channel (reported as a gap); the input-ring record layout is a Phase 2 item of `0019`, so M18 can add the record kind without a new ADR.

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
(filled in during Phase 3)
