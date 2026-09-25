# games/reference

The reference game (`docs/spec/reference-game.md`): a private Vite app plus `sim/`, a game crate on
the engine's `Game` trait (`docs/decisions/0003-game-facing-api.md`). World, terrain, resources and
the collect rules landed in `docs/plan/20-reference-game-v0.md`; players, presence and the DOM
overlay are `20b-reference-player-and-collect-ui.md`.

## Commands

- `pnpm --filter reference dev` / `build` / `preview` / `typecheck`.
- `node games/reference/scripts/gen-assets.mjs [--check] [--out <dir>]`: regenerates `assets/
  {tiles,sprites}.{png,json}` (committed). `--check` fails if a fresh run would differ from what's
  committed, without writing anything.
- Bindings (`src/bindings/*.ts`, committed) and the `.wasm` regenerate together on any
  `pnpm --filter reference build`/`dev` (the `engine()` Vite plugin's own bindings step, wired by
  this package's `vite.config.ts`); review `git diff src/bindings` after touching `sim/`.
- `cargo nextest run -E 'package(reference-sim)'` for this crate's own Rust tests (a bare
  `pnpm test rust -t reference` matches an unrelated engine test by substring, not this crate).
- Landmarks (`tests/fixtures/landmarks.json`): a native guard test, `landmarks_fixture_current`
  (`sim/tests/landmarks_fixture.rs`), recomputes the nearest land tile and nearest resource tiles
  from `RefWorldgen` at `TEST_SEED` and fails, naming this file, if the fixture drifted. No
  regenerate script: update the JSON to match the test's own computed values and re-run.

## Module layout (`sim/src`)

- `content.rs`: terrain/resource ids, `TraitSet` bits, durations (`TICK_RATE.secs(..)`, 0006), and
  `Game::register`.
- `noise.rs`: `engine::noise` composed into height/moisture channels.
- `worldgen.rs`: `RefWorldgen`/`RefParams`, the real fBm generator, `hash2` resource scatter.
- `rules/`: one file per feature. `collect.rs` is the first (`StartCollect`/`CancelCollect`,
  `in_range`, `admit`'s witness-tolerance check); craft/furnace rules (M32) get their own file.
- `client.rs`: `ClientSide<RefGame>` (`RefClient`): `PlayerPresence`, the closed-form camera-follow
  spring (`spring_step`, `.claude/rules/hot-paths.md` applies here), the own-player circle/range-ring
  `extract`, and the depletion `tile_visual` override.
- `lib.rs`: the `Game` impl, plus wire-facing plain-data types (`RefAction`, `RefPlayer`,
  `TileXY`/`WorldXY`) instead of `engine::world::{TilePos, WorldPos}` (not `Codec`/`TS`).

## Two page entries (`src/`)

`game.ts`'s `startGame(opts)` is the device/renderer/art/client/camera-drive wiring shared by both
pages (optional `clock`/`scheduler`, default real; optional `test`, forwarded to `createClient`).
`main.ts` + `index.html` is production: never sets `ClientOptions.test` (`__setCamera`/
`__cameraState` are the one exception, `main.ts`'s own Deviations note). `test-entry.ts` +
`test.html`: every diagnostic `window.__*` hook and a manual clock (`ClientOptions.test`, `engine/
test`'s `stepFrame`/`stepTick`/`stepSimTickSync`/`injectPointer`/`injectWheel`), built into the
`reference` Playwright preview. A dispatched action sits on the client until a `stepFrame` call
flushes the uplink; an upload-ring record needs the page's own drain interval (no real frame loop
runs here) -- see a stepped spec's own comments for the exact sequencing a new one needs.

## Conventions

- `TEST_SEED` (`sim/tests/common/mod.rs`) is also `src/main.ts`'s own world seed: a native test's
  landmark tiles are what a player actually sees.
- `sim/tests/common/mod.rs::RefScenario`: the shared native test harness (new world, join, dispatch,
  step ticks, read player/tile, state hash); `#![allow(dead_code)]` there is deliberate.
- A resource id doubles as its own "full" depletion-stage visual id; `tile_visual` adds a stage
  offset (`content::RESOURCE_STAGE_{FULL,HALF,LOW}`) from `aux` on top of it. Three stage buckets
  only (10/10 -> 7/10 is still "full"): a single collect never visibly changes a fresh tile's stage.
- This package depends on `engine` alone (`reference_package_depends_only_on_engine`, `unit` suite):
  never import across the package boundary from `packages/engine/tests/**`, even in `tests/`.
