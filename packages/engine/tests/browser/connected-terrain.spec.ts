// `connected-terrain.html`'s tests (docs/plan/15b-ring-connection-and-replica-rendering.md, step 6):
// `hidden_tab_sends_no_camera_report` (0019 §2, this milestone's own extension: while `FrameLoop`
// is paused, no camera report reaches the host). Chromium only.
//
// `overlay_tile_reaches_screen` (docs/plan/15c-terrain-visibility-and-cache-invalidation.md, steps
// 3-5): the GPU readback M15b could not build, now unblocked by M15c steps 1-2's fix
// (`Cache::evict_if_present` reporting its eviction, `GenQueue::set_view` consulting `TerrainStore::
// cache_invalidation_seq()`). `fx-puts`'s tick rule paints tile (0, 0) with `aux != 0` on its very
// first simulated tick (`Puts::tick`: `cx.tick().0 % secs_1 == 0` is true at tick 0 -- the fixture's
// own "once per simulated second" rule includes the very first tick, not just every later one), and
// `PutsClient::tile_visual` swaps that tile's resource layer to `OVERLAY_VISUAL_ID` (`fixtures/
// puts/src/lib.rs`, visual id 2, "water blue" in `tiles.json`) whenever `aux != 0` -- so "pristine
// colour" is provable only strictly before any host tick runs at all, not merely before some
// interval.
import { expect, test } from '@playwright/test'
import type { FrameUniformValues } from '../../src/render/terrain.js'
import type { NetCounters } from '../../src/test/client.js'
import { expectPixel } from '../../src/test/render.js'
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
    __writeFrameUniform?: (v: FrameUniformValues) => void
    __renderAndRead?: (
      width: number,
      height: number,
    ) => Promise<{ width: number; height: number; data: number[] }>
    __errors?: () => string[]
  }
}

// `GRASS`/`WATER` (`terrain-readback.spec.ts`'s own colours, `scripts/gen-terrain-art.mjs`'s
// `CELLS`): visual 1 (grass, `fx-puts`'s own pristine base) and visual 2 (`OVERLAY_VISUAL_ID`, the
// resource layer the tick rule swaps in). Both declare `"band": 0` in `tiles.json`, so this pair
// never dithers regardless of camera zoom or pixel position (`terrain.wgsl`: `if (band > 0u &&
// !cutoff_active)` guards the whole edge-blend block) -- the probe pixel needs no boundary-distance
// reasoning at all, only "which of the two colours is there".
const GRASS: readonly [number, number, number, number] = [34, 139, 34, 255]
const WATER: readonly [number, number, number, number] = [30, 80, 200, 255]
const TOL = 2 // 0020 §6: "≤ 2/255 per channel"

/** `tileCentrePx`'s own formula, inverted for the one case this test needs (`camTileX = 0`,
 * `camFracX = 0`, `tilesPerPx = 1`, an even `viewportPxW`/`viewportPxH`): tile (0, 0) lands exactly
 * on pixel `(viewportPxW / 2, viewportPxH / 2)`, the same "pixel index === tile index" convention
 * `terrain-readback.spec.ts`'s own `borderCamera` documents. */
