// `prediction-no-flicker` (docs/plan/26-prediction-rendering-and-clocks.md, Tests added): a real,
// connected `fx-predict` client (`predict.html`, `predict.ts`) dispatches `Paint` at a plain tile
// well outside the world's water/resource patches. Stepped frames (`__predictAdvance`, `stepTick`
// under the hood), never a wall-clock wait (must-knows). The property this pins is 0012's own "no
// snapping": once the semantic pixel probe at the anchor tile's centre leaves the pristine colour
// it held at dispatch, it must never read that colour again, all the way past the host's own ack
// (`Deviations` below records the measured number of stepped frames before the probe first
// changes, and the transient value it reads on the way -- not itself a regression, since it never
// goes back to pristine, but recorded so a later milestone can decide whether to tighten it).
import { expect, test } from '@playwright/test'
import type { FrameUniformValues } from '../../src/render/terrain.ts'
import type { PixelBuffer } from '../../src/test/render.ts'
import { expectAdapter, expectNoGpuErrors } from './support/gpu.ts'
import { openPage } from './support/page.ts'

declare global {
  interface Window {
    __predictInit?: () => Promise<{ adapterInfo: unknown }>
    /** `fx_predict::Action::Paint { tile, base }` (docs/plan/26-...md step 3): JSON-encodes and
     * dispatches through the real, production `Client.dispatch` -- never a test backdoor. */
    __predictDispatchPaint?: (x: number, y: number, base: number) => number
    /** Moves the client's own camera *state* (never sent until the next `__predictAdvance`'s own
     * `stepFrame`, `connected-terrain.ts`'s own precedent), so the host's subscription covers the
     * anchor tile this test probes. */
    __predictSetCamera?: (x: number, y: number, tilesAcross: number) => void
    /** One `resumeWorkers` + `stepFrame` + `stepTick(n)` + a full upload-ring drain
     * (`connected-terrain.ts`'s own `__advance`, same "drain to empty, deterministically"
     * reasoning) -- no camera parameters: every probe here writes the frame uniform directly. */
    __predictAdvance?: (ticks: number) => Promise<void>
    __predictWriteFrameUniform?: (v: FrameUniformValues) => void
    __predictRenderAndRead?: (
      width: number,
      height: number,
    ) => Promise<{ width: number; height: number; data: number[] }>
    __predictClock?: () => {
      authoritative: number
      predicted: number
      ticksPerSecond: number
      tickFraction: number
    }
    __predictErrors?: () => string[]
  }
}

// `scripts/gen-terrain-art.mjs`'s own `CELLS` comment: "cell 0: black -- visual 0, the 'nothing
// drawn here' sentinel colour" (a shared *test-asset* convention, not an engine sentinel --
// `Tile::VOID` is base `0xff`). `fx_predict::GRASS_BASE` is `0`, so this fixture's own pristine
// terrain renders as that cell's colour here, not the green "grass" cell other fixtures' own
// base-1 pristine tiles get (`connected-terrain.spec.ts`).
const PRISTINE: readonly [number, number, number, number] = [0, 0, 0, 255] // visual 0
const PAINTED: readonly [number, number, number, number] = [30, 80, 200, 255] // visual 2
const TOL = 2 // 0020 §6: "≤ 2/255 per channel"

// Well outside `PredictWorldgen`'s water (`x <= -3`) and resource patch (`8..12 x 8..12`): plain
// grass, no resource layer, so the pristine and painted colours are each exactly one solid visual
// with nothing else blended in.
const ANCHOR_X = 0
const ANCHOR_Y = 0
const PAINT_BASE = 2

