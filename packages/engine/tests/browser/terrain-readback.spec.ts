// Terrain readback: steps 2-4 of docs/plan/09-renderer-terrain.md ("Order of work"). Scenes hand-fill
// the page/indirection textures directly through `window.__terrain` (no worker, no ABI instance --
// the real ring-driven data path is step 5's; Deviations records exactly which tests here would need
// to be re-pointed at it). Every scene uses `tilesPerPx: 1` and places the camera so pixel index
// equals tile index (`camTileX/Y === viewportPx.../2`), so expected pixel positions need no
// `tileCentrePx` maths beyond what's spelled out inline.
import { expect, test } from '@playwright/test'
import type { FrameUniformValues } from '../../src/render/terrain.ts'
import { expectPixel, type PixelBuffer } from '../../src/test/render.ts'
import { expectAdapter, expectNoGpuErrors } from './support/gpu.ts'
import { openPage } from './support/page.ts'

const GRASS: readonly [number, number, number, number] = [34, 139, 34, 255]
const WATER: readonly [number, number, number, number] = [30, 80, 200, 255]
const ORE: readonly [number, number, number, number] = [230, 140, 20, 255]
const NEUTRAL: readonly [number, number, number, number] = [32, 32, 32, 255]
const TOL = 2 // 0020 §6: "≤ 2/255 per channel"

const VISUAL_GRASS = 1
const VISUAL_WATER = 2
const VISUAL_ORE = 5
const CHUNK_TEXELS = 32 * 32

/** Flat `[base0, resource0, base1, resource1, ...]` for one chunk, every tile `base`/`resource: 0`. */
function flatChunk(base: number): number[] {
  const out: number[] = new Array(CHUNK_TEXELS * 2)
  for (let i = 0; i < CHUNK_TEXELS; i++) {
    out[i * 2] = base
    out[i * 2 + 1] = 0
  }
  return out
}

type Terrain = NonNullable<Window['__terrain']>

/** The border/resource probe scene shared by `probe_tile_colours`, `far_from_origin_exact` and
 * `device.view_probe_both_paths`: chunk (0, 0) is grass (with one ore tile at local index 5),
 * chunk (1, 0) is water. Both are staged in ring-1's own toroidal indirection cell. */
async function stageBorderScene(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const t = window.__terrain as Terrain
    await t.loadArt('/terrain/tiles.json')
  })
  await page.evaluate(
    ([grassChunk, waterChunk, grassVisual, oreVisual]) => {
      const t = window.__terrain as Terrain
      t.writePageChunk(0, grassChunk)
      t.writePageChunk(1, waterChunk)
      t.writePageTexel(0, 5, grassVisual, oreVisual) // local tile (5, 0) of chunk 0: grass base, ore resource
      t.writeIndir([
        { x: 0, y: 0, value: 0 }, // chunk (0, 0) -> slot 0
        { x: 1, y: 0, value: 1 }, // chunk (1, 0) -> slot 1
      ])
    },
    [flatChunk(VISUAL_GRASS), flatChunk(VISUAL_WATER), VISUAL_GRASS, VISUAL_ORE] as const,
  )
}

/** Pixel index === tile index on both axes (Camera comment above): `viewportPxW`x16,
 * `tilesPerPx: 1`, `camTileX = viewportPxW / 2`, `camTileY = 8`. */
function borderCamera(viewportPxW: number, camTileX: number, camTileY: number): FrameUniformValues {
  return {
    camTileX,
    camTileY,
    camFracX: 0,
    camFracY: 0,
    viewportPxW,
    viewportPxH: 16,
    tilesPerPx: 1,
    seed: 0,
    cursorTileX: 0,
    cursorTileY: 0,
    cursorValid: 0,
    neighbourCutoffPx: 0,
  }
}

async function renderBorderScene(
  page: import('@playwright/test').Page,
  camera: FrameUniformValues,
): Promise<PixelBuffer> {
  const raw = await page.evaluate(async (cam) => {
    const t = window.__terrain as Terrain
    t.writeFrameUniform(cam)
    return t.renderAndRead(cam.viewportPxW, cam.viewportPxH)
  }, camera)
  return { width: raw.width, height: raw.height, data: Uint8Array.from(raw.data) }
}

test('device: view probe both paths', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')

  // Forced `false`: always calls `createView()`.
  const noProbe = await page.evaluate(() => window.__terrain?.init({ forceViewProbe: false }))
  expectAdapter(testInfo, noProbe?.adapterInfo ?? null)
  expect(noProbe?.viewProbePasses).toBe(false)
  await stageBorderScene(page)
  const camera = borderCamera(64, 32, 8)
  const noProbePixels = await renderBorderScene(page, camera)
  expectPixel(noProbePixels, 31, 0, GRASS, TOL)
  expectPixel(noProbePixels, 32, 0, WATER, TOL)
  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))

  // A fresh page, forced `true`: skips `createView()`, same scene, same pixels.
  await openPage(page, '/terrain.html')
  const forced = await page.evaluate(() => window.__terrain?.init({ forceViewProbe: true }))
  expect(forced?.viewProbePasses).toBe(true)
  await stageBorderScene(page)
  const forcedPixels = await renderBorderScene(page, camera)
  expectPixel(forcedPixels, 31, 0, GRASS, TOL)
  expectPixel(forcedPixels, 32, 0, WATER, TOL)
  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))

  // The real, unforced probe result, recorded beside `adapter.info` (0018 §1).
  await openPage(page, '/terrain.html')
  const real = await page.evaluate(() => window.__terrain?.init())
  testInfo.annotations.push({
    type: 'view-probe.unforced',
    description: String(real?.viewProbePasses),
  })
})

