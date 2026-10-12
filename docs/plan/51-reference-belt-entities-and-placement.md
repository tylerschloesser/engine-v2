# M51: Reference game: belt entities and placement (sim crate, art, caps)

Status: not started · After: 50 · Tyler-dependent: T (the **(assumed)** lines of `games/reference/README.md` "Belts": lanes, shape rules, no belts over resources; all proceeding on their defaults, asked 2026-10-11)

Rewritten on 2026-10-12 against the code as built (the manager's survey `m51-research.md` in the session scratchpad: `RefEntity` is a plain furnace struct, the client and its tests assume every entity is a 2x2 furnace, the renderer flips only left-right, and the recommended transport caps would break the soak's 8 MiB arena and the large-save memory budget). The construction-mode UI, the browser tests and the test-page hooks are split into M51b so each half is one reviewable commit.

## Goal
The reference game's sim crate has belt, spawner and despawner entities (one tile, a direction, a kind, a derived shape M52 will write, a spawner configuration M53 will use) that a player places, rotates and picks up by tile-addressed, predicted actions; the client draws them as direction-aware generated sprites animated on the item clock and shows a direction-aware placement ghost; the item squares exist in the atlas; every world config the game builds declares its transport caps; `SCHEMA_VERSION` is bumped and the full-game golden re-recorded once. No lines yet (M52 maps them). Every rule this milestone implements cites `games/reference/README.md` "Belts".

## Read first
1. `docs/architecture/README.md`
2. `games/reference/README.md` ("Belts": Feature set, Placement, Art, Scale; "Crafting and building", "Furnace"), `games/reference/CLAUDE.md` (Conventions: placement, furnace, adding an item; the golden; the soak)
3. `docs/decisions/0076-transport-lines-engine-game-split.md` (§6, §9), `docs/decisions/0079-transport-core-decisions.md` (§5 caps, §19 (e), §20 (b)), `docs/decisions/0078-transport-forecast-replication.md` A12 (the item clock)
4. `.claude/skills/add-action-type/SKILL.md`; `games/reference/sim/src/{lib.rs, content.rs, client.rs, rules/place.rs, rules/furnace.rs}`; `games/reference/scripts/gen-assets.mjs`; `packages/engine/fixtures/belts/src/lib.rs` (`Dir`, the request pattern), `packages/engine/crates/engine/src/transport/draw.rs` (`ItemStyle`), `client/frame_view.rs` (`item_time`, `with_transport`).
Rules: `.claude/rules/prediction.md`, `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md` (`client.rs`). Skills: `add-action-type`, `run-tests`.

