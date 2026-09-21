// Canvas lifecycle: resize/DPR/render-scale (docs/plan/09b-terrain-art-and-lifecycle.md, steps 4-5)
// and backgrounding (`FrameLoop.pause()`/`resume()`, `CB_FLAGS.REBASE`). Every test drives size/DPR
// through `engine/test.setViewport` (headless Chromium cannot really resize a window or change
// display DPI) and visibility through `engine/test.setVisibility` (`document.hidden` cannot be
// forced from outside the page); `viewport.html`'s real `ResizeObserver`/`matchMedia` stay live
// throughout (never disabled for these tests) but are never what these assertions read.
import { expect, test } from '@playwright/test'
import { expectAdapter, expectNoGpuErrors } from './support/gpu.ts'
import { openPage } from './support/page.ts'

type Viewport = NonNullable<Window['__viewport']>

test('viewport: resize renders same frame', async ({ page }, testInfo) => {
  await openPage(page, '/viewport.html')
  const { adapterInfo } = await page.evaluate(() => (window.__viewport as Viewport).init())
  expectAdapter(testInfo, adapterInfo)

  const first = await page.evaluate(() => {
    const v = window.__viewport as Viewport
    v.setViewportAndTick(32, 32, 1)
    return { size: v.canvasSize(), draws: v.drawCalls() }
  })
  expect(first.size).toEqual({ width: 32, height: 32 })
  expect(first.draws).toBe(1)

  // Queued, not yet applied (0018 §8: "size applied at the start of the next frame").
  const beforeTick = await page.evaluate(() => {
    const v = window.__viewport as Viewport
    v.setViewport(64, 64, 1)
    return v.canvasSize()
  })
  expect(beforeTick).toEqual({ width: 32, height: 32 })

  const afterTick = await page.evaluate(() => {
    const v = window.__viewport as Viewport
    v.tick()
    return { size: v.canvasSize(), draws: v.drawCalls() }
  })
  expect(afterTick.size).toEqual({ width: 64, height: 64 })
  // Exactly one more draw across the whole resize: the resize and its first render happen inside
  // the same tick, so no separate frame at the stale size is ever drawn in between (0018 §8:
  // "renders at once (no cleared flash)").
  expect(afterTick.draws).toBe(2)

  expectNoGpuErrors(await page.evaluate(() => (window.__viewport as Viewport).errors()))
})

test('viewport: dpr change', async ({ page }, testInfo) => {
  await openPage(page, '/viewport.html')
  const { adapterInfo } = await page.evaluate(() => (window.__viewport as Viewport).init())
  expectAdapter(testInfo, adapterInfo)

  const at2 = await page.evaluate(() => {
    const v = window.__viewport as Viewport
    v.setViewportAndTick(10, 10, 2)
    return v.viewport()
  })
  expect(at2).toEqual({ widthPx: 20, heightPx: 20, dpr: 2, renderScale: 2 })

  const at1 = await page.evaluate(() => {
    const v = window.__viewport as Viewport
    v.setViewportAndTick(10, 10, 1)
    return v.viewport()
  })
  expect(at1).toEqual({ widthPx: 10, heightPx: 10, dpr: 1, renderScale: 1 })

  expectNoGpuErrors(await page.evaluate(() => (window.__viewport as Viewport).errors()))
})

test('viewport: render scale caps at 2', async ({ page }, testInfo) => {
  await openPage(page, '/viewport.html')
  let { adapterInfo } = await page.evaluate(() => (window.__viewport as Viewport).init())
  expectAdapter(testInfo, adapterInfo)

  const dpr3 = await page.evaluate(() => {
    const v = window.__viewport as Viewport
    v.setViewportAndTick(10, 10, 3)
    return v.viewport()
  })
  expect(dpr3.renderScale).toBe(2)
  expect(dpr3.widthPx).toBe(20)
  expect(dpr3.heightPx).toBe(20)

  const dpr15 = await page.evaluate(() => {
    const v = window.__viewport as Viewport
    v.setViewportAndTick(10, 10, 1.5)
    return v.viewport()
  })
  expect(dpr15.renderScale).toBe(1.5)
  expect(dpr15.widthPx).toBe(15)
  expect(dpr15.heightPx).toBe(15)

  // `render: { scale: 1 }` (a fresh page/`init()`: the option is fixed for the wiring's own
  // lifetime, the same way `ClientOptions.render` is fixed for a real client) overrides the
  // DPR-derived cap entirely: the CSS size at any DPR.
  ;({ adapterInfo } = await page.evaluate(() =>
    (window.__viewport as Viewport).init({ render: { scale: 1 } }),
  ))
  expectAdapter(testInfo, adapterInfo)
  const explicitScale = await page.evaluate(() => {
    const v = window.__viewport as Viewport
    v.setViewportAndTick(10, 10, 3)
    return v.viewport()
  })
  expect(explicitScale).toEqual({ widthPx: 10, heightPx: 10, dpr: 3, renderScale: 1 })

  expectNoGpuErrors(await page.evaluate(() => (window.__viewport as Viewport).errors()))
})

