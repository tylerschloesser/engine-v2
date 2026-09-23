// Uber-quad readback probes (docs/plan/17-drawlist-and-sprites.md Tests added): each test opens
// `drawables.html` once and hand-fills the DrawList header/body directly (`support/draw-scene.ts`),
// grouping several probes per page load (0020 §4: "group probes into one page load where that
// doesn't weaken what each test asserts"). Probes sit off-centre, at shape edges, or inside a ring's
// hole -- not at a texel/shape centre, where a wrong formula and a right one tend to agree (M09b's
// own inverted-sampling bug survived exactly that).
//
// Every scene here uses a 64x64 target, `tilesPerPx = 1/8` (8 device px/tile), camera centred at
// world tile (0, 0) with `windowOrigin`/`camTile` both `[0, 0]` and zero fractional offsets: a
// record's own `pos` is then its screen centre in tiles-from-viewport-centre, and 1 tile == 8px, so
// pixel = (32, 32) + pos*8 + local_offset. A size-4 shape (`uberquad.wgsl`'s own `dist = length(uv*2
// -1)`) is a circle of *pixel* radius 16 inscribed in a 32x32 px box (real pixel distance from centre
// is `dist * 16` isotropically, since the box is square and the scale factor is uniform).
import { expect, test } from '@playwright/test'
import {
  ANCHOR_CURSOR_TILE,
  SCREEN_PX_STROKE,
  SCREEN_PX_STROKE_WIDTH,
} from '../../src/render/drawables.ts'
import { expectPixel, type PixelBuffer } from '../../src/test/render.ts'
import { buildDrawListBytes, type DrawRecordSpec, microDrawCamera } from './support/draw-scene.ts'
import { expectAdapter, expectNoGpuErrors } from './support/gpu.ts'
import { openPage } from './support/page.ts'

const TOL = 2 // 0020 §6: "≤ 2/255 per channel"
const TRANSPARENT: readonly [number, number, number, number] = [0, 0, 0, 0]
const CAMERA = microDrawCamera({ viewportPxW: 64, viewportPxH: 64, tilesPerPx: 1 / 8 })

async function render(
  page: import('@playwright/test').Page,
  records: readonly DrawRecordSpec[],
  camera: ReturnType<typeof microDrawCamera> = CAMERA,
  size = 64,
): Promise<PixelBuffer> {
  const { header, body } = buildDrawListBytes(records)
  await page.evaluate(
    ([h, b, cam]) => {
      window.__drawables?.acquireFromBytes(h, b)
      window.__drawables?.writeFrameUniform(cam)
    },
    [header, body, camera] as const,
  )
  const result = await page.evaluate(([w, h]) => window.__drawables?.renderAndRead(w, h), [
    size,
    size,
  ] as const)
  if (!result) throw new Error('renderAndRead returned nothing')
  return { width: result.width, height: result.height, data: new Uint8Array(result.data) }
}

test('draw.circle_and_ring_probe', async ({ page }, testInfo) => {
  await openPage(page, '/drawables.html')
  const init = await page.evaluate(() => window.__drawables?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)

  const circle: DrawRecordSpec = {
    pos: [0, 0],
    size: [4, 4],
    kind: 1 /* KIND_CIRCLE */,
    layer: 0,
    color: [255, 0, 0, 255],
  }
  let pixels = await render(page, [circle])
  expectPixel(pixels, 32, 32, [255, 0, 0, 255], TOL) // centre
  expectPixel(pixels, 25, 25, [255, 0, 0, 255], TOL) // off-centre, still inside (dist ~9.9px < 16px)
  expectPixel(pixels, 10, 10, TRANSPARENT, TOL) // outside (dist ~31.1px > 16px)

  const ring: DrawRecordSpec = {
    pos: [0, 0],
    size: [4, 4],
    kind: 2 /* KIND_RING */,
    layer: 1,
    color: [0, 255, 0, 255],
  }
  pixels = await render(page, [circle, ring])
  // Ring's outer band (dist ~15px: inside outer radius 16px, outside the default 0.35-thick hole at
  // ~10.4px) draws over the red circle underneath.
  expectPixel(pixels, 32, 17, [0, 255, 0, 255], TOL)
  // Inside the ring's own hole (dist 6px < 10.4px): the red circle underneath shows through.
  expectPixel(pixels, 32, 26, [255, 0, 0, 255], TOL)
  // Outside both shapes entirely.
  expectPixel(pixels, 2, 2, TRANSPARENT, TOL)

  expectNoGpuErrors(await page.evaluate(() => window.__drawables?.errors() ?? []))
})

