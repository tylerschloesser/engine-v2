// Mip-chain blit (docs/decisions/0018-renderer.md §4: "generates mips to 1x1"; docs/plan/
// 09b-terrain-art-and-lifecycle.md Scope: "render/mips.ts: mip chain to 1x1 for every array layer at
// load, with one blit pipeline and reused descriptors"). One full-viewport triangle per (layer,
// level) pass: the fragment bilinearly samples the previous mip level, at the array layer `mip_layer`
// names, into the next level's own single-layer attachment.
//
// `mip_src`'s bound view spans every array layer (compatibility mode requires a `2d-array` texture
// binding to reference all of a texture's layers, docs/plan/09b-terrain-art-and-lifecycle.md
// Deviations -- found by `uncapturederror` on an earlier draft that narrowed the view to one layer,
// the same way `render/terrain.ts`'s own bind group already has to bind the *whole* array), narrowed
// only by mip level (`baseMipLevel: level - 1, mipLevelCount: 1`); `mip_layer` (one per-pass uniform
// buffer, distinct per pass so many passes can be recorded into one command encoder and submitted
// once -- `render/mips.ts`'s own comment) selects which layer of that view this pass reads. Edit
// this file, then run `node scripts/embed-wgsl.mjs` (packages/engine/CLAUDE.md).

@group(0) @binding(0) var mip_sampler: sampler;
@group(0) @binding(1) var mip_src: texture_2d_array<f32>;
struct MipLayer {
  layer: u32,
}
@group(0) @binding(2) var<uniform> mip_layer: MipLayer;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VOut {
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out: VOut;
  out.pos = vec4<f32>(corners[vertex_index], 0.0, 1.0);
  out.uv = corners[vertex_index] * 0.5 + vec2<f32>(0.5, 0.5);
  return out;
}

// `mip_src`'s bound view is narrowed to exactly one source mip level (addressed as level 0 within
// that view); `mip_layer.layer` is that same view's own array-layer index (0-based across the whole
// texture, since the view spans every layer).
@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(mip_src, mip_sampler, in.uv, i32(mip_layer.layer), 0.0);
}
