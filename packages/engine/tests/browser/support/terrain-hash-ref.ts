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

// M09b fix round 1 (item 1, "flip and rotate have zero pixel coverage"): mirrors `terrain.wgsl`'s
// `FLAG_FLIP_X`/`FLAG_FLIP_Y`/`FLAG_ROTATE` bit values exactly (`render/art.ts`'s own `FLAG_BITS`).
export const FLAG_FLIP_X = 1
export const FLAG_FLIP_Y = 2
export const FLAG_ROTATE = 4

export type Transform = {
  readonly rotate: boolean
  readonly flipX: boolean
  readonly flipY: boolean
}

/** Mirrors `sample_tile_art`'s flip/rotate selection exactly: which of a visual's *allowed*
 * transforms (`flagsMask`, the visual table's packed `flags` bitmask) this tile's hash turns on --
 * the `h.y` lane, one bit per transform, gated by the same bit in `flagsMask`. */
export function selectTransform(
  tileX: number,
  tileY: number,
  seed: number,
  flagsMask: number,
): Transform {
  const h = tileHash(tileX, tileY, seed)
  return {
    rotate: (flagsMask & FLAG_ROTATE) !== 0 && (h.y & FLAG_ROTATE) !== 0,
    flipX: (flagsMask & FLAG_FLIP_X) !== 0 && (h.y & FLAG_FLIP_X) !== 0,
    flipY: (flagsMask & FLAG_FLIP_Y) !== 0 && (h.y & FLAG_FLIP_Y) !== 0,
  }
}

/** Mirrors `sample_tile_art`'s uv-transform order exactly -- rotate (`uv = uv.yx`), *then* flip_x,
 * *then* flip_y -- applied to a tile-local `[x, y]` in `[0, 1)` per axis (the fragment's own
 * `art_frac`, before any transform). Getting this order or either flip's sign wrong changes which
 * quadrant a transformed probe point falls into for at least one of the 8 hash-bit combinations
 * `terrain.flip_and_rotate_match_reference` drives, so a wrong order/sign fails that test even
 * though a same-diagonal probe point (`x === y`) would not (a plain transpose is invisible there). */
export function applyTransform(uv: readonly [number, number], t: Transform): [number, number] {
  let [x, y] = uv
  if (t.rotate) {
    const swapped = y
    y = x
    x = swapped
  }
  if (t.flipX) x = 1 - x
  if (t.flipY) y = 1 - y
  return [x, y]
}

// M09b fix round 1 (item 2, "jitter is untestable by construction"): mirrors `terrain.wgsl`'s own
// `JITTER_AMPLITUDE` constant exactly -- **not** a value this reference is free to choose; it must
// track the shader's own constant of the same name (docs/plan/09b-terrain-art-and-lifecycle.md
// Deviations records why 1/255 was picked, but this reference does not re-derive it).
export const JITTER_AMPLITUDE = 1 / 255

/** Mirrors `fs_main`'s jitter computation exactly: `(jitter_hash / 255 - 0.5) * 2 *
 * JITTER_AMPLITUDE * fade`, a signed delta in normalised `[0, 1]` channel units (not yet scaled to
 * 0..255 or applied to a colour -- `jitteredChannelByte` below does both). `fade` is the caller's
 * own `clamp(1 / (tilesPerPx * artSize), 0, 1)` (same formula `fs_main` computes from
 * `frame.tiles_per_px`). */
export function jitterDelta(tileX: number, tileY: number, seed: number, fade: number): number {
  const jitterHash = tileHash(tileX, tileY, seed).z & 0xff
  return (jitterHash / 255 - 0.5) * 2 * JITTER_AMPLITUDE * fade
}

/** Mirrors the shader's own `clamp(out_color.rgb + vec3(jitter), 0, 1)` for one channel, plus the
 * `rgba8unorm` render target's own float-to-8-bit-unorm rounding on the way out (`round(x * 255)`,
 * ties away from zero -- the convention this reference found to match the real readback exactly,
 * `terrain.jitter_matches_reference`'s own Deviations note). `base255` is the flat cell's own stored
 * channel value (0..255). */
export function jitteredChannelByte(base255: number, delta: number): number {
  const normalised = base255 / 255
  const jittered = Math.min(1, Math.max(0, normalised + delta))
  return Math.round(jittered * 255)
}
