# 0018: Renderer: TypeScript WebGPU ferry on the main thread, Rust produces every byte

Status: Accepted (2026-09-19)

## Context

Requirements and the accepted exception to "Rust for everything" are in [`../spec/client.md`](../spec/client.md) and [`../spec/overview.md`](../spec/overview.md). The forces: pointer/keyboard events and the DOM exist only on the main thread; world-anchored DOM must present in the same frame as the canvas ([0019](0019-camera-input-and-overlay.md)); the rendering thread must meet the allocation budget in [0016](0016-zero-gc-definition.md); the WASM download must stay small on mobile; the main thread runs no WASM and instance memory is not shared ([0015](0015-threads-memory-and-topology.md)); the view is bounded at 256 tiles per axis ([0010](0010-rates-and-subscriptions.md)); tiles are 4 bytes and [0007](0007-world-model.md) delegates the GPU texel format here.

## Decision

**1. Placement.** A TypeScript renderer on the main thread issues every WebGPU call inside one `requestAnimationFrame` callback, together with camera integration and overlay writes. It holds no game knowledge: it uploads bytes and issues a constant 2–10 draws. All frame data (DrawList, chunk texels, indirection, tables) is produced by Rust in the client worker. Reasons:
- *Input and DOM live only on main.* The WICG input-for-workers proposal never shipped; a worker renderer forwards every event and can only add latency to a camera that has no sim round trip ([0001](0001-camera-and-presence.md)).
- *Overlay swim.* Worker-presented frames are not synchronized with DOM style changes ("it is not defined when those frames become visible"); the synchronized `transferToImageBitmap` path puts a per-frame hop and main-thread work back.
- *wgpu garbage and size.* wgpu's web backend builds a fresh JS descriptor per call, needs wasm-bindgen (rejected in [0014](0014-js-wasm-boundary.md)), and adds a few hundred KB; its benefits (native targets, WebGL fallback) are non-goals.
- *Unconfirmed WebGPU-in-worker on iOS Safari:* BCD claims Safari 26 support; no independent confirmation was found and public Rust worker demos omit Safari.
- *The wrapper-object floor is language-independent.* The browser binding allocates it: measured 16 B per wrapper, 104 B/frame for the production shape (canvas texture, view, encoder, pass, command buffer, +24 B per task), about 118 B/frame with the rAF callback. Every descriptor, the submit array, and every typed-array view is created once and mutated in place. If a startup probe inside an error scope shows the browser accepts a `GPUTexture` as the attachment `view` (Chrome 140+), `createView()` is skipped.

**2. Frame-data path.** The game implements (trait in [0003](0003-game-facing-api.md)):

```rust
fn extract(&self, view: &FrameView<G>, out: &mut DrawList);   // once per produced frame, client worker
fn tile_visual(t: Tile) -> TileTexel { TileTexel::from_tables(t) }   // on chunk load/patch, never per frame. TileTexel { base: u16, resource: u16 };
                                                                      // from_tables = each layer's id through the game's id → visual-id table (identity if none is registered)

impl DrawList {                       // engine-owned, preallocated; a full list drops the record and bumps a debug counter
    pub fn sprite(&mut self, layer: u8, pos: WorldPos, sprite: SpriteId) -> &mut Draw;  // Q24.8 minus window origin in integers, then f32
    pub fn circle(..); pub fn ring(..); pub fn rect(..); pub fn bar(..); pub fn radial(..); pub fn ghost(..);
}
#[repr(C)] pub struct Draw {          // exactly 32 bytes, little-endian = one GPU instance
    pub pos: [f32; 2],                // tiles, relative to the frame's integer window origin (or to the cursor tile, flag below)
    pub size: [f32; 2],               // tiles
    pub kind_sprite: u16,             // bits 12..16 kind, bits 0..12 sprite id
    pub layer: u8,                    // 0..8
    pub flags: u8,                    // ANCHOR_CURSOR_TILE | SCREEN_PX_STROKE | PREDICTED | FLIP_X
    pub color: u32,                   // rgba8
    pub param: f32,                   // progress 0..1 or rotation
    pub pick_id: u32,                 // 0 = not pickable (0019)
}
```

