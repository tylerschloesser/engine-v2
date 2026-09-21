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
import {
  applyTransform,
  jitterDelta,
  jitteredChannelByte,
  selectTransform,
  selectVariant,
} from './support/terrain-hash-ref.ts'

const GRASS: readonly [number, number, number, number] = [34, 139, 34, 255]
const WATER: readonly [number, number, number, number] = [30, 80, 200, 255]
const ORE: readonly [number, number, number, number] = [230, 140, 20, 255]
const NEUTRAL: readonly [number, number, number, number] = [32, 32, 32, 255]
const TOL = 2 // 0020 §6: "≤ 2/255 per channel"
// M09b fix round 1 (item 2): the jitter reference predicts the exact rounded 8-bit channel value,
// not just "within 0020 §6's tolerance" -- 0 (exact) if the round-trip supports it.
const JITTER_TOL = 0

// M09b fixture additions (docs/plan/09b-terrain-art-and-lifecycle.md Planning decisions
// "Probe-friendly fixture art"; `scripts/gen-terrain-art.mjs`): `tile_px` is 4, so every art texel
// is a quarter of a tile on each axis.
const ART_SIZE = 4
const VARIANT_VISUAL = 6
const VARIANT_COLOURS: readonly (readonly [number, number, number, number])[] = [
  [255, 0, 255, 255], // variant 0: magenta
  [0, 255, 255, 255], // variant 1: cyan
  [255, 255, 0, 255], // variant 2: yellow
]
const HASH_SEED = 12345

/** The centre (as a `camFrac` value) of art texel `idx` (0..`ART_SIZE`-1) within a tile: with a 1x1
 * render target (`microCamera` below), `frag_coord` is exactly the viewport's own centre pixel, so
 * `rel == camFrac` and `art_frac == camFrac` (`camTile`'s `floor(camFrac)` contribution is always 0
 * for `camFrac` in `[0, 1)`) -- this is what lets a single scalar pick out one specific art texel of
 * one specific tile with no pixel-grid arithmetic at all. */
function texelFrac(idx: number): number {
  return (idx + 0.5) / ART_SIZE
}

/** A `FrameUniformValues` for a 1x1 render target (Seams: no new `engine/test` surface needed --
 * `renderBorderScene`/`renderAndRead` already accept any viewport size). */
function microCamera(opts: {
  camTileX: number
  camTileY: number
  camFracX: number
  camFracY: number
  tilesPerPx: number
  seed?: number
}): FrameUniformValues {
  return {
    camTileX: opts.camTileX,
    camTileY: opts.camTileY,
    camFracX: opts.camFracX,
    camFracY: opts.camFracY,
    viewportPxW: 1,
    viewportPxH: 1,
    tilesPerPx: opts.tilesPerPx,
    seed: opts.seed ?? 0,
    cursorTileX: 0,
    cursorTileY: 0,
    cursorValid: 0,
    neighbourCutoffPx: 0,
  }
}

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

// The real-client scenes (docs/plan/09-renderer-terrain.md, step 5): a real `createClient()` over
// `fx-terrain` (Gen + Client roles) instead of hand-filled textures -- readback (`expectAdapter|
// readback`, M10's own grep) still runs through `terrain-client.html`. `fx-terrain`'s deterministic
// generator (`fixtures/terrain/src/lib.rs`) puts the same grass/ore/water scene at the same chunk
// coordinates the hand-filled scenes above use, so the pixel assertions below are unchanged from
// the ones the predecessor's stop-gap `terrain.html` scene already proved.
type TerrainClient = NonNullable<Window['__terrainClient']>

async function readClientBorderScene(
  page: import('@playwright/test').Page,
  camera: FrameUniformValues,
): Promise<PixelBuffer> {
  const raw = await page.evaluate(async (cam) => {
    const t = window.__terrainClient as TerrainClient
    t.writeFrameUniform(cam)
    return t.renderAndRead(cam.viewportPxW, cam.viewportPxH)
  }, camera)
  return { width: raw.width, height: raw.height, data: Uint8Array.from(raw.data) }
}

/** Shared by the fast-tier chromium test and its `@slow` WebKit repeat below (Tests added):
 * `terrain-client.html`, a real client, the border/ore scene, then the same four pixel
 * assertions. */
