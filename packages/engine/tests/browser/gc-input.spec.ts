// `input` zero-GC page (docs/plan/11-camera-and-input.md, Tests added: "Zero-GC: page id `input`
// through `zeroGcSuite` (600 frames of injected drag, pinch, wheel and WASD with a `tap` every 30
// frames; chunk streaming and the renderer active; isolates `main`, `client`, `gen0`)"). Same
// production-topology shape as `terrain.spec.ts` (real `createClient()`, real WebGPU adapter, no
// `post-message` control -- a production worker has no spare `postMessage` type for a message-driven
// tick).
import { expect, test } from '@playwright/test'
import { zeroGcSuite } from './gc/suite.ts'
import { openPage } from './support/page.ts'

declare global {
  interface Window {
    __gcInputRingDrops?: () => number
  }
}

zeroGcSuite({
  pageId: 'input',
  path: '/gc-input.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
})

// Budgets (Exit criteria): "`inputRing` `drops == 0`" -- the ring is sized for 64 in-flight
// records (`sab/layout.ts`'s `RING_DEFAULTS.inputRing`) and this scenario only ever has one tap in
// flight at a time, so a nonzero count here would mean the client worker's own drain
// (`worker/client-input.ts`) fell behind, not that the ring is genuinely too small.
test('input: inputRing drops 0', async ({ page }) => {
  await openPage(page, '/gc-input.html')
  await page.evaluate(() => window.__gc?.run(600, false))
  const drops = await page.evaluate(() => window.__gcInputRingDrops?.())
  expect(drops).toBe(0)
})
