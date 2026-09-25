# games/reference

The reference game (`docs/spec/reference-game.md`): a private Vite app plus `sim/`, a game crate on
the engine's `Game` trait (`docs/decisions/0003-game-facing-api.md`). World/terrain/collect rules:
`docs/plan/20-reference-game-v0.md`; players, presence and the DOM overlay: `20b-reference-player-
and-collect-ui.md`.

## Commands

- `pnpm --filter reference dev` / `build` / `preview` / `typecheck`.
- `node games/reference/scripts/gen-assets.mjs [--check] [--out <dir>]`: regenerates committed
  `assets/{tiles,sprites}.{png,json}`.
- Bindings (`src/bindings/*.ts`) and the `.wasm` regenerate together on any `pnpm --filter reference
  build`/`dev`; review `git diff src/bindings` after touching `sim/`.
- `cargo nextest run -E 'package(reference-sim)'` for this crate's Rust tests (`pnpm test rust -t
  reference` matches an unrelated engine test by substring).
- `tests/fixtures/landmarks.json`: `landmarks_fixture_current` recomputes it from `RefWorldgen` at
  `TEST_SEED` and fails, naming this file, if it drifted.

## Module layout (`sim/src`)

- `content.rs`: terrain/resource ids, `TraitSet` bits, durations, `SEED` (every real page's seed --
  `ClientSide` gets no engine seed/params channel), `Game::register`.
- `noise.rs`/`worldgen.rs`: `engine::noise` composition, `RefWorldgen`/`hash2` scatter, `terrain_at`
  (single-tile `classify`, no chunk generated).
- `rules/`: one file per feature (`collect.rs`: `StartCollect`/`CancelCollect`, `in_range`, `admit`).
- `client.rs` (`.claude/rules/hot-paths.md` applies to the whole file): `ClientSide<RefGame>`
  (`RefClient`) -- the camera-follow spring, own-player circle/range-ring `extract`, `ui()` (below;
  `Ui.spawn` is `nearest_land_tile`'s one-time spiral, cached at construction), depletion visuals.
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
wired once in `game.ts`'s `startGame`, which also calls `client.camera.moveTo` to `Ui.spawn` once,
only when `client.camera.restored` is `false` -- follow this shape for a new button-driven feature.

`startGame(opts)` is the device/renderer/art/client/camera/UI wiring shared by `main.ts` (production,
no `window.__*` hooks) and `test-entry.ts` (`test.html`, every diagnostic hook plus a manual clock).
**`Ui.in_range`/`world.tile()` need a real sim tick**, not just `stepFrame`: a tile is readable
through the replica only once the host has downlinked it. `tests/helpers/game.ts`'s `panTo`/
`uiState`/`clickCollect`/`pumpUntil` do this choreography for a browser spec -- poll a real `uiState`
condition, never a fixed tick/frame count (`ui-smoke.spec.ts`'s own fixed counts flaked under load).

## Conventions

- `TEST_SEED` (`sim/tests/common/mod.rs`) aliases `content::SEED`, also `src/main.ts`'s own world
  seed (a string literal there); `RefScenario` is the shared native test harness.
- A resource id doubles as its own "full" depletion-stage visual id; `tile_visual` adds a stage
  offset from `aux`. Three stage buckets only (10/10 -> 7/10 is still "full").
- Depends on `engine` alone (`reference_package_depends_only_on_engine`): never import across the
  package boundary from `packages/engine/tests/**`, even in `tests/`.