// Step 5 (docs/plan/17-drawlist-and-sprites.md Order of work): the cursor-anchored ghost. Both
// tests below `acquireFromBytes` exactly once, then call `writeFrameUniform`/`renderAndRead` twice
// with no second `acquireFromBytes` in between -- proving the two behaviours 0018 §2/Planning
// decisions promise happen entirely in the vertex shader, off whatever `writeFrameUniform` last
// wrote, with no dependency on a fresh DrawList publish. Both the vertex shader's cursor-anchor
// branch and the ghost kind's own fixed alpha landed already in step 4's single `uberquad.wgsl`
// (Deviations, "Steps 4/5 boundary"); this step's own work is these two tests plus their failability
// proofs.

test('draw.ghost_follows_cursor_same_frame', async ({ page }, testInfo) => {
  await openPage(page, '/drawables.html')
  const init = await page.evaluate(() => window.__drawables?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)

  // `pos: [0, 0]` is an offset from the cursor tile, not the window origin (`ANCHOR_CURSOR_TILE`).
  const ghost: DrawRecordSpec = {
    pos: [0, 0],
    size: [4, 4],
    kind: 6 /* KIND_GHOST */,
    layer: 0,
    flags: ANCHOR_CURSOR_TILE,
    color: [200, 100, 50, 255],
  }
  const { header, body } = buildDrawListBytes([ghost])
  await page.evaluate(([h, b]) => window.__drawables?.acquireFromBytes(h, b), [
    header,
    body,
  ] as const)

  // `KIND_GHOST`'s fixed alpha (0.5, `uberquad.wgsl`'s own `fs_main`) over a transparent-black clear,
  // straight (non-premultiplied) alpha blending: rgb halves, alpha halves -- [200,100,50,255] ->
  // [100,50,25,128] (127.5 rounds either way, TOL 2 covers it).
  const GHOST_BLENDED: readonly [number, number, number, number] = [100, 50, 25, 128]

  async function renderAtCursor(cursorTileX: number, cursorTileY: number): Promise<PixelBuffer> {
    const camera = microDrawCamera({
      viewportPxW: 64,
      viewportPxH: 64,
      tilesPerPx: 1 / 8,
      cursorTileX,
      cursorTileY,
      cursorValid: 1,
    })
    await page.evaluate((cam) => window.__drawables?.writeFrameUniform(cam), camera)
    const result = await page.evaluate(([w, h]) => window.__drawables?.renderAndRead(w, h), [
      64, 64,
    ] as const)
    if (!result) throw new Error('renderAndRead returned nothing')
    return { width: result.width, height: result.height, data: new Uint8Array(result.data) }
  }

  // px = (32, 32) + cursorTile * 8 (module doc comment's own formula, cursor tile in place of pos).
  let pixels = await renderAtCursor(3, 2)
  expectPixel(pixels, 56, 48, GHOST_BLENDED, TOL)
  expectPixel(pixels, 16, 40, TRANSPARENT, TOL) // not yet at the second cursor tile's spot

  // Same DrawList, no second `acquireFromBytes`: only the cursor tile moved, and the ghost must
  // move with it, off the live frame uniform alone.
  pixels = await renderAtCursor(-2, 1)
  expectPixel(pixels, 16, 40, GHOST_BLENDED, TOL)
  expectPixel(pixels, 56, 48, TRANSPARENT, TOL) // the first cursor tile's spot is empty now

  expectNoGpuErrors(await page.evaluate(() => window.__drawables?.errors() ?? []))
})

