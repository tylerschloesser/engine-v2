// docs/plan/09-renderer-terrain.md, Tests added: "manifest.schema_errors" -- every failure mode of
// 0018 §4's limits and the tiles.json v1 schema (Planning decisions), each naming the offending id.
import { expect, test } from 'vitest'
import { buildVisualTable, ManifestError, VISUAL_TABLE_BYTES, validateManifest } from './art.js'

const VALID = {
  version: 1,
  image: 'tiles.png',
  tile_px: 16,
  columns: 4,
  visuals: {
    0: { first: 0, variants: 1, flags: [], priority: 0, band: 0 },
    5: { first: 1, variants: 2, flags: ['flip_x'], priority: 3, band: 1 },
  },
}

test('manifest: valid document round-trips', () => {
  const m = validateManifest(VALID)
  expect(m.image).toBe('tiles.png')
  expect(m.visuals['5']).toEqual({ first: 1, variants: 2, flags: ['flip_x'], priority: 3, band: 1 })
})

test('manifest: schema errors', () => {
  expect(() => validateManifest(null)).toThrow(ManifestError)
  expect(() => validateManifest({ ...VALID, version: 2 })).toThrow(/version/)
  expect(() => validateManifest({ ...VALID, image: '' })).toThrow(/image/)
  expect(() => validateManifest({ ...VALID, tile_px: 0 })).toThrow(/tile_px/)
  expect(() => validateManifest({ ...VALID, columns: -1 })).toThrow(/columns/)
  expect(() => validateManifest({ ...VALID, visuals: null })).toThrow(/visuals/)

  // Visual id out of range (0018 §4: 1,024 visuals, ids [0, 1024)) names the offending id.
  expect(() => validateManifest({ ...VALID, visuals: { 1024: VALID.visuals[0] } })).toThrow(/1024/)
  expect(() => validateManifest({ ...VALID, visuals: { '-1': VALID.visuals[0] } })).toThrow(/-1/)
  expect(() => validateManifest({ ...VALID, visuals: { x: VALID.visuals[0] } })).toThrow(/'x'/)

  // Per-visual field errors, each naming the visual id.
  expect(() =>
    validateManifest({
      ...VALID,
      visuals: { 3: { first: -1, variants: 1, flags: [], priority: 0, band: 0 } },
    }),
  ).toThrow(/visual '3'/)
  expect(() =>
    validateManifest({
      ...VALID,
      visuals: { 3: { first: 0, variants: 0, flags: [], priority: 0, band: 0 } },
    }),
  ).toThrow(/visual '3'/)
  expect(() =>
    validateManifest({
      ...VALID,
      visuals: { 3: { first: 255, variants: 5, flags: [], priority: 0, band: 0 } },
    }),
  ).toThrow(/256 cells/)
  expect(() =>
    validateManifest({
      ...VALID,
      visuals: { 3: { first: 0, variants: 1, flags: ['spin'], priority: 0, band: 0 } },
    }),
  ).toThrow(/flag/)
  expect(() =>
    validateManifest({
      ...VALID,
      visuals: { 3: { first: 0, variants: 1, flags: [], priority: -1, band: 0 } },
    }),
  ).toThrow(/priority/)
  expect(() =>
    validateManifest({
      ...VALID,
      visuals: { 3: { first: 0, variants: 1, flags: [], priority: 0, band: -1 } },
    }),
  ).toThrow(/band/)

  // Over the 1,024-visual limit.
  const tooMany: Record<string, unknown> = {}
  for (let i = 0; i < 1025; i++)
    tooMany[i] = { first: 0, variants: 1, flags: [], priority: 0, band: 0 }
  expect(() => validateManifest({ ...VALID, visuals: tooMany })).toThrow(/1024/)
})

test('manifest: buildVisualTable packs the fixed 16 KiB layout', () => {
  const m = validateManifest(VALID)
  const bytes = buildVisualTable(m)
  expect(bytes.length).toBe(VISUAL_TABLE_BYTES)
  const view = new DataView(bytes.buffer)
  // Visual 5: first=1, variants=2, flags=flip_x (bit 0), priority=3, band=1.
  const base = 5 * 16
  expect(view.getUint32(base + 0, true)).toBe(1 | (2 << 16))
  expect(view.getUint32(base + 4, true)).toBe(1 | (3 << 16))
  expect(view.getUint32(base + 8, true)).toBe(1)
  expect(view.getUint32(base + 12, true)).toBe(0)
  // An id never registered stays all-zero.
  expect(view.getUint32(7 * 16, true)).toBe(0)
})
