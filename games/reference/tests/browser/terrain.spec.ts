// `reference_terrain_renders` (docs/plan/20-reference-game-v0.md Tests added): semantic probes on
// three landmark tiles (0020 §6's probe-not-screenshot rule) -- a water tile, a plain land tile and
// a resource tile, all near the origin under `sim/tests/common/mod.rs::TEST_SEED` (the real page's
// own world seed, `src/main.ts`). Landmark coordinates found by an ad hoc native scan of
// `RefWorldgen` for this exact seed (Deviations has the scan and the coordinates); a real
// `landmarks.json` fixture is step 5's (Provides: "left for step 4/5").
//
// Moved onto the stepped test entry by docs/plan/20b-reference-player-and-collect-ui.md step 0:
// `__probeTile` now lives only on `test.html` (production's `index.html` exposes no `window.__*`
// hooks at all). Same probe technique, same assertions -- only the page changed.
import { expect, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

declare global {
  interface Window {
    __probeTile?: (
      tileX: number,
      tileY: number,
    ) => Promise<{ r: number; g: number; b: number; a: number }>
  }
}

test('reference_terrain_renders', async ({ page }) => {
  await openGame(page, { path: '/test.html' })

  // Water (base WATER = 1): `content::{DEEP_WATER, WATER, SAND, GRASS, DIRT}` colours are
  // `scripts/gen-assets.mjs`'s own flat colours (Deviations names the exact RGB per id).
  const water = await page.evaluate(() => window.__probeTile?.(3, 0))
  expect(water).toEqual({ r: 40, g: 100, b: 200, a: 255 })

  // Plain land (base SAND = 2, no resource).
  const land = await page.evaluate(() => window.__probeTile?.(1, 0))
  expect(land).toEqual({ r: 215, g: 195, b: 140, a: 255 })

  // Iron resource tile (resource id 16 = its own "full" depletion-stage visual, identity-mapped by
  // default -- no `Game::register` override needed yet, Deviations).
  const iron = await page.evaluate(() => window.__probeTile?.(0, 0))
  expect(iron).toEqual({ r: 230, g: 140, b: 60, a: 255 })
})