async function runProbeTileColours(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
): Promise<void> {
  await openPage(page, '/terrain-client.html')
  const init = await page.evaluate(() => window.__terrainClient?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  // Planning decisions "`writeTexture` from a SAB view is unverified": recorded here, not
  // asserted -- this is the `@slow` WebKit scene that "catches a Safari difference automatically".
  testInfo.annotations.push({
    type: 'sabWriteTextureOk',
    description: String(init?.sabWriteTextureOk),
  })

  await page.evaluate(() => {
    const t = window.__terrainClient as TerrainClient
    t.setCamera(32, 8, 64)
    t.setHalfExtent(64, 64)
  })
  await page.evaluate(async () => {
    await (window.__terrainClient as TerrainClient).idle()
  })

  const camera = borderCamera(64, 32, 8)
  const pixels = await readClientBorderScene(page, camera)

  // Both sides of the chunk (0,0)/(1,0) border (tile 31 vs tile 32).
  expectPixel(pixels, 31, 0, GRASS, TOL)
  expectPixel(pixels, 32, 0, WATER, TOL)
  // The resource tile (local index 5 of chunk 0) shows the resource's colour, not the base's.
  expectPixel(pixels, 5, 0, ORE, TOL)
  // A plain grass tile elsewhere in chunk 0.
  expectPixel(pixels, 10, 0, GRASS, TOL)

  expectNoGpuErrors(await page.evaluate(() => window.__terrainClient?.errors() ?? []))
}

test('terrain: probe tile colours', async ({ page }, testInfo) => {
  await runProbeTileColours(page, testInfo)
})

// `@webkit-gpu` (playwright.config.ts's own webkit project grep) + `@slow` (0020 §4): runs only
// under `pnpm test:slow`, only in the `webkit` project -- Firefox's own `@engines`-only grep never
// matches this title, so a null WebGPU adapter there (0020 §6) never reaches `expectAdapter`.
test('terrain: probe tile colours webkit @webkit-gpu @slow', async ({ page }, testInfo) => {
  await runProbeTileColours(page, testInfo)
})

test('terrain: nonresident is neutral', async ({ page }, testInfo) => {
  await openPage(page, '/terrain-client.html')
  const init = await page.evaluate(() => window.__terrainClient?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  // No `setCamera`/`idle()` at all: nothing is ever requested from a gen worker, so no chunk is
  // ever resident and every toroidal indirection cell stays `INDIR_NONE` from init.
  const camera = borderCamera(64, 32, 8)
  const pixels = await readClientBorderScene(page, camera)
  expectPixel(pixels, 0, 0, NEUTRAL, TOL)
  expectPixel(pixels, 31, 0, NEUTRAL, TOL)
  expectPixel(pixels, 63, 0, NEUTRAL, TOL)
  expectNoGpuErrors(await page.evaluate(() => window.__terrainClient?.errors() ?? []))
})

test('terrain: patch one texel', async ({ page }, testInfo) => {
  // A real `uploadRing`-shaped SAB driven by hand-built records (no worker): proves `render/
  // upload.ts`'s own CHUNK-then-PATCH handling directly (docs/plan/09-renderer-terrain.md
  // Deviations "Steps 5-7" -- this test is not one of the two the brief names as needing a real
  // client; hand-building the records this way exercises the code `render/upload.ts` itself added
  // in step 5, which the hand-filled `writePageChunk`/`writePageTexel` calls above never touch).
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await page.evaluate(async () => {
    await (window.__terrain as Terrain).loadArt('/terrain/tiles.json')
  })

  const HEADER = 16
  function chunkRecord(slot: number, base: number): number[] {
    const rec = new Array(4112).fill(0)
    rec[0] = 1 // KIND_CHUNK
    rec[2] = slot & 0xff
    rec[3] = (slot >> 8) & 0xff
    for (let i = 0; i < 1024; i++) {
      rec[HEADER + i * 4] = base & 0xff
      rec[HEADER + i * 4 + 1] = (base >> 8) & 0xff
      // resource stays 0
    }
    return rec
  }
  function indirRecord(x: number, y: number, value: number): number[] {
    const rec = new Array(4112).fill(0)
    rec[0] = 3 // KIND_INDIR
    rec[4] = 1 // count
    rec[HEADER] = x
    rec[HEADER + 1] = y
    rec[HEADER + 2] = value & 0xff
    rec[HEADER + 3] = (value >> 8) & 0xff
    return rec
  }
  function patchRecord(slot: number, index: number, base: number, resource: number): number[] {
    const rec = new Array(4112).fill(0)
    rec[0] = 2 // KIND_PATCH
    rec[4] = 1 // count
    rec[HEADER] = slot & 0xff
    rec[HEADER + 1] = (slot >> 8) & 0xff
    rec[HEADER + 2] = index & 0xff
    rec[HEADER + 3] = (index >> 8) & 0xff
    rec[HEADER + 4] = base & 0xff
    rec[HEADER + 5] = (base >> 8) & 0xff
    rec[HEADER + 6] = resource & 0xff
    rec[HEADER + 7] = (resource >> 8) & 0xff
    return rec
  }

  await page.evaluate(
    ([chunk, indir]) => {
      const t = window.__terrain as Terrain
      t.createTestRing()
      t.stageRecord(chunk)
      t.stageRecord(indir)
      t.drainRing(1 << 20)
    },
    [chunkRecord(0, VISUAL_GRASS), indirRecord(0, 0, 0)] as const,
  )

  const camera = borderCamera(64, 32, 8)
  let pixels = await renderBorderScene(page, camera)
  expectPixel(pixels, 5, 0, GRASS, TOL) // local index 5: still plain grass, no patch yet

  // Patch local index 5 of slot 0 to the ore resource, on top of the already-resident chunk.
  await page.evaluate(
    (patch) => {
      const t = window.__terrain as Terrain
      t.stageRecord(patch)
      t.drainRing(1 << 20)
    },
    patchRecord(0, 5, VISUAL_GRASS, VISUAL_ORE),
  )
  pixels = await renderBorderScene(page, camera)
  expectPixel(pixels, 5, 0, ORE, TOL) // now shows the patched resource
  expectPixel(pixels, 10, 0, GRASS, TOL) // an untouched tile is unaffected

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

// M09b step 2 (docs/plan/09b-terrain-art-and-lifecycle.md): the PCG-hash variant/flip/rotate/jitter
// path. Both tests below drive `terrain.html`'s hand-filled path (no Rust fixture change, Files
// touched: "No Rust"), reusing `microCamera`'s 1x1 render target so one scalar (`camFracX`/
// `camFracY`) picks out one specific art texel of one specific tile with no pixel-grid arithmetic.

test('terrain: variants match reference', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await page.evaluate(async (chunk) => {
    const t = window.__terrain as Terrain
    await t.loadArt('/terrain/tiles.json')
    t.writePageChunk(0, chunk)
    t.writeIndir([{ x: 0, y: 0, value: 0 }])
  }, flatChunk(VARIANT_VISUAL))

  // Comfortably magnified (texels_per_px = 0.5 < 1, `fade === 1`): probing the texel *centre*
  // (Planning decisions "Reference implementation of the hash in the test") makes the "fat pixel"
  // seam formula a no-op, so the read colour is exactly variant `selectVariant(...)`'s own.
  const MAGNIFIED_TILES_PER_PX = 1 / 8
  const probes: readonly (readonly [number, number])[] = [
    [0, 0],
    [1, 0],
    [5, 7],
    [17, 3],
    [31, 31],
  ]
  for (const [tx, ty] of probes) {
    const variant = selectVariant(tx, ty, HASH_SEED, VARIANT_COLOURS.length)
    const want = VARIANT_COLOURS[variant] as readonly [number, number, number, number]
    const pixel = await renderBorderScene(
      page,
      microCamera({
        camTileX: tx,
        camTileY: ty,
        camFracX: texelFrac(1),
        camFracY: texelFrac(1),
        tilesPerPx: MAGNIFIED_TILES_PER_PX,
        seed: HASH_SEED,
      }),
    )
    expectPixel(pixel, 0, 0, want, TOL)
  }
  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))
})

test('terrain: magnified texel exact', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await stageBorderScene(page) // M09's own grass (chunk 0) / water (chunk 1) border scene.

  // Exactly 1 screen px per art texel ("integer pixels-per-texel", Planning decisions): every one
  // of the 4 texels on each side of the chunk (0,0)/(1,0) border -- tiles 31 and 32, `CHUNK_BITS ===
  // 5` (docs/plan/09-renderer-terrain.md Planning decisions) -- reads its own tile's exact flat
  // colour, with no blur or bleed across the array-layer boundary at the seam.
  const INTEGER_TILES_PER_PX = 1 / ART_SIZE
  for (let texel = 0; texel < ART_SIZE; texel++) {
    const grassPixel = await renderBorderScene(
      page,
      microCamera({
        camTileX: 31,
        camTileY: 8,
        camFracX: texelFrac(texel),
        camFracY: texelFrac(0),
        tilesPerPx: INTEGER_TILES_PER_PX,
      }),
    )
    expectPixel(grassPixel, 0, 0, GRASS, TOL)

    const waterPixel = await renderBorderScene(
      page,
      microCamera({
        camTileX: 32,
        camTileY: 8,
        camFracX: texelFrac(texel),
        camFracY: texelFrac(0),
        tilesPerPx: INTEGER_TILES_PER_PX,
      }),
    )
    expectPixel(waterPixel, 0, 0, WATER, TOL)
  }
  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))
})

