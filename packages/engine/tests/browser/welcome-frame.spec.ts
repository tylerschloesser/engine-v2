// `mp/welcome_frame_same_wake` (docs/plan/39c-acceptance-gap-tests.md step 5; ADR 0042 §3): a remote
// client configured by its first `Welcome` runs `frame()` again in that same wake, so its first gen
// requests (and presence sample) leave then, not one wake later. The page holds the `Welcome` in
// the downlink ring while the client worker is parked, bumps exactly one frame request and resumes:
// with the re-run in `worker/client.ts` `onConfigured` the gen request ring is written by the time
// that one wake acks; without it the ring stays empty until a second frame.
//
// Inject-fail-revert: `if (false && framedThisWake)` in `onConfigured` -- this test failed with
// "the frame request that carried the Welcome also made the first gen requests"
// (`Received: 0`, `Expected: > 0`); reverted.
import { expect, test } from '@playwright/test'
import { fixtureBuildDir } from '../support/fixtures.js'
import { openPage } from './support/page.js'
import { startTestServer } from './support/test-server.js'

declare global {
  interface Window {
    __hold?: () => Promise<void>
    __welcomeQueued?: () => boolean
    __fire?: () => Promise<{ genRequestsPushed: number; configured: boolean }>
  }
}

test('mp/welcome_frame_same_wake @slow', async ({ page }) => {
  test.setTimeout(45_000)
  const server = await startTestServer({ fixture: fixtureBuildDir('puts'), manualTimer: true })
  try {
    await openPage(page, `/welcome-frame.html?url=${encodeURIComponent(server.url)}`)
    await page.evaluate(() => window.__hold?.())
    // The `Welcome` leaves on a server tick; the client worker is parked, so it only queues.
    await expect
      .poll(
        async () => {
          server.stepTick()
          return page.evaluate(() => window.__welcomeQueued?.())
        },
        { timeout: 10_000 },
      )
      .toBe(true)
    const r = await page.evaluate(() => window.__fire?.())
    expect(
      r?.genRequestsPushed,
      'the frame request that carried the Welcome also made the first gen requests',
    ).toBeGreaterThan(0)
  } finally {
    await server.stop()
  }
})
