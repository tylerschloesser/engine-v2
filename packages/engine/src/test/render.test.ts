// `engine/test`'s pure helpers (docs/plan/09-renderer-terrain.md Seams): `tileCentrePx` and
// `expectPixel` need no GPU, so they get a plain unit test even though `terrain-readback.spec.ts`
// exercises the GPU-backed `renderTo`/`readPixels` end to end instead.
import { expect, test } from 'vitest'
import { expectPixel, type PixelBuffer, tileCentrePx } from './render.js'

test('tileCentrePx: pixel index equals tile index at the pixel-aligned coincidence', () => {
  // The same camera shape `terrain-readback.spec.ts` uses: tilesPerPx 1, camTile == half viewport.
  const camera = {
    camTileX: 32,
    camTileY: 8,
    camFracX: 0,
    camFracY: 0,
    viewportPxW: 64,
    viewportPxH: 16,
    tilesPerPx: 1,
  }
  const out = { x: -1, y: -1 }
  tileCentrePx(camera, 31, 0, out)
  expect(out.x).toBeCloseTo(31.5)
  expect(out.y).toBeCloseTo(0.5)
  tileCentrePx(camera, 32, 0, out)
  expect(out.x).toBeCloseTo(32.5)
})

test('tileCentrePx: scales by tilesPerPx and shifts by camFrac', () => {
  const camera = {
    camTileX: 0,
    camTileY: 0,
    camFracX: 0.25,
    camFracY: 0,
    viewportPxW: 100,
    viewportPxH: 100,
    tilesPerPx: 2,
  }
  const out = { x: 0, y: 0 }
  tileCentrePx(camera, 0, 0, out)
  // rel = 0.5 - 0 - 0.25 = 0.25; px = 50 + 0.25 / 2 = 50.125
  expect(out.x).toBeCloseTo(50.125)
  expect(out.y).toBeCloseTo(50.25)
})

function bufferOf(
  width: number,
  height: number,
  fill: [number, number, number, number],
): PixelBuffer {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4)
  return { width, height, data }
}

test('expectPixel: passes within tolerance, throws outside it', () => {
  const pixels = bufferOf(2, 2, [10, 20, 30, 255])
  expect(() => expectPixel(pixels, 0, 0, [10, 20, 30, 255], 0)).not.toThrow()
  expect(() => expectPixel(pixels, 1, 1, [12, 20, 30, 255], 2)).not.toThrow()
  expect(() => expectPixel(pixels, 1, 1, [13, 20, 30, 255], 2)).toThrow(/channel r/)
  expect(() => expectPixel(pixels, 5, 0, [10, 20, 30, 255], 0)).toThrow(/outside/)
})
