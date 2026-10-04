// `?bench=large-save` parameters (`bench-request.ts`): `zoom=max` is the scripted zoom-out of M39-frame-shares
// (M39f step 11); the other parameters keep their M36 meaning.
import { expect, test } from 'vitest'
import { benchRequest, MAX_TILES_ACROSS } from './bench-request.js'

const MAX = 256 // the camera's maximum zoom-out (`tilesAcross`, 0019), written out so a change here is seen

test('bench_request: zoom=max (and no zoom) is the camera maximum, a number is that many tiles, junk falls back', () => {
  expect(benchRequest('?bench=large-save&pan=2&zoom=max')).toEqual({
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