// M09b fix round 1 (item 1, "flip and rotate have zero pixel coverage"): visual 9's quadrant-
// patterned cell (`scripts/gen-terrain-art.mjs`) makes a flip/rotate transform visibly move a
// different quadrant's colour under a fixed probe point.
const TRANSFORM_VISUAL = 9
const TRANSFORM_FLAGS = 7 // flip_x (1) | flip_y (2) | rotate (4): every transform allowed
const QUADRANT_COLOURS: readonly (readonly [number, number, number, number])[] = [
  [255, 0, 0, 255], // top-left: red
  [0, 255, 0, 255], // top-right: green
  [0, 0, 255, 255], // bottom-left: blue
  [255, 128, 0, 255], // bottom-right: orange
]
// The probe's own untransformed uv (art texel (0, 2) of the quadrant cell): x < 0.5 (left), y >=
// 0.5 (bottom) -- a rotate (swap) alone moves this to a *different* quadrant than flip_x or flip_y
// alone would, unlike a diagonal (x === y) probe point, where a plain transpose is invisible.
const TRANSFORM_PROBE_UV: readonly [number, number] = [texelFrac(0), texelFrac(2)]

function quadrantColour(uv: readonly [number, number]): readonly [number, number, number, number] {
  const [x, y] = uv
  const index = (y < 0.5 ? 0 : 2) + (x < 0.5 ? 0 : 1)
  return QUADRANT_COLOURS[index] as readonly [number, number, number, number]
}

