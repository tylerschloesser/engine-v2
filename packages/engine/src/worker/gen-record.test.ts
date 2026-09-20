import { expect, test } from 'vitest'
import { GEN_RECORD_HEADER_BYTES, readI32LE, writeGenHeader, writeI32LE } from './gen-record.js'

test('gen record layout', () => {
  const u8 = new Uint8Array(GEN_RECORD_HEADER_BYTES)
  writeGenHeader(u8, 0, 7, -3)

  // [cx i32][cy i32][0 u32][0 u32] (docs/plan/08b-gen-workers-and-queue.md, Seams).
  expect(readI32LE(u8, 0)).toBe(7)
  expect(readI32LE(u8, 4)).toBe(-3)
  expect(readI32LE(u8, 8)).toBe(0)
  expect(readI32LE(u8, 12)).toBe(0)

  // Little-endian: byte 0 is the low byte of cx.
  expect(Array.from(u8.subarray(0, 4))).toEqual([7, 0, 0, 0])
  // -3 as i32 little-endian: 0xfffffffd.
  expect(Array.from(u8.subarray(4, 8))).toEqual([0xfd, 0xff, 0xff, 0xff])
})

test('gen record layout: readI32LE/writeI32LE round-trip negative and large values', () => {
  const u8 = new Uint8Array(8)
  writeI32LE(u8, 0, -2147483648)
  writeI32LE(u8, 4, 2147483647)
  expect(readI32LE(u8, 0)).toBe(-2147483648)
  expect(readI32LE(u8, 4)).toBe(2147483647)
})

test('gen record layout: a result record places the header before GenOut bytes', () => {
  // 16-byte header followed by a 4-byte "GenOut" payload (Seams: "16 + slab_bytes: the same header
  // followed by the tile bytes of GenOut").
  const slabBytes = 4
  const u8 = new Uint8Array(GEN_RECORD_HEADER_BYTES + slabBytes)
  writeGenHeader(u8, 0, 1, 2)
  const genOut = new Uint8Array([9, 8, 7, 6])
  u8.set(genOut, GEN_RECORD_HEADER_BYTES)

  expect(readI32LE(u8, 0)).toBe(1)
  expect(readI32LE(u8, 4)).toBe(2)
  expect(Array.from(u8.subarray(GEN_RECORD_HEADER_BYTES))).toEqual([9, 8, 7, 6])
})
