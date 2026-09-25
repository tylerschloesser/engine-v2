// `reference_new_player_spawns_on_land` (docs/plan/20b-reference-player-and-collect-ui.md Tests
// added, step 6): a fresh session's camera starts on the spawn tile (`RefClient::nearest_land_tile`,
// step 5), not the world's raw `(0, 0)` centre -- `game.ts`'s shared `onUi` subscription calls
// `client.camera.moveTo` once, only when `client.camera.restored` is `false` (a fresh browser
// context here, no `localStorage` camera to restore).
import { expect, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

declare global {
  interface Window {
    __cameraState?: () => { x: number; y: number; tilesAcross: number }
    __stepFrame?: (dtMs: number) => Promise<void>
  }
}

// `tests/fixtures/landmarks.json`'s own `land` tile at `TEST_SEED`: `(0, 0)` (also the iron
// landmark -- `terrain.spec.ts`'s own comment). `spawn_is_nearest_land_tile` (native) proves the
// Rust side finds this same tile independently of this browser test.
const SPAWN_TILE = { x: 0, y: 0 }

test('reference_new_player_spawns_on_land', async ({ page }) => {
  await openGame(page, { path: '/test.html' })

  // Deliberately never calls `__setCamera` (which would itself overwrite `cameraState`, hiding the
  // very evidence this test is after): stepped frames alone let `game.ts`'s own `onUi` subscription
  // fire (`RefClient::frame` marks `ui_dirty` unconditionally every call) and run its `moveTo` --
  // `Ui.spawn` needs no world read at all (`RefClient`'s own cached field, step 5), so no
  // `__stepTick` is needed either.
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__stepFrame?.(16))
  }

  // The default `CameraState` also centres at `(0, 0)` (`packages/engine/src/camera/state.ts`), so
  // `+ 0.5` (the spawn tile's own centre, `game.ts`'s own `moveTo` call) is what distinguishes "the
  // spawn rule ran" from "nothing moved the camera at all".
  const state = await page.evaluate(() => window.__cameraState?.())
  expect(state).toEqual({ x: SPAWN_TILE.x + 0.5, y: SPAWN_TILE.y + 0.5, tilesAcross: 12 })
})
