// `reference_pan_and_zoom_work` (Exit criteria: "pan and zoom work"): real pointer-drag and wheel
// events dispatched by Playwright against the real canvas, read back through `client.cameraState`
// (`window.__cameraState`, a production, public field `createClient` already maintains from real
// input -- `main.ts`'s own `onCamera` already reads it every frame). No `engine/test` injection: a
// real drag/wheel over the canvas is cheaper and exercises the same DOM listeners a real player's
// gesture would.
import { expect, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

declare global {
  interface Window {
    __cameraState?: () => { x: number; y: number; tilesAcross: number }
  }
}

test('reference_pan_and_zoom_work', async ({ page }) => {
  await openGame(page)

  const before = await page.evaluate(() => window.__cameraState?.())
  if (!before) throw new Error('__cameraState missing')

  const box = await page.locator('#game').boundingBox()
  if (!box) throw new Error('#game canvas has no bounding box')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  // Pan: a real drag over the canvas.
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 120, cy + 80, { steps: 6 })
  await page.mouse.up()
  await page.waitForFunction(
    (prev) => {
      const s = window.__cameraState?.()
      return !!s && (s.x !== prev.x || s.y !== prev.y)
    },
    before,
    { timeout: 2_000 },
  )
  const afterPan = await page.evaluate(() => window.__cameraState?.())
  if (!afterPan) throw new Error('__cameraState missing')
  expect(afterPan.x !== before.x || afterPan.y !== before.y).toBe(true)

  // Zoom: a real wheel gesture over the canvas. Positive `deltaY` zooms out (`input/wheel.ts`'s
  // own doc comment); the camera starts at `DEFAULT_MIN_TILES` (12, `camera/camera.ts`), so
  // zooming further in would just clamp at the same value.
  await page.mouse.move(cx, cy)
  await page.mouse.wheel(0, 240)
  await page.waitForFunction(
    (prev) => {
      const s = window.__cameraState?.()
      return !!s && s.tilesAcross !== prev.tilesAcross
    },
    afterPan,
    { timeout: 2_000 },
  )
  const afterZoom = await page.evaluate(() => window.__cameraState?.())
  if (!afterZoom) throw new Error('__cameraState missing')
  expect(afterZoom.tilesAcross).not.toBe(afterPan.tilesAcross)
})