`FrameView` carries the interpolated `WorldRead`, clocks, visible rect plus margin, zoom, and the cursor tile (exact shape deferred in 0003). Capacity: **65,536 records (2 MiB)**, per-game config. Publishing is the mandatory copy out of instance memory: a stable counting sort by `layer` into one of three slots of a SAB triple buffer (3 × (256 B header + 2 MiB)); the header holds the frame sequence, `window_origin: [i32; 2]`, `layer_count: [u32; 8]`, and the fields [0019](0019-camera-input-and-overlay.md) defines. In rAF the main thread takes the newest slot and issues **one** `queue.writeBuffer(instanceBuf, 0, sabView, slotOffset, usedBytes)`, then one instanced `draw(6, n, 0, first)` per non-empty layer (no depth buffer, no render bundles, no indirect draws). `pick_id` is not bound as a vertex attribute. Because `pos` is relative to a window origin and not to the live camera, the newest camera is applied to a one-frame-old list without error.

**3. Terrain.** One full-viewport triangle; the fragment shader maps pixel → tile → chunk → slot → texel → art.
- **Texel format: `rg16uint`, 4 bytes, `r` = base-layer visual id, `g` = resource-layer visual id (0 = none).** Same size and stride as the 4 KiB dense slab of 0007. The conversion is done by the client-role WASM while it writes the chunk into the SAB upload ring: 1,024 calls of `tile_visual` (table lookups by default; a game overrides it to show `aux`, e.g. depletion). Cost is one pass over 4 KiB per chunk load and one call per tile delta, against a measured ~0.1 ms to generate the chunk; unmeasured, expected in microseconds.
- **Tile page texture:** 1024×1024 `rg16uint` (4 MiB) = 1,024 slots of 32×32; slot = the chunk's slab index in the client dense cache (0007), so there is no second allocator. One `writeTexture` per chunk, one texel per tile delta, drained from the upload ring at frame start under a byte budget (default 64 KiB per frame), with reused descriptor objects.
- **Chunk indirection texture:** 64×64 `r16uint`, addressed toroidally by `chunk & 63`, value = slot or `0xFFFF`. The worker keeps entries only for chunks within ±31 of the camera chunk and updates it through the same ring on residency change, never per frame. Non-resident chunks draw a neutral colour. Neighbour reads for dithering use the same path, so chunk borders need no aprons; a missing neighbour counts as "same as self".
- **Visual table:** uniform buffer of 1,024 × 16 B (16 KiB, the compatibility-mode binding limit): first array layer, variant count, flags (flip/rotate), dither priority, band width.
- **Art sampling:** tiles in a `texture_2d_array` (one layer per tile image, bleeding impossible by construction); sprites in a padded atlas. Variant, flip and brightness jitter come from an integer PCG hash of `(tile_x, tile_y, seed)`, exact on every GPU. Edge dithering is stateless: within `band` art texels of an edge, a higher-priority neighbour's art replaces the pixel where `bayer4x4(art_texel) < coverage(distance)`, evaluated on the art-texel grid; it and the jitter fade out below 1 screen px per art texel. Magnification uses a bilinear sampler with the `fwidth` seam ("fat pixel") formula; minification uses trilinear mips; blending is premultiplied alpha. No zoom snapping; the camera snaps to device pixels at rest.

**4. Art contract.** The game's asset script (no engine tool, no npm dependency) supplies:
- `tiles.png`: a sheet of square tiles of one size (`tile_px`, 16 for the reference game) + `tiles.json`: visual id → `{first, variants, flags, priority, band}`. At most 256 tile images (the guaranteed `maxTextureArrayLayers`) and 1,024 visuals. The engine loads with `createImageBitmap` + `copyExternalImageToTexture` (`premultipliedAlpha: true`) into `rgba8unorm` and generates mips to 1×1. No compressed formats (they fragment by platform and ruin pixel art).
- `sprites.png`: atlas ≤ 4096², 2 px extruded padding, 2 mip levels + `sprites.json`: sprite id → rect, pivot, size in tiles, frame count. ≤ 4,096 sprites.
- Shapes need no art: one instanced "uber-quad" pipeline draws sprite, circle/ring (SDF, `fwidth` AA), rect, progress bar, radial progress and tile ghost by `kind`. No in-canvas text; text is DOM.

