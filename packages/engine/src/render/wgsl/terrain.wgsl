// Terrain fragment shader (docs/decisions/0018-renderer.md §3, §5; docs/plan/09-renderer-terrain.md
// Planning decisions "Bind group layout"): one full-viewport triangle, the fragment maps
// pixel -> tile -> chunk -> slot -> texel -> art. This milestone's sampling only: `textureLoad`,
// variant 0, nearest, no dithering; a non-resident chunk (indirection == NONE) draws a neutral
// colour. Edit this file, then run `node scripts/embed-wgsl.mjs` (packages/engine/CLAUDE.md).

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

// A colour no tile-art cell in this milestone's fixture uses (docs/plan/09-renderer-terrain.md
// Deviations): 32/255 exactly, so the `rgba8unorm` readback round-trips bit-for-bit.
const NEUTRAL_COLOR: vec4<f32> = vec4<f32>(32.0 / 255.0, 32.0 / 255.0, 32.0 / 255.0, 1.0);

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
// -- chunk (1<<18, 1<<18) and chunk (0, 0) share the same `& 63` cell since 2^18 is a multiple of 64).
fn wrap_mask(v: i32, mask: i32) -> u32 {
  return u32(v & mask);
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
  let half_viewport = frame.viewport_px * 0.5;
  // 0018 §5: rel = (px - half) * tiles_per_px + cam_frac, then tile = cam_tile + floor(rel), all in
  // i32/f32 -- precision is independent of distance from the world origin.
  let rel = (frag_coord.xy - half_viewport) * frame.tiles_per_px + frame.cam_frac;
  let rel_floor = floor(rel);
  let tile = frame.cam_tile + vec2<i32>(rel_floor);

  let chunk = vec2<i32>(tile.x >> CHUNK_BITS, tile.y >> CHUNK_BITS);
  let local = vec2<i32>(tile.x & CHUNK_MASK, tile.y & CHUNK_MASK);

  let indir_coord = vec2<i32>(i32(wrap_mask(chunk.x, INDIR_MASK)), i32(wrap_mask(chunk.y, INDIR_MASK)));
  let slot = textureLoad(indir_tex, indir_coord, 0).r;
  if (slot == INDIR_NONE) {
    return NEUTRAL_COLOR;
  }

  let slot_origin = vec2<i32>((i32(slot) % SLOTS_PER_ROW) * 32, (i32(slot) / SLOTS_PER_ROW) * 32);
  let page_coord = slot_origin + local;
  let texel = textureLoad(page_tex, page_coord, 0);
  let base_visual = texel.r;
  let resource_visual = texel.g;
  // 0018 §3's texel format: g = 0 means "no resource", so the base layer shows through.
  let visual_id = select(base_visual, resource_visual, resource_visual != 0u);

  let entry = visual_table.entries[visual_id];
  let first_layer = entry.x & 0xFFFFu; // variants (entry.x >> 16) are M09b's

  let art_size = textureDimensions(art_tex, 0);
  let art_frac = rel - rel_floor; // fractional part of `rel`, in [0, 1)
  let art_texel = vec2<i32>(min(
    vec2<u32>(art_frac * vec2<f32>(art_size)),
    art_size - vec2<u32>(1u, 1u),
  ));
  return textureLoad(art_tex, art_texel, i32(first_layer), 0);
}
