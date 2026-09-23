// Uber-quad instanced shader (docs/decisions/0018-renderer.md §2, §4 "Shapes need no art"; docs/plan/
// 17-drawlist-and-sprites.md Scope, steps 4-6): one instanced draw per non-empty DrawList layer, six
// vertices (two triangles) per instance, drawing every `Draw` kind except sprite (M17b) by an SDF or
// simple coverage test in the fragment stage -- circle, ring, rect, progress bar, radial progress,
// tile ghost. `pick_id` (bytes 28..32 of a `Draw` record) is never bound as a vertex attribute (0018
// §2). Edit this file, then run `node scripts/embed-wgsl.mjs` (packages/engine/CLAUDE.md).
//
// Camera-relative placement mirrors `terrain.wgsl`'s own formula (0018 §5), run in reverse (world ->
// clip instead of pixel -> world): `px = half_viewport + (world_rel - cam_frac) / tiles_per_px`,
// `ndc = px / viewport_px * 2 - 1` (y flipped: framebuffer y is down, clip y is up). `world_rel` is
// this instance's own position relative to `cam_tile`, in continuous tile units, built from whichever
// anchor its `ANCHOR_CURSOR_TILE` flag selects (`window_origin` or the live `cursor_tile`) plus the
// DrawList's own per-record `pos` (already relative to that anchor, Rust's `DrawList::relative_pos`)
// plus this vertex's own offset within the instance's `size` box.

struct DrawFrame {
  cam_tile: vec2<i32>,
  cam_frac: vec2<f32>,
  window_origin: vec2<i32>,
  cursor_tile: vec2<i32>,
  viewport_px: vec2<f32>,
  tiles_per_px: f32,
  cursor_valid: u32,
}
@group(0) @binding(0) var<uniform> frame: DrawFrame;

// Sprite atlas + sprite table (docs/plan/17b-sprites-and-frame-budget.md Scope, Planning decisions
// "Sprite table in data textures, not uniforms"): `atlas_tex` is the padded, 2-mip sprite sheet
// (`render/atlas.ts`); `sprite_rect_tex`/`sprite_pivot_size_tex` are the 64x64 `rgba32float` data
// textures a sprite id addresses at `(id % 64, id / 64)` with `textureLoad` (unfilterable in
// compatibility mode, 0018 §7 -- loaded, never sampled). One bind group (Planning decisions).
@group(0) @binding(1) var atlas_tex: texture_2d_array<f32>;
@group(0) @binding(2) var atlas_sampler: sampler;
@group(0) @binding(3) var sprite_rect_tex: texture_2d<f32>;
@group(0) @binding(4) var sprite_pivot_size_tex: texture_2d<f32>;

const ANCHOR_CURSOR_TILE: u32 = 1u;
const SCREEN_PX_STROKE: u32 = 2u;
const FLIP_X: u32 = 8u;

const KIND_SPRITE: u32 = 0u;
const KIND_CIRCLE: u32 = 1u;
const KIND_RING: u32 = 2u;
const KIND_RECT: u32 = 3u;
const KIND_BAR: u32 = 4u;
const KIND_RADIAL: u32 = 5u;
const KIND_GHOST: u32 = 6u;

// `render/atlas.ts`'s own `SPRITE_TABLE_EDGE`/`SPRITE_MIP_LEVEL_COUNT` (duplicated the same way
// `DRAW_BYTES`/`CAPACITY` mirror `client/drawlist.rs`'s constants).
const SPRITE_TABLE_EDGE: u32 = 64u;
const SPRITE_MAX_LOD: f32 = 1.0; // SPRITE_MIP_LEVEL_COUNT - 1

/// `SCREEN_PX_STROKE`'s own fixed on-screen width (device pixels), applied to `KIND_RING`'s band
/// thickness -- the one kind here with a natural "stroke" (docs/plan/17-drawlist-and-sprites.md
/// steps 4-6 Deviations: the brief names the flag but not which kind(s) use it). 6, not a thinner
/// value: the AA transition (`aa`, below) is itself roughly 1 real screen pixel wide per edge, so a
/// band has to be several times that to leave any pixel at full unblended coverage for a probe.
const STROKE_PX: f32 = 6.0;
/// `KIND_RING`'s own default band thickness (a fraction of its radius) when `SCREEN_PX_STROKE` is
/// not set -- scales with the drawable's own world size, like every other unstroked kind.
const RING_THICKNESS_DEFAULT: f32 = 0.35;
const PI: f32 = 3.14159265358979;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) @interpolate(flat, either) kind: u32,
  @location(3) @interpolate(flat, either) flags: u32,
  @location(4) param: f32,
  @location(5) @interpolate(flat, either) stroke_uv: f32,
  // Sprite-only (docs/plan/17b-sprites-and-frame-budget.md steps 1-3): `sprite_rect` is frame 0's own
  // atlas rect in pixels (`fs_main` offsets it by the frame index); `sprite_world_size` is the
  // sprite's own size in tiles (`sprites.json`'s `size`) -- both looked up once per vertex from the
  // sprite tables (below) rather than a second `textureLoad` per fragment. Zero for every other kind.
  @location(6) @interpolate(flat, either) sprite_rect: vec4<f32>,
  @location(7) @interpolate(flat, either) sprite_world_size: vec2<f32>,
}

