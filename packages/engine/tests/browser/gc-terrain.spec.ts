// `terrain: zero-GC over a scripted pan` (docs/plan/09-renderer-terrain.md, Tests added): a real
// `createClient()` over `fx-terrain` plus a real device/renderer, driven the same way `gc-gen.ts`
// drives `fx-worldgen` -- the camera panning a little every frame so chunks are generated,
// converted, uploaded and evicted inside the measured window. `expectAdapter: true`: the first
// zero-GC page with a real WebGPU adapter (0016 §1, `gc-page.ts`'s own "a later page's script fills
// this in"). No `post-message` control: same reasoning as `gen`/`echo`/`topology` (a production
// worker has no spare `postMessage` type for a message-driven tick).
import { expect, test } from '@playwright/test'
import { zeroGcSuite } from './gc/suite.ts'
import { type AdapterInfo, expectAdapter } from './support/gpu.ts'
import { openPage } from './support/page.ts'

zeroGcSuite({
  pageId: 'terrain',
  path: '/gc-terrain.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
})

// Open gate failures item 3, gate round 1: counters read at both marks of the same 600-frame
// window `zeroGcSuite`'s own clean run drives (`gc/instrument.ts`'s `FRAMES`), proving generation,
// upload and eviction all happen *inside* it (this page's own small cache, gc-terrain.ts, forces
// continuous eviction under its wide-view pan) -- not merely that a fixture *can* produce these
// events once, outside any measured window.
test('terrain: chunks generate, upload and evict inside the window', async ({ page }, testInfo) => {
  await openPage(page, '/gc-terrain.html')
  const ready = await page.evaluate(() => window.__gc?.ready)
  expectAdapter(testInfo, (ready?.adapter as AdapterInfo | null) ?? null)

  const before = await page.evaluate(() => window.__terrainGcCounters?.())
  await page.evaluate(() => window.__gc?.run(600, false))
  const after = await page.evaluate(() => window.__terrainGcCounters?.())

  expect(before).toBeDefined()
  expect(after).toBeDefined()
  expect(
    (after?.generated ?? 0) > (before?.generated ?? -1),
    'chunks must be generated inside the window',
  ).toBe(true)
  expect(
    (after?.uploadedChunks ?? 0) > (before?.uploadedChunks ?? -1),
    'CHUNK records must upload inside the window',
  ).toBe(true)
  expect(
    (after?.evicted ?? 0) > (before?.evicted ?? -1),
    'the small cache must evict inside the window',
  ).toBe(true)
})