function originCamera(viewportPx: number): FrameUniformValues {
  return {
    camTileX: 0,
    camTileY: 0,
    camFracX: 0,
    camFracY: 0,
    viewportPxW: viewportPx,
    viewportPxH: viewportPx,
    tilesPerPx: 1,
    seed: 0,
    cursorTileX: 0,
    cursorTileY: 0,
    cursorValid: 0,
    neighbourCutoffPx: 0,
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

/** `Uploader::on_frame`'s own residency scan (`client/upload.rs`) gates on `!changed &&
 * self.last_visible == Some(visible)`, where `changed` comes only from drained `CacheEvent`s --
 * there is no "a chunk newly finished generating" event, so under a genuinely static camera the
 * *first* `on_frame` call (when the chunk is not yet resident) is also the *last* one to scan,
 * until either an eviction fires or the visible rect itself changes. `TerrainFeed::deliver`
 * (materializing a pristine or regenerated chunk) runs on the client worker's own gen-result pump,
 * not from `frame()`, so it never itself causes a rescan. This is a pre-existing gap in `Uploader`'s
 * own staleness detection -- separate from, and not fixed by, this milestone's `GenQueue`/
 * `invalidation_seq` change (Non-scope: "do not redesign the dense cache or its LRU"), and every
 * production/zero-GC page that already renders correctly does so because its camera moves every
 * frame, which this readback's own camera deliberately does not (the milestone's Goal: "with the
 * camera held still"). Nudging the camera one tile away and back, both across real `stepFrame`
 * calls with zero host ticks, forces two more `visible`-changing `on_frame` scans -- a test-only
 * workaround local to this file, not a production change, and harmless here: the world is 1x1
 * tile of interest and 0 ticks run, so this never touches host state or the tick-rule timing this
 * test depends on. */
async function settleUploads(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(([x, y, tilesAcross]) => window.__advance?.(x, y, tilesAcross, 0), [
    1, 0, 8,
  ] as const)
  await page.evaluate(([x, y, tilesAcross]) => window.__advance?.(x, y, tilesAcross, 0), [
    0, 0, 8,
  ] as const)
}

async function readOriginPixel(
  page: import('@playwright/test').Page,
  camera: FrameUniformValues,
): Promise<import('../../src/test/render.js').PixelBuffer> {
  await page.evaluate((cam) => window.__writeFrameUniform?.(cam), camera)
  const raw = await page.evaluate(([w, h]) => window.__renderAndRead?.(w, h), [
    camera.viewportPxW,
    camera.viewportPxH,
  ] as const)
  return {
    width: raw?.width ?? 0,
    height: raw?.height ?? 0,
    data: Uint8Array.from(raw?.data ?? []),
  }
}

// M15c steps 3-5 (Order of work step 3): the readback probe M15b's own Deviations left for this
// milestone once the cache-invalidation bug (steps 1-2) had a fix. Camera fixed at tile (0, 0)
// throughout -- the same "camera holds still" shape the milestone's own Goal names -- across a
// sequence of `__advance` calls that never move the camera except inside `settleUploads`' own
// test-only jiggle (see its doc comment):
//   1. Zero host ticks: only the client's own `TerrainFeed` has run, so tile (0, 0) is resident
//      from pristine client-side generation alone, with no host round trip yet. Pristine colour.
//   2. One host tick: `fx-puts`'s tick rule fires on this, its very first simulated tick (module
//      comment above), painting tile (0, 0) and downlinking a snapshot that evicts it
//      (`TerrainStore::replace_overlay`, `Cache::evict_if_present`).
//   3. Zero more host ticks: the next `frame()`/`GenQueue::set_view` call is the one this
//      milestone's fix makes notice `TerrainStore::cache_invalidation_seq()` moved since step 2 and
//      rescan despite `view.visible` being byte-identical throughout. Overlay colour.
test('overlay_tile_reaches_screen', async ({ page }, testInfo) => {
  await openPage(page, '/connected-terrain.html')
  const adapterInfo = await page.evaluate(() => window.__init?.().then((r) => r.adapterInfo))
  expectAdapter(testInfo, adapterInfo as Parameters<typeof expectAdapter>[1])

  const camera = originCamera(16)

  // 1. Client-only pristine generation, no host tick at all.
  await page.evaluate(([x, y, tilesAcross]) => window.__advance?.(x, y, tilesAcross, 0), [
    0, 0, 8,
  ] as const)
  await settleUploads(page)
  expectPixel(await readOriginPixel(page, camera), 8, 8, GRASS, TOL)

  // 2. One host tick: paints the tile and downlinks the snapshot that evicts it client-side.
  const afterPaint = await page.evaluate(
    ([x, y, tilesAcross]) => window.__advance?.(x, y, tilesAcross, 1),
    [0, 0, 8] as const,
  )
  expect(
    afterPaint?.chunkSnapshots ?? 0,
    'the tick rule must have painted tile (0, 0) and downlinked a snapshot for it',
  ).toBeGreaterThan(0)

  // 3. Zero more ticks, camera back at rest: the next `frame()` call is what the M15c fix makes
  // rescan despite `view.visible` being unchanged, re-requesting and re-materializing tile (0, 0)
  // with its new overlay; `settleUploads` then forces `Uploader::on_frame` to notice it resident
  // again (same pre-existing gap as step 1, not this milestone's own fix).
  await page.evaluate(([x, y, tilesAcross]) => window.__advance?.(x, y, tilesAcross, 0), [
    0, 0, 8,
  ] as const)
  await settleUploads(page)
  expectPixel(await readOriginPixel(page, camera), 8, 8, WATER, TOL)

  expectNoGpuErrors((await page.evaluate(() => window.__errors?.())) ?? [])
})