test('terrain: probe tile colours', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)

  await stageBorderScene(page)
  const camera = borderCamera(64, 32, 8)
  const pixels = await renderBorderScene(page, camera)

  // Both sides of the chunk (0,0)/(1,0) border (tile 31 vs tile 32).
  expectPixel(pixels, 31, 0, GRASS, TOL)
  expectPixel(pixels, 32, 0, WATER, TOL)
  // A resource tile (local index 5 of chunk 0) shows the resource's colour, not the base's.
  expectPixel(pixels, 5, 0, ORE, TOL)
  // A plain grass tile elsewhere in chunk 0.
  expectPixel(pixels, 10, 0, GRASS, TOL)

  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))
})

test('terrain: nonresident is neutral', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await page.evaluate(async () => {
    await (window.__terrain as Terrain).loadArt('/terrain/tiles.json')
  })
  // No `writePageChunk`/`writeIndir` at all: every toroidal cell stays `INDIR_NONE` from init.
  const camera = borderCamera(64, 32, 8)
  const pixels = await renderBorderScene(page, camera)
  expectPixel(pixels, 0, 0, NEUTRAL, TOL)
  expectPixel(pixels, 31, 0, NEUTRAL, TOL)
  expectPixel(pixels, 63, 0, NEUTRAL, TOL)
  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))
})

test('terrain: far from origin exact', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await stageBorderScene(page)

  const nearOrigin = await renderBorderScene(page, borderCamera(64, 32, 8))
  // Shift the camera tile by exactly 2^23 on both axes: chunk shifts by exactly 2^18 (2^23 / 32),
  // and 2^18 is a multiple of 64, so the toroidal indirection window addresses the very same cells
  // (docs/plan/09-renderer-terrain.md Deviations, `terrain.wgsl`'s own `wrap_mask` comment).
  const shift = 1 << 23
  const farOrigin = await renderBorderScene(page, borderCamera(64, 32 + shift, 8 + shift))

  expect(farOrigin.data).toEqual(nearOrigin.data)
  expectPixel(farOrigin, 31, 0, GRASS, TOL)
  expectPixel(farOrigin, 32, 0, WATER, TOL)
  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))
})

test('terrain: nothing outside viewport', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await page.evaluate(async (grassChunk) => {
    const t = window.__terrain as Terrain
    await t.loadArt('/terrain/tiles.json')
    t.writePageChunk(0, grassChunk)
    t.writeIndir([{ x: 0, y: 0, value: 0 }]) // only chunk (0, 0) is resident
  }, flatChunk(VISUAL_GRASS))

  // 64x64, camera tile (16, 16): visible tiles range roughly [-16, 47] on both axes, so only the
  // middle third of the frame falls inside the one resident chunk (tiles [0, 31]); every corner is
  // outside it (docs/plan/09-renderer-terrain.md Deviations: this milestone's own reading of
  // "nothing outside viewport" -- nothing beyond the resident chunk's footprint shows anything but
  // the neutral colour).
  const camera: FrameUniformValues = {
    camTileX: 16,
    camTileY: 16,
    camFracX: 0,
    camFracY: 0,
    viewportPxW: 64,
    viewportPxH: 64,
    tilesPerPx: 1,
    seed: 0,
    cursorTileX: 0,
    cursorTileY: 0,
    cursorValid: 0,
    neighbourCutoffPx: 0,
  }
  const raw = await page.evaluate(async (cam) => {
    const t = window.__terrain as Terrain
    t.writeFrameUniform(cam)
    return t.renderAndRead(cam.viewportPxW, cam.viewportPxH)
  }, camera)
  const pixels: PixelBuffer = {
    width: raw.width,
    height: raw.height,
    data: Uint8Array.from(raw.data),
  }

  expectPixel(pixels, 0, 0, NEUTRAL, TOL) // top-left corner: chunk (-1, -1)
  expectPixel(pixels, 63, 0, NEUTRAL, TOL) // top-right corner: chunk (1, -1)
  expectPixel(pixels, 0, 63, NEUTRAL, TOL) // bottom-left corner: chunk (-1, 1)
  expectPixel(pixels, 63, 63, NEUTRAL, TOL) // bottom-right corner: chunk (1, 1)
  expectPixel(pixels, 32, 32, GRASS, TOL) // centre: inside chunk (0, 0)
  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))
})
