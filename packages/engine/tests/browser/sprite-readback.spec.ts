// Sprite readback probes (docs/plan/17b-sprites-and-frame-budget.md Tests added), the sprite-kind
// twin of `draw-readback.spec.ts` (M17): `drawables.html`'s hand-filled scene, now with
// `window.__drawables.loadSprites()` fetching the real fixture atlas (`scripts/gen-sprite-art.mjs`'s
// own output, `/drawables/sprites.json`). Every probe sits off a texel centre and off a quadrant
// boundary by several device pixels, never exactly on one -- `docs/plan/
// 09b-terrain-art-and-lifecycle.md` Deviations: "every probe in the suite sat exactly at a texel
// centre" is exactly what let the M09b magnified-sampling inversion ship unnoticed.
import { expect, test } from '@playwright/test'
import { expectPixel, type PixelBuffer } from '../../src/test/render.ts'
import { buildDrawListBytes, type DrawRecordSpec, microDrawCamera } from './support/draw-scene.ts'
import { expectAdapter, expectNoGpuErrors } from './support/gpu.ts'
import { openPage } from './support/page.ts'
import { seamSnap } from './support/terrain-hash-ref.ts'

const TOL = 2 // 0020 §6: "≤ 2/255 per channel"
const KIND_SPRITE = 0
const FLIP_X = 1 << 3

// `scripts/gen-sprite-art.mjs`'s own fixture ids. Sprite id 2 ("bleed") has no constant here: `sprite
// .no_bleed_at_mip1` reads the atlas's own mip 1 texture directly (`readAtlasMip1`), never drawing a
// record that names it.
const SPRITE_QUAD = 0
const SPRITE_STRIP = 1

const RED: readonly [number, number, number, number] = [255, 0, 0, 255]
const GREEN: readonly [number, number, number, number] = [0, 255, 0, 255]
const BLUE: readonly [number, number, number, number] = [0, 0, 255, 255]
const YELLOW: readonly [number, number, number, number] = [255, 255, 0, 255]
const WHITE: readonly [number, number, number, number] = [255, 255, 255, 255]

