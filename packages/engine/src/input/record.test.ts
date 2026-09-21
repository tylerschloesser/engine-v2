import { expect, test } from 'vitest'
import { INPUT_RECORD_BYTES, InputKind, writeInputRecord } from './record.js'

test('input: record layout golden', () => {
  // Field values chosen to catch a swapped field, a wrong offset, a sign error on the `i32` tile
  // pair, or a little/big-endian mistake (docs/plan/11-camera-and-input.md's own warning): every
  // byte distinct, a negative tile axis, a large positive one, and frac values (0.25/0.75) whose
  // IEEE-754 bit patterns are neither all-zero nor palindromic under a byte-order flip.
  const dst = new Uint8Array(INPUT_RECORD_BYTES)
  writeInputRecord(dst, 0, {
    kind: InputKind.Drag,
    button: 2,
    modifiers: 0b1011,
    pointer: 1,
    seq: 0x0102_0304,
    tileX: -7,
    tileY: 1_000_000,
    fracX: 0.25,
    fracY: 0.75,
    pickId: 0x0a0b_0c0d,
    timeMs: 0x1122_3344,
  })
  expect(Array.from(dst)).toEqual([
    0x05,
    0x02,
    0x0b,
    0x01, // kind=5 (drag), button=2, modifiers=0b1011, pointer=1 (touch)
    0x04,
    0x03,
    0x02,
    0x01, // seq = 0x0102_0304
    0xf9,
    0xff,
    0xff,
    0xff, // tile.x = -7
    0x40,
    0x42,
    0x0f,
    0x00, // tile.y = 1_000_000
    0x00,
    0x00,
    0x80,
    0x3e, // frac.x = 0.25f
    0x00,
    0x00,
    0x40,
    0x3f, // frac.y = 0.75f
    0x0d,
    0x0c,
    0x0b,
    0x0a, // pick_id = 0x0a0b_0c0d
    0x44,
    0x33,
    0x22,
    0x11, // time_ms = 0x1122_3344
  ])
})

test('input: record layout golden at a nonzero offset', () => {
  // A ring producer writes into a *slot's own* payload view, never at index 0 of the whole SAB
  // (`sab/ring.ts`): this proves the encoder writes relative to `offset`, leaving bytes before it
  // untouched.
  const dst = new Uint8Array(INPUT_RECORD_BYTES + 8)
  writeInputRecord(dst, 8, {
    kind: InputKind.Tap,
    button: 0,
    modifiers: 0,
    pointer: 0,
    seq: 1,
    tileX: 0,
    tileY: 0,
    fracX: 0,
    fracY: 0,
    pickId: 0,
    timeMs: 0,
  })
  expect(Array.from(dst.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(dst[8]).toBe(InputKind.Tap)
})