test('terrain: flip and rotate match reference', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await page.evaluate(async (chunk) => {
    const t = window.__terrain as Terrain
    await t.loadArt('/terrain/tiles.json')
    t.writePageChunk(0, chunk)
    t.writeIndir([{ x: 0, y: 0, value: 0 }])
  }, flatChunk(TRANSFORM_VISUAL))

  // Comfortably magnified (as `variants match reference`): probing the texel *centre* makes the
  // "fat pixel" seam formula a no-op, so the read colour is exactly the transformed quadrant's own.
  const MAGNIFIED_TILES_PER_PX = 1 / 8
  // Eight tiles (row 0, `seed HASH_SEED`), one per possible `h.y & 7` hash-bit pattern (found by a
  // scan recorded in Deviations): every rotate/flip_x/flip_y combination the hash can select is
  // exercised at least once.
  const probes: readonly (readonly [number, number])[] = [
    [11, 0],
    [13, 0],
    [1, 0],
    [4, 0],
    [6, 0],
    [0, 0],
    [26, 0],
    [8, 0],
  ]
  for (const [tx, ty] of probes) {
    const transform = selectTransform(tx, ty, HASH_SEED, TRANSFORM_FLAGS)
    const want = quadrantColour(applyTransform(TRANSFORM_PROBE_UV, transform))
    const pixel = await renderBorderScene(
      page,
      microCamera({
        camTileX: tx,
        camTileY: ty,
        camFracX: TRANSFORM_PROBE_UV[0],
        camFracY: TRANSFORM_PROBE_UV[1],
        tilesPerPx: MAGNIFIED_TILES_PER_PX,
        seed: HASH_SEED,
      }),
    )
    expectPixel(pixel, 0, 0, want, TOL)
  }
  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))
})

