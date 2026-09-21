// Terrain fragment shader (docs/decisions/0018-renderer.md §3, §5; docs/plan/09-renderer-terrain.md
// Planning decisions "Bind group layout"; docs/plan/09b-terrain-art-and-lifecycle.md Scope, Order of
// work steps 1-2): one full-viewport triangle, the fragment maps pixel -> tile -> chunk -> slot ->
// texel -> art. Through this step: a PCG hash of (tile_x, tile_y, seed) picks a variant and
// flip/rotate/brightness jitter; magnification uses a "fat pixel" bilinear seam formula, minification
// uses trilinear mips (`render/mips.ts`); jitter fades out below 1 screen px per art texel. Stateless
// edge dithering is step 3. Edit this file, then run `node scripts/embed-wgsl.mjs`
// (packages/engine/CLAUDE.md).

struct FrameUniform {
  cam_tile: vec2<i32>,
  cam_frac: vec2<f32>,
  viewport_px: vec2<f32>,
  tiles_per_px: f32,
  seed: u32,
  cursor_tile: vec2<i32>,
  cursor_valid: u32,
  neighbour_cutoff_px: f32,
}

// A fixed-size array cannot be a uniform-address-space variable's type directly (WGSL requires it
// wrapped in a struct for the buffer's memory-layout rules; verified against
// https://www.w3.org/TR/WGSL/, 2026-09-20): `VisualTable.entries` is the 1,024 x 16 B table of 0018
// §3, `entries[id].x = first | variants << 16`, `.y = flags | priority << 16`, `.z = band`.
struct VisualTable {
  entries: array<vec4<u32>, 1024>,
}

@group(0) @binding(0) var<uniform> frame: FrameUniform;
@group(0) @binding(1) var page_tex: texture_2d<u32>;
@group(0) @binding(2) var indir_tex: texture_2d<u32>;
@group(0) @binding(3) var<uniform> visual_table: VisualTable;
@group(0) @binding(4) var art_tex: texture_2d_array<f32>;
@group(0) @binding(5) var art_sampler: sampler;

// 0007 §3 ("CHUNK_BITS is 5 here", docs/plan/09-renderer-terrain.md Planning decisions): every
// chunk/page/indirection size below is derived from this one constant.
const CHUNK_BITS: u32 = 5u;
const CHUNK_MASK: i32 = 31; // (1 << CHUNK_BITS) - 1
const SLOTS_PER_ROW: i32 = 32; // 1024 page px / 32 px per slot
const INDIR_MASK: i32 = 63; // 64x64 toroidal window, fixed regardless of chunk size (0018 §3)
const INDIR_NONE: u32 = 0xFFFFu;
// Sentinel `lookup_visual` returns for "chunk not resident at this tile" -- distinct from every real
// visual id (0018 §4 caps those at 1,024). Step 3 also uses this for a dithering neighbour.
const VISUAL_MISSING: u32 = 0xFFFFu;

// A colour no tile-art cell in this milestone's fixture uses (docs/plan/09-renderer-terrain.md
// Deviations): 32/255 exactly, so the `rgba8unorm` readback round-trips bit-for-bit.
const NEUTRAL_COLOR: vec4<f32> = vec4<f32>(32.0 / 255.0, 32.0 / 255.0, 32.0 / 255.0, 1.0);

// Visual-table flag bits (`render/art.ts`'s own `FLAG_BITS`): which transforms a visual *allows*;
// the per-tile PCG hash below decides whether one instance of it actually applies one.
const FLAG_FLIP_X: u32 = 1u;
const FLAG_FLIP_Y: u32 = 2u;
const FLAG_ROTATE: u32 = 4u;

// Brightness jitter's amplitude (docs/plan/09b-terrain-art-and-lifecycle.md Deviations: 0018 §3
// names the feature, not a magnitude): chosen small enough that every flat-colour probe in this
// milestone's fixture stays inside 0020 §6's 2/255 tolerance without a test needing to model it.
const JITTER_AMPLITUDE: f32 = 1.0 / 255.0;

