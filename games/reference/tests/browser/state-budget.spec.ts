// `reference_state_budget_full_shows_reason` (M34b Tests
// added): a world whose entity budget leaves no room (`/test.html?maxEntities=0`) refuses
// `PlaceFurnace` with `Rejected(Engine(StateBudgetFull))`; the furnace stays in the inventory and the
// build control shows why (`.build-reason`). The native half is the wasm suite's
// `reference_state_budget_full`. Stepped ticks and frames only.
import { expect, test } from '@playwright/test'
import {
  craftFurnace,
  frame,
  ITEM,
  openGame,
  PLACE,
  pumpUntil,
  tileToScreen,
  uiState,
} from '../helpers/game.js'

test('reference_state_budget_full_shows_reason', async ({ page }) => {
  await openGame(page, { path: '/test.html?maxEntities=0' })
  await uiState(page) // primes the `lastUi` subscription
  await craftFurnace(page)

  // Build mode, then a mouse tap on a free 2x2 of land.
  const reason = page.locator('.build-reason')
  await expect(reason).toBeHidden()
  await page.locator('.build-button').click()
  await page.evaluate((d) => window.__stepFrame?.(d), 16)
  await pumpUntil(page, (u) => u?.placing === true)
  const p = await tileToScreen(page, PLACE.free.x + 0.5, PLACE.free.y + 0.5)
  await page.mouse.move(p.x, p.y)
  await frame(page)
  await page.mouse.click(p.x, p.y)
  await frame(page, 60) // the uplink is paced at 50 ms

  // The host's verdict arrives as stepped ticks run: wait on the reason itself.
  for (let i = 0; i < 40 && (await reason.isHidden()); i++) {
    await page.evaluate((k) => window.__stepTick?.(k), 1)
    await frame(page)
  }
  await expect(reason).toBeVisible()
  await expect(reason).toHaveAttribute('data-reason', 'StateBudgetFull')
  await expect(reason).toContainText('The world is full')

  // Nothing was spent: the furnace is still in the inventory, the player still holds it to build.
  const ui = await uiState(page)
  expect(ui?.inventory[ITEM.furnace]).toBe(1)
})
