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
