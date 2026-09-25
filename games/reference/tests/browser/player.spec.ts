// `reference_player_circle_lags_and_settles` (docs/plan/20b-reference-player-and-collect-ui.md
// Order of work step 1: "browser check that the circle lags and settles"). Stepped frames,
// injected input (here: a direct `__setCamera` jump rather than a real drag -- the spring itself
// does not care how the camera got where it is): the own-player circle (`window.__playerCircle`,
// a raw DrawList read via `engine/test.drawListRecords`, no GPU probe needed) must not jump
// straight to a new camera target, but must reach it after enough stepped frames.
import { expect, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

declare global {
  interface Window {
    __setCamera?: (x: number, y: number, tilesAcross: number) => Promise<void>
    __stepFrame?: (dtMs: number) => Promise<void>
    __playerCircle?: () => { x: number; y: number } | null
  }
}

test('reference_player_circle_lags_and_settles', async ({ page }) => {
  await openGame(page, { path: '/test.html' })

  // First camera placement: the spring's own first `frame()` call snaps to it exactly (Scope:
  // "a fresh client never visibly springs in from (0, 0)" -- `RefClient`'s own doc comment).
  await page.evaluate(() => window.__setCamera?.(0, 0, 20))
  const start = await page.evaluate(() => window.__playerCircle?.())
  expect(start).not.toBeNull()
  expect(Math.abs((start as { x: number }).x)).toBeLessThan(0.01)

  // Jump the camera far away, then read back after exactly one more stepped frame: the circle
  // must have moved toward the target but not reached it (a lag, not a teleport).
  await page.evaluate(() => window.__setCamera?.(30, 0, 20))
  const lagging = await page.evaluate(() => window.__playerCircle?.())
  expect(lagging).not.toBeNull()
  const lx = (lagging as { x: number }).x
  expect(lx).toBeGreaterThan(0)
  expect(lx).toBeLessThan(29)

  // Step enough frames (~2 s of simulated time) for the critically damped spring to settle.
  for (let i = 0; i < 128; i++) {
    await page.evaluate(() => window.__stepFrame?.(16))
  }
  const settled = await page.evaluate(() => window.__playerCircle?.())
  expect(settled).not.toBeNull()
  expect(Math.abs((settled as { x: number }).x - 30)).toBeLessThan(0.05)
  expect(Math.abs((settled as { y: number }).y)).toBeLessThan(0.05)
})