test('viewport: clamped to limit', async ({ page }, testInfo) => {
  await openPage(page, '/viewport.html')
  const { adapterInfo } = await page.evaluate(() =>
    (window.__viewport as Viewport).init({ maxTextureDimension2D: 100 }),
  )
  expectAdapter(testInfo, adapterInfo)

  const clamped = await page.evaluate(() => {
    const v = window.__viewport as Viewport
    v.setViewportAndTick(1000, 1000, 1)
    return { viewport: v.viewport(), canvas: v.canvasSize() }
  })
  expect(clamped.viewport.widthPx).toBe(100)
  expect(clamped.viewport.heightPx).toBe(100)
  expect(clamped.canvas).toEqual({ width: 100, height: 100 })

  expectNoGpuErrors(await page.evaluate(() => (window.__viewport as Viewport).errors()))
})

test('lifecycle: hidden stops visible rebases', async ({ page }, testInfo) => {
  await openPage(page, '/viewport.html')
  const { adapterInfo } = await page.evaluate(() => (window.__viewport as Viewport).init())
  expectAdapter(testInfo, adapterInfo)

  // The very first `resume()` is an ordinary start, not a return from backgrounding: no rebase.
  const afterFirstResume = await page.evaluate(() => {
    const v = window.__viewport as Viewport
    v.setVisibility('visible')
    return { calls: v.requestFrameCalls(), rebase: v.rebaseFlagSet() }
  })
  expect(afterFirstResume.calls).toBe(1)
  expect(afterFirstResume.rebase).toBe(false)

  const afterHide = await page.evaluate(() => {
    const v = window.__viewport as Viewport
    v.setVisibility('hidden')
    v.frame(16) // nothing to run: `pause()` already cancelled the pending rAF callback
    return v.requestFrameCalls()
  })
  expect(afterHide).toBe(1) // unchanged: the rAF loop is stopped

  const afterShow = await page.evaluate(() => {
    const v = window.__viewport as Viewport
    v.setVisibility('visible')
    return { calls: v.requestFrameCalls(), rebase: v.rebaseFlagSet() }
  })
  expect(afterShow.calls).toBe(2) // rAF re-armed
  expect(afterShow.rebase).toBe(true) // 0018 §8: "tell the client worker to re-base interpolation"

  expectNoGpuErrors(await page.evaluate(() => (window.__viewport as Viewport).errors()))
})

// Not one of the brief's five named tests: evidence for the delegation prompt's own extra ask
// ("wire `ClientOptions.render.neighbourCutoffPx` ... through to `frameUniform`").
test('viewport: neighbourCutoffPx wired from ClientOptions.render', async ({ page }, testInfo) => {
  await openPage(page, '/viewport.html')
  let { adapterInfo } = await page.evaluate(() => (window.__viewport as Viewport).init())
  expectAdapter(testInfo, adapterInfo)
  expect(await page.evaluate(() => (window.__viewport as Viewport).neighbourCutoffPx())).toBe(0)

  ;({ adapterInfo } = await page.evaluate(() =>
    (window.__viewport as Viewport).init({ render: { neighbourCutoffPx: 4 } }),
  ))
  expectAdapter(testInfo, adapterInfo)
  expect(await page.evaluate(() => (window.__viewport as Viewport).neighbourCutoffPx())).toBe(4)

  expectNoGpuErrors(await page.evaluate(() => (window.__viewport as Viewport).errors()))
})
