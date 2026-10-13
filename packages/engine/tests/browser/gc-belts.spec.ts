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
  // here a test takes about 5 s. Under SwiftShader only, a multiple of the project's timeout for this
  // page: a ceiling on a hang, not a budget (nothing is measured against it). Locally the project's
  // stands, so a real hang still fails fast (`playwright.config.ts`, ADR 0071). Three times the
  // project's 180 s (540 s; M58 CI follow-up): `neg burst client @slow` read 196 s on run
  // 38359813173, timed out at 270 s on run 38391953558 with nothing in its path changed, and read
  // 314 s on run 38398376800; the client worker renders the full belt field in software while the
  // burst runs.
  timeoutScale: process.env.ENGINE_GPU === 'swiftshader' ? 3 : undefined,
})

test('gc-belts items_in_view', async ({ page }) => {
  // The same ceiling as the suite's budget tests above: under SwiftShader the page's 60-frame join
  // renders the full field in software, and after the four burst pages at machine load 10 it ran
  // past the project's 90 s (locally, alone, 2 s there; CI run 38384 of the popover-retry commit
  // read the follower one tick behind, which the page's settle cycles now absorb).
  test.setTimeout(process.env.ENGINE_GPU === 'swiftshader' ? 540_000 : 30_000)
  await openPage(page, '/gc-belts.html')
  // M50: 260 belt sprites (4 rows x 65 visible tiles), then 2,080 items (8 lanes x 65 tiles x 4,
  // every visible tile full), read at a pinned follower tick and item clock (the page's `READ_TICK`).
  expect(await page.evaluate(() => window.__beltsRecords)).toBe(260 + 2_080)
})
