// `reference: capability screen on failure` (docs/plan/35-packaging-and-adapters.md): when
// `checkSupport()` fails the page shows the capability screen instead of a blank canvas. The failure is
// forced with `addInitScript`, before any page script runs, so no WebGPU device and no worker is ever
// created: `navigator.gpu` is made absent, which is the `no-webgpu` code.
import { expect, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

test('reference: capability screen on failure', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined })
  })
  await openGame(page, { path: '/index.html' })

  const screen = page.locator('.capability-screen')
  await expect(screen).toBeVisible()
  // The game branches on the engine's `code`; the screen carries it and its own wording.
  await expect(screen.locator('li[data-code="no-webgpu"]')).toContainText('WebGPU')
  await expect(screen.locator('li')).toHaveCount(1)
  expect(page.workers(), 'no worker was started').toHaveLength(0)
  expect(await page.locator('#game').count(), 'the canvas is gone with the screen').toBe(0)
})
