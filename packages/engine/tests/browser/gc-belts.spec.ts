// `gc-belts` zero-GC page (M49, docs/decisions/0078 A12): `fx-belts`' client drawing about 2,000
// moving items a frame through `transport::draw::draw_items` (`pages/src/gc-belts.ts`), over the
// production topology (isolates `main`, `client`, `sim`, `gen0`). `expectAdapter: true` (a real
// WebGPU adapter; main's row is `ceil(clean) + 8`, the 0016 §1 formula: this page reads 91-92 B a
// frame, `drawables` 108, since it dispatches nothing and does not pan); `controlKinds: ['object', 'burst']` (a production worker has
// no spare `postMessage` type, `gc-drawables.spec.ts`'s reasoning). `gc-belts items_in_view` pins
// that the measured frames really draw the items.
import { expect, test } from '@playwright/test'
import { zeroGcSuite } from './gc/suite.ts'
import { openPage } from './support/page.ts'

declare global {
  interface Window {
    __beltsItemsDrawn?: number
  }
}

zeroGcSuite({
  pageId: 'gc-belts',
  path: '/gc-belts.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
})

test('gc-belts items_in_view', async ({ page }) => {
  await openPage(page, '/gc-belts.html')
  expect(await page.evaluate(() => window.__beltsItemsDrawn)).toBe(2_072)
})