## Scope
- **The entity.** `RefEntity` becomes `enum RefEntity { Furnace(Furnace), Belt(Belt) }` (`Copy`, plain data); `Belt { origin: TileXY, dir: Dir, kind: BeltKind, shape: BeltShape, spawn: [Option<SpawnCfg>; 2] }` with `Dir { East, South, West, North }` (as `fx-belts`), `BeltKind { Belt, Spawner, Despawner }`, `BeltShape { Straight, CurveLeft, CurveRight }` (derived; M51 writes `Straight` and M52 derives it), `SpawnCfg { item: u8, rate: u16 }` (no accumulator: 0079 §19 (e) is M53's). `content`: `BELT_PROTO = PrototypeId(1)`, footprint 1x1, traits `NOT_BUILDABLE` (a belt is not covered by anything); `Game::prototype`/`anchor` by variant; every furnace-only site dispatches by kind (`furnace_at` rejects a belt with `NoFurnaceHere`; `advance` ignores belts in M51; `apply_tap`, `recheck_open`, `ui`, `bench.rs`, the native tests' `StubWorld`s). `SCHEMA_VERSION` 7 (8 under `test-hooks`), history line added; no migration (0079 §6: old saves refuse with `save-incompatible`).
- **Actions** (the `add-action-type` skill; appended last): `PlaceBelt { at: TileXY, dir: Dir, kind: BeltKind }` (`Growth::entities(1)`; `can_place(w, footprint, forbidden: TraitSet)` generalised: a belt forbids `NOT_BUILDABLE | COLLECTABLE` (the README's "belts may not cover resources", by trait, never by tile id: `can_place_names_no_tile_type` stays), the furnace forbids `NOT_BUILDABLE` as today; free: no inventory check), `RotateBelt { at }` (direction clockwise E→S→W→N, a put with the same anchor and id; `NoBeltHere` when the tile holds none or a furnace), `PickUpBelt { at }` (despawn; returns nothing; items destroyed is M52+'s concern since there are none). Rejects `NoBeltHere`, reuse `NotBuildable`. All predicted (R2); validate first, write after.
- **The client (`client.rs`).** `extract` draws a belt as the sprite for its kind, shape and direction (east, north, south their own sprites, west = east + `FLIP_X`), `param` = animation frame from the item clock (`view.item_time()`: `floor(item_time * 24 / 8) % 8`, so lane marks move at belt speed and in step with M53's items; a view without transport uses the tick); the predicted tint as the furnace; the placement ghost becomes tool-aware: `placing: Option<Tool>` with `Tool { Furnace, Belt(BeltKind) }` and a `dir`, `LOCAL.PLACE_MODE` carrying the tool in `a` (0 off, 1 furnace, 2 belt, 3 spawner, 4 despawner) and a new `LOCAL.ROTATE_TOOL`; a belt ghost is a cursor-anchored tinted sprite showing the direction (`ANCHOR_CURSOR_TILE`); the furnace ghost stays the quad; `Ui.placing` reports the tool and direction (`UiPlacing { tool, dir }`), `Ui.can_build` means "a furnace is in inventory" (the belt tools are always available): the "placing ends when the last furnace is gone" rule applies to the furnace tool only.
- **Art** (`gen-assets.mjs`, multi-row atlas, deterministic): belt sprites for straight E/N/S, curve left and curve right E/N/S (M52 draws them; generated now so the atlas is settled), spawner and despawner variants (a mark on the straight sprite), 8 animation frames each (lane marks advancing 1/8 of a tile a frame), 1 x 1 tiles, pivot `[0, 0]`, alpha 255; six item squares (bordered flat squares, one colour per `ItemId`, 0.5 x 0.5 tile, `SPRITE_ITEM_FIRST + id`); `content::{SPRITE_BELT_*, SPRITE_ITEM_FIRST}`; `gen_assets_reproducible` and the tiles limits test green; `--check` clean.
- **Caps (0079 §5).** `world.json` gains `maxLines` 32,768 and `maxItems` 262,144 (reaches `main.ts`, `test-entry.ts`, the server); `gc-entry.ts`, `gc-single-player-entry.ts`, `golden-record.mjs`, `refHarness` the same; **the bench keeps 0** (`benchHost`, `benchWorldConfig`: the large save has no belts and the recommended caps add about 20 MiB against `mem.simHighWaterLargeSave`'s 88 MiB in the 96 MiB arena; recorded in Deviations, to be revisited when the bench world gets belts); **the soak uses 1,024 / 8,192** (about 0.7 MB) with `SOAK_ARENA_BYTES` raised by 1 MiB so its leak sensitivity holds, the live set measured and recorded. The replica reservation at the recommended caps (17.5 MB in the 48 MiB client arena) measured once on the real page (`engine_mem_grows` 0; the headroom recorded).
- **Golden.** `pnpm --filter reference golden:record` once; the log must be byte-identical (no script step changes in M51) and every checkpoint hash from the first furnace placement onward moves (the enum discriminant): the diff reviewed and stated in Deviations; `golden_replay`, the wasm replays and `determinism.spec.ts` green.
- **Tests.** Rust (`sim/tests/belt.rs`, `belt_predict.rs`): `place_belt_rules` (water, a resource, a furnace tile, a belt tile rejected by trait; land accepted; three kinds), `rotate_keeps_entity` (same id, same anchor, dir cycles four times), `pickup_despawns`, `no_reference_entity_moves_in_a_tick` (0079 §20 (b): over a scripted place/rotate/pick-up session every entity's anchor at tick end equals its anchor at spawn), `belt_actions_are_predicted` (place, rotate, pick-up predicted then acked; a rejected one restores), `extract_hash_belts` (a DrawList golden of the three kinds in four directions plus a predicted one and a belt ghost), `extract_with_belts_allocates_nothing`; the furnace tests re-pointed at the enum, every pin kept. Netcode: `reference_belt_same_tile_race` (two players place on one tile, the loser `NotBuildable`, torn-state probe). The existing suites green; the action-log and downlink budget rows unchanged (no script change).
- Docs: `games/reference/README.md` "Not implemented" (belts: entities and placement built, lines M52), `games/reference/CLAUDE.md` (Conventions: the belt entity, the tools, the caps per site), `docs/architecture/README.md` if it lists the reference game's entities.

## Non-scope
- The construction-mode UI (tool palette, rotate button and `R`, touch confirm), the browser tests and `test-entry.ts` hooks: M51b. Lines and shapes (M52); the spawner panel, `SetSpawner`, spawner/despawner rules, items drawn on the reference page (M53); splitters (M54); undergrounds (M55). A migration for schema 6 saves (0079 §6).

## Files, packages and crates touched
- `games/reference/sim/src/{lib.rs, content.rs, client.rs, bench.rs, rules/place.rs, rules/furnace.rs, rules/belt.rs (new)}`, `sim/tests/{belt.rs, belt_predict.rs (new), the furnace/place/ghost/ui tests, common/}`, `sim/tests/golden/*.hash`.
- `games/reference/scripts/gen-assets.mjs`, `assets/sprites.{png,json}`, `world.json`, `src/{mode.ts, gc-entry.ts, gc-single-player-entry.ts}` (caps only), `src/bindings/*.ts` (regenerated), `scripts/golden-record.mjs`, `tests/golden/full-game.json`, `tests/helpers/net.ts` (caps), `tests/netcode/{soak.test.ts, races.test.ts or belt-races.test.ts}`, `README.md`, `CLAUDE.md`.
- `packages/engine/tests/support/bench-build.ts` only if a comment records the bench's 0 caps.

## Seams
**Provides:** `RefEntity::Belt`, `Dir`, `BeltKind`, `BeltShape`, `SpawnCfg`, the three actions, `content::{BELT_PROTO, SPRITE_BELT_*, SPRITE_ITEM_FIRST}`, `Tool`/`UiPlacing`, `LOCAL.ROTATE_TOOL`, the caps in every world config, the item squares. **Consumes:** M33's placement and ghost, M49's item clock (`FrameView::item_time`), `fx-belts`' `Dir`.

## Planning decisions
- **Split sim and UI.** The enum refactor touches about thirty native test files and the client; the UI half is TypeScript and browser tests. Two commits, two reviews.
- **A belt is one tile, a furnace cannot stand on it, it cannot stand on a resource** (the README's Placement line, its assumed clause by trait). Rotation never moves the anchor (0079 §20 (b) holds by construction for 1x1; M54's 2x1 splitter is the first risk and gets its own rule).
- **Direction is sprites, not rotation.** The uberquad shader has `FLIP_X` only and `param` is the frame index: east, north and south sprites, west mirrored. The atlas is generated, so the count is cheap.
- **Belts animate on the item clock** so lane marks and items move together (0078 A12); a world with no transport caps falls back to the tick.
- **Caps per site, not one value**: the game and its tests declare the recommended caps; the bench keeps 0 (its budget) and the soak small caps with its arena raised by their cost, so each measured budget keeps its meaning.
- **One schema bump per milestone**: M53's `SetSpawner` and any spawner epoch bump again; saves do not survive between belts milestones (0079 §6).

## Order of work
1. The enum, prototypes, `Dir`/`BeltKind`/`BeltShape`/`SpawnCfg`, every furnace-only site dispatching by kind; the native suite green with the furnace pins unchanged.
2. Actions and rules (`rules/belt.rs`, generalised `can_place`), `SCHEMA_VERSION`, the Rust tests with injects.
3. Art and `content` sprite ids; `extract` belts and the belt ghost; `Tool`/`UiPlacing`/`LOCAL` codes; the DrawList golden and the no-alloc test.
4. Caps at every site; the soak's caps and arena; the replica reservation measured; the full-game golden re-recorded and reviewed; bindings regenerated; the netcode race; docs; Deviations.

## Tests added
Rust: `place_belt_rules`, `rotate_keeps_entity`, `pickup_despawns`, `no_reference_entity_moves_in_a_tick`, `belt_actions_are_predicted`, `extract_hash_belts`, `extract_with_belts_allocates_nothing`. Netcode: `reference_belt_same_tile_race`.

## Exit criteria
- [ ] The Rust tests above pass with an inject-fail-revert each; every existing furnace pin unchanged.
- [ ] `gen_assets_reproducible` passes; `gen-assets.mjs --check` clean; the full-game golden re-recorded once with the reviewed diff stated (log identical, hashes move from the first placement).
- [ ] Every world config the game builds declares caps (the bench's 0 and the soak's small caps with their reasons); the soak green with its live set recorded; the replica reservation on the real page recorded.
- [ ] `reference_belt_same_tile_race` passes; `pnpm test` and `pnpm lint` green; `belts-tick` within noise (nothing in the engine crate changes).

## Verification commands
`cargo nextest run -E 'package(reference-sim)'` · `pnpm test rust -t belt` · `pnpm test netcode -t reference_belt` · `pnpm test netcode -t reference_` · `node games/reference/scripts/gen-assets.mjs --check` · `pnpm test unit -t gen_assets` · `pnpm test:slow netcode -t soak-netcode` · `pnpm test wasm -t reference` · `pnpm test && pnpm lint`

## Budgets
- `SCHEMA_VERSION` 6 → 7; `mem.simHighWaterLargeSave` unchanged (bench caps 0); the soak arena 8 → 9 MiB with the reason; the action-log and downlink rows unchanged; `belts-tick` 1.2638 ms (engine untouched).

## Context artifacts
`games/reference/README.md`, `games/reference/CLAUDE.md`.

## Manual device checks
none (M57; M51b has the browser tests).

## Deviations
(filled in during execution)
