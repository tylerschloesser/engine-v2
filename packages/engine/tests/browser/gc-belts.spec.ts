// `gc-belts` zero-GC page (M49, docs/decisions/0078 A12): `fx-belts`' client drawing about 2,000
// moving items a frame through `transport::draw::draw_items` (`pages/src/gc-belts.ts`), over the
// production topology (isolates `main`, `client`, `sim`, `gen0`). `expectAdapter: true` (a real
// WebGPU adapter; main's row is `ceil(clean) + 8`, the 0016 §1 formula: this page reads 91-92 B a
// frame, `drawables` 108, since it dispatches nothing and does not pan); `controlKinds: ['object', 'burst']` (a production worker has
// no spare `postMessage` type, `gc-drawables.spec.ts`'s reasoning). `gc-belts items_in_view` pins
// that the measured frames really draw the items (and, since M50, the belt tiles in view).
import { expect, test } from '@playwright/test'
import { zeroGcSuite } from './gc/suite.ts'
import { openPage } from './support/page.ts'

declare global {
  interface Window {
    __beltsRecords?: number
  }
}

zeroGcSuite({
  pageId: 'gc-belts',
  path: '/gc-belts.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
  // M49 CI follow-up (run 38310820864): on the CI runner (4 vCPUs, SwiftShader) `neg object main`
  // and `neg object sim` hit the gc project's timeout (90 s there) in the warm-up passes (7 of 8);
  // here a test takes about 5 s. Under SwiftShader only, three times the project's timeout for this
  // page: a ceiling on a hang, not a budget (nothing is measured against it). Locally the project's
  // stands, so a real hang still fails fast (`playwright.config.ts`, ADR 0071).
  timeoutScale: process.env.ENGINE_GPU === 'swiftshader' ? 3 : undefined,
})

test('gc-belts items_in_view', async ({ page }) => {
  await openPage(page, '/gc-belts.html')
  // M50: 260 belt sprites (4 rows x 65 visible tiles), then 2,072 items.
  expect(await page.evaluate(() => window.__beltsRecords)).toBe(260 + 2_072)
})
