// Canvas-presentation smoke test, extended to assert production phase order (docs/plan/
// 09b-terrain-art-and-lifecycle.md, step 6; docs/decisions/0020-testing-strategy.md §6 layer c).
// Both tests drive `device.html` (step 7): the one page in this suite that runs the *production*
// `createFrameLoop`/`createRealFrameLoop` against a real canvas, a real `Client`/`TerrainRenderer`
// and a real `Scheduler`-driven `requestAnimationFrame` -- not the manual clock every other
// real-client page here uses (0020 §3's "browser tests never use real rAF pacing" is about lockstep
// determinism tests; this page exists specifically to measure real frame pacing, so it is the one
// deliberate exception). A handful of real frames (tens of milliseconds of real wall-clock time) is
// all either test needs, so this stays well inside the browser suite's own budget.
import { expect, test } from '@playwright/test'
import { FRAME_PHASES } from '../../src/frame-loop.ts'
import { expectAdapter, expectNoGpuErrors } from './support/gpu.ts'
import { openPage } from './support/page.ts'

type Device = NonNullable<Window['__device']>

test('canvas: presents', async ({ page }, testInfo) => {
  await openPage(page, '/device.html?tiles=8')
  const adapterInfo = await page.evaluate(() => (window.__device as Device).adapterInfo())
  expectAdapter(testInfo, adapterInfo)

  await page.waitForFunction(() => (window.__device as Device).framesRendered() >= 1)

  expectNoGpuErrors(await page.evaluate(() => (window.__device as Device).errors()))
})

test('frame-loop: production runs phases in order', async ({ page }, testInfo) => {
  await openPage(page, '/device.html?tiles=8')
  const adapterInfo = await page.evaluate(() => (window.__device as Device).adapterInfo())
  expectAdapter(testInfo, adapterInfo)

  // A few whole ticks, not just one: proves the order holds end to end across the real rAF loop,
  // not only on its first callback.
  await page.waitForFunction(() => (window.__device as Device).framesRendered() >= 3)
  const log = await page.evaluate(() => (window.__device as Device).phaseLog())

  expect(log.length).toBeGreaterThanOrEqual(FRAME_PHASES.length)
  expect(log.length % FRAME_PHASES.length).toBe(0)
  for (let i = 0; i < log.length; i += FRAME_PHASES.length) {
    expect(log.slice(i, i + FRAME_PHASES.length)).toEqual(FRAME_PHASES)
  }

  expectNoGpuErrors(await page.evaluate(() => (window.__device as Device).errors()))
})
