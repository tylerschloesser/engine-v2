// docs/plan/18-picking-and-overlay.md Order of work step 1: "pick.ts with unit tests on hand-built
// slots" -- a header + body built by hand (no SAB, no client, no worker), exercising
// `scanDrawListForPick` directly against the exact byte layout `render/drawables.ts`'s own
// `packDrawKindLayerFlags` produces (0018 §2).
import { expect, test } from 'vitest'
import {
  ANCHOR_CURSOR_TILE,
  DRAW_BYTES,
  KIND_BAR,
  KIND_CIRCLE,
  KIND_GHOST,
  KIND_RADIAL,
  KIND_RECT,
  KIND_RING,
  LAYER_COUNT,
  packDrawKindLayerFlags,
  SCREEN_PX_STROKE,
} from '../render/drawables.js'
import { MIN_STROKE_PICK_RADIUS_PX, scanDrawListForPick } from './pick.js'

const HEADER_BYTES = 1024
const HEADER_OFF_LAYER_COUNT = 16
const DRAW_OFF_POS = 0
const DRAW_OFF_SIZE = 8
const DRAW_OFF_KIND_LAYER_FLAGS = 16
const DRAW_OFF_PICK_ID = 28

type DrawSpec = {
  posX: number
  posY: number
  sizeX: number
  sizeY: number
  kind: number
  layer: number
  flags?: number
  pickId: number
}

/** Builds a header + body pair from a flat list of records, grouped into layers exactly the way
 * `DrawList::sort_into`'s stable counting sort would (ascending `layer`, original order preserved
 * within a layer -- the caller passes records already in the order it wants them "submitted"). */
function buildSlot(records: DrawSpec[]): { header: DataView; bodyView: DataView } {
  const byLayer: DrawSpec[][] = Array.from({ length: LAYER_COUNT }, () => [])
  for (const r of records) (byLayer[r.layer] as DrawSpec[]).push(r)
  const ordered = byLayer.flat()

  const headerBuf = new ArrayBuffer(HEADER_BYTES)
  const header = new DataView(headerBuf)
  let acc = 0
  for (let i = 0; i < LAYER_COUNT; i++) {
    header.setUint32(HEADER_OFF_LAYER_COUNT + i * 4, (byLayer[i] as DrawSpec[]).length, true)
    acc += (byLayer[i] as DrawSpec[]).length
  }
  header.setUint32(4, acc, true) // record_count (unused by the scan itself, kept for realism)

  const bodyBuf = new ArrayBuffer(Math.max(1, ordered.length) * DRAW_BYTES)
  const bodyView = new DataView(bodyBuf)
  ordered.forEach((r, i) => {
    const off = i * DRAW_BYTES
    bodyView.setFloat32(off + DRAW_OFF_POS, r.posX, true)
    bodyView.setFloat32(off + DRAW_OFF_POS + 4, r.posY, true)
    bodyView.setFloat32(off + DRAW_OFF_SIZE, r.sizeX, true)
    bodyView.setFloat32(off + DRAW_OFF_SIZE + 4, r.sizeY, true)
    bodyView.setUint32(
      off + DRAW_OFF_KIND_LAYER_FLAGS,
      packDrawKindLayerFlags(r.kind, 0, r.layer, r.flags ?? 0),
      true,
    )
    bodyView.setUint32(off + DRAW_OFF_PICK_ID, r.pickId, true)
  })
  return { header, bodyView }
}

function pick(records: DrawSpec[], relX: number, relY: number, minRadius = 0): number {
  const { header, bodyView } = buildSlot(records)
  return scanDrawListForPick(
    header,
    bodyView,
    relX,
    relY,
    minRadius,
    new Uint32Array(LAYER_COUNT),
    new Uint32Array(LAYER_COUNT),
  )
}

