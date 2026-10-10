// `reference_draws_player_furnace_and_ghost` (M33c Scope 3):
// the DrawList reaches pixels on the real reference page (`game.ts`'s `attachClientDrawables`).
// Every check compares the same pixel with the drawables pass on and off (`window.__pixelAt`,
// `test-entry.ts`), so no exact GPU colour is asserted and it holds under SwiftShader. Stepped
// frames only; every wait is on observable state, never a fixed count.
import { expect, test } from '@playwright/test'
import {
  craftFurnace,
  frame,
  KIND,
  only,
  openGame,
  PLACE,
  panTo,
  pumpUntil,
  tileToScreen,
  uiState,
} from '../helpers/game.js'

type Rgba = [number, number, number, number]
declare global {
  interface Window {
    __pixelAt?: (x: number, y: number) => Promise<{ on: Rgba; off: Rgba }>
    __playerCircle?: () => { x: number; y: number } | null
  }
}

/** Sum of absolute channel differences (RGB) between the pass on and off at a world point. */
async function delta(
  page: import('@playwright/test').Page,
  x: number,
  y: number,
): Promise<{ sum: number; d: number[] }> {
  const px = await page.evaluate(([a, b]) => window.__pixelAt?.(a, b), [x, y] as const)
  if (!px) throw new Error('no __pixelAt')
  const d = [0, 1, 2].map((i) => (px.on[i] as number) - (px.off[i] as number))
  return { sum: d.reduce((a, v) => a + Math.abs(v), 0), d }
}

const VISIBLE = 40
/** The ghost is a translucent tint (alpha 0x90), so its pixel moves less than an opaque draw. */
const TINT_VISIBLE = 15

test('reference_draws_player_furnace_and_ghost', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  await uiState(page) // primes the `lastUi` subscription
  await craftFurnace(page)
  await panTo(page, { x: 0, y: 0 })

  // The own player's circle: its centre pixel differs from terrain there.
  await frame(page)
  const circle = await page.evaluate(() => window.__playerCircle?.())
  expect(circle, 'the player circle is in the DrawList').toBeTruthy()
  const player = await delta(page, (circle as { x: number }).x, (circle as { y: number }).y)
  expect(player.sum, 'player circle pixel differs from terrain').toBeGreaterThan(VISIBLE)
  expect(player.d[1], 'player circle is green: green moves more than red').toBeGreaterThan(
    player.d[0] as number,
  )

  // Construction mode: the ghost's tint changes across the shore. The
  // tile (2, -1) sits inside both the shore-ok footprint (origin 1,-1) and the shore-water one (2,-1).
  const build = page.locator('.build-button')
  await build.click()
  await page.evaluate((d) => window.__stepFrame?.(d), 16)
  await pumpUntil(page, (ui) => ui?.placing === true)
  const hover = async (tile: { x: number; y: number }) => {
    const p = await tileToScreen(page, tile.x + 0.5, tile.y + 0.5)
    await page.mouse.move(p.x, p.y)
    await frame(page)
    expect(await only(page, KIND.ghost), 'the ghost follows the pointer').toBeDefined()
    return delta(page, 2.5, -0.5)
  }
  const ok = await hover(PLACE.shoreOk)
  const bad = await hover(PLACE.shoreWater)
  expect(ok.sum, 'valid ghost pixel differs from terrain').toBeGreaterThan(TINT_VISIBLE)
  expect(bad.sum, 'invalid ghost pixel differs from terrain').toBeGreaterThan(TINT_VISIBLE)
  // The tint follows `can_place`: green over a valid footprint, red over an invalid one (the same
  // tile, so the terrain under it is identical; compared as the change against the pass off).
  expect((ok.d[1] as number) - (ok.d[0] as number), 'valid ghost tints green').toBeGreaterThan(0)
  expect((bad.d[0] as number) - (bad.d[1] as number), 'invalid ghost tints red').toBeGreaterThan(0)
  const tintGap = ok.d.reduce((a, v, i) => a + Math.abs(v - (bad.d[i] as number)), 0)
  expect(tintGap, 'valid and invalid footprints tint differently').toBeGreaterThan(TINT_VISIBLE)

  // Place on free land: the furnace sprite's footprint centre differs from terrain.
  const good = await tileToScreen(page, PLACE.free.x + 0.5, PLACE.free.y + 0.5)
  await page.mouse.move(good.x, good.y)
  await frame(page)
  await page.mouse.click(good.x, good.y)
  await frame(page)
  await frame(page)
  const furnace = await only(page, KIND.sprite)
  expect(furnace, 'the furnace is in the DrawList').toBeDefined()
  await pumpUntil(page, (ui) => ui?.placing === false)
  await frame(page)
  const f = furnace as { x: number; y: number; w: number; h: number }
  const placed = await delta(page, f.x + f.w / 2, f.y + f.h / 2)
  expect(placed.sum, 'furnace pixel differs from terrain').toBeGreaterThan(VISIBLE)
})