struct VOut {
  @builtin(position) pos: vec4<f32>,
}

// Fullscreen triangle, no vertex buffer (0018 §2's "one triangle, one draw").
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VOut {
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out: VOut;
  out.pos = vec4<f32>(corners[vertex_index], 0.0, 1.0);
  return out;
}

// Euclidean remainder for a power-of-two `m` (`m - 1` passed as `mask`): equal to Rust's
// `rem_euclid` for any `i32`, including negative values, because two's-complement `&` already wraps
// toroidally (docs/plan/09-renderer-terrain.md Deviations: proved by `terrain.far_from_origin_exact`
// -- chunk (1<<18, 1<<18) and chunk (0, 0) share the same masked cell since 2^18 is a multiple of 64).
fn wrap_mask(v: i32, mask: i32) -> u32 {
  return u32(v & mask);
}

// One PCG3D permutation round (Mark Jarzynski & Marc Olano, "Hash Functions for GPU Rendering",
// JCGT 2020): u32-only add/mul/xor/shift, so it wraps identically here and in a JS reference built
// with `Math.imul`/`>>> 0` (docs/plan/09b-terrain-art-and-lifecycle.md Planning decisions
// "Reference implementation of the hash in the test, not a golden image").
fn pcg3d(v_in: vec3<u32>) -> vec3<u32> {
  var v = v_in * vec3<u32>(1664525u) + vec3<u32>(1013904223u);
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v = v ^ (v >> vec3<u32>(16u));
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

// `bitcast<u32>`, not `u32(...)`: `tile.x`/`tile.y` may be negative and the hash needs the raw
// 32-bit pattern (matching a JS reference's `x >>> 0`), not a saturating/implementation-defined
// numeric conversion.
fn tile_hash(tile: vec2<i32>) -> vec3<u32> {
  return pcg3d(vec3<u32>(bitcast<u32>(tile.x), bitcast<u32>(tile.y), frame.seed));
}

// Visual-id lookup through the indirection path. Returns `VISUAL_MISSING` when the chunk at `tile`
// is not resident; `fs_main` substitutes the neutral colour in that case.
fn lookup_visual(tile: vec2<i32>) -> u32 {
  let chunk = vec2<i32>(tile.x >> CHUNK_BITS, tile.y >> CHUNK_BITS);
  let local = vec2<i32>(tile.x & CHUNK_MASK, tile.y & CHUNK_MASK);
  let indir_coord = vec2<i32>(i32(wrap_mask(chunk.x, INDIR_MASK)), i32(wrap_mask(chunk.y, INDIR_MASK)));
  let slot = textureLoad(indir_tex, indir_coord, 0).r;
  if (slot == INDIR_NONE) {
    return VISUAL_MISSING;
  }
  let slot_origin = vec2<i32>((i32(slot) % SLOTS_PER_ROW) * 32, (i32(slot) / SLOTS_PER_ROW) * 32);
  let texel = textureLoad(page_tex, slot_origin + local, 0);
  // 0018 §3's texel format: g = 0 means "no resource", so the base layer shows through.
  return select(texel.r, texel.g, texel.g != 0u);
}

// Samples `visual_id`'s art at tile-local `uv_in` (the fragment's `art_frac`, [0, 1) per axis before
// any flip/rotate), applying this visual's own PCG-hash variant/flip/rotate. `lod` is 0 for the
// magnified "fat pixel" path (explicit level, the seam formula's own snap), or the minified
// trilinear mip level otherwise -- always a value derived purely from `frame.tiles_per_px` (uniform
// across the whole draw call), so every texture-sample call below uses an *explicit* level and
// never an implicit-derivative `textureSample`/`fwidth` (docs/plan/09b-terrain-art-and-lifecycle.md
// Deviations: this sidesteps WGSL's uniform-control-flow restriction on implicit derivatives
// entirely, rather than relying on it being satisfied).
fn sample_tile_art(tile: vec2<i32>, visual_id: u32, uv_in: vec2<f32>, lod: f32) -> vec4<f32> {
  let entry = visual_table.entries[visual_id];
  let first_layer = entry.x & 0xFFFFu;
  let variant_count = max(entry.x >> 16u, 1u);
  let flags = entry.y & 0xFFFFu;

  let h = tile_hash(tile);
  let variant = h.x % variant_count;
  let layer = i32(first_layer + variant);

  var uv = uv_in;
  if ((flags & FLAG_ROTATE) != 0u && (h.y & 4u) != 0u) {
    uv = uv.yx;
  }
  if ((flags & FLAG_FLIP_X) != 0u && (h.y & 1u) != 0u) {
    uv.x = 1.0 - uv.x;
  }
  if ((flags & FLAG_FLIP_Y) != 0u && (h.y & 2u) != 0u) {
    uv.y = 1.0 - uv.y;
  }

  if (lod <= 0.0) {
    // "Fat pixel" seam formula (0018 §3 sources: gpu-tilemap-rendering, pixel_art_filtering): snap
    // toward the nearest texel centre in proportion to screen pixels per art texel, avoiding blur
    // under magnification. The screen-to-tile mapping is affine (0018 §5: no perspective, one
    // `tiles_per_px` scalar for the whole frame), so the derivative of `uv * art_size` w.r.t. screen
    // pixels is the *same uniform constant* everywhere -- computed here in closed form rather than
    // with the `fwidth` builtin.
    let art_size = vec2<f32>(textureDimensions(art_tex, 0));
    let texel = uv * art_size;
    let texel_per_px = max(vec2<f32>(frame.tiles_per_px * art_size.x), vec2<f32>(1e-6));
    let centre_offset = fract(texel) - 0.5;
    let seamed =
      floor(texel) + clamp(centre_offset / (texel_per_px * 0.5), vec2<f32>(-0.5), vec2<f32>(0.5)) +
      0.5;
    return textureSampleLevel(art_tex, art_sampler, seamed / art_size, layer, 0.0);
  }
  return textureSampleLevel(art_tex, art_sampler, uv, layer, lod);
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
  let half_viewport = frame.viewport_px * 0.5;
  // 0018 §5: rel = (px - half) * tiles_per_px + cam_frac, then tile = cam_tile + floor(rel), all in
  // i32/f32 -- precision is independent of distance from the world origin.
  let rel = (frag_coord.xy - half_viewport) * frame.tiles_per_px + frame.cam_frac;
  let rel_floor = floor(rel);
  let tile = frame.cam_tile + vec2<i32>(rel_floor);

  let visual_id = lookup_visual(tile);
  if (visual_id == VISUAL_MISSING) {
    return NEUTRAL_COLOR;
  }

  let art_size_f = f32(textureDimensions(art_tex, 0).x);
  // Art texels per screen pixel: 0 or less means magnified (>= 1 screen px per art texel), the
  // explicit-LOD equivalent of `log2(texels-per-pixel)`, clamped at 0. `px_per_texel`'s own inverse
  // gives the fade-out factor below 1 screen px per art texel (Scope).
  let texels_per_px = frame.tiles_per_px * art_size_f;
  let lod = max(0.0, log2(max(texels_per_px, 1e-6)));
  let px_per_texel = 1.0 / max(texels_per_px, 1e-6);
  let fade = clamp(px_per_texel, 0.0, 1.0);

  let art_frac = rel - rel_floor;
  var out_color = sample_tile_art(tile, visual_id, art_frac, lod);

  // Brightness jitter: one more PCG3D lane off the same per-tile hash (recomputed here rather than
  // threaded out of `sample_tile_art`, which has no tuple return -- one more u32 hash, not a texture
  // fetch).
  let jitter_hash = tile_hash(tile).z;
  let jitter = (f32(jitter_hash & 0xFFu) / 255.0 - 0.5) * 2.0 * JITTER_AMPLITUDE * fade;
  out_color = vec4<f32>(
    clamp(out_color.rgb + vec3<f32>(jitter), vec3<f32>(0.0), vec3<f32>(1.0)),
    out_color.a,
  );

  return out_color;
}
