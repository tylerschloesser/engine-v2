// `connected.html`'s tests (docs/plan/15b-ring-connection-and-replica-rendering.md, step 6): a real
// `SimHost.accept`ed connection over `fx-puts`, driven deterministically through `stepTick`
// (`CB_SIM_STEP_REQ`, no real-time pacing armed -- `connected-paced.spec.ts` is the one page that
// arms it, for the ADR 0030 wake test). Chromium only (no `@engines`): nothing here is
// renderer/GPU-specific.
import { expect, test } from '@playwright/test'
import type { SimHostCounters } from '../../src/server.js'
import type { NetCounters } from '../../src/test/client.js'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __replicaHash?: () => Promise<string>
    __hostRegionHash?: (conn?: number) => Promise<string>
    __worldHash?: () => Promise<string>
    __simCounters?: () => Promise<SimHostCounters>
    __advance?: (x: number, y: number, tilesAcross: number, ticks: number) => Promise<NetCounters>
  }
}

test('replica_hash_equals_host_in_browser', async ({ page }) => {
  await openPage(page, '/connected.html')

  const { replica, host } = await page.evaluate(async () => {
    await window.__advance?.(0, 0, 32, 40)
    const replica = await window.__replicaHash?.()
    const host = await window.__hostRegionHash?.()
    return { replica, host }
  })

  expect(replica).toHaveLength(16)
  expect(replica).toBe(host)
})

test('pan_changes_subscription', async ({ page }) => {
  await openPage(page, '/connected.html')

  const before = await page.evaluate((x) => window.__advance?.(0, 0, 32, x), 20)
  expect(before?.chunkEntersPristine ?? 0).toBeGreaterThan(0)
  expect(before?.chunkLeaves ?? 0).toBe(0)

  // Far enough that every previously-subscribed chunk is outside ring 3 (`RING_UNSUB`); enough
  // ticks that the 5 s / 100-tick hold time (`SubscriptionSet::new`'s own `tick_rate.secs(5)`)
  // fully elapses at 20 Hz.
  const after = await page.evaluate((x) => window.__advance?.(100_000, 100_000, 32, x), 150)
  expect(after?.chunkLeaves ?? 0).toBeGreaterThan(0)
  // Backpressure never fired for this modest scenario (the ring, not a snapshot golden): the real
  // proof of "never drops" at scale is `join_at_max_zoom_out_never_drops`, below.
  expect(after?.downlink.drops).toBe(0)
  expect(after?.downlinkRetries).toBe(0)
})

// docs/plan/15b-ring-connection-and-replica-rendering.md, Tests added: "join_at_max_zoom_out_never_
// drops" -- born `@slow` (ADR 0020 §4 rung 3: this milestone's own trip-wire), with a shrunk
// fast-tier variant covering the same backpressure path at a scenario small enough for the 20 s
// budget (0020 §4's "never demote the only test covering a feature; shrink its scenario").
async function joinAtMaxZoomOut(page: import('@playwright/test').Page, ticks: number) {
  await openPage(page, '/connected.html')
  // 0010 "Untrusted-view clamps": half-extent up to 128 tiles/axis -> `tilesAcross` 256.
  const counters = await page.evaluate((ticks) => window.__advance?.(0, 0, 256, ticks), ticks)
  expect(counters?.downlink.drops).toBe(0)
  expect(counters?.uplink.drops).toBe(0)
  expect(counters?.chunkEntersPristine ?? 0).toBeGreaterThan(0)
}

test('join_at_max_zoom_out_never_drops (shrunk)', async ({ page }) => {
  await joinAtMaxZoomOut(page, 10)
})

test('join_at_max_zoom_out_never_drops @slow', async ({ page }) => {
  await joinAtMaxZoomOut(page, 200)
})
