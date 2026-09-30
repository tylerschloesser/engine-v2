// `reference_place_touch` (docs/plan/33-reference-furnace.md Tests added): a touch tap moves the
// ghost and shows Confirm anchored to it, a drag still pans, Confirm places. Touch pointers are
// injected (`engine/test.injectPointer`, `pointerType` 'touch'); the click on Confirm is a real one.
import { expect, test } from '@playwright/test'
import {
  craftFurnace,
  FLAG,
  frame,
  GHOST,
  ITEM,
  KIND,
  only,
  openGame,
  PLACE,
  panTo,
  pumpUntil,
  tileToScreen,
  uiState,
} from '../helpers/game.js'

test('reference_place_touch', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  await uiState(page)
  await craftFurnace(page)
  await panTo(page, { x: 0, y: 0 })

  await page.locator('.build-button').click()
  await page.evaluate((d) => window.__stepFrame?.(d), 16) // drains the local-intent record (a tick would wait on it)
  await pumpUntil(page, (ui) => ui?.placing === true)
  const confirm = page.locator('.build-confirm')
  await expect(confirm).toBeHidden()

  // A touch tap: down and up inside the tap thresholds, stepped frames between.
  const at = await tileToScreen(page, PLACE.free.x + 0.5, PLACE.free.y + 0.5)
  await page.evaluate(([x, y]) => window.__injectPointer?.('down', 1, x, y, 0, 'touch'), [
    at.x,
    at.y,
  ] as const)
  await frame(page, 16)
  await page.evaluate(([x, y]) => window.__injectPointer?.('up', 1, x, y, 40, 'touch'), [
    at.x,
    at.y,
  ] as const)
  await frame(page, 16)
  await frame(page, 16)

  // The engine's cursor tile is the tapped tile; the ghost is there, tinted valid.
  expect(await page.evaluate(() => window.__cursorTile?.())).toEqual({ ...PLACE.free, valid: true })
  const ghost = await only(page, KIND.ghost)
  expect(ghost?.color).toBe(GHOST.valid)
  expect((ghost?.flags ?? 0) & FLAG.anchorCursorTile).toBe(FLAG.anchorCursorTile)

  // Confirm shows, centred under the 2x2 ghost within 1 CSS px (the ghost's bottom-centre is the
  // world point (x + 1, y + 2)).
  await expect(confirm).toBeVisible()
  const anchored = async () => {
    const box = await confirm.boundingBox()
    const want = await tileToScreen(page, PLACE.free.x + 1, PLACE.free.y + 2)
    if (!box) throw new Error('no confirm box')
    return { dx: box.x + box.width / 2 - want.x, dy: box.y - want.y }
  }
  const a0 = await anchored()
  expect(Math.abs(a0.dx)).toBeLessThanOrEqual(1)
  expect(Math.abs(a0.dy)).toBeLessThanOrEqual(1)

  // A drag still pans (construction mode does not turn it into a tool drag) and Confirm follows.
  const cam0 = await page.evaluate(() => window.__cameraState?.())
  await page.evaluate(([x, y]) => window.__injectPointer?.('down', 2, x, y, 100, 'touch'), [
    at.x + 200,
    at.y + 100,
  ] as const)
  await frame(page, 16)
  for (let i = 1; i <= 4; i++) {
    await page.evaluate(([x, y, t]) => window.__injectPointer?.('move', 2, x, y, t, 'touch'), [
      at.x + 200 - i * 20,
      at.y + 100,
      100 + i * 16,
    ] as const)
    await frame(page, 16)
  }
  await page.evaluate(([x, y]) => window.__injectPointer?.('up', 2, x, y, 400, 'touch'), [
    at.x + 120,
    at.y + 100,
  ] as const)
  await frame(page, 16)
  await frame(page, 16)
  const cam1 = await page.evaluate(() => window.__cameraState?.())
  expect(cam1?.x, 'the drag panned the camera').not.toBe(cam0?.x)
  expect(await page.evaluate(() => window.__cursorTile?.())).toEqual({ ...PLACE.free, valid: true })
  const a1 = await anchored()
  expect(Math.abs(a1.dx)).toBeLessThanOrEqual(1)
  expect(Math.abs(a1.dy)).toBeLessThanOrEqual(1)

  // Confirm places.
  await confirm.click()
  await frame(page)
  await frame(page)
  expect(await only(page, KIND.sprite), 'predicted furnace on the tapped tile').toBeDefined()
  // The uplink is paced at 50 ms (0010): one long frame flushes the action before a tick waits on it.
  await frame(page, 60)
  await page.evaluate((k) => window.__stepTick?.(k), 3)
  const done = await pumpUntil(page, (ui) => (ui?.inventory[ITEM.furnace] ?? 1) === 0)
  expect(done?.inventory[ITEM.furnace]).toBe(0)
  await pumpUntil(page, (ui) => ui?.placing === false)
  await expect(confirm).toBeHidden()
})
