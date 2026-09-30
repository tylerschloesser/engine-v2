# games/reference

The reference game (`docs/spec/reference-game.md`): a private Vite app plus `sim/`, a game crate on the engine's `Game` trait (`docs/decisions/0003-game-facing-api.md`). Rules: `docs/plan/20-reference-game-v0.md` (world, collect), `20b-reference-player-and-collect-ui.md` (players, overlay), `32-reference-crafting.md` (craft), `33-reference-furnace.md` (furnace, placement).

## Commands

- `pnpm --filter reference dev` / `build` / `preview` / `typecheck`.
- `node games/reference/scripts/gen-assets.mjs [--check] [--out <dir>]`: regenerates committed `assets/{tiles,sprites}.{png,json}`.
- Bindings (`src/bindings/*.ts`) and the `.wasm` regenerate together on any `pnpm --filter reference
  build`/`dev`; review `git diff src/bindings` after touching `sim/`.
- `cargo nextest run -E 'package(reference-sim)'` for this crate's Rust tests (`pnpm test rust -t
  reference` matches an unrelated engine test by substring).
- `tests/fixtures/landmarks.json`: `landmarks_fixture_current` recomputes it from `RefWorldgen` at
  `TEST_SEED` and fails, naming this file, if it drifted.
- `gc.html`/`src/gc-entry.ts`: the zero-GC page (spec: `packages/engine/tests/browser/gc-reference.
  spec.ts`; budget: `gc.pages.reference`). `vite.config.ts`'s `minify: false` is load-bearing:
  software-mode attribution matches by runtime function name (found live).

## Module layout (`sim/src`)

- `content.rs`: terrain/resource ids, `TraitSet` bits, durations, `SEED` (every real page's seed --
  `ClientSide` gets no engine seed/params channel), `Game::register`.
- `noise.rs`/`worldgen.rs`: `engine::noise` composition, `RefWorldgen`/`hash2` scatter, `terrain_at`.
- `rules/`: one file per feature (`collect.rs`: `StartCollect`/`CancelCollect`, `in_range`, `admit`; `craft.rs`: `StartCraft`, due-craft completion, `update_unlocks`; `place.rs`: `can_place`, `PlaceFurnace`; `furnace.rs`: deposit, take, pick-up, `advance`).
- `client.rs` (`.claude/rules/hot-paths.md` applies): `ClientSide<RefGame>` (`RefClient`) -- the
  camera-follow spring, own-player circle/range-ring `extract`, `ui()` (below; `Ui.spawn` is
  `nearest_land_tile`'s one-time spiral, cached at construction), depletion visuals.
- `lib.rs`: the `Game` impl, plus wire-facing plain-data types (`RefAction`, `RefPlayer`, `RefUi`,
  `TileXY`/`WorldXY`/`UiCollecting`/`UiInRange`) instead of `engine::world`/`time` types.

## The `Ui` rule, DOM modules (`src/ui/`) and the two page entries (`src/`)

`Ui` changes at state-change rate, never per frame: `in_range`'s own `from` is cached at tile-entry
time (`tracked_range`), and `spawn` never changes at all, so `Ui` stays `PartialEq`-stable while a
player merely stands in range. A per-frame value never belongs in `Ui` (0003).

Framework-free (Requirements). `dom.ts`: `el()`, `diffKeyed()` (generic keyed-list reconciler, reused
by M32-M34). `collect.ts`: one `<button data-collect-tile="x,y">` per `Ui.in_range` entry, anchored
with `client.overlay.anchor`; one CSS fill animation; `CancelCollect` on pan-out; a rejected
`StartCollect` adds a `reject-<reason>` class. `inventory.ts`: a fixed, non-anchored readout. Both
wired in `game.ts`'s `startGame` (the device/renderer/art/client/camera/UI wiring shared by `main.ts`,
`test-entry.ts` and `gc-entry.ts`), which also calls `client.camera.moveTo` to `Ui.spawn` once, only
when `shouldMoveToSpawn` (`src/spawn.ts`) allows it. **`Ui.in_range`/`world.tile()` need a real sim tick**, not
just `stepFrame` (`engine/test.stepTick`, docs/plan/20c-client-ack-freeze-under-untilquiescent.md:
safe on every topology, `gc-entry.ts`'s own connected one included -- `untilQuiescent` no longer
waits on `uploadRing`, a page's own job to drain). `tests/helpers/game.ts`'s
`panTo`/`uiState`/`clickCollect`/`pumpUntil` poll a real `uiState` condition, never a fixed count.

## Conventions

- `TEST_SEED` (`sim/tests/common/mod.rs`) aliases `content::SEED`, also `src/main.ts`'s own world
  seed (a string literal there); `RefScenario` is the shared native test harness.
- A resource id doubles as its own "full" depletion-stage visual id; `tile_visual` adds a stage
  offset from `aux`. Three stage buckets only (10/10 -> 7/10 is still "full").
- Adding an item (M32): `ItemId` variant + `ITEM_COUNT` (`content.rs`), `ITEM_LABELS` (`src/ui/inventory.ts`), `ITEM` (`tests/helpers/game.ts`), bump `SCHEMA_VERSION`. A recipe: append to `RECIPES` (index = id = `unlocks` bit) and `RECIPE_NAMES` (`src/ui/craft.ts`). Tests reach states with `RefScenario::give` (native, never an action) or `collectN` (browser).
- Depends on `engine` alone (`reference_package_depends_only_on_engine`): never import across the
  package boundary from `packages/engine/tests/**`, even in `tests/`.
- Placement (M33): shared rule helpers take `&dyn WorldRead` and return `Result<_, Unknown>`; never name a tile or entity type in a placement rule (`can_place` asks `traits_at`; a new unbuildable terrain or building only adds `NOT_BUILDABLE` in `content::register`). Construction mode is client-local: `client.input.emit(LOCAL.PLACE_MODE, on)` (`src/ui/build.ts`, mirrors `content::local`) -> `RefClient.placing` -> ghost in `extract`. Step one frame after an emit or a dispatch before a tick waits (the rings drain in frames; the uplink is paced at 50 ms). A page draws its DrawList (circle, ring, furnace, ghost) with `engine/render`'s `attachClientDrawables(client, device, renderer, { colorFormat })`, called in `game.ts`; it loads `ClientOptions.assets.sprites` itself, and a hand-rolled frame loop must call `client.pick.acquire()` before `renderer.draw` (`draws.spec.ts` compares pixels with the pass on and off through `__pixelAt`; `__draws` reads the DrawList).
- Furnace (M33b): machines sleep. Change a machine's state only in `advance` (`rules/furnace.rs`), one put per state change, scheduled with `wake_at`; an idle machine has no timer and is never visited (`idle_furnaces_cost_nothing`). Actions address a machine by any footprint tile, resolved with `entity_at` (0022 section 6). Client state that points at an entity is keyed by tile and re-checked with `entity_at` every `frame`: entities can disappear (`RefClient.open`, `recheck_open`: read through the overlay-merged `FrameView::entities` when the tile is visible, since `FrameView::world()` is the raw replica; `Unknown` leaves it open). A tap finds its furnace by `ev.tile`, not `pick_id` (sprites are pickable since M33d, but a tile needs no pick record and survives the ghost-to-real swap). The panel (`src/ui/furnace.ts`) holds no open/closed state: it shows `Ui.furnace`. A panel's controls must not sit under a `.collect-button` in browser tests: stand out of collect range.
- `onUi` arrives on the real rAF: a helper that reads `Ui` waits for a non-null one (`readUi`, `panTo`; `test-entry.ts`'s `?lateUi=n` makes a late `Ui` deterministic); page code that acts on the first `Ui` checks what the player did meanwhile (`src/spawn.ts`).
