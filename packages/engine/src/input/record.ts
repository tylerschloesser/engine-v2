// The `inputRing` wire record (docs/decisions/0019-camera-input-and-overlay.md §4; docs/plan/
// 11-camera-and-input.md Seams, `inputRing` record: 32 bytes, little-endian, one per recognized
// semantic event). `writeInputRecord` is the single encoder both `input/semantic.ts`'s ring
// producer and this file's own golden test go through -- pure, allocation-free (`.claude/rules/
// hot-paths.md`: this runs on the semantic-recognition path, once per emitted event, which is
// normal play, not a rare discontinuity).
//
// Layout: `0 kind u8`, `1 button u8`, `2 modifiers u8` (bit 0 shift, 1 ctrl, 2 alt, 3 meta),
// `3 pointer u8` (0 mouse, 1 touch, 2 pen), `4 seq u32`, `8 tile i32x2`, `16 frac f32x2`,
// `24 pick_id u32`, `28 time_ms u32` (wrapping).

export const INPUT_RECORD_BYTES = 32

export const InputKind = {
  Tap: 1,
  Hover: 2,
  Longpress: 3,
  DragStart: 4,
  Drag: 5,
  DragEnd: 6,
} as const
export type InputKindValue = (typeof InputKind)[keyof typeof InputKind]

export type InputRecordFields = {
  kind: InputKindValue
  button: number
  modifiers: number
  pointer: number
  seq: number
  tileX: number
  tileY: number
  fracX: number
  fracY: number
  pickId: number
  timeMs: number
}

function writeU32LE(dst: Uint8Array, off: number, v: number): void {
  dst[off] = v & 0xff
  dst[off + 1] = (v >>> 8) & 0xff
  dst[off + 2] = (v >>> 16) & 0xff
  dst[off + 3] = (v >>> 24) & 0xff
}

// Two's-complement bit patterns are identical for a signed or unsigned 32-bit value: the same
// byte-splitting that writes `seq`/`pick_id`/`time_ms` (`u32`) also writes `tile.x`/`tile.y`
// (`i32`) correctly, negative values included (JS's bitwise operators already work on a 32-bit
// two's-complement representation).
const writeI32LE = writeU32LE

// A module-level scratch pair (created once, `.claude/rules/hot-paths.md`): `Float32Array`/
// `Uint8Array` views over the *same* 4-byte buffer, so writing the float and reading its LE bytes
// back needs no per-call allocation. Every real engine (x86, ARM, wasm32) is little-endian, the
// same assumption `sab/block.ts`'s typed-array views already make.
const f32Scratch = new Float32Array(1)
const f32Bytes = new Uint8Array(f32Scratch.buffer)

function writeF32LE(dst: Uint8Array, off: number, v: number): void {
  f32Scratch[0] = v
  dst[off] = f32Bytes[0] as number
  dst[off + 1] = f32Bytes[1] as number
  dst[off + 2] = f32Bytes[2] as number
  dst[off + 3] = f32Bytes[3] as number
}

/** Writes one `INPUT_RECORD_BYTES`-byte record at `dst[offset..offset+32)`. `dst` is any
 * caller-owned byte view (a ring slot's payload view in production; a plain `Uint8Array` in a
 * test) -- this function never allocates one itself. */
export function writeInputRecord(dst: Uint8Array, offset: number, f: InputRecordFields): void {
  dst[offset] = f.kind
  dst[offset + 1] = f.button
  dst[offset + 2] = f.modifiers
  dst[offset + 3] = f.pointer
  writeU32LE(dst, offset + 4, f.seq >>> 0)
  writeI32LE(dst, offset + 8, f.tileX | 0)
  writeI32LE(dst, offset + 12, f.tileY | 0)
  writeF32LE(dst, offset + 16, f.fracX)
  writeF32LE(dst, offset + 20, f.fracY)
  writeU32LE(dst, offset + 24, f.pickId >>> 0)
  writeU32LE(dst, offset + 28, f.timeMs >>> 0)
}