// M09b fix round 1 (item 2, "jitter is untestable by construction"): the TS reference predicts the
// exact jittered 8-bit channel value, so a no-op, inverted, wrong-channel or unfaded jitter fails.
test('terrain: jitter matches reference', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await stageBorderScene(page) // grass (chunk 0) / water (chunk 1); band 0, so dithering never fires.

  // Fully magnified (`fade === 1`, same convention as `variants match reference`): three tiles whose
  // hash gives clearly different jitter bytes (41, 99 and 214 out of 255; Deviations records how
  // they were found), probed at a tile *centre* so no dithering or seam correction is in play --
  // only jitter can move the read pixel away from GRASS's own stored colour.
  const MAGNIFIED_TILES_PER_PX = 1 / 8
  const FADE = 1 // clamp(1 / (tilesPerPx * ART_SIZE), 0, 1) === 1 at this zoom
  const tiles: readonly (readonly [number, number])[] = [
    [11, 0],
    [1, 0],
    [6, 0],
  ]
  for (const [tx, ty] of tiles) {
    const delta = jitterDelta(tx, ty, HASH_SEED, FADE)
    const want: readonly [number, number, number, number] = [
      jitteredChannelByte(GRASS[0], delta),
      jitteredChannelByte(GRASS[1], delta),
      jitteredChannelByte(GRASS[2], delta),
      GRASS[3],
    ]
    const pixel = await renderBorderScene(
      page,
      microCamera({
        camTileX: tx,
        camTileY: ty,
        camFracX: 0.5,
        camFracY: 0.5,
        tilesPerPx: MAGNIFIED_TILES_PER_PX,
        seed: HASH_SEED,
      }),
    )
    expectPixel(pixel, 0, 0, want, JITTER_TOL)
  }
  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))
})

// M09b step 3 (docs/plan/09b-terrain-art-and-lifecycle.md): stateless edge dithering.

const PRIO_LOW_VISUAL = 7
const PRIO_HIGH_VISUAL = 8
const PRIO_LOW: readonly [number, number, number, number] = [90, 90, 90, 255]
const PRIO_HIGH: readonly [number, number, number, number] = [220, 20, 60, 255]

/** Chunk (0, 0) is flat `PRIO_LOW_VISUAL` (priority 1, band 2), chunk (1, 0) is flat
 * `PRIO_HIGH_VISUAL` (priority 2, band 2) -- `includeNeighbour` controls whether chunk (1, 0)'s own
 * indirection entry is ever staged (`terrain.missing_neighbour_is_self`). */
async function stageDitherScene(
  page: import('@playwright/test').Page,
  includeNeighbour: boolean,
): Promise<void> {
  await page.evaluate(async () => {
    await (window.__terrain as Terrain).loadArt('/terrain/tiles.json')
  })
  await page.evaluate(
    ([lowChunk, highChunk, includeNeighbour]) => {
      const t = window.__terrain as Terrain
      t.writePageChunk(0, lowChunk)
      t.writePageChunk(1, highChunk)
      const entries: { x: number; y: number; value: number }[] = [{ x: 0, y: 0, value: 0 }]
      if (includeNeighbour) entries.push({ x: 1, y: 0, value: 1 })
      t.writeIndir(entries)
    },
    [flatChunk(PRIO_LOW_VISUAL), flatChunk(PRIO_HIGH_VISUAL), includeNeighbour] as const,
  )
}

// texels_per_px === 1 (fully magnified, fade === 1): the band=2 dithering zone spans art texels 2
// and 3 (dist_right 1 and 0); texels 0 and 1 (dist_right 3 and 2) are outside it.
const DITHER_TILES_PER_PX = 1 / ART_SIZE
// Tiles 31/32 straddle the chunk (0,0)/(1,0) border (`CHUNK_BITS === 5`, docs/plan/
// 09-renderer-terrain.md Planning decisions), matching `stageDitherScene`'s own chunk-index
// indirection entries (`x: 0`/`x: 1`) -- an adjacent-tile *within* one chunk (e.g. tiles 0/1) would
// never reach the neighbouring chunk's own staged visual at all.
const SELF_TILE_X = 31
const NEIGHBOUR_TILE_X = 32

async function ditherProbe(
  page: import('@playwright/test').Page,
  tileX: number,
  texelX: number,
  texelY: number,
  tilesPerPx: number,
): Promise<PixelBuffer> {
  return renderBorderScene(
    page,
    microCamera({
      camTileX: tileX,
      camTileY: 0,
      camFracX: texelFrac(texelX),
      camFracY: texelFrac(texelY),
      tilesPerPx,
    }),
  )
}