test('draw.one_frame_old_list_has_no_error', async ({ page }, testInfo) => {
  await openPage(page, '/drawables.html')
  const init = await page.evaluate(() => window.__drawables?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)

  // A plain world-anchored rect: `pos` is relative to `window_origin` (default [0, 0]), never to the
  // live camera (0018 §2).
  const rect: DrawRecordSpec = {
    pos: [0, 0],
    size: [4, 4],
    kind: 3 /* KIND_RECT */,
    layer: 0,
    color: [10, 20, 30, 255],
  }
  const { header, body } = buildDrawListBytes([rect])
  await page.evaluate(([h, b]) => window.__drawables?.acquireFromBytes(h, b), [
    header,
    body,
  ] as const)

  async function renderAtCamera(camTileX: number): Promise<PixelBuffer> {
    const camera = microDrawCamera({
      viewportPxW: 64,
      viewportPxH: 64,
      tilesPerPx: 1 / 8,
      camTileX,
    })
    await page.evaluate((cam) => window.__drawables?.writeFrameUniform(cam), camera)
    const result = await page.evaluate(([w, h]) => window.__drawables?.renderAndRead(w, h), [
      64, 64,
    ] as const)
    if (!result) throw new Error('renderAndRead returned nothing')
    return { width: result.width, height: result.height, data: new Uint8Array(result.data) }
  }

  // First frame's own camera (`cam_tile = [0, 0]`): the rect (32x32 px box) is centred at px (32, 32),
  // spanning [16, 48). Probe near its left edge (inside now, outside once the box shifts right) and
  // just past its right edge (outside now, inside once the box shifts right) -- the box is wide
  // enough that its own centre pixel stays covered either way, so the edges are what discriminates.
  let pixels = await renderAtCamera(0)
  expectPixel(pixels, 18, 32, [10, 20, 30, 255], TOL)
  expectPixel(pixels, 50, 32, TRANSPARENT, TOL)

  // The camera moves (a real one-frame-old-list situation, 0018 §2's own "applied ... without
  // error") with *no* second `acquireFromBytes`: `world_rel = (window_origin - cam_tile) - cam_frac
  // + pos`, so moving `cam_tile` left by one tile shifts the box one tile (8px) right, to [24, 56),
  // tracking the new camera correctly rather than staying stuck or erroring.
  pixels = await renderAtCamera(-1)
  expectPixel(pixels, 50, 32, [10, 20, 30, 255], TOL)
  expectPixel(pixels, 18, 32, TRANSPARENT, TOL)

  expectNoGpuErrors(await page.evaluate(() => window.__drawables?.errors() ?? []))
})

test('draw.rect_bar_radial_probe', async ({ page }, testInfo) => {
  await openPage(page, '/drawables.html')
  const init = await page.evaluate(() => window.__drawables?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)

  // Rect: fills its whole box, no SDF -- one probe near a corner is enough to prove it isn't
  // circle-clipped.
  let pixels = await render(page, [
    { pos: [0, 0], size: [4, 4], kind: 3 /* KIND_RECT */, layer: 0, color: [10, 20, 30, 255] },
  ])
  expectPixel(pixels, 17, 17, [10, 20, 30, 255], TOL) // near a corner (dist ~21px, outside a circle)
  expectPixel(pixels, 5, 5, TRANSPARENT, TOL) // outside the 32x32 px box entirely

  // Bar: filled from uv.x = 0 up to `param`, off-centre x probes (not the box's own midline) so a
  // reversed or off-by-one fill formula would disagree.
  for (const param of [0, 0.5, 1]) {
    pixels = await render(page, [
      {
        pos: [0, 0],
        size: [4, 4],
        kind: 4 /* KIND_BAR */,
        layer: 0,
        color: [0, 200, 0, 255],
        param,
      },
    ])
    // uv.x = 0.25 (px 24, 8px left of the box centre 32): filled once param >= 0.25.
    expectPixel(pixels, 24, 32, param >= 0.25 ? [0, 200, 0, 255] : TRANSPARENT, TOL)
    // uv.x = 0.75 (px 40, 8px right of centre): filled once param >= 0.75.
    expectPixel(pixels, 40, 32, param >= 0.75 ? [0, 200, 0, 255] : TRANSPARENT, TOL)
  }

  // Radial: filled disk swept clockwise from the top (12 o'clock) up to `param` of a full turn.
  // Probe at 3 o'clock (a quarter turn, param 0.25) and 9 o'clock (three-quarter turn, param 0.75) --
  // off the cardinal top/bottom points a sign error in `atan2`'s argument order would still pass.
  for (const param of [0, 0.5, 1]) {
    pixels = await render(page, [
      {
        pos: [0, 0],
        size: [4, 4],
        kind: 5 /* KIND_RADIAL */,
        layer: 0,
        color: [200, 0, 200, 255],
        param,
      },
    ])
    // 3 o'clock, inside the radius (dist ~11px < 16px): swept once param >= 0.25.
    expectPixel(pixels, 43, 32, param >= 0.25 ? [200, 0, 200, 255] : TRANSPARENT, TOL)
    // 9 o'clock: swept once param >= 0.75.
    expectPixel(pixels, 21, 32, param >= 0.75 ? [200, 0, 200, 255] : TRANSPARENT, TOL)
  }

  expectNoGpuErrors(await page.evaluate(() => window.__drawables?.errors() ?? []))
})

