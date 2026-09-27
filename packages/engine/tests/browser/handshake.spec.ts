// `handshake/welcome-view-clamp-limits-zoom` (docs/plan/28-sessions-and-reconnect.md, Tests added):
// a real single-player page whose host view clamp (0010) is 128 tiles per axis, not the 256
// default -- proving `Welcome`'s own `view_max_tiles_per_axis` field actually reaches
// `client.camera.setViewClamp` (0019 §1), through the `client-welcome` postMessage this milestone's
// step 5 adds, not just that some clamp is enforced.
import { expect, test } from '@playwright/test'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __hvcInjectWheel?: (deltaY: number, cssX: number, cssY: number) => void
    __hvcTickCamera?: (dtMs: number) => void
    __hvcCameraState?: () => { centreX: number; centreY: number; tilesAcross: number }
  }
}

test('handshake: welcome view clamp limits zoom', async ({ page }) => {
  await openPage(page, '/handshake-view-clamp.html')

  const before = await page.evaluate(() => window.__hvcCameraState?.())
  expect(before?.tilesAcross).toBeLessThan(128)

  // One large zoom-out gesture (deltaY = 3000, `WHEEL_K = 0.002` -> pending log-zoom delta 6,
  // `input/wheel.ts`'s own doc comment: positive `deltaY` zooms out), then enough real-shaped
  // frames for `camera/camera.ts`'s own eased convergence to fully catch up -- `e^6 ~= 400x` the
  // starting `tilesAcross`, so 128 is reached and clamped long before the ease finishes.
  await page.evaluate(() => window.__hvcInjectWheel?.(3000, 400, 300))
  for (let i = 0; i < 40; i++) {
    await page.evaluate(() => window.__hvcTickCamera?.(16))
  }

  const after = await page.evaluate(() => window.__hvcCameraState?.())
  expect(after?.tilesAcross).toBe(128)
})