test('terrain: dither only inside band', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await stageDitherScene(page, true)

  // Tile (0, 0) is the lower-priority visual: its own centre (art texels 0 and 1, dist_right 3 and
  // 2 -- outside the band, since band is 2) never dithers, for two different reasons depending on
  // which edge the nearest-edge search actually picks at distance 0: texel 0's nearest edge is left
  // (tile 30, tied with top at distance 0 but checked first) -- tile 30 *is* staged (same chunk 0 as
  // self) and simply ties on priority, so the comparison never fires; texel 1's nearest edge is top
  // (tile (31, -1), strictly closer than its own left edge at distance 1) -- chunk (0, -1) is
  // genuinely never staged, so that one *does* fall back through the missing-neighbour path.
  expectPixel(await ditherProbe(page, SELF_TILE_X, 0, 0, DITHER_TILES_PER_PX), 0, 0, PRIO_LOW, TOL)
  expectPixel(await ditherProbe(page, SELF_TILE_X, 1, 0, DITHER_TILES_PER_PX), 0, 0, PRIO_LOW, TOL)
  // Art texel 2, rows 1 and 2 (dist_right 1, coverage 0.5; rows 0 and 3 are closer to the tile's own
  // top/bottom edge than to its right edge, Deviations, so they are not usable here): row 2's Bayer
  // value (1/16) is under coverage, row 1's (14/16) is not -- the checkerboard-like partial coverage
  // the Bayer matrix is for.
  expectPixel(await ditherProbe(page, SELF_TILE_X, 2, 1, DITHER_TILES_PER_PX), 0, 0, PRIO_LOW, TOL)
  expectPixel(await ditherProbe(page, SELF_TILE_X, 2, 2, DITHER_TILES_PER_PX), 0, 0, PRIO_HIGH, TOL)
  // Art texel 3, row 0 (dist_right 0, coverage 1.0: every possible Bayer value is under it -- and
  // the tie with the top edge, also at distance 0, resolves to "right" since it is checked first).
  expectPixel(await ditherProbe(page, SELF_TILE_X, 3, 0, DITHER_TILES_PER_PX), 0, 0, PRIO_HIGH, TOL)

  // Tile (1, 0) is the higher-priority visual: its neighbour (tile (0, 0)) has *lower* priority, so
  // the comparison never fires, even deep inside its own band.
  expectPixel(
    await ditherProbe(page, NEIGHBOUR_TILE_X, 0, 0, DITHER_TILES_PER_PX),
    0,
    0,
    PRIO_HIGH,
    TOL,
  )
  expectPixel(
    await ditherProbe(page, NEIGHBOUR_TILE_X, 1, 1, DITHER_TILES_PER_PX),
    0,
    0,
    PRIO_HIGH,
    TOL,
  )

  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))
})

test('terrain: missing neighbour is self', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await stageDitherScene(page, false) // chunk (1, 0)'s indirection cell is never written: stays NONE

  // Every position that showed the neighbour's colour in the test above shows self instead: a
  // missing neighbour reads as this tile's own visual (0018 §3: "a missing neighbour counts as same
  // as self"), so the priority comparison never fires -- and nothing reads as `NEUTRAL_COLOR`
  // either (that sentinel is only for the *primary* tile's own missing chunk).
  expectPixel(await ditherProbe(page, SELF_TILE_X, 2, 1, DITHER_TILES_PER_PX), 0, 0, PRIO_LOW, TOL)
  expectPixel(await ditherProbe(page, SELF_TILE_X, 2, 2, DITHER_TILES_PER_PX), 0, 0, PRIO_LOW, TOL)
  expectPixel(await ditherProbe(page, SELF_TILE_X, 3, 0, DITHER_TILES_PER_PX), 0, 0, PRIO_LOW, TOL)

  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))
})

