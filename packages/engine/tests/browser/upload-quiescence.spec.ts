// `upload-quiescence.html`'s test (docs/plan/20c-client-ack-freeze-under-untilquiescent.md):
// `untilQuiescent` (inside `stepTick`) must not wait on `uploadRing` -- the one ring only a page's
// own renderer/test code drains, never a worker (Deviations: "which ring each side owns"). Before
// the fix this hangs for `untilQuiescent`'s own 10s `POLL_TIMEOUT_MS` once real chunk uploads have
// landed in `uploadRing` (Deviations has the pasted red output, `test/client.ts`'s pre-fix
// `ringSabs`); after the fix it resolves in well under a second of real time, with `uploadRing`
// left genuinely undrained (`pushed > popped`) the whole time -- proof this is a contract change,
// not a case where the ring happened to end up empty anyway.
import { expect, test } from '@playwright/test'
import type { RingStats } from '../../src/sab/ring.js'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __advanceNoWait?: (x: number, y: number, tilesAcross: number, ticks: number) => Promise<void>
    __uploadStats?: () => RingStats
  }
}

test('upload_quiescence: stepTick resolves without draining uploadRing', async ({ page }) => {
  await openPage(page, '/upload-quiescence.html')

  const start = Date.now()
  // `connected.spec.ts`'s own `pan_changes_subscription` precedent (tilesAcross 32, real ticks):
  // enough real camera movement/ticks that real `CHUNK` uploads land in `uploadRing`.
  await page.evaluate((x) => window.__advanceNoWait?.(0, 0, 32, x), 20)
  await page.evaluate((x) => window.__advanceNoWait?.(100_000, 100_000, 32, x), 40)
  const elapsedMs = Date.now() - start
  // Generous relative to a real settle (well under a second locally): nowhere near
  // `untilQuiescent`'s own 10s `POLL_TIMEOUT_MS`, which is what this test hits without the fix.
  expect(elapsedMs).toBeLessThan(5000)

  // Proof this is a real contract change, not an accident of an already-empty ring: `uploadRing`
  // is genuinely left undrained (`pushed > popped`) the whole time, since this page never once
  // constructs a consumer for it (`upload-quiescence.ts`'s own module comment).
  const stats = await page.evaluate(() => window.__uploadStats?.())
  expect(stats?.pushed ?? 0).toBeGreaterThan(0)
  expect(stats?.pushed).toBeGreaterThan(stats?.popped ?? -1)
})