function anchorCamera(viewportPx: number): FrameUniformValues {
  return {
    camTileX: ANCHOR_X,
    camTileY: ANCHOR_Y,
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

async function readAnchorPixel(page: import('@playwright/test').Page): Promise<PixelBuffer> {
  const camera = anchorCamera(16)
  await page.evaluate((cam) => window.__predictWriteFrameUniform?.(cam), camera)
  const raw = await page.evaluate(([w, h]) => window.__predictRenderAndRead?.(w, h), [
    16, 16,
  ] as const)
  return {
    width: raw?.width ?? 0,
    height: raw?.height ?? 0,
    data: Uint8Array.from(raw?.data ?? []),
  }
}

/** The one pixel this whole file ever probes: `(8, 8)` of a 16x16 target centred on the anchor
 * tile (`anchorCamera`'s own `tilesPerPx: 1`). */
function anchorTexel(pixel: PixelBuffer): [number, number, number, number] {
  const i = (8 * pixel.width + 8) * 4
  return [
    pixel.data[i] ?? 0,
    pixel.data[i + 1] ?? 0,
    pixel.data[i + 2] ?? 0,
    pixel.data[i + 3] ?? 0,
  ]
}

function matches(got: readonly number[], want: readonly [number, number, number, number]): boolean {
  return want.every((w, c) => Math.abs((got[c] ?? 0) - w) <= TOL)
}

test('prediction-no-flicker', async ({ page }, testInfo) => {
  await openPage(page, '/predict.html')
  const adapterInfo = await page.evaluate(() => window.__predictInit?.().then((r) => r.adapterInfo))
  expectAdapter(testInfo, adapterInfo as Parameters<typeof expectAdapter>[1])

  await page.evaluate(([x, y, tilesAcross]) => window.__predictSetCamera?.(x, y, tilesAcross), [
    ANCHOR_X,
    ANCHOR_Y,
    8,
  ] as const)
  // Warm-up: subscribe the anchor tile's chunk and let its pristine generation round trip land
  // (`connected-terrain.spec.ts`'s own `pumpFrames`-shaped reasoning) -- no action dispatched yet.
  for (let i = 0; i < 6; i++) {
    await page.evaluate((n) => window.__predictAdvance?.(n), 0)
  }
  const beforeDispatch = anchorTexel(await readAnchorPixel(page))
  expect(matches(beforeDispatch, PRISTINE), `pristine anchor pixel was ${beforeDispatch}`).toBe(
    true,
  )

  // Dispatch, then step one frame at a time (must-knows: stepped, never a wall-clock wait),
  // reading the probe every step from the very first one after dispatch through several steps
  // past the host's own ack (this harness's own round trip is a handful of ticks at most, 0010).
  await page.evaluate(([x, y, base]) => window.__predictDispatchPaint?.(x, y, base), [
    ANCHOR_X,
    ANCHOR_Y,
    PAINT_BASE,
  ] as const)
  const seen: Array<[number, number, number, number]> = []
  for (let step = 0; step < 8; step++) {
    await page.evaluate((n) => window.__predictAdvance?.(n), 1)
    seen.push(anchorTexel(await readAnchorPixel(page)))
  }

  const firstChanged = seen.findIndex((px) => !matches(px, PRISTINE))
  expect(
    firstChanged,
    `never left the pristine colour across ${seen.length} steps: ${JSON.stringify(seen)}`,
  ).toBeGreaterThanOrEqual(0)
  // The property 0012 "Correction without snapping" actually promises: once the probe has left
  // the colour it held at dispatch, it never reads that colour again -- no flicker back, all the
  // way past the ack.
  for (let step = firstChanged; step < seen.length; step++) {
    expect(
      matches(seen[step] as [number, number, number, number], PRISTINE),
      `flickered back to pristine at step ${step}: ${JSON.stringify(seen)}`,
    ).toBe(false)
  }
  // And it actually converges on the painted colour (not stuck on some other transient forever).
  expect(
    matches(seen[seen.length - 1] as [number, number, number, number], PAINTED),
    `never converged on the painted colour: ${JSON.stringify(seen)}`,
  ).toBe(true)

  // `client.clock().predicted - authoritative` is a real, positive, stable lead (Provides:
  // "`client.clock().predicted` differs from `.authoritative` from this milestone on").
  const clock = await page.evaluate(() => window.__predictClock?.())
  expect(clock).toBeDefined()
  const lead = (clock?.predicted ?? 0) - (clock?.authoritative ?? 0)
  expect(lead).toBeGreaterThanOrEqual(1)
  expect(lead).toBeLessThanOrEqual(40) // LeadEstimator's own clamp

  expectNoGpuErrors((await page.evaluate(() => window.__predictErrors?.())) ?? [])
})
