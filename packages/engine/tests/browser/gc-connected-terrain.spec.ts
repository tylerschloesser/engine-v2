// `connected-terrain: zero-GC over a real connected, rendered pan` (docs/plan/
// 15c-terrain-visibility-and-cache-invalidation.md, step 4, Tests added: "the zero-GC panning
// window (600 frames, sim + client isolates within budget, ring drops === 0)"). A real
// `createClient()` local, **connected** (`host.connect: true`) topology over `fx-puts`, plus a real
// device/renderer, driven by a scripted pan (`gc-connected-terrain.ts`) -- `expectAdapter: true`
// (a real WebGPU adapter, `terrain`'s own precedent). No `post-message` control: same reasoning as
// `terrain`/`sim`/`sim-paced` (a production worker has no spare `postMessage` type for a
// message-driven tick).
import { expect, test } from '@playwright/test'
import { zeroGcSuite } from './gc/suite.ts'
import { type AdapterInfo, expectAdapter } from './support/gpu.ts'
import { openPage } from './support/page.ts'

declare global {
  interface Window {
    // Same signature as `connected.spec.ts`/`connected-terrain.spec.ts`'s own global `Window`
    // augmentation (a TS project-wide `declare global` must match exactly everywhere it appears).
    __netCounters?: (conn?: number) => Promise<import('../../src/test/client.ts').NetCounters>
  }
}

zeroGcSuite({
  pageId: 'connected-terrain',
  path: '/gc-connected-terrain.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
})

// Exit criteria: "ring drops === 0" -- `join_at_max_zoom_out_never_drops`'s own
// `counters.uplink/downlink.drops` shape (`connected.spec.ts`), but over a real *panning* 600-frame
// window instead of one big static join, proving the uplink/downlink rings this milestone's own
// connected-rendering path depends on never overflow under sustained camera movement + real ticking.
test('connected-terrain: ring drops === 0 over 600 panning frames', async ({ page }, testInfo) => {
  await openPage(page, '/gc-connected-terrain.html')
  const ready = await page.evaluate(() => window.__gc?.ready)
  expectAdapter(testInfo, (ready?.adapter as AdapterInfo | null) ?? null)

  await page.evaluate(() => window.__gc?.run(600, false))
  const counters = await page.evaluate(() => window.__netCounters?.())

  expect(counters).toBeDefined()
  expect(counters?.uplink.drops ?? -1).toBe(0)
  expect(counters?.downlink.drops ?? -1).toBe(0)
  expect(
    counters?.chunkEntersPristine ?? 0,
    'the pan must actually move chunks through subscription inside the window',
  ).toBeGreaterThan(0)
})
