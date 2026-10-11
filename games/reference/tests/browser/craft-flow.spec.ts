// `reference_craft_flow` (M32 Tests added): collect to the unlock
// threshold, the crafting menu appears on the step the unlock lands (and not before), craft with a
// real CSS progress animation, step the duration, and the inventory shows one furnace and the stone
// cost paid. Stepped ticks only, never real time (0020 §4).
import { expect, test } from '@playwright/test'
import { collectN, ITEM, openGame, pumpUntil, readUi } from '../helpers/game.js'

// `content::RECIPES[0]`: cost 5 stone, 5 s = 100 ticks at 20 Hz; unlock at 5 stone mined.
const CRAFT_TICKS = 100 + 1 // + the host's tick T+1 queuing (0004)

test('reference_craft_flow', async ({ page }) => {
  // `?lateUi=3`: the first three `uiState` reads answer null, as when the first `Ui` is late.
  await openGame(page, { path: '/test.html?lateUi=3' })
  const menu = page.locator('.craft-menu')
  const button = page.locator('[data-craft-recipe="0"]')

  // Fresh world: no menu, no recipes.
  expect((await readUi(page)).recipes).toEqual([])
  await expect(menu).toHaveAttribute('hidden', '')

  // Four stone: still below the threshold.
  const four = await collectN(page, 'stone', 4)
  expect(four?.inventory[ITEM.stone]).toBe(4)
  expect(four?.recipes).toEqual([])
  await expect(menu).toHaveAttribute('hidden', '')

  // The fifth stone lands: the menu appears without a reload.
  const five = await collectN(page, 'stone', 1)
  expect(five?.unlocks).toBe(1)
  expect(five?.recipes.length).toBe(1)
  await expect(menu).not.toHaveAttribute('hidden', '')
  await expect(menu).toBeVisible()
  await expect(button).toBeEnabled()

  // Craft: the button disables and fills until the authoritative clock reaches `done_at` (`own-timer.ts`).
  await button.click()
  await page.evaluate((dtMs) => window.__stepFrame?.(dtMs), 16)
  // `Ui.crafting` is predicted (ADR 0073) and shows at the tap; the inventory is the replica's, so the
  // cost shows once the host has applied the craft. Wait for both.
  const crafting = await pumpUntil(
    page,
    (ui) => ui?.crafting !== null && ui?.crafting !== undefined && ui?.inventory[ITEM.stone] === 0,
  )
  expect(crafting?.inventory[ITEM.stone], 'cost paid at StartCraft').toBe(0)
  await expect(button).toBeDisabled()
  await expect(button).toHaveClass(/is-filling/)
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))),
  )
  const clock = await page.evaluate(() => window.__clock?.())
  if (!crafting?.crafting || !clock) throw new Error('missing crafting/clock state')
  // Bounded as in `collect-flow.spec.ts`: longer than the unstretched `done_at - predicted`, no longer
  // than the duration plus the largest lead.
  const tickMs = 1000 / clock.ticksPerSecond
  const longestMs = (CRAFT_TICKS + 40) * tickMs // duration + the largest lead (40 ticks, 0064 §3)
  const unstretchedMs = (crafting.crafting.done_at - clock.predicted) * tickMs
  const durations = await button.evaluate((el) =>
    el
      .getAnimations({ subtree: true })
      .filter((a) => a.playState === 'running')
      .map((a) => (a.effect as KeyframeEffect | null)?.getTiming().duration ?? null),
  )
  expect(durations.length, 'exactly one running fill animation').toBe(1)
  expect(durations[0] as number).toBeLessThanOrEqual(longestMs + 1)
  expect(durations[0] as number, 'stretched over duration + lead').toBeGreaterThan(unstretchedMs)

  // Step the duration: one furnace, stone spent.
  await page.evaluate((k) => window.__stepTick?.(k), CRAFT_TICKS)
  const done = await pumpUntil(page, (ui) => ui?.crafting === null)
  expect(done?.inventory[ITEM.furnace]).toBe(1)
  expect(done?.inventory[ITEM.stone]).toBe(0)
  await expect(page.locator('.inventory')).toContainText('Furnace: 1')
  // Stone is now below the cost: the button stays listed but disabled.
  await expect(button).toBeDisabled()
})
