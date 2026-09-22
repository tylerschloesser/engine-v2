// A manual byte-range copy. `TypedArray.prototype.set` cannot express a source-side sub-range
// without `subarray()`, which `sab.no_alloc_syntax` forbids outside a constructor (it allocates a
// view). Used on every ring/seqlock/triple/camera-block copy that reads or writes a variable
// sub-range of a caller-owned buffer.
export function copyBytes(
  dst: Uint8Array,
  dstOff: number,
  src: Uint8Array,
  srcOff: number,
  len: number,
): void {
  for (let i = 0; i < len; i++) dst[dstOff + i] = at(src, srcOff + i)
}

/** Trusted indexed read under `noUncheckedIndexedAccess` (`biome`'s `noNonNullAssertion` forbids
 * `!`; matches `src/test/harness.ts`'s existing `as WorkerHandle` idiom). Every caller here indexes
 * with a bound already checked against the array's own known length or slot count. */
export function at<T>(arr: { readonly [index: number]: T }, i: number): T {
  return arr[i] as T
}

/** A little-endian `u32` read from `u8[off..off+4)` with no `DataView` (a fresh allocation per
 * call) and no `subarray()`: plain arithmetic over `at()`, safe on a per-frame/per-message path
 * (`.claude/rules/hot-paths.md`). */
export function readU32LE(u8: Uint8Array, off: number): number {
  return (
    (at(u8, off) | (at(u8, off + 1) << 8) | (at(u8, off + 2) << 16) | (at(u8, off + 3) << 24)) >>> 0
  )
}

/** Little-endian write, the counterpart of `readU32LE`. */
export function writeU32LE(u8: Uint8Array, off: number, value: number): void {
  u8[off] = value & 0xff
  u8[off + 1] = (value >>> 8) & 0xff
  u8[off + 2] = (value >>> 16) & 0xff
  u8[off + 3] = (value >>> 24) & 0xff
}