async function initWithSprites(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
): Promise<void> {
  await openPage(page, '/drawables.html')
  const init = await page.evaluate(() => window.__drawables?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await page.evaluate(() => window.__drawables?.loadSprites())
}

async function render(
  page: import('@playwright/test').Page,
  records: readonly DrawRecordSpec[],
  camera: ReturnType<typeof microDrawCamera>,
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

// 64x64 target, `tilesPerPx = 1/8` (8 device px/tile) -- the same micro-camera every `draw-
// readback.spec.ts` probe uses, so a sprite drawn at `pos: [0, 0]` sits centred on pixel (32, 32).
const CAMERA = microDrawCamera({ viewportPxW: 64, viewportPxH: 64, tilesPerPx: 1 / 8 })

test('sprite.pivot_and_size_probe', async ({ page }, testInfo) => {
  await initWithSprites(page, testInfo)

  // "quad" (id 0): pivot [0.25, 0.75], size [2, 1] tiles -- an off-centre pivot on both axes and a
  // non-square size, so a swapped w/h or an unapplied pivot each move the quadrant boundaries off
  // where this test looks. Geometry: world x spans [-0.5, 1.5] tiles (px [28, 44)), world y spans
  // [-0.75, 0.25] tiles (px [26, 34)); the quadrant boundary sits at px x=36, y=30 (worked from
  // `uberquad.wgsl`'s own `quad_tiles = (uv - pivot) * size` at uv 0.5). Every probe below sits
  // several device pixels off both boundary lines.
  const quad: DrawRecordSpec = {
    pos: [0, 0],
    size: [0, 0], // ignored for a sprite kind -- geometry comes from the sprite's own manifest size
    kind: KIND_SPRITE,
    spriteId: SPRITE_QUAD,
    layer: 0,
    color: WHITE,
  }
  const pixels = await render(page, [quad], CAMERA)
  expectPixel(pixels, 30, 28, RED, TOL) // top-left quadrant
  expectPixel(pixels, 40, 28, GREEN, TOL) // top-right
  expectPixel(pixels, 30, 32, BLUE, TOL) // bottom-left
  expectPixel(pixels, 40, 32, YELLOW, TOL) // bottom-right
  expectPixel(pixels, 10, 10, [0, 0, 0, 0], TOL) // well outside the sprite's own box

  expectNoGpuErrors(await page.evaluate(() => window.__drawables?.errors() ?? []))
})

// Fix round 1 (coordinator review): the binding rule requires proving that anchoring the sprite
// magnified formula on `floor(texel)` instead of `floor(texel + 0.5)` fails a probe placed at a
// *fractional* offset, mirroring `terrain.seam_matches_reference`'s own approach -- none of the
// probes above exercise this (they all land, once seamed, on a texel comfortably inside its own
// quadrant, which every candidate anchor choice agrees on once `offset = texel - anchor` cancels the
// anchor point algebraically; only a probe whose seamed position crosses close enough to a real
// quadrant boundary tells the two anchor choices apart, the same way M09b's own bug was invisible to
// probes at fractional-but-not-boundary-crossing positions). This test's own probe was found by a
// small offline search (not committed) over camera/pixel combinations for the "quad" sprite, scoring
// each by how far its seamed texel position sits off a texel centre (checked) and how close to the
// real quadrant boundary (close, but not past it) -- `docs/plan/17b-sprites-and-frame-budget.md`
// Deviations "Fix round 1" records the exact search and the algebraic finding that a plain anchor
// swap alone (without also decoupling the offset from the anchor, as the real M09b bug did) cancels
// out in the *centre* of a saturating region, so a probe close to the boundary is required to expose
// it at all in this formula's own shape.
test('sprite.seam_matches_reference', async ({ page }, testInfo) => {
  await initWithSprites(page, testInfo)

  // "quad" (id 0), `pos: [0, 0]`, `tilesPerPx = 1/24`: `scale.x = rect.w(8) * tilesPerPx / size.x(2)
  // = 1/6`, `scale.y = rect.h(8) * tilesPerPx / size.y(1) = 1/3` (both < 1: the magnified/fat-pixel
  // branch, `lod <= 0`). Pixel (41, 21) on a 64x64 target: `raw_uv = (43/96, 5/16)`, exactly (worked
  // in exact fractions, not floats, to rule out rounding). `seamSnap` (the same reference `terrain.
  // seam_matches_reference` uses -- this sprite kind's own fat-pixel formula is structurally
  // identical, redone per-axis) predicts the seamed position lands at texel `(3.5, 2.5)`: solidly
  // inside the top-left (red) quadrant, 0.5 texels off the x=4 quadrant boundary and comfortably off
  // both axes' own texel centres.
  const TILES_PER_PX = 1 / 24
  const RECT_W = 8
  const RECT_H = 8
  const SIZE_W = 2
  const SIZE_H = 1
  const scaleX = (RECT_W * TILES_PER_PX) / SIZE_W
  const scaleY = (RECT_H * TILES_PER_PX) / SIZE_H
  const rawU = 43 / 96
  const rawV = 5 / 16
  const seamedU = seamSnap(rawU, RECT_W, scaleX)
  const seamedV = seamSnap(rawV, RECT_H, scaleY)
  expect(seamedU * RECT_W).toBeCloseTo(3.5, 9)
  expect(seamedV * RECT_H).toBeCloseTo(2.5, 9)

  const camera = microDrawCamera({ viewportPxW: 64, viewportPxH: 64, tilesPerPx: TILES_PER_PX })
  const quad: DrawRecordSpec = {
    pos: [0, 0],
    size: [0, 0],
    kind: KIND_SPRITE,
    spriteId: SPRITE_QUAD,
    layer: 0,
    color: WHITE,
  }
  const pixels = await render(page, [quad], camera)
  expectPixel(pixels, 41, 21, RED, TOL)

  expectNoGpuErrors(await page.evaluate(() => window.__drawables?.errors() ?? []))
})

test('sprite.flip_x', async ({ page }, testInfo) => {
  await initWithSprites(page, testInfo)

  // Same "quad" sprite, `FLIP_X` set: the geometry footprint (and so the pivot/size math above) is
  // unaffected -- only the *sampled* texture mirrors in place, so the same four probe pixels now
  // read the opposite quadrant's colour (proves flip acts on sampling, not on the world position the
  // pivot placed).
  const quad: DrawRecordSpec = {
    pos: [0, 0],
    size: [0, 0],
    kind: KIND_SPRITE,
    spriteId: SPRITE_QUAD,
    layer: 0,
    flags: FLIP_X,
    color: WHITE,
  }
  const pixels = await render(page, [quad], CAMERA)
  expectPixel(pixels, 30, 28, GREEN, TOL) // was red unflipped
  expectPixel(pixels, 40, 28, RED, TOL) // was green unflipped
  expectPixel(pixels, 30, 32, YELLOW, TOL) // was blue unflipped
  expectPixel(pixels, 40, 32, BLUE, TOL) // was yellow unflipped

  expectNoGpuErrors(await page.evaluate(() => window.__drawables?.errors() ?? []))
})

test('sprite.frames_by_param', async ({ page }, testInfo) => {
  await initWithSprites(page, testInfo)

  // "strip" (id 1): 3 frames, each a flat colour, `param` selects the frame (`floor(param)` offsets
  // the rect's own x by `frame * rect.w` -- Non-scope: "a game passes the frame in param"). Centre
  // pixel (32, 32) sits well inside whichever frame is selected.
  for (const [param, expected] of [
    [0, [0, 255, 255, 255]],
    [1, [255, 0, 255, 255]],
    [2, [255, 165, 0, 255]],
  ] as const) {
    const strip: DrawRecordSpec = {
      pos: [0, 0],
      size: [0, 0],
      kind: KIND_SPRITE,
      spriteId: SPRITE_STRIP,
      layer: 0,
      color: WHITE,
      param,
    }
    const pixels = await render(page, [strip], CAMERA)
    expectPixel(pixels, 32, 32, expected, TOL)
  }

  expectNoGpuErrors(await page.evaluate(() => window.__drawables?.errors() ?? []))
})

test('sprite.no_bleed_at_mip1', async ({ page }, testInfo) => {
  await initWithSprites(page, testInfo)

  // Reads the atlas's own mip level 1 directly (`window.__drawables.readAtlasMip1`, `src/test/
  // render.ts`'s `readTextureMip`) rather than through on-screen sampling: a screen pixel chosen to
  // avoid a *geometry* texel centre can still land exactly on a *mip-sampling* texel centre (the
  // hardware's own -0.5 texel-centre bias), reading one unblended source texel with no way to tell
  // from outside whether the mip chain blended correctly -- found empirically while building this
  // test (Deviations). Reading the generated mip level directly tests the actual mechanism the 2px
  // extrusion protects: whether padding pixels, not the unlisted neighbour, ended up inside the mip
  // average nearest the sprite's own edge.
  //
  // "bleed" (id 2, flat red, rect [4, 20, 32, 32]) sits immediately next to an unlisted flat-blue
  // block, separated only by each side's own 2px extruded padding (`scripts/gen-sprite-art.mjs`).
  // Measured (Deviations): mip 1 texel (18, 10) is the last texel of bleed's own padded block
  // (pure red); (19, 10) is the unlisted neighbour's first texel (pure blue) -- a hard edge in mip 1
  // itself, with no blend, because every mip 1 texel on bleed's own side pools two mip 0 texels that
  // are either both real content or both that same content's own extruded copy, never one of each.
  const mip1 = await page.evaluate(() => window.__drawables?.readAtlasMip1())
  if (!mip1) throw new Error('readAtlasMip1 returned nothing')
  const buffer: PixelBuffer = {
    width: mip1.width,
    height: mip1.height,
    data: new Uint8Array(mip1.data),
  }
  expectPixel(buffer, 18, 10, RED, TOL)
  // One texel further out is already past bleed's own padded block into the unlisted neighbour's
  // territory -- confirms the probe above sits right at the edge, not deep in safe interior.
  expectPixel(buffer, 19, 10, BLUE, TOL)

  expectNoGpuErrors(await page.evaluate(() => window.__drawables?.errors() ?? []))
})

test('sprite.layering_with_shapes', async ({ page }, testInfo) => {
  await initWithSprites(page, testInfo)

  // A fully-opaque rect and the "quad" sprite fully overlapping: the higher layer wins the pixel
  // (M17's own `draw.layers_order` rule), and this proves it holds when one of the two draws is a
  // sprite kind, not just two shapes.
  const rect: DrawRecordSpec = {
    pos: [0, 0],
    size: [3, 3],
    kind: 3 /* KIND_RECT */,
    layer: 0,
    color: [10, 20, 30, 255],
  }
  const sprite: DrawRecordSpec = {
    pos: [0, 0],
    size: [0, 0],
    kind: KIND_SPRITE,
    spriteId: SPRITE_QUAD,
    layer: 1,
    color: WHITE,
  }
  // Sprite (layer 1) drawn over the rect (layer 0): the overlap pixel shows the sprite's own colour.
  let pixels = await render(page, [rect, sprite], CAMERA)
  expectPixel(pixels, 30, 28, RED, TOL) // quad's own top-left quadrant, not the rect's fill colour

  // Swap layers: the rect (now layer 1) wins over the sprite (now layer 0).
  const rectOnTop: DrawRecordSpec = { ...rect, layer: 1 }
  const spriteBelow: DrawRecordSpec = { ...sprite, layer: 0 }
  pixels = await render(page, [rectOnTop, spriteBelow], CAMERA)
  expectPixel(pixels, 30, 28, [10, 20, 30, 255], TOL)

  expectNoGpuErrors(await page.evaluate(() => window.__drawables?.errors() ?? []))
})
