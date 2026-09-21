// Shared TS reference for `terrain.wgsl`'s PCG3D-based variant hash (docs/plan/
// 09b-terrain-art-and-lifecycle.md Planning decisions: "Reference implementation of the hash in the
// test, not a golden image ... recomputes the PCG hash in TypeScript and predicts which variant cell
// each probed tile shows; integer hashes are exact on every GPU (0018 §3), so this holds on Metal
// and SwiftShader alike"). Mirrors `pcg3d`/`tile_hash`/`sample_tile_art`'s variant-selection line in
// `terrain.wgsl` exactly: every operation is u32 add/mul/xor/shift, computed here with `Math.imul`
// (32-bit wrapping multiply) and `>>> 0` (unsigned 32-bit wrapping add/shift/bit-reinterpret), so the
// two implementations agree bit for bit -- test-only, not part of this milestone's Seams.
export type Hash3 = { x: number; y: number; z: number }

function add32(a: number, b: number): number {
  return (a + b) >>> 0
}

function mul32(a: number, b: number): number {
  return Math.imul(a, b) >>> 0
}

/** Mirrors `pcg3d` in `terrain.wgsl` exactly (Mark Jarzynski & Marc Olano, "Hash Functions for GPU
 * Rendering", JCGT 2020). */
export function pcg3d(vIn: Hash3): Hash3 {
  let x = add32(mul32(vIn.x, 1664525), 1013904223)
  let y = add32(mul32(vIn.y, 1664525), 1013904223)
  let z = add32(mul32(vIn.z, 1664525), 1013904223)
  x = add32(x, mul32(y, z))
  y = add32(y, mul32(z, x))
  z = add32(z, mul32(x, y))
  // `v ^= v >> 16u` (WGSL/GLSL): each component XORs with its *own* right-shift -- x with x, not
  // with y (an earlier draft transcribed this as a cross-component shift, caught by this test's own
  // first run against the real shader disagreeing with the reference, Deviations).
  x = (x ^ (x >>> 16)) >>> 0
  y = (y ^ (y >>> 16)) >>> 0
  z = (z ^ (z >>> 16)) >>> 0
  x = add32(x, mul32(y, z))
  y = add32(y, mul32(z, x))
  z = add32(z, mul32(x, y))
  return { x, y, z }
}

/** Mirrors `tile_hash` in `terrain.wgsl`: `bitcast<u32>(tile.x)`'s exact TS equivalent is `x >>> 0`
 * (both reinterpret a 32-bit two's-complement bit pattern as unsigned, with no rounding or
 * saturation, so a negative tile coordinate hashes identically in both languages). */
export function tileHash(tileX: number, tileY: number, seed: number): Hash3 {
  return pcg3d({ x: tileX >>> 0, y: tileY >>> 0, z: seed >>> 0 })
}

/** Mirrors `sample_tile_art`'s variant selection: `h.x % variant_count`. */
export function selectVariant(
  tileX: number,
  tileY: number,
  seed: number,
  variantCount: number,
): number {
  return tileHash(tileX, tileY, seed).x % variantCount
}
