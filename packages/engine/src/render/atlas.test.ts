// docs/plan/17b-sprites-and-frame-budget.md, Tests added: "sprites.schema_errors" -- every failure
// mode of 0018 §4's limits and the sprites.json v1 schema (Planning decisions), each naming the
// offending id, mirroring `art.test.ts`'s "manifest: schema errors".
import { expect, test } from 'vitest'
import {
  buildSpriteTables,
  SPRITE_TABLE_EDGE,
  SpriteManifestError,
  validateSpritesManifest,
} from './atlas.js'

const VALID = {
  version: 1,
  image: 'sprites.png',
  padding: 2,
  sprites: {
    0: { rect: [4, 4, 8, 8], pivot: [0.25, 0.75], size: [2, 1], frames: 1 },
    1: { rect: [20, 4, 8, 8], pivot: [0.5, 0.5], size: [1, 1], frames: 3 },
  },
}

test('sprites: valid document round-trips', () => {
  const m = validateSpritesManifest(VALID)
  expect(m.image).toBe('sprites.png')
  expect(m.sprites['1']).toEqual({
    rect: [20, 4, 8, 8],
    pivot: [0.5, 0.5],
    size: [1, 1],
    frames: 3,
  })
})

test('sprites: schema errors', () => {
  expect(() => validateSpritesManifest(null)).toThrow(SpriteManifestError)
  expect(() => validateSpritesManifest({ ...VALID, version: 2 })).toThrow(/version/)
  expect(() => validateSpritesManifest({ ...VALID, image: '' })).toThrow(/image/)
  expect(() => validateSpritesManifest({ ...VALID, padding: -1 })).toThrow(/padding/)
  expect(() => validateSpritesManifest({ ...VALID, sprites: null })).toThrow(/sprites/)

  // Sprite id out of range (0018 §4: 4,096 sprites, ids [0, 4096)) names the offending id.
  expect(() => validateSpritesManifest({ ...VALID, sprites: { 4096: VALID.sprites[0] } })).toThrow(
    /4096/,
  )
  expect(() => validateSpritesManifest({ ...VALID, sprites: { '-1': VALID.sprites[0] } })).toThrow(
    /-1/,
  )
  expect(() => validateSpritesManifest({ ...VALID, sprites: { x: VALID.sprites[0] } })).toThrow(
    /'x'/,
  )

  // Per-sprite field errors, each naming the sprite id.
  expect(() =>
    validateSpritesManifest({
      ...VALID,
      sprites: { 3: { rect: [0, 0, 0, 8], pivot: [0, 0], size: [1, 1], frames: 1 } },
    }),
  ).toThrow(/sprite '3'.*rect/)
  expect(() =>
    validateSpritesManifest({
      ...VALID,
      sprites: { 3: { rect: [0, 0, 8, 8], pivot: [1.5, 0], size: [1, 1], frames: 1 } },
    }),
  ).toThrow(/sprite '3'.*pivot/)
  expect(() =>
    validateSpritesManifest({
      ...VALID,
      sprites: { 3: { rect: [0, 0, 8, 8], pivot: [0, 0], size: [0, 1], frames: 1 } },
    }),
  ).toThrow(/sprite '3'.*size/)
  expect(() =>
    validateSpritesManifest({
      ...VALID,
      sprites: { 3: { rect: [0, 0, 8, 8], pivot: [0, 0], size: [1, 1], frames: 0 } },
    }),
  ).toThrow(/sprite '3'.*frames/)

  // Over the 4,096-sprite limit.
  const tooMany: Record<string, unknown> = {}
  for (let i = 0; i < 4097; i++) {
    tooMany[i] = { rect: [0, 0, 1, 1], pivot: [0, 0], size: [1, 1], frames: 1 }
  }
  expect(() => validateSpritesManifest({ ...VALID, sprites: tooMany })).toThrow(/4096/)
})

test('sprites: buildSpriteTables lays out rect/pivot+size at (id % 64, id / 64)', () => {
  const manifest = validateSpritesManifest(VALID)
  const { rectBytes, pivotSizeBytes } = buildSpriteTables(manifest)
  expect(rectBytes.length).toBe(SPRITE_TABLE_EDGE * SPRITE_TABLE_EDGE * 4)
  // sprite 0
  expect(Array.from(rectBytes.slice(0, 4))).toEqual([4, 4, 8, 8])
  expect(Array.from(pivotSizeBytes.slice(0, 4))).toEqual([0.25, 0.75, 2, 1])
  // sprite 1
  expect(Array.from(rectBytes.slice(4, 8))).toEqual([20, 4, 8, 8])
  expect(Array.from(pivotSizeBytes.slice(4, 8))).toEqual([0.5, 0.5, 1, 1])
  // untouched sprite id (2) stays zeroed
  expect(Array.from(rectBytes.slice(8, 12))).toEqual([0, 0, 0, 0])
})
