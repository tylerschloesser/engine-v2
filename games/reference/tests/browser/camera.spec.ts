// `reference_pan_and_zoom_work` (Exit criteria: "pan and zoom work"): real pointer-drag and wheel
// events dispatched by Playwright against the real canvas, read back through `client.cameraState`
// (`window.__cameraState`). Moved onto the stepped test entry (orchestrator ruling on cut 1's
// flagged decision, docs/plan/20b-reference-player-and-collect-ui.md steps 3-4 delegation prompt:
// "the production page exposes no `window.__*` hooks") -- `main.ts` no longer carries any hook at
// all. The gestures themselves are still real: Playwright's own mouse drag/wheel against the real
// canvas, recorded by the engine's real DOM listeners exactly as production installs them
// (`createClient` never gates that on the manual clock). What changed is only how the recorded
// input gets *integrated*: production runs it every real rAF (`game.ts`'s own `onCamera`); this
// page's own `real.loop` never ticks on its own (step 0's note: nothing calls `.frame()`/fires its
// scheduler), so the test calls `window.__tickCamera` (`client.camera.tick(dtMs)`, the exact same
// call `onCamera` makes) itself, the number of times needed for each gesture to show up. No
// `engine/test.injectPointer`/`injectWheel`: this test keeps real DOM events, not injected ones.
import { expect, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

declare global {
  interface Window {
    __cameraState?: () => { x: number; y: number; tilesAcross: number }
    __tickCamera?: (dtMs: number) => void
  }
}

async function tickCamera(page: import('@playwright/test').Page, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => window.__tickCamera?.(16))
  }
}

test('reference_pan_and_zoom_work', async ({ page }) => {
  await openGame(page, { path: '/test.html' })

  const before = await page.evaluate(() => window.__cameraState?.())
  if (!before) throw new Error('__cameraState missing')

  const box = await page.locator('#game').boundingBox()
  if (!box) throw new Error('#game canvas has no bounding box')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  // Pan: a real drag over the canvas. One tick right after `down` establishes the drag's own
  // baseline position (`camera/camera.ts`'s own per-slot bookkeeping: the very first `integrate()`
  // call while a pointer is active never applies a delta, only records where it started); the tick
  // after the `move` is the one that actually applies the pan.
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await tickCamera(page, 1)
  await page.mouse.move(cx + 120, cy + 80, { steps: 6 })
  await tickCamera(page, 1)
  await page.mouse.up()
  await tickCamera(page, 1)
  const afterPan = await page.evaluate(() => window.__cameraState?.())
  if (!afterPan) throw new Error('__cameraState missing')
  expect(afterPan.x !== before.x || afterPan.y !== before.y).toBe(true)

  // Zoom: a real wheel gesture over the canvas. Positive `deltaY` zooms out (`input/wheel.ts`'s
  // own doc comment); the camera starts at `DEFAULT_MIN_TILES` (12, `camera/camera.ts`), so
  // zooming further in would just clamp at the same value. The wheel notch eases in over
  // `WHEEL_TAU_MS` (22 ms, `camera/camera.ts`): several 16 ms ticks give it room to apply.
  await page.mouse.move(cx, cy)
  await page.mouse.wheel(0, 240)
  await tickCamera(page, 10)
  const afterZoom = await page.evaluate(() => window.__cameraState?.())
  if (!afterZoom) throw new Error('__cameraState missing')
  expect(afterZoom.tilesAcross).not.toBe(afterPan.tilesAcross)
})