**5. Camera-relative rendering.** The camera is f64 tiles on the main thread (exact over the ±2^23 range). The uniform carries `cam_tile: vec2<i32>`, `cam_frac: vec2<f32>`, tiles per pixel and viewport size; the shader computes `rel = (px − half) × tiles_per_px + cam_frac` (|rel| ≤ ~130) and `tile = cam_tile + floor(rel)` in `i32`. Entities get `(window_origin − cam_tile) − cam_frac`, computed in f64. Hashes take integer tiles only. Precision is independent of distance from the origin.

**6. Zoom budget.** Limits are tiles across the long axis, default 12–256 (Requirements; clamp and chunk counts in 0010). Worst case 256×256 = 65,536 tiles, 121 subscribed chunks, 65,536 drawables. **Far zoom needs no terrain LOD:** the full-viewport shader costs per pixel, not per tile, and the mip chain converges each tile to its mean colour, which is the map view. `FrameView.zoom` lets a game skip or swap small drawables; the engine imposes no entity LOD.

**7. Support and no fallback.** WebGPU ships in Chrome desktop 113 and Android 121 (Android 12+, Vulkan 1.1), Safari 26 on OS 26 (iPhone 11 and later), Firefox 141 Windows / 147 macOS; not in Firefox Android or Linux. Measured reach (Web3D Survey): iOS 85%, Android 74%, macOS 91%, Windows 87%. That is viable for friends co-op, so there is no non-WebGPU path; `checkSupport()`, exported from the package root next to `createClient` ([0017](0017-packaging-and-build.md)) so it can run before a client exists, reports why a device fails and the game styles the capability screen. **Compatibility mode is a design constraint, not a test commitment:** request `featureLevel: 'compatibility'`; instance data in vertex buffers (no storage buffers in the vertex stage); each texture bound with one view dimension; textures ≤ 4096; uniform bindings ≤ 16 KiB; one colour attachment; `@interpolate(flat, either)`; never request above-default limits without checking `adapter.limits`.

**8. Lifecycle.** Canvas configured once per device: `getPreferredCanvasFormat()`, `alphaMode: 'opaque'`, no depth, no MSAA. *Resize/DPR:* `ResizeObserver` with `device-pixel-content-box` (Safari: `content-box × devicePixelRatio`, rounded, plus a re-armed one-shot `matchMedia('(resolution: Ndppx)')`); the observer records the size, the next rAF sets `canvas.width/height` and renders at once (no cleared flash); clamped to `maxTextureDimension2D`. **Render scale** = `min(DPR, 2)` by default, per-game config. *Backgrounding:* on hidden, stop rAF; on visible, reset the frame clock, re-check size, and tell the client worker to re-base interpolation ([0012](0012-prediction-and-reconciliation.md)). *Device loss:* every GPU object is a cache of worker-side or HTTP-cached state. `device.lost` → new adapter → new device → reconfigure the same canvas → recreate pipelines and buffers → re-fetch art → ask the worker to re-enqueue every resident chunk, the indirection and the table. Camera, input, overlay and sim never stop. A null adapter, or two losses within 10 s, emits a fatal `rendererLost` for the game's reload prompt. Tested with `device.destroy()` behind a test flag ([0020](0020-testing-strategy.md)).