test('terrain: dither fades when minified', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await stageDitherScene(page, true)

  // Control: at the immediate edge (art texel 3, dist_right 0, coverage 1.0 when fully faded in),
  // fully magnified still dithers (matches the test above).
  const magnified = await ditherProbe(page, SELF_TILE_X, 3, 0, DITHER_TILES_PER_PX)
  expectPixel(magnified, 0, 0, PRIO_HIGH, TOL)

  // Deep in the fade-out zone (Scope: "fade-out of dither and jitter below 1 screen px per art
  // texel"): `texels_per_px` = 8 * `ART_SIZE` = 32, `coverage` = 1.0 / 32 ≈ 0.03 -- under every
  // possible Bayer value at this Bayer column (10/16, 6/16, 9/16, 5/16), so the same position now
  // shows self instead.
  const FAR_TILES_PER_PX = 8
  const minified = await ditherProbe(page, SELF_TILE_X, 3, 0, FAR_TILES_PER_PX)
  expectPixel(minified, 0, 0, PRIO_LOW, TOL)

  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))
})

test('terrain: minified converges to mean', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await stageBorderScene(page) // M09's own grass (chunk 0) / water (chunk 1) border scene.

  // "1 px per tile" (Tests added): far enough out that a whole tile's own mip pyramid has converged
  // to 1x1 (0018 §6: "the mip chain converges each tile to its mean colour") -- a looser 8/255
  // tolerance than every other probe here, per Tests added, since minified sampling reads a
  // trilinear-blended mip level rather than a single exact texel.
  const FAR_TILES_PER_PX = 8
  const MEAN_TOL = 8
  const grassPixel = await renderBorderScene(
    page,
    microCamera({
      camTileX: 3,
      camTileY: 8,
      camFracX: 0.5,
      camFracY: 0.5,
      tilesPerPx: FAR_TILES_PER_PX,
    }),
  )
  expectPixel(grassPixel, 0, 0, GRASS, MEAN_TOL)
  const waterPixel = await renderBorderScene(
    page,
    microCamera({
      camTileX: 35,
      camTileY: 8,
      camFracX: 0.5,
      camFracY: 0.5,
      tilesPerPx: FAR_TILES_PER_PX,
    }),
  )
  expectPixel(waterPixel, 0, 0, WATER, MEAN_TOL)
  expectNoGpuErrors(await page.evaluate(() => window.__terrain?.errors() ?? []))
})

