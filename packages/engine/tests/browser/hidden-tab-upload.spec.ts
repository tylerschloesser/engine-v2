// `hidden-tab-upload.html`'s test (docs/plan/20c-client-ack-freeze-under-untilquiescent.md, the
// "production question"): can a production client worker reach the same frozen-ack state as
// `untilQuiescent`'s own bug, since a hidden tab's `FrameLoop.pause()` (0018 §8) stops exactly the
// "upload" phase that drains `client.uploadRing` in a real page? Answer this test proves: no --
// `worker/client-upload.ts`'s `pump()` asks for `min(freeSlots(), UPLOAD_BATCH_MAX)` and returns
// immediately when that is 0, so an undrained (or even full) `uploadRing` never blocks a wake. This
// page is production wiring verbatim (no `ClientOptions.test`): the sim paces itself for real, so
// real downlink traffic (a live world's own tick, independent of this client's own visibility)
// keeps landing while the tab is hidden, staging fresh `CHUNK` records nothing drains -- `pushed`
// grows past `popped` and stays there for the whole hidden window -- and the client still catches
// up the moment the tab is visible again.
import { expect, test } from '@playwright/test'
import type { RingStats } from '../../src/sab/ring.js'
import { expectAdapter, expectNoGpuErrors } from './support/gpu.js'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __init?: () => Promise<{ adapterInfo: unknown }>
    __setHidden?: (hidden: boolean) => void
    __uploadStats?: () => RingStats
    __errors?: () => string[]
  }
}

// `@slow`: needs several real seconds (a real hidden window, `packages/engine/CLAUDE.md`'s own
// "Where tests live": "put `@slow` in a title" -- the fast `browser` suite has no room for this at
// 28-29s of its own 35s budget, docs/plan/20b-reference-player-and-collect-ui.md Deviations).
test('hidden_tab_upload_backpressure_never_blocks_the_client @slow', async ({ page }, testInfo) => {
  await openPage(page, '/hidden-tab-upload.html')
  const adapterInfo = await page.evaluate(() => window.__init?.().then((r) => r.adapterInfo))
  expectAdapter(testInfo, adapterInfo as Parameters<typeof expectAdapter>[1])

  // Visible first: let the real frame loop join and settle (its own "upload" phase drains the
  // join burst), so the ring genuinely starts near-empty.
  await page.waitForTimeout(300)

  await page.evaluate(() => window.__setHidden?.(true))
  // A few real seconds with the real frame loop paused (0018 §8): the sim keeps ticking and
  // pushing real downlink traffic the whole time (independent of this client's own visibility),
  // and nothing drains `uploadRing` while the "upload" phase never runs.
  await page.waitForTimeout(2000)

  const whileHidden = await page.evaluate(() => window.__uploadStats?.())
  // The scenario is real, not vacuous: some backlog genuinely built up.
  expect(whileHidden?.pushed ?? 0).toBeGreaterThan(whileHidden?.popped ?? -1)

  await page.evaluate(() => window.__setHidden?.(false))
  // The real proof: the client is not stuck. If it were, this would never settle (there is no
  // `stepTick`/`untilQuiescent` on this production-topology page to hang on -- only real time).
  await expect
    .poll(
      async () => {
        const stats = await page.evaluate(() => window.__uploadStats?.())
        return (stats?.pushed ?? 0) === (stats?.popped ?? -1)
      },
      { timeout: 5000 },
    )
    .toBe(true)

  expectNoGpuErrors((await page.evaluate(() => window.__errors?.())) ?? [])
})
