// `reference_place_mouse` (docs/plan/33-reference-furnace.md Tests added), with
// `reference_ghost_swap_one_frame` folded into the same page boot (ruling R2: the step keeps that
// name). Real Playwright mouse events on the real canvas; stepped ticks and frames only (0020 §4).
import { expect, test } from '@playwright/test'
import {
  craftFurnace,
  draws,
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

/** A furnace's provisional entity id has bit 31 set (0022 section 5). */
const PROVISIONAL_BIT = 2 ** 31

test('reference_place_mouse', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  await uiState(page) // primes the `lastUi` subscription
  await craftFurnace(page)
  await panTo(page, { x: 0, y: 0 })

  // The Build button appears with the item; construction mode is off until it is pressed.
  const build = page.locator('.build-button')
  await expect(build).toBeVisible()
  expect((await uiState(page))?.can_build).toBe(true)
  expect((await uiState(page))?.placing).toBe(false)
  await frame(page)
  expect(await only(page, KIND.ghost), 'no ghost outside construction mode').toBeUndefined()
  await build.click()
  await page.evaluate((d) => window.__stepFrame?.(d), 16) // drains the local-intent record (a tick would wait on it)
  await pumpUntil(page, (ui) => ui?.placing === true)

  // Hover: the ghost's cursor tile follows the pointer, and its tint follows `can_place`.
  const hover = async (tile: { x: number; y: number }) => {
    // Aim at the tile's centre.
    const p = await tileToScreen(page, tile.x + 0.5, tile.y + 0.5)
    await page.mouse.move(p.x, p.y)
    await frame(page)
    return only(page, KIND.ghost)
  }
  const ok = await hover(PLACE.shoreOk)
  expect(await page.evaluate(() => window.__cursorTile?.())).toEqual({
    ...PLACE.shoreOk,
    valid: true,
  })
  expect(ok?.color).toBe(GHOST.valid)
  expect((ok?.flags ?? 0) & FLAG.anchorCursorTile).toBe(FLAG.anchorCursorTile)
  expect([ok?.w, ok?.h]).toEqual([2, 2])

  // One tile east the footprint reaches water: the same pointer, one tile over, turns red.
  const water = await hover(PLACE.shoreWater)
  expect(await page.evaluate(() => window.__cursorTile?.())).toEqual({
    ...PLACE.shoreWater,
    valid: true,
  })
  expect(water?.color).toBe(GHOST.invalid)
  // A resource under the footprint is invalid too (R1 default).
  expect((await hover(PLACE.overIron))?.color).toBe(GHOST.invalid)
  // Back on free land it is valid again.
  expect((await hover(PLACE.free))?.color).toBe(GHOST.valid)

  // Clicking an invalid spot dispatches, is rejected by the host, and leaves the item.
  const bad = await tileToScreen(page, PLACE.shoreWater.x + 0.5, PLACE.shoreWater.y + 0.5)
  await page.mouse.click(bad.x, bad.y)
  // The uplink is paced at 50 ms (0010): one long frame flushes the action before a tick waits on it.
  await frame(page, 60)
  await page.evaluate((k) => window.__stepTick?.(k), 3)
  await frame(page)
  expect((await uiState(page))?.inventory[ITEM.furnace], 'rejected: item kept').toBe(1)
  expect(await only(page, KIND.sprite), 'rejected: no furnace').toBeUndefined()

  // A click on free land places: the furnace appears at once (predicted) ...
  const good = await tileToScreen(page, PLACE.free.x + 0.5, PLACE.free.y + 0.5)
  await page.mouse.move(good.x, good.y)
  await frame(page)
  await page.mouse.click(good.x, good.y)
  await frame(page)
  await frame(page)
  const predicted = await only(page, KIND.sprite)
  expect(predicted, 'predicted furnace appears without a tick').toBeDefined()
  expect((predicted?.flags ?? 0) & FLAG.predicted).toBe(FLAG.predicted)
  expect(predicted?.pickId).toBeGreaterThanOrEqual(PROVISIONAL_BIT)
  expect([predicted?.x, predicted?.y]).toEqual([expect.any(Number), expect.any(Number)])
  // (`Ui.inventory` is the host's state: it drops at the ack, below.)

  // reference_ghost_swap_one_frame: step ticks and frames across the ack; every published DrawList
  // holds exactly one furnace record, never zero and never two, until it is the real one.
  await test.step('reference_ghost_swap_one_frame', async () => {
    let real = false
    for (let i = 0; i < 40 && !real; i++) {
      await page.evaluate((k) => window.__stepTick?.(k), 1)
      await frame(page)
      const sprites = (await draws(page)).filter((r) => r.kind === KIND.sprite)
      expect(sprites.length, `frame ${i}: exactly one furnace record`).toBe(1)
      const rec = sprites[0]
      expect([rec?.x, rec?.y], 'same tile across the swap').toEqual([predicted?.x, predicted?.y])
      real = ((rec?.flags ?? 0) & FLAG.predicted) === 0
      if (real) expect(rec?.pickId, 'real id after the ack').toBeLessThan(PROVISIONAL_BIT)
    }
    expect(real, 'the ack replaced the prediction').toBe(true)
  })

  // The last item is gone: construction mode ends by itself and the ghost with it.
  const done = await pumpUntil(page, (ui) => ui?.placing === false)
  expect(done?.inventory[ITEM.furnace]).toBe(0)
  await frame(page)
  expect(await only(page, KIND.ghost)).toBeUndefined()
  await expect(build).toBeHidden()
})