**9. Frame-time budget.** Target 60 fps, i.e. 16.6 ms per frame, on the baseline phone (Safari's Low Power Mode halves rAF to 30 Hz; motion is time-based, [0019](0019-camera-input-and-overlay.md)). Shares: the main-thread rAF callback (camera integration, overlay writes, upload-ring drain within its byte budget, one `writeBuffer`, encode, submit) **≤ 4 ms**; GPU **≤ 6 ms** (the fill-rate check under Consequences); the client worker's `frame` (drain rings, apply network frames, interpolate, `extract`, sort and publish), which runs in parallel with main, **≤ 8 ms**, so a DrawList is published every rAF interval with half the interval spare for a burst of chunk texel conversions. These numbers are derived from the 60 fps target, not measured. The automated proxy is desktop: one third of each CPU share (main ≤ 1.3 ms, worker ≤ 2.7 ms at the reference game's worst-case view), using the 3–5x phone factor of [0008](0008-chunk-generation.md), asserted as a slow-tier wall-clock benchmark on Tyler's Mac ([0020](0020-testing-strategy.md) section 9); the phone numbers are checked by hand with the fill-rate check.

## Alternatives rejected

- **wgpu in a worker with OffscreenCanvas:** overlay swim, forwarded input, per-call descriptor garbage, wasm-bindgen, download size, and the least-proven cell of the support matrix (iOS Safari).
- **TypeScript renderer in a worker:** removes the wgpu costs but keeps swim and input forwarding; it only helps when the main thread is janky, and this design leaves the main thread nearly idle.
- **Raw `web-sys` on main:** needs WASM and wasm-bindgen glue on the main thread for the same wrapper floor.
- **Instanced quads per tile:** 65,536 instances at far zoom and CPU work whenever the visible set changes. **Per-chunk meshes:** most memory, slowest edits.
- **A rendering library:** ruled out in `overview.md`; none targets a constant-draw-count tile shader, and the engine has zero runtime dependencies ([0017](0017-packaging-and-build.md)).
- **Uploading the sim tile verbatim:** rejected in 0007. **One atlas with nearest sampling for everything:** bleeds under mips, shimmers at fractional zoom. **GPU id-buffer picking:** async readback, garbage, latency (0019).

## Consequences

- A slow game UI framework on the main thread stutters the canvas; the mitigation is change-driven UI observation ([0003](0003-game-facing-api.md)).
- `tile_visual` is part of the `ClientSide` trait in 0003. A game is limited to 256 tile images, 1,024 visuals and 4,096 sprites until an ADR adds a second array or atlas.
- GPU memory is small and fixed: 4 MiB page + 2 MiB instances + art. SAB cost: about 6 MiB for the triple buffer.
- The allocation floor was measured on desktop Chromium only; `writeBuffer` from a SAB-backed view and the `GPUTexture`-as-view probe are unverified on Safari and Firefox. Deferred to Phase 2: run the zero-GC harness shape in Safari and Firefox by hand, because the CDP instrument is Chromium-only.
- **Deferred to Phase 2/3 manual device checks: terrain shader fill-rate on real phones** (indirection + two tile loads + neighbour dithering + fat-pixel sampling at maximum zoom-out, render scale 2, one mid-range Android and one iPhone; pass = steady 60 fps, GPU time under ~6 ms), because real phones cannot be automated in this phase and no shader exists yet. Fallbacks, in order: lower the render-scale cap (1.5, then 1; cost falls with its square); drop neighbour reads below ~4 screen px per tile; last, one instanced quad per visible chunk over the same data textures.
- Deferred to Phase 2: exact WGSL, the manifest JSON schema, the upload-ring record layout, and the worker's frame clock (owned by 0015), because they are implementation details with no cross-domain effect.

## Sources

- [`../research/client.md`](../research/client.md) 1.1–1.5, 1.8, 1.9, 2.1–2.5, 3.1–3.5, 3.10, 3.11; [`../../spikes/zero-gc-webgpu/RESULT.md`](../../spikes/zero-gc-webgpu/RESULT.md) (16 B wrappers, 104–118 B/frame, `writeBuffer` from shared memory at zero JS-heap cost, real Metal device headless); 0007 section 4.
- Support: https://github.com/gpuweb/gpuweb/wiki/Implementation-Status · https://caniuse.com/webgpu · https://web3dsurvey.com/webgpu · https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ · https://developer.chrome.com/blog/new-in-webgpu-146
- Compatibility-mode limits (checked 2026-09-19): https://webgpufundamentals.org/webgpu/lessons/webgpu-compatibility-mode.html · default limits: https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits
- Workers: https://github.com/WICG/input-for-workers · https://wiki.whatwg.org/wiki/OffscreenCanvas · https://github.com/matthewjberger/webgpu-worker · wgpu web backend: https://github.com/gfx-rs/wgpu/blob/trunk/wgpu/src/backend/webgpu.rs
- Uploads and garbage: https://toji.dev/webgpu-best-practices/buffer-uploads.html · https://webgpufundamentals.org/webgpu/lessons/webgpu-optimization.html · https://developer.chrome.com/blog/new-in-webgpu-140
- Tilemaps and sampling: https://blog.paavo.me/gpu-tilemap-rendering/ · https://github.com/bevyengine/bevy/pull/18866 · https://jorenjoestar.github.io/post/pixel_art_filtering/ · https://www.factorio.com/blog/post/fff-251 · https://www.factorio.com/blog/post/fff-333
- Lifecycle: https://toji.dev/webgpu-best-practices/device-loss.html · https://webgpufundamentals.org/webgpu/lessons/webgpu-resizing-the-canvas.html
