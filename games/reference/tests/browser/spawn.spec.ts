// `reference_new_player_spawns_on_land` (docs/plan/20b-reference-player-and-collect-ui.md Tests
// added, step 6): a fresh session's camera starts on the spawn tile (`RefClient::nearest_land_tile`,
// step 5), not the world's raw `(0, 0)` centre -- `game.ts`'s shared `onUi` subscription calls
// `client.camera.moveTo` once, only when `client.camera.restored` is `false` (a fresh browser
// context here, no `localStorage` camera to restore).
//
// **Gate round 1 fix.** Under `content::SEED` + `RefParams::default()`, tile `(0, 0)` is *always*
// land (the noise function's own height channel reads exactly `0.0` at the origin lattice point,
// independent of seed) -- identical to `nearest_land_tile`'s own `unwrap_or(TilePos::new(0, 0))`
// fallback, so a test asserting spawn `== (0, 0)` cannot tell a working search from a broken one
// defaulting to that same value, nor tell a real `moveTo` call from no call at all (the engine's own
// `CameraState` also defaults to `(0, 0)`). `/test.html?altSpawnParams` (`test-entry.ts`) passes a
// different `ClientOptions.test.game` (the documented per-worker config escape hatch) that raises
// `water_level` enough to make the origin water, reaching the real spawn pipeline via a new engine
// hook (`ClientSide::on_init`, called once right after `Default::default()`, before `frame`/`extract`
// /`ui` ever run -- `packages/engine/crates/engine/src/client/texel.rs`) rather than a client-side
// hack: the true nearest land tile under that world is `(-1, -1)` (computed natively and guarded the
// same way `landmarks.json` is: `sim/tests/spawn.rs::spawn_alt_params_is_nearest_land_tile`,
// `tests/fixtures/spawn-alt-params.json`), distinct from both the origin and the fallback, so this
// test now fails if either is broken. Proven live (this cut's own verification, not shipped):
// removing `game.ts`'s `client.camera.moveTo` call failed this test (camera stayed at its own
// default `(0, 0)`, not `(-0.5, -0.5)`); forcing `nearest_land_tile`'s own search loop to run zero
// iterations (hitting its `unwrap_or` fallback) also failed it (spawn read back as `(0, 0)`, not
// `(-1, -1)`).
import { expect, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

declare global {
  interface Window {
    __cameraState?: () => { x: number; y: number; tilesAcross: number }
    __stepFrame?: (dtMs: number) => Promise<void>
  }
}

// `tests/fixtures/spawn-alt-params.json`'s own `land` tile under `?altSpawnParams`'s world.
const ALT_SPAWN_TILE = { x: -1, y: -1 }

test('reference_new_player_spawns_on_land', async ({ page }) => {
  await openGame(page, { path: '/test.html?altSpawnParams' })

  // Deliberately never calls `__setCamera` (which would itself overwrite `cameraState`, hiding the
  // very evidence this test is after): stepped frames alone let `game.ts`'s own `onUi` subscription
  // fire (`RefClient::frame` marks `ui_dirty` unconditionally every call) and run its `moveTo` --
  // `Ui.spawn` needs no world read at all (`RefClient`'s own cached field, set by `on_init` before
  // this page's very first frame), so no `__stepTick` is needed either.
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__stepFrame?.(16))
  }

  const state = await page.evaluate(() => window.__cameraState?.())
  expect(state).toEqual({ x: ALT_SPAWN_TILE.x + 0.5, y: ALT_SPAWN_TILE.y + 0.5, tilesAcross: 12 })
})
