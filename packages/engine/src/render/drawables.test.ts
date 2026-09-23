// docs/plan/17-drawlist-and-sprites.md Tests added, `unit` suite.
import { expect, test } from 'vitest'
import { packDrawColor, packDrawKindLayerFlags, UBERQUAD_VERTEX_LAYOUT } from './drawables.js'
import { UBERQUAD_WGSL } from './wgsl.generated.js'

const FORMAT_BYTES: Record<string, number> = {
  float32: 4,
  float32x2: 8,
  float32x3: 12,
  float32x4: 16,
  uint32: 4,
  unorm8x4: 4,
}

test('uberquad.vertex_layout_has_no_pick_id', () => {
  expect(UBERQUAD_VERTEX_LAYOUT.arrayStride).toBe(32)
  expect(UBERQUAD_VERTEX_LAYOUT.stepMode).toBe('instance')

  const attrs = [...UBERQUAD_VERTEX_LAYOUT.attributes].sort((a, b) => a.offset - b.offset)
  // Every byte of `Draw` (0018 §2) except `pick_id` (28..32) is covered exactly once, no gaps, no
  // overlaps.
  let cursor = 0
  for (const a of attrs) {
    expect(a.offset).toBe(cursor)
    const size = FORMAT_BYTES[a.format]
    expect(size, `unknown format ${a.format}`).toBeDefined()
    cursor += size as number
  }
  expect(cursor).toBe(28) // stops exactly before pick_id, bytes [28, 32) never bound.

  // `uberquad.wgsl`'s own `vs_main` declares exactly the five per-instance inputs above (locations
  // 0..4), no sixth `@location(5)` that would read `pick_id`'s own bytes.
  const vsMatch = UBERQUAD_WGSL.match(/fn vs_main\(([\s\S]*?)\) -> VOut/)
  expect(vsMatch, 'vs_main not found in uberquad.wgsl').toBeTruthy()
  const params = (vsMatch as RegExpMatchArray)[1] as string
  const locations = [...params.matchAll(/@location\((\d+)\)/g)].map((m) => Number(m[1]))
  expect(locations.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
})

test('drawables.pack_draw_color roundtrips rgba bytes', () => {
  const packed = packDrawColor(0x11, 0x22, 0x33, 0xff)
  const bytes = new Uint8Array(new Uint32Array([packed]).buffer)
  expect([...bytes]).toEqual([0x11, 0x22, 0x33, 0xff])
})

test('drawables.pack_draw_kind_layer_flags matches Draw::kind_sprite packing', () => {
  const packed = packDrawKindLayerFlags(2 /* KIND_RING */, 0, 5, 0x0a)
  const bytes = new Uint8Array(new Uint32Array([packed]).buffer)
  const kindSprite = (bytes[0] as number) | ((bytes[1] as number) << 8)
  expect(kindSprite >>> 12).toBe(2)
  expect(bytes[2]).toBe(5) // layer
  expect(bytes[3]).toBe(0x0a) // flags
})