// Two triangles, six vertices, uv in [0, 1]^2 (`UBERQUAD_VERTEX_LAYOUT`'s own instance-step
// attributes are the other per-vertex inputs, `render/drawables.ts`).
fn quad_uv(vertex_index: u32) -> vec2<f32> {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
  );
  return corners[vertex_index];
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_index: u32,
  @location(0) inst_pos: vec2<f32>,
  @location(1) inst_size: vec2<f32>,
  @location(2) kind_layer_flags: u32,
  @location(3) color_raw: vec4<f32>,
  @location(4) param: f32,
) -> VOut {
  let kind = (kind_layer_flags >> 12u) & 0xFu;
  let flags = (kind_layer_flags >> 24u) & 0xFFu;

  var uv = quad_uv(vertex_index);
  if ((flags & FLIP_X) != 0u) {
    uv.x = 1.0 - uv.x;
  }

  var origin_tile = frame.window_origin;
  var hidden = false;
  if ((flags & ANCHOR_CURSOR_TILE) != 0u) {
    origin_tile = frame.cursor_tile;
    hidden = frame.cursor_valid == 0u;
  }

  // Sprite kind (docs/plan/17b-sprites-and-frame-budget.md steps 1-3): geometry is built from the
  // *unflipped* quad uv and the sprite's own pivot/size (looked up by sprite id, low 12 bits of
  // `kind_layer_flags` -- 0018 §2's own packing), never from `uv`/`inst_size` above -- `FLIP_X`
  // mirrors only the *sampled* texture (`sample_uv`, passed to `fs_main` as `out.uv`), never the
  // sprite's own world footprint (deliberately decoupled: flipping a sprite must not move it).
  // Every non-sprite kind is completely unaffected below: `pivot`/`box_size`/`box_uv` default to
  // `0.5`/`inst_size`/`uv` (the flipped uv, unchanged from before this kind existed).
  var pivot = vec2<f32>(0.5, 0.5);
  var box_size = inst_size;
  var box_uv = uv;
  var sample_uv = uv;
  var sprite_rect = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  var sprite_world_size = vec2<f32>(0.0, 0.0);
  if (kind == KIND_SPRITE) {
    let sprite_id = kind_layer_flags & 0xFFFu;
    let coord = vec2<i32>(i32(sprite_id % SPRITE_TABLE_EDGE), i32(sprite_id / SPRITE_TABLE_EDGE));
    let rect = textureLoad(sprite_rect_tex, coord, 0);
    let ps = textureLoad(sprite_pivot_size_tex, coord, 0);
    pivot = ps.xy;
    box_size = ps.zw;
    let raw = quad_uv(vertex_index);
    box_uv = raw;
    sample_uv = raw;
    if ((flags & FLIP_X) != 0u) {
      sample_uv.x = 1.0 - sample_uv.x;
    }
    sprite_rect = rect;
    sprite_world_size = box_size;
  }

  // `(origin_tile - cam_tile) - cam_frac`, then `+ inst_pos` (already relative to `origin_tile`,
  // Rust's own `relative_pos`) `+` this vertex's own offset inside the instance's own box (centred
  // at `pivot` for a sprite, at `0.5` -- box-centred -- for every other kind: the quad's own uv [0,1]
  // maps to `[-pivot, 1 - pivot] * box_size`).
  let rel_tile = vec2<f32>(origin_tile - frame.cam_tile) - frame.cam_frac;
  let quad_tiles = (box_uv - pivot) * box_size;
  let world_rel = rel_tile + inst_pos + quad_tiles;

  let half_viewport = frame.viewport_px * 0.5;
  let px = half_viewport + world_rel / frame.tiles_per_px;
  let ndc_x = (px.x / frame.viewport_px.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (px.y / frame.viewport_px.y) * 2.0;

  var out: VOut;
  out.pos = select(vec4<f32>(ndc_x, ndc_y, 0.0, 1.0), vec4<f32>(10.0, 10.0, 10.0, 1.0), hidden);
  out.uv = sample_uv;
  out.color = color_raw;
  out.kind = kind;
  out.flags = flags;
  out.param = param;
  // `STROKE_PX` device pixels -> world tiles (`* tiles_per_px`) -> this instance's own uv-space
  // fraction of `size.x` (`local = uv * 2 - 1` has derivative 2, folded into `fs_main`'s own use of
  // this value rather than here).
  out.stroke_uv = (STROKE_PX * frame.tiles_per_px) / max(inst_size.x, 1e-6);
  out.sprite_rect = sprite_rect;
  out.sprite_world_size = sprite_world_size;
  return out;
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let local = in.uv * 2.0 - vec2<f32>(1.0, 1.0);
  let dist = length(local);
  // Half `fwidth`: `smoothstep(x - aa, x + aa, ...)` is a `2 * aa`-wide transition, so this targets
  // roughly one real screen pixel of antialiasing per edge, not two (Deviations: chosen so `KIND_
  // RING`'s own band, only `STROKE_PX` wide, still has room for an unblended pixel at its middle).
  let aa = max(fwidth(dist) * 0.5, 1e-5);

  var alpha = 0.0;
  var frag_rgb = in.color.rgb;
  if (in.kind == KIND_CIRCLE) {
    alpha = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, dist);
  } else if (in.kind == KIND_RING) {
    let thickness_uv = select(RING_THICKNESS_DEFAULT, in.stroke_uv * 2.0, (in.flags & SCREEN_PX_STROKE) != 0u);
    let rt = clamp(thickness_uv, 0.02, 0.95);
    let outer_a = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, dist);
    let inner = 1.0 - rt;
    let inner_a = smoothstep(inner - aa, inner + aa, dist);
    alpha = outer_a * inner_a;
  } else if (in.kind == KIND_RECT) {
    alpha = 1.0;
  } else if (in.kind == KIND_BAR) {
    alpha = select(0.0, 1.0, in.uv.x <= in.param);
  } else if (in.kind == KIND_RADIAL) {
    let angle = atan2(local.x, -local.y);
    let norm_angle = select(angle, angle + 2.0 * PI, angle < 0.0) / (2.0 * PI);
    alpha = select(0.0, 1.0, dist <= 1.0 && norm_angle <= in.param);
  } else if (in.kind == KIND_GHOST) {
    alpha = 0.5;
  } else if (in.kind == KIND_SPRITE) {
    // Sprite sampling (docs/plan/17b-sprites-and-frame-budget.md steps 1-3; binding rule: anchor the
    // magnified path on `floor(texel + 0.5)`, never `floor(texel)` -- `docs/plan/
    // 09b-terrain-art-and-lifecycle.md` Deviations "Fix round 2" found the inverted form saturates to
    // a shared texel *edge* instead of the texel's own centre, blending ~50/50 with the neighbour
    // almost everywhere. This is the same formula as `terrain.wgsl`'s fixed `sample_tile_art`, redone
    // here per-axis (a sprite's rect need not be square relative to its own world size) and with an
    // explicit level clamped to `SPRITE_MAX_LOD` (only 2 mip levels exist, unlike tile art's full
    // pyramid).
    let atlas_dims = textureDimensions(atlas_tex, 0);
    let atlas_size = vec2<f32>(f32(atlas_dims.x), f32(atlas_dims.y));

    // "frames are laid out left to right from rect" (Seams): frame `i`'s rect is `rect` shifted by
    // `i * rect.w`; `param` carries the frame index here (Non-scope: "a game passes the frame in
    // param"), never rotation/progress for this kind.
    var frame_rect = in.sprite_rect;
    let frame_index = floor(max(in.param, 0.0));
    frame_rect.x = frame_rect.x + frame_index * frame_rect.z;

    // Art texels per screen pixel, per axis (mirrors `terrain.wgsl`'s own `texels_per_px`, generalised
    // off a single `art_size` scalar since a sprite's rect and world size need not share one aspect
    // ratio): `rect_px / world_tiles` is atlas texels per tile; `* tiles_per_px` (tiles per screen
    // pixel) converts to atlas texels per screen pixel.
    let scale = max(
      vec2<f32>(frame_rect.z, frame_rect.w) * frame.tiles_per_px /
        max(in.sprite_world_size, vec2<f32>(1e-6, 1e-6)),
      vec2<f32>(1e-6, 1e-6),
    );
    let texels_per_px = max(scale.x, scale.y);
    let lod = clamp(max(0.0, log2(max(texels_per_px, 1e-6))), 0.0, SPRITE_MAX_LOD);

    let texel = frame_rect.xy + in.uv * frame_rect.zw;
    var sample_color: vec4<f32>;
    if (lod <= 0.0) {
      let anchor = floor(texel + vec2<f32>(0.5, 0.5));
      let offset = texel - anchor;
      let seamed = anchor + clamp(offset / scale, vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, 0.5));
      sample_color = textureSampleLevel(atlas_tex, atlas_sampler, seamed / atlas_size, 0, 0.0);
    } else {
      sample_color = textureSampleLevel(atlas_tex, atlas_sampler, texel / atlas_size, 0, lod);
    }
    frag_rgb = sample_color.rgb * in.color.rgb;
    alpha = sample_color.a;
  } else {
    // Any future kind this pipeline does not know.
    discard;
  }

  if (alpha <= 0.0) {
    discard;
  }
  return vec4<f32>(frag_rgb, in.color.a * alpha);
}