test('terrain: upload budget while panning', async ({ page }, testInfo) => {
  await openPage(page, '/terrain-client.html')
  const init = await page.evaluate(() => window.__terrainClient?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  await page.evaluate(() => {
    const t = window.__terrainClient as TerrainClient
    t.setCamera(0, 8, 64)
    t.setHalfExtent(24, 24)
  })

  const UPLOAD_BUDGET_BYTES = 64 * 1024 // 0018 §3's own default
  const FRAMES = 600
  const FRAME_MS = 1000 / 60
  // ~40 tiles over the whole run: crosses the chunk (0,0)/(1,0) boundary at x=32 partway through,
  // so the queue keeps finding fresh work across most of the window (0016 §2's own "chunk-enter
  // bursts are not exempt").
  const PAN_PER_FRAME = 40 / FRAMES

  const { uploadBytesPerFrame } = await page.evaluate(
    ([frames, dtMs, panX, budget]) =>
      (window.__terrainClient as TerrainClient).panAndDrive(frames, dtMs, panX, 0, budget),
    [FRAMES, FRAME_MS, PAN_PER_FRAME, UPLOAD_BUDGET_BYTES] as const,
  )
  expect(uploadBytesPerFrame).toHaveLength(FRAMES)
  for (const bytes of uploadBytesPerFrame) {
    expect(bytes, 'uploadBytes per frame must stay within the byte budget').toBeLessThanOrEqual(
      UPLOAD_BUDGET_BYTES,
    )
  }

  // Let anything the budget deferred finish, then one verification draw (0018 §1: a constant
  // one-draw-call frame regardless of upload traffic).
  await page.evaluate(async () => {
    await (window.__terrainClient as TerrainClient).idle()
  })
  await page.evaluate((cam) => (window.__terrainClient as TerrainClient).writeFrameUniform(cam), {
    camTileX: 32,
    camTileY: 8,
    camFracX: 0,
    camFracY: 0,
    viewportPxW: 64,
    viewportPxH: 16,
    tilesPerPx: 1,
    seed: 0,
    cursorTileX: 0,
    cursorTileY: 0,
    cursorValid: 0,
    neighbourCutoffPx: 0,
  } satisfies FrameUniformValues)
  await page.evaluate(([w, h]) => (window.__terrainClient as TerrainClient).renderAndRead(w, h), [
    64, 16,
  ] as const)
  const drawCalls = await page.evaluate(() => window.__terrainClient?.drawCalls() ?? -1)
  expect(drawCalls).toBe(1)

  // Ring-1 chunks resident at rest: the pan's start (0, 0) and end (1, 0) both fall inside the
  // half-extent-24 view at some point along the way, and this fixture's cache (1,024 chunks) never
  // fills over a ~4-chunk-wide pan, so neither is ever evicted.
  const hash00 = await page.evaluate(() =>
    (window.__terrainClient as TerrainClient).chunkHash(0, 0),
  )
  const hash10 = await page.evaluate(() =>
    (window.__terrainClient as TerrainClient).chunkHash(1, 0),
  )
  expect(hash00).not.toBeNull()
  expect(hash10).not.toBeNull()

  expectNoGpuErrors(await page.evaluate(() => window.__terrainClient?.errors() ?? []))
})

function pixelRgba(pixels: PixelBuffer, x: number, y: number): [number, number, number, number] {
  const i = (y * pixels.width + x) * 4
  return [
    pixels.data[i] as number,
    pixels.data[i + 1] as number,
    pixels.data[i + 2] as number,
    pixels.data[i + 3] as number,
  ]
}

/** Not `expectPixel` (Seams: one target only) -- item 4's own assertion needs "one of two
 * acceptable colours, never a third", so this stays a spec-local helper rather than a new
 * `engine/test` export (out of item 7's own, already-named list). */
function expectPixelOneOf(
  pixels: PixelBuffer,
  x: number,
  y: number,
  options: readonly (readonly [number, number, number, number])[],
  tol: number,
): void {
  const got = pixelRgba(pixels, x, y)
  const ok = options.some((want) => got.every((c, i) => Math.abs(c - (want[i] as number)) <= tol))
  expect(
    ok,
    `pixel (${x}, ${y}) = [${got.join(', ')}] matched none of ${JSON.stringify(options)}`,
  ).toBe(true)
}

// Open gate failures item 4, gate round 1: a small (2-chunk) cache under a wide view forces
// continuous eviction/slot-reuse well beyond 0018 §6's own 121-chunk ring-1 worst case, so both
// (0, 0)'s and (1, 0)'s page slots get reused by other chunks repeatedly while `idle()` converges.
// If `Uploader::stage` ever staged a CHUNK reusing a slot before that slot's own previous-occupant
// INDIR-none, this screen position could show whichever chunk most recently overwrote the slot's
// texels through the *other* chunk's own stale toroidal cell -- any colour but grass/water/neutral
// is exactly that bug, "the other chunk's texels" the brief names.
test('terrain: evicted slot shows new chunk, never stale texels', async ({ page }, testInfo) => {
  await openPage(page, '/terrain-client.html')
  const init = await page.evaluate(() => window.__terrainClient?.init({ clientCacheChunks: 2 }))
  expectAdapter(testInfo, init?.adapterInfo ?? null)

  await page.evaluate(() => {
    const t = window.__terrainClient as TerrainClient
    t.setCamera(32, 8, 64)
    t.setHalfExtent(64, 64)
  })
  await page.evaluate(async () => {
    await (window.__terrainClient as TerrainClient).idle()
  })

  const camera = borderCamera(64, 32, 8)
  const pixels = await readClientBorderScene(page, camera)
  expectPixelOneOf(pixels, 31, 0, [GRASS, NEUTRAL], TOL)
  expectPixelOneOf(pixels, 32, 0, [WATER, NEUTRAL], TOL)

  expectNoGpuErrors(await page.evaluate(() => window.__terrainClient?.errors() ?? []))
})

// Open gate failures item 6, gate round 1 negative: a deliberately invalid WGSL string must make
// `checkCompilation` fail the check (`readback`'s own filename keeps this in M10's
// `expectAdapter|readback` grep, docs/plan/09-renderer-terrain.md Consumes).
test('device: bad wgsl fails the compilation check', async ({ page }, testInfo) => {
  await openPage(page, '/terrain.html')
  const init = await page.evaluate(() => window.__terrain?.init())
  expectAdapter(testInfo, init?.adapterInfo ?? null)
  const errors = await page.evaluate(() => window.__terrain?.checkBadWgsl() ?? [])
  expect(
    errors.length,
    'a bad WGSL module must produce a getCompilationInfo() message',
  ).toBeGreaterThan(0)
})