test('draw.layers_order', async ({ page }, testInfo) => {
  await openPage(page, '/drawables.html')
  const init = await page.evaluate(() => window.__drawables?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)

  // Higher layer wins the pixel: two fully-overlapping rects, layer 0 red drawn first, layer 7 blue
  // drawn last (the counting sort's own ascending-layer order) -- blue must win regardless of which
  // was pushed to the scratch list first.
  let pixels = await render(page, [
    { pos: [0, 0], size: [4, 4], kind: 3, layer: 7, color: [0, 0, 255, 255] },
    { pos: [0, 0], size: [4, 4], kind: 3, layer: 0, color: [255, 0, 0, 255] },
  ])
  expectPixel(pixels, 32, 32, [0, 0, 255, 255], TOL)

  // Within one layer, records keep their own push (stable-sort) order -- the *last*-pushed record
  // of a layer is the last instance the GPU draws for it, so it wins an overlap over an
  // earlier-pushed record of the *same* layer (no depth test, 0018 §2): red pushed first, green
  // pushed second, same layer, fully overlapping -- green must win.
  pixels = await render(page, [
    { pos: [0, 0], size: [4, 4], kind: 3, layer: 2, color: [255, 0, 0, 255] },
    { pos: [0, 0], size: [4, 4], kind: 3, layer: 2, color: [0, 255, 0, 255] },
  ])
  expectPixel(pixels, 32, 32, [0, 255, 0, 255], TOL)

  expectNoGpuErrors(await page.evaluate(() => window.__drawables?.errors() ?? []))
})

test('draw.screen_px_stroke_constant_under_zoom', async ({ page }, testInfo) => {
  await openPage(page, '/drawables.html')
  const init = await page.evaluate(() => window.__drawables?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)

  const ring: DrawRecordSpec = {
    pos: [0, 0],
    size: [4, 4],
    kind: 2 /* KIND_RING */,
    layer: 0,
    flags: SCREEN_PX_STROKE,
    color: [0, 200, 255, 255],
  }
  expect(SCREEN_PX_STROKE_WIDTH).toBe(6)

  // Zoomed out: 8 px/tile, outer radius 16px, so the band spans real pixel distance [10, 16] from
  // centre (`SCREEN_PX_STROKE_WIDTH` thick, independent of the ring's own world size).
  let camera = microDrawCamera({ viewportPxW: 128, viewportPxH: 128, tilesPerPx: 1 / 8 })
  let pixels = await render(page, [ring], camera, 128)
  expectPixel(pixels, 64, 51, [0, 200, 255, 255], TOL) // d=13: the band's own middle
  // d=8: 2px inside the inner edge (10) -- the diagnostic probe (Probe placement: a naive
  // UV-scaled thickness, which would scale with `R`, puts colour much further out than a
  // screen-px-constant one at the *larger* `R` used below, so this probe alone cannot distinguish
  // the two; the matching probe on the zoomed-in case, below, is what does).
  expectPixel(pixels, 64, 56, TRANSPARENT, TOL)
  expectPixel(pixels, 64, 44, TRANSPARENT, TOL) // d=20: outside the outer edge

  // Zoomed in: 16 px/tile, outer radius 32px, band [26, 32]. If the ring's stroke scaled with world
  // size instead of staying screen-px-constant, the band here would be roughly twice as thick (~12px,
  // i.e. [20, 32]) and the same "d=24" diagnostic probe below would incorrectly read the ring's
  // colour.
  camera = microDrawCamera({ viewportPxW: 128, viewportPxH: 128, tilesPerPx: 1 / 16 })
  pixels = await render(page, [ring], camera, 128)
  expectPixel(pixels, 64, 35, [0, 200, 255, 255], TOL) // d=29: the band's own middle
  expectPixel(pixels, 64, 40, TRANSPARENT, TOL) // d=24: the discriminating probe
  expectPixel(pixels, 64, 28, TRANSPARENT, TOL) // d=36: outside the outer edge

  expectNoGpuErrors(await page.evaluate(() => window.__drawables?.errors() ?? []))
})
