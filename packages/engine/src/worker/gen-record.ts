// The 16-byte genRequest/genResult record header (docs/plan/08b-gen-workers-and-queue.md, Seams:
// "Records (little-endian): request, 16 bytes [cx i32][cy i32][0 u32][0 u32]; result, 16 +
// slab_bytes: the same header followed by the tile bytes of GenOut."). Shared by `worker/gen.ts`
// (decodes a request, encodes a result header) so the layout is proven once, directly, by a unit
// test (`gen-record.test.ts`) instead of only indirectly through a browser page. Field readers stay
// individual, not object-returning: a hot-path caller (`worker/gen.ts`'s per-job loop) must not
// allocate a `{ cx, cy }` object per pass (`.claude/rules/hot-paths.md`).
export const GEN_RECORD_HEADER_BYTES = 16

export function readI32LE(u8: Uint8Array, off: number): number {
  return (
    (u8[off] as number) |
    ((u8[off + 1] as number) << 8) |
    ((u8[off + 2] as number) << 16) |
    ((u8[off + 3] as number) << 24) |
    0
  )
}

export function writeI32LE(u8: Uint8Array, off: number, v: number): void {
  u8[off] = v & 0xff
  u8[off + 1] = (v >>> 8) & 0xff
  u8[off + 2] = (v >>> 16) & 0xff
  u8[off + 3] = (v >>> 24) & 0xff
}

/** Writes a whole header at once: `[cx i32][cy i32][0 u32][0 u32]`, the two reserved trailing words
 * always zero. Allocation-free (writes through the given view, no object built or returned), so
 * `worker/gen.ts` can call it on its own per-job hot path. */
export function writeGenHeader(u8: Uint8Array, off: number, cx: number, cy: number): void {
  writeI32LE(u8, off, cx)
  writeI32LE(u8, off + 4, cy)
  writeI32LE(u8, off + 8, 0)
  writeI32LE(u8, off + 12, 0)
}
