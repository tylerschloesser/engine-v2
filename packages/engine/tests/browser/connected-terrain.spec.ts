// `connected-terrain.html`'s tests (docs/plan/15b-ring-connection-and-replica-rendering.md, step 6):
// `hidden_tab_sends_no_camera_report` (0019 §2, this milestone's own extension: while `FrameLoop`
// is paused, no camera report reaches the host). Chromium only.
//
// `overlay_tile_reaches_screen` is NOT here (Deviations, "Decision needed"): a real newly-found bug
// blocks it -- a chunk the client has already pristine-generated, then receives a host *snapshot*
// for (`TerrainStore::replace_overlay`), is correctly evicted from the cache (`replace_overlay`'s
// own doc comment: "the next read regenerates and re-applies") but nothing ever re-triggers that
// read while the camera stays still: `evict_if_present` (unlike `materialize`'s own eviction path)
// pushes no `CacheEvent`, and both `Uploader::on_frame` and `GenQueue::set_view` gate their own
// rescans behind "did the visible rect change" -- pre-existing M07/M08b code, first exercised by
// this milestone's own wiring (a real `Replica` and a real `TerrainFeed` sharing one `TerrainStore`
// for the first time). Reproduced and left for the orchestrator; see this milestone's own Deviations
// for the exact repro and candidate fix shape.
import { expect, test } from '@playwright/test'
import type { NetCounters } from '../../src/test/client.js'
import { expectAdapter, expectNoGpuErrors } from './support/gpu.js'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __init?: () => Promise<{ adapterInfo: unknown }>
    __setCamera?: (x: number, y: number, tilesAcross: number) => void
    __setVisibility?: (state: 'hidden' | 'visible') => void
    __resume?: () => Promise<void>
    __stepTick?: (n: number) => Promise<void>
    __advance?: (x: number, y: number, tilesAcross: number, ticks: number) => Promise<NetCounters>
    __netCounters?: (conn?: number) => Promise<NetCounters>
    __errors?: () => string[]
  }
}

test('hidden_tab_sends_no_camera_report', async ({ page }, testInfo) => {
  await openPage(page, '/connected-terrain.html')
  const adapterInfo = await page.evaluate(() => window.__init?.().then((r) => r.adapterInfo))
  expectAdapter(testInfo, adapterInfo as Parameters<typeof expectAdapter>[1])

  // Join first, visibly, so there is a real connection before it goes hidden.
  const joined = await page.evaluate(() => window.__advance?.(0, 0, 8, 5))

  const whileHidden = await page.evaluate(async () => {
    await window.__resume?.() // `__advance`'s own trailing `untilQuiescent` parked everything
    window.__setVisibility?.('hidden')
    window.__setCamera?.(100_000, 100_000, 32) // field write only -- no `stepFrame`, no send
    await window.__stepTick?.(100)
    return window.__netCounters?.()
  })
  // `netCounters`' `host::ConnCounters` are cumulative for the connection's life, so the join
  // above already counts towards them: compare against that baseline, not zero. No `frame()` call
  // ran while hidden (`CB_FRAME_REQ` never advanced, `FrameLoop.pause()`), so `ClientCore::
  // set_camera` never saw the new (100_000, 100_000) position: whatever uplink traffic `__resume`
  // above's own "drain on resume" pass sent (`worker/shell.ts`'s `runBlockingLoop`, a pre-existing
  // M08b behaviour unrelated to this test -- a keepalive batch, at most, from the *old* camera
  // state) carried no camera section, so the host's subscription never saw the new position
  // either: no chunk entered or left while hidden.
  expect(whileHidden?.chunkEntersPristine ?? -1).toBe(joined?.chunkEntersPristine ?? -2)
  expect(whileHidden?.chunkLeaves ?? -1).toBe(joined?.chunkLeaves ?? -2)

  const afterVisible = await page.evaluate(async () => {
    window.__setVisibility?.('visible')
    return window.__advance?.(100_000, 100_000, 32, 40)
  })
  expect(afterVisible?.bytesUp ?? 0).toBeGreaterThan(whileHidden?.bytesUp ?? 0)
  expect(afterVisible?.chunkEntersPristine ?? 0).toBeGreaterThan(
    whileHidden?.chunkEntersPristine ?? 0,
  )

  expectNoGpuErrors((await page.evaluate(() => window.__errors?.())) ?? [])
})