test('pick.contains_per_kind', () => {
  // Circle/ring/radial: distance from `pos` <= size.x / 2.
  const circle: DrawSpec = {
    posX: 10,
    posY: 10,
    sizeX: 4,
    sizeY: 4,
    kind: KIND_CIRCLE,
    layer: 0,
    pickId: 1,
  }
  expect(pick([circle], 10, 10)).toBe(1) // dead centre
  expect(pick([circle], 11.9, 10)).toBe(1) // just inside radius 2
  expect(pick([circle], 12.1, 10)).toBe(0) // just outside

  const ring: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 6,
    sizeY: 6,
    kind: KIND_RING,
    layer: 0,
    pickId: 2,
  }
  expect(pick([ring], 2.9, 0)).toBe(2) // inside the outer radius (0019 §4: "ring (outer radius)")
  expect(pick([ring], 3.1, 0)).toBe(0)

  const radial: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 2,
    sizeY: 2,
    kind: KIND_RADIAL,
    layer: 0,
    pickId: 3,
  }
  expect(pick([radial], 0.9, 0)).toBe(3)
  expect(pick([radial], 1.1, 0)).toBe(0)

  // Rect/bar/ghost: the axis-aligned box of `pos` and `size`, centred at `pos`.
  const rect: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 4,
    sizeY: 2,
    kind: KIND_RECT,
    layer: 0,
    pickId: 4,
  }
  expect(pick([rect], 1.9, 0.9)).toBe(4)
  expect(pick([rect], 2.1, 0)).toBe(0)
  expect(pick([rect], 0, 1.1)).toBe(0)

  const bar: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 4,
    sizeY: 1,
    kind: KIND_BAR,
    layer: 0,
    pickId: 5,
  }
  expect(pick([bar], 1.9, 0.4)).toBe(5)
  expect(pick([bar], 0, 0.6)).toBe(0)

  const ghost: DrawSpec = {
    posX: 5,
    posY: 5,
    sizeX: 1,
    sizeY: 1,
    kind: KIND_GHOST,
    layer: 0,
    pickId: 6,
  }
  expect(pick([ghost], 5.4, 5.4)).toBe(6)
  expect(pick([ghost], 5.6, 5.4)).toBe(0)

  // `SCREEN_PX_STROKE`: a minimum pick radius applies (a thin ring's own tiny `size` would
  // otherwise be nearly unpickable).
  const thinRing: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 0.1,
    sizeY: 0.1,
    kind: KIND_RING,
    layer: 0,
    flags: SCREEN_PX_STROKE,
    pickId: 7,
  }
  const minRadiusTiles = 2 // an arbitrary "6 CSS px" conversion for this test
  expect(pick([thinRing], minRadiusTiles - 0.1, 0, minRadiusTiles)).toBe(7)
  expect(pick([thinRing], minRadiusTiles + 0.1, 0, minRadiusTiles)).toBe(0)
  // Without the flag, the same tiny `size` is not floored to the minimum.
  const thinRingNoFlag: DrawSpec = { ...thinRing, flags: 0, pickId: 8 }
  expect(pick([thinRingNoFlag], minRadiusTiles - 0.1, 0, minRadiusTiles)).toBe(0)
})

test('pick.front_to_back_order', () => {
  // Two overlapping records on different layers: the higher layer wins regardless of submission
  // order (layers scanned high to low).
  const low: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 4,
    sizeY: 4,
    kind: KIND_CIRCLE,
    layer: 2,
    pickId: 1,
  }
  const high: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 4,
    sizeY: 4,
    kind: KIND_CIRCLE,
    layer: 5,
    pickId: 2,
  }
  expect(pick([low, high], 0, 0)).toBe(2)
  expect(pick([high, low], 0, 0)).toBe(2) // submission order to `buildSlot` doesn't matter here

  // Same layer, two overlapping records: the *last* submitted one wins (reverse within a layer --
  // it was drawn on top).
  const first: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 4,
    sizeY: 4,
    kind: KIND_CIRCLE,
    layer: 0,
    pickId: 10,
  }
  const second: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 4,
    sizeY: 4,
    kind: KIND_CIRCLE,
    layer: 0,
    pickId: 11,
  }
  expect(pick([first, second], 0, 0)).toBe(11)

  // A non-overlapping lower-priority record underneath is still found when the point misses the
  // one on top.
  const onTop: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 2,
    sizeY: 2,
    kind: KIND_CIRCLE,
    layer: 5,
    pickId: 20,
  }
  const underneath: DrawSpec = {
    posX: 5,
    posY: 5,
    sizeX: 2,
    sizeY: 2,
    kind: KIND_CIRCLE,
    layer: 0,
    pickId: 21,
  }
  expect(pick([onTop, underneath], 5, 5)).toBe(21)
})

test('pick.skips_zero_id_and_cursor_anchored', () => {
  const zeroId: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 4,
    sizeY: 4,
    kind: KIND_CIRCLE,
    layer: 5,
    pickId: 0,
  }
  const cursorAnchored: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 4,
    sizeY: 4,
    kind: KIND_CIRCLE,
    layer: 4,
    flags: ANCHOR_CURSOR_TILE,
    pickId: 99,
  }
  const real: DrawSpec = {
    posX: 0,
    posY: 0,
    sizeX: 4,
    sizeY: 4,
    kind: KIND_CIRCLE,
    layer: 0,
    pickId: 1,
  }
  // `zeroId` is on the highest layer and would otherwise win; `cursorAnchored` has a real, non-zero
  // `pick_id` and would otherwise win over `real` -- both must be skipped.
  expect(pick([zeroId, cursorAnchored, real], 0, 0)).toBe(1)

  // Nothing left to hit: 0.
  expect(pick([zeroId, cursorAnchored], 0, 0)).toBe(0)
})

test('pick.min_stroke_pick_radius_constant', () => {
  expect(MIN_STROKE_PICK_RADIUS_PX).toBe(6)
})
