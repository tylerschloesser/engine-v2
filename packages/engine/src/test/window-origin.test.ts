// M39aa: a DrawRecord's `pos` is relative to the frame's window origin (0018 section 2), which jumps by 64 tiles
// when the camera crosses a multiple of 64. `check.ts world()` adds `windowOriginOf` back: the same world point read
// from a camera on either side of the boundary must give the same position (the Pixel round's 64.000 "jump").
import { expect, test } from 'vitest'
import { createDrawListSlot } from '../render/drawlist-slot.js'
import { DRAWLIST_BODY_BYTES, DRAWLIST_HEADER_BYTES } from '../sab/layout.js'
import { createTriple, TripleWriter } from '../sab/triple.js'
import { type DrawRecord, decodeSlotRecords, windowOriginOf } from './client.js'

/** Publish one frame with one record at `rel` (tiles relative to `origin`); returns the world position read back. */
function worldRead(origin: [number, number], rel: [number, number]): [number, number] {
  const sab = createTriple(DRAWLIST_HEADER_BYTES, DRAWLIST_BODY_BYTES)
  const writer = new TripleWriter(sab, DRAWLIST_HEADER_BYTES, DRAWLIST_BODY_BYTES)
  const slot = createDrawListSlot(sab)
  const back = writer.backSlot()
  const h = writer.headerView(back)
  const hv = new DataView(h.buffer, h.byteOffset, h.byteLength)
  hv.setUint32(0, 1, true)
  hv.setUint32(4, 1, true)
  hv.setInt32(8, origin[0], true)
  hv.setInt32(12, origin[1], true)
  const b = writer.bodyView(back)
  const bv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  bv.setFloat32(0, rel[0], true)
  bv.setFloat32(4, rel[1], true)
  bv.setUint16(16, 1 << 12, true) // kind circle
  writer.publish()
  slot.acquire()
  const out: DrawRecord[] = []
  decodeSlotRecords(slot, out)
  const o = windowOriginOf(slot)
  const r = out[0] as DrawRecord
  return [r.pos[0] + o.x, r.pos[1] + o.y]
}

test('window_origin: a world position is the same with the camera either side of a 64-tile boundary', () => {
  const west = worldRead([-64, 0], [64.52, 0.52]) // camera centre at x < 0
  const east = worldRead([0, 0], [0.52, 0.52]) // the next frame, centre at x >= 0
  expect(west[0]).toBeCloseTo(0.52, 5)
  expect(east[0]).toBeCloseTo(0.52, 5)
  // f32 keeps ~7 digits, so the two reads agree to well under a millimetre-tile, not bit for bit
  expect(west[0]).toBeCloseTo(east[0], 4)
  expect(west[1]).toBeCloseTo(east[1], 4)
  const n = worldRead([0, -64], [3.5, 64.25]) // a negative y origin
  expect(n[1]).toBeCloseTo(0.25, 4)
})
