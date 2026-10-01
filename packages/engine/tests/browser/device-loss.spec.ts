// WebGPU device loss (docs/plan/37b-device-loss.md; docs/decisions/0018-renderer.md §8): a real
// client over `fx-terrain` behind a `GpuHost` (`pages/src/device-loss.ts`). Both tests lose the
// device on purpose, so each opts out of the global "a device loss fails the test" rule with
// `allowDeviceLoss(page)` (0020 §6). Stepped frames and the manual clock only; the picture is proved
// by a pixel readback of real GPU state after recovery (`renderTo`/`readPixels`), never by a flag.
import { expect, type Page, test } from '@playwright/test'
import { expectPixel, type PixelBuffer } from '../../src/test/render.ts'
import { expectAdapter, expectNoGpuErrors } from './support/gpu.ts'
import { allowDeviceLoss, openPage } from './support/page.ts'

const GRASS: readonly [number, number, number, number] = [34, 139, 34, 255]
const WATER: readonly [number, number, number, number] = [30, 80, 200, 255]
const ORE: readonly [number, number, number, number] = [230, 140, 20, 255]
const NEUTRAL: readonly [number, number, number, number] = [32, 32, 32, 255]
const TOL = 2 // 0020 §6: "≤ 2/255 per channel"
const FRAME_MS = 1000 / 60
/** `frame-loop.ts`'s `DEFAULT_UPLOAD_BUDGET_BYTES` (0018 §3): what `step()`'s drain runs under. */
const UPLOAD_BUDGET_BYTES = 64 * 1024

type DeviceLoss = NonNullable<Window['__deviceLoss']>

/** Pixel index === tile index on both axes: 64x16 viewport, `tilesPerPx: 1`, camera centre (32, 8)
 * (the `terrain-readback.spec.ts` border scene: chunk (0,0) grass with ore at local index 5,
 * chunk (1,0) water). */
const BORDER_CAMERA = {
  camTileX: 32,
  camTileY: 8,
  camFracX: 0,
  camFracY: 0,
  viewportPxW: 64,
  viewportPxH: 16,
  tilesPerPx: 1,
} as const

async function openLossPage(page: Page, testInfo: import('@playwright/test').TestInfo) {
  await openPage(page, '/device-loss.html')
  allowDeviceLoss(page)
  const init = await page.evaluate(() => window.__deviceLoss?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await page.evaluate((cam) => {
    const d = window.__deviceLoss as DeviceLoss
    d.setCamera(32, 8, 64)
    d.setHalfExtent(64, 64)
    d.setProbeCamera(cam)
  }, BORDER_CAMERA)
}

async function readBorder(page: Page): Promise<PixelBuffer> {
  const raw = await page.evaluate(() => (window.__deviceLoss as DeviceLoss).renderAndRead(64, 16))
  return { width: raw.width, height: raw.height, data: Uint8Array.from(raw.data) }
}

function expectBorderScene(pixels: PixelBuffer): void {
  expectPixel(pixels, 31, 0, GRASS, TOL)
  expectPixel(pixels, 32, 0, WATER, TOL)
  expectPixel(pixels, 5, 0, ORE, TOL)
  expectPixel(pixels, 10, 0, GRASS, TOL)
}

test('device loss recovers', async ({ page }, testInfo) => {
  await openLossPage(page, testInfo)
  await page.evaluate(async () => {
    const d = window.__deviceLoss as DeviceLoss
    d.anchor(32.5, 8.5)
    await d.idle()
  })
  expectBorderScene(await readBorder(page))
  const before = await page.evaluate(() => {
    const d = window.__deviceLoss as DeviceLoss
    return { words: d.controlWords(), rect: d.anchorRect() }
  })

  await page.evaluate(() => (window.__deviceLoss as DeviceLoss).loseDevice())
  expect(await page.evaluate(() => (window.__deviceLoss as DeviceLoss).hasDevice())).toBe(false)

  // The outage: the camera keeps moving, the client worker keeps acking frames, the camera block
  // keeps being written and the anchored element keeps tracking, with no device at all.
  const during = await page.evaluate((frameMs) => {
    const d = window.__deviceLoss as DeviceLoss
    d.setCamera(40, 8, 64)
    for (let i = 0; i < 6; i++) d.step(frameMs)
    return {
      words: d.controlWords(),
      rect: d.anchorRect(),
      counters: d.counters(),
      hasDevice: d.hasDevice(),
    }
  }, FRAME_MS)
  expect(during.hasDevice, 'the rebuild must not have finished inside one synchronous burst').toBe(
    false,
  )
  expect(during.counters.ticksWithoutDevice).toBe(6)
  expect(during.words.ack).not.toBe(before.words.ack)
  expect(during.words.cameraSeq).toBeGreaterThan(before.words.cameraSeq)
  expect(during.rect.x, 'the anchored element tracked the camera pan').toBeLessThan(
    before.rect.x - 1,
  )

  // Recovery, then the refill paced by the loop's own budgeted drain.
  const generation = await page.evaluate(() => (window.__deviceLoss as DeviceLoss).untilRecovered())
  expect(generation).toBe(1)
  await page.evaluate((frameMs) => {
    const d = window.__deviceLoss as DeviceLoss
    d.setCamera(32, 8, 64)
    for (let i = 0; i < 40; i++) d.step(frameMs)
  }, FRAME_MS)

  const after = await readBorder(page)
  expectBorderScene(after)
  // Not a trivially-neutral frame: the neutral colour is what an empty page texture draws.
  expect(Array.from(after.data.slice(31 * 4, 31 * 4 + 4))).not.toEqual([...NEUTRAL])
  expectNoGpuErrors(await page.evaluate(() => (window.__deviceLoss as DeviceLoss).errors()))
})

test('device loss: uploads stay under the frame budget', async ({ page }, testInfo) => {
  await openLossPage(page, testInfo)
  await page.evaluate(async () => {
    await (window.__deviceLoss as DeviceLoss).idle()
  })
  const initialBytes = await page.evaluate(() =>
    (window.__deviceLoss as DeviceLoss).uploadBytesTotal(),
  )
  expect(initialBytes, 'the first join uploaded something').toBeGreaterThan(UPLOAD_BUDGET_BYTES)

  await page.evaluate(() => (window.__deviceLoss as DeviceLoss).loseDevice())
  await page.evaluate(() => (window.__deviceLoss as DeviceLoss).untilRecovered())

  const refill = await page.evaluate((frameMs) => {
    const d = window.__deviceLoss as DeviceLoss
    const base = d.uploadBytesTotal()
    const perFrame: number[] = []
    for (let i = 0; i < 60; i++) perFrame.push(d.step(frameMs).uploadBytes)
    return { perFrame, total: d.uploadBytesTotal() - base }
  }, FRAME_MS)

  // Every frame stays under the per-frame budget (`uploadBytes` counter) ...
  expect(Math.max(...refill.perFrame)).toBeLessThanOrEqual(UPLOAD_BUDGET_BYTES)
  // ... the refill really happened (everything resident was uploaded again), and took several
  // frames: it is paced, not one burst.
  expect(refill.total).toBeGreaterThanOrEqual(initialBytes * 0.9)
  expect(refill.perFrame.filter((b) => b > 0).length).toBeGreaterThan(2)
  expectNoGpuErrors(await page.evaluate(() => (window.__deviceLoss as DeviceLoss).errors()))
})
