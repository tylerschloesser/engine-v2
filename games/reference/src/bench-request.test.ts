// `?bench=large-save` parameters (`bench-request.ts`): `zoom=max` is the scripted zoom-out of M39-frame-shares
// (M39f step 11); the other parameters keep their M36 meaning.
import { expect, test } from 'vitest'
import {
  beltField,
  benchCamera,
  benchRequest,
  benchTilesAcross,
  benchView,
  furnaceBlock,
  MAX_TILES_ACROSS,
  MID_TILES_ACROSS,
} from './bench-request.js'

const MAX = 256 // the camera's maximum zoom-out (`tilesAcross`, 0019), written out so a change here is seen

test('bench_request: zoom=max (and no zoom) is the camera maximum, a number is that many tiles, junk falls back', () => {
  expect(benchRequest('?bench=large-save&pan=2&zoom=max')).toEqual({
    mode: 'large-save',
    scale: 1,
    panTilesPerSecond: 2,
    tilesAcross: MAX,
  })
  expect(benchRequest('?bench=large-save')?.tilesAcross).toBe(MAX)
  expect(benchRequest('?bench=large-save&zoom=64&scale=64')).toMatchObject({
    scale: 64,
    tilesAcross: 64,
  })
  expect(benchRequest('?bench=large-save&zoom=nope')?.tilesAcross).toBe(MAX)
  expect(benchRequest('?bench=large-save&zoom=-3')?.tilesAcross).toBe(MAX)
  expect(benchRequest('?zoom=max')).toBeUndefined() // not a bench page without the parameter
})

test('bench_request: the exported maximum is the literal', () => {
  expect(MAX_TILES_ACROSS).toBe(MAX)
})

// M57: `?bench=belts` (the belt field) and `zoom=mid`.
test('bench_request: belts mode, zoom=mid is 64 across, other modes are not a bench page', () => {
  expect(benchRequest('?bench=belts&zoom=mid')).toEqual({
    mode: 'belts',
    scale: 1,
    panTilesPerSecond: 12,
    tilesAcross: 64,
  })
  expect(MID_TILES_ACROSS).toBe(64)
  expect(benchRequest('?bench=belts')?.tilesAcross).toBe(MAX)
  expect(benchRequest('?bench=large-save&zoom=mid')?.tilesAcross).toBe(64)
  expect(benchRequest('?bench=other')).toBeUndefined()
})

test('bench_camera: the belt field pans from its centre and stays on it; the large save from the left', () => {
  const max = benchRequest('?bench=belts') as NonNullable<ReturnType<typeof benchRequest>>
  const mid = benchRequest('?bench=belts&zoom=mid') as NonNullable<ReturnType<typeof benchRequest>>
  expect(beltField(1)).toEqual({ x: 128, y: 72 })
  expect(beltField(4)).toEqual({ x: 128, y: 18 })
  // 256 across: a swing of 8 tiles; 64 across: 96 each way, the view's edge at the field's.
  expect([0, 8, 16, 24, 32, 36].map((d) => benchCamera(max, d).x)).toEqual([
    128, 136, 128, 120, 128, 132,
  ])
  expect([0, 96, 192, 288, 384].map((d) => benchCamera(mid, d).x)).toEqual([128, 224, 128, 32, 128])
  expect(benchCamera(mid, 0).y).toBe(72)
  const ls = benchRequest('?bench=large-save&scale=1') as NonNullable<
    ReturnType<typeof benchRequest>
  >
  const block = furnaceBlock(1)
  const amp = block.halfSpan - 140
  expect(benchCamera(ls, 0)).toEqual({ x: block.x - amp, y: block.y })
  expect(benchCamera(ls, 2 * amp).x).toBe(block.x + amp)
})

// M57 fix round 1: `zoom=max` on the belt field fits its 256 tiles to the viewport's short side in
// portrait (every belt in view on a phone held upright); landscape and `mid` keep the long axis.
test('bench_tiles_across: the belt field at zoom=max fits the short side in portrait', () => {
  const max = benchRequest('?bench=belts') as NonNullable<ReturnType<typeof benchRequest>>
  const mid = benchRequest('?bench=belts&zoom=mid') as NonNullable<ReturnType<typeof benchRequest>>
  const ls = benchRequest('?bench=large-save') as NonNullable<ReturnType<typeof benchRequest>>
  expect(benchTilesAcross(max, 1280, 720)).toBe(256)
  expect(benchTilesAcross(max, 390, 844)).toBe(555)
  expect(benchTilesAcross(mid, 390, 844)).toBe(64)
  expect(benchTilesAcross(ls, 390, 844)).toBe(256)
  expect(benchView(256, 1280, 720)).toBeUndefined()
  // 555 x 257 tiles: 18 x 9 chunks, two more each way.
  expect(benchView(555, 390, 844)).toEqual({ maxTilesPerAxis: 555, maxChunks: 22 * 13 })
})
