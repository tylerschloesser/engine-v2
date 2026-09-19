# Research: client (rendering, camera, input, overlay)

Phase 1 research for every open question in `docs/spec/client.md`. Evidence and recommendations, not decisions. All URLs accessed 2026-09-19 unless noted.

Spec baseline used: the camera is client-local, never mutates the world, is not an action, and is only *reported* to the sim's host as an unlogged subscription message (`docs/spec/overview.md`, Fixed decisions). There is therefore no sim round trip, prediction, or reconciliation anywhere in the camera path. This matters a lot for renderer placement (section 3.1).

---

## 1. Findings

### 1.1 WebGPU support matrix (verified today)

| Browser / platform | Status | Since | Notes |
|---|---|---|---|
| Chrome/Edge desktop: Windows x86/x64, macOS, ChromeOS | Shipped | 113 (May 2023) | Dawn. |
| Chrome Android, ARM/Qualcomm/Intel GPUs, Android 12+ | Shipped | 121 (Jan 2024) | Needs Vulkan 1.1+. |
| Chrome Android, Imagination GPUs, Android 16+ | Shipped | 139 | |
| Chrome Android, Samsung Xclipse | In progress | ~154 expected | Some Exynos Galaxy phones still lack core WebGPU. |
| Chrome Android, WebGPU **compatibility mode** (GLES 3.1) | Shipped | 146 (Feb 2026) | Opt in with `requestAdapter({ featureLevel: 'compatibility' })`. Android first; ChromeOS and Windows D3D11 being explored. |
| Chrome Linux | Partial | 144 (Intel Gen12+), 147-148 (NVIDIA 535+ on Wayland) | Everything else behind a flag. |
| Chrome Windows ARM64 | Flag only | | |
| Safari macOS / iOS / iPadOS / visionOS | Shipped | Safari 26.0 (Sept 2025); requires OS 26 (macOS Tahoe, iOS 26) | caniuse marks 26.0-27.x "partial". Safari 26.2 fixed depth-stencil/resolve attachment gaps; 27.0 (Sept 2026) added WGSL `clip_distances`. No WebGPU on iOS 18 or older at all. |
| Firefox Windows | Shipped | 141 (Jul 2025) | wgpu-based. |
| Firefox macOS | Shipped | 145 (Apple silicon, macOS 26), 147 (all macOS) | |
| Firefox Linux, Firefox Android | Not shipped | Nightly only; "expected 2026" | BCD: Firefox Android `getCoalescedEvents` also returns an empty array. |

Reach: caniuse reports 87.35% global (85.72% full + 1.63% partial). Web3D Survey (real-device sampling) reports 82.7% overall; by platform: ChromeOS 92%, macOS 91%, Windows 87%, **iOS 85%**, **Android 74%**, Linux 17%; by browser Firefox 59%. Chrome telemetry quoted with the compatibility-mode intent-to-ship: ~15-23% of Android Chrome users lack Vulkan 1.1 (10% have no Vulkan), which is the gap compatibility mode closes.

Sources:
- gpuweb Implementation Status wiki: https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- caniuse: https://caniuse.com/webgpu
- MDN browser-compat-data (`WorkerNavigator.gpu`, `OffscreenCanvas.getContext`): https://github.com/mdn/browser-compat-data (files `api/WorkerNavigator.json`, `api/OffscreenCanvas.json`)
- WebKit: https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ , https://webkit.org/blog/17640/webkit-features-for-safari-26-2/ , https://webkit.org/blog/18178/webkit-features-for-safari-26-6/ (Jul 2026, no WebGPU changes), https://webkit.org/blog/18325/webkit-features-for-safari-27-0/
- Chrome: https://developer.chrome.com/blog/new-in-webgpu-121 , https://developer.chrome.com/blog/new-in-webgpu-146 , https://web.dev/blog/webgpu-supported-major-browsers
- Web3D Survey: https://web3dsurvey.com/webgpu

### 1.2 Mobile limitations

- **Default limits are what we can count on** (browsers report tiers, not hardware): `maxTextureDimension2D` 8192, `maxTextureArrayLayers` 256, `maxBindGroups` 4, `maxBufferSize` 256 MiB, `maxUniformBufferBindingSize` 64 KiB, `maxStorageBufferBindingSize` 128 MiB, 16 sampled textures and 8 storage buffers per stage. A 2D tile renderer fits comfortably inside the defaults; never request more than default without checking `adapter.limits`. (https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits)
- **Compatibility mode subset** (relevant if we want the extra Android reach): `maxTextureDimension2D` 4096; storage buffers in the vertex stage are 0 by default (about 45% of those devices lack them); a texture has exactly one binding view dimension (`textureBindingViewDimension` at creation); no per-layer views of a 2d-array in a bind group; no per-attachment blend differences; `@interpolate(flat)` must be `either`; 16 texture+sampler combos per stage. (https://webgpufundamentals.org/webgpu/lessons/webgpu-compatibility-mode.html)
- **Texture formats**: compressed formats fragment by platform (BC on desktop, ETC2/ASTC on mobile; WebGPU guarantees only that one family exists). Block compression also ruins pixel art. Uncompressed `rgba8unorm` is the only sane choice for this genre and the atlases are small. `navigator.gpu.getPreferredCanvasFormat()` is `bgra8unorm` on most platforms and `rgba8unorm` on Android; always use it. (https://www.ludicon.com/castano/blog/2026/01/choosing-texture-formats-for-webgpu-applications/)
- **Tile-based mobile GPUs**: avoid MSAA and depth attachments we do not need; Chrome 146 added `TRANSIENT_ATTACHMENT` for attachments that never leave tile memory (not needed if we have a single color attachment).
- **Frame pacing on iOS**: Safari caps rAF at 60 Hz by default even on ProMotion, and drops rAF to 30 Hz in Low Power Mode. Camera integration and inertia must be time-based, never frame-count-based. (https://motion.dev/magazine/when-browsers-throttle-requestanimationframe , https://popmotion.io/blog/20180104-when-ios-throttles-requestanimationframe/)
- **Memory on iOS**: historical WebKit behavior includes a total-canvas-memory ceiling (384 MB warning), a canvas-resize leak (WebKit bug 219780), and jetsam kills of the whole tab under pressure. Keep one canvas, resize rarely, keep GPU memory small. (https://bugs.webkit.org/show_bug.cgi?id=219780)
- **Device loss / backgrounding**: nothing in the spec or vendor docs promises the device survives backgrounding. iOS has a long history of "context lost" on app switch for WebGL (Apple forum thread 737042) and Safari 26 has open WebGPU device-lost reports for WASM apps (imgui #9103, PlayCanvas forum). Chrome: after a GPU process crash the first re-request succeeds, a second crash within two minutes blocks new adapters; `requestAdapter()` from a background tab may not resolve until foregrounded. On mobile the more common failure is the OS discarding the whole page, which is a reload, not a device loss. Treat device loss as a normal, recoverable event; treat page discard as a fast-resume problem (cross-domain, section 4). (https://toji.dev/webgpu-best-practices/device-loss.html , https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips , https://github.com/gpuweb/gpuweb/blob/main/design/ErrorHandling.md , https://github.com/ocornut/imgui/issues/9103)

### 1.3 OffscreenCanvas + WebGPU in workers

| Capability | Chrome / Android | Firefox | Safari (macOS/iOS) |
|---|---|---|---|
| `WorkerNavigator.gpu` | 113 / 121 | 141 (same platform gating as main thread; not service workers) | 26 |
| `OffscreenCanvas.getContext('webgpu')` | 113 / 121 | 141 (BCD still says "Windows only"; data conflicts with the `WorkerNavigator` entry, treat macOS as unverified) | 26 |
| `requestAnimationFrame` in dedicated workers | 69 | 99 | 16.4 |

Caveats found:
- Mozilla's meta bug for WebGPU in workers (1818042) is still open; it works in release but remaining scope is listed. (https://bugzilla.mozilla.org/show_bug.cgi?id=1818042)
- Public Rust worker-rendering demos (`matthewjberger/webgpu-worker`, `bevy-worker`) list only Chromium 113+ and Firefox 141+ as supported and omit Safari. BCD says Safari 26 supports it; I found no independent confirmation on iOS. Worker rendering on iOS Safari is the least-proven path in the matrix. (https://github.com/matthewjberger/webgpu-worker)
- **Workers get no input events.** The WICG "input for workers" proposal never shipped; every worker-rendering app forwards pointer events from the main thread (the demo above coalesces to one message per frame). (https://github.com/WICG/input-for-workers)
- **Worker-presented frames are not synchronized with main-thread DOM updates.** The OffscreenCanvas design notes are explicit: with the async (commit / implicit present) path "it is not defined when those frames become visible". The synchronized path is `transferToImageBitmap()` to the main thread and display via `ImageBitmapRenderingContext`, added specifically for Google Maps' DOM-sync requirement; it puts a per-frame hop and main-thread work back in. (https://wiki.whatwg.org/wiki/OffscreenCanvas , https://lists.w3.org/Archives/Public/public-whatwg-archive/2016Jan/0001.html)

### 1.4 Where WebGPU allocates JS garbage, and how to minimize it

Per-frame API calls that unavoidably return a fresh JS wrapper object:
- `context.getCurrentTexture()` (a new `GPUTexture` each frame; same object within a frame)
- `texture.createView()` (new `GPUTextureView` per call). Avoidable where supported: since Chrome 140 a `GPUTexture` can be passed directly as a color attachment `view`/`resolveTarget`. Safari/Firefox support unverified; probe once at startup inside an error scope. (https://developer.chrome.com/blog/new-in-webgpu-140)
- `device.createCommandEncoder()`, `encoder.beginRenderPass()`, `encoder.finish()` (three wrappers)
- `mapAsync()` returns a Promise, and `getMappedRange()` returns a new `ArrayBuffer` each time; both are garbage per use.

Avoidable garbage (the usual real offenders):
- Descriptor object literals per call. Fix: build every descriptor once (`renderPassDescriptor`, its `colorAttachments[0]`, the `[commandBuffer]` submit array, `writeTexture` destination/layout/size objects) and mutate fields in place each frame. (webgpufundamentals lists "pre-computed render pass descriptors" among its optimizations: https://webgpufundamentals.org/webgpu/lessons/webgpu-optimization.html)
- Per-object bind groups, buffers, or `writeBuffer` calls. Fix: one big instance buffer, one `writeBuffer` (measured 40% JS time reduction in the same article); bind groups created at load or on resource change only.
- Typed-array temporaries. Fix: `queue.writeBuffer(gpuBuf, dstOffset, source, srcOffset, size)` takes a source view plus offset/size, so one long-lived `Uint8Array` over WASM memory serves every upload with no `subarray()`. Toji: "if you are using WebGPU from WASM code, `writeBuffer()` is the preferred path" because mapping would need an extra copy out of the WASM heap anyway. `writeBuffer`/`writeTexture` accept views backed by a `SharedArrayBuffer` (the bare SAB was the contested case: gpuweb #4186). (https://toji.dev/webgpu-best-practices/buffer-uploads.html , https://github.com/gpuweb/gpuweb/issues/4186)
- Render bundles move per-draw JS->C++->GPU-process marshalling and validation to record time; buffer *contents* and indirect-draw arguments can still change between replays, but the draw list itself is baked and bundles cannot set viewport/scissor. They pay off with hundreds of draws. If the frame is a small constant number of draws (section 3.3), bundles are unnecessary. (https://toji.dev/webgpu-best-practices/render-bundles.html)
- Indirect draws let instance counts change without touching JS arguments; marginal for us because `draw(6, n)` takes plain numbers and allocates nothing.

Conclusion: a WebGPU frame cannot be literally zero-allocation. The floor is about 4-5 tiny short-lived wrapper objects per frame (texture, optional view, encoder, pass, command buffer), i.e. roughly 300 objects/s at 60 Hz, all dying in the young generation. Everything else is avoidable. This floor is identical whether the calls come from TypeScript, web-sys, or wgpu, because it is the browser binding that allocates.

### 1.5 wgpu-on-web vs raw web-sys vs TypeScript

- **wgpu** (v30.0.1, Aug 2026; vendors its own WebGPU bindings on wasm-bindgen 0.2.127). Mature and what Firefox itself is built on, but on the web backend it is a translation layer over the browser API: `wgpu/src/backend/webgpu.rs` constructs a fresh JS descriptor (`GpuXxxDescriptor::new(...)`, `js_sys::Array`) on every call, and `write_buffer` goes through a boxed byte staging type. So it adds descriptor garbage per call that hand-written code avoids, plus "a few hundred kilobytes before compression" for the WebGPU-only backend (historically ~10 MB when naga/WebGL were pulled in; wgpu relies on std heavily, no `no_std`). Its value (portability to native, WebGL fallback) is something this project has declared a non-goal. (https://github.com/gfx-rs/wgpu/blob/trunk/CHANGELOG.md , https://github.com/gfx-rs/wgpu/blob/trunk/wgpu/src/backend/webgpu.rs , https://github.com/gfx-rs/wgpu/discussions/2278 , https://rustify.rs/articles/rust-gpu-computing-wgpu-2026)
- **Raw web-sys**: WebGPU is still behind `--cfg=web_sys_unstable_apis`. Dictionaries are JS objects built with property sets from Rust; to avoid per-frame garbage you must cache them as owned `JsValue`s (wasm-bindgen slab slots) and mutate via reflective sets, which is the TypeScript technique with more friction and a JS<->WASM crossing per call. Borrowed `&JsValue` args use a stack and do not allocate; owned returns (`GPUTexture`, encoder, pass) take and free slab slots each frame. It also forces wasm-bindgen glue into the render path, prejudging the ABI question in `runtime-and-packaging.md`. (https://rustwasm.github.io/docs/wasm-bindgen/contributing/design/js-objects-in-rust.html)
- **TypeScript**: direct control over every allocation, zero binary size, zero dependencies (the types come from the dev-only `@webgpu/types`), best debuggability in browser devtools, and no WASM instance needed on the rendering thread. Figma's experience is a useful caution in the other direction: their C++/WASM renderer needed custom C++/JS bindings where Emscripten's WebGPU bindings were too slow, i.e. the binding layer is where WASM renderers lose time. (https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)

### 1.6 Input latency: main thread vs worker

- Pointer/keyboard events are delivered only on the main thread. Worker rendering therefore adds a forwarding step (postMessage or a SAB write) and the worker's rAF is not phase-aligned with the main thread's input dispatch, so worst-case input-to-photon is one frame worse, never better, when the main thread is healthy.
- Worker rendering wins only when the main thread is janky (long tasks, GC from a UI framework): the worker keeps presenting. But input is still stuck behind the same jank, and in this design the main thread is nearly idle (sim, sync, interpolation are in workers), so there is little jank to escape.
- Worker-presented frames and DOM style changes are composited independently (1.3), so world-anchored DOM will swim. Even same-thread libraries struggle: MapLibre's maintainers acknowledge DOM markers desync from the WebGL canvas in some update paths (worse in Firefox) and recommend in-canvas symbols when sync matters. (https://github.com/maplibre/maplibre-gl-js/discussions/6494)

### 1.7 Pointer events and gestures on iOS Safari

- `touch-action: none | pan-x | pan-y | manipulation` supported since iOS 9.3-13 (BCD); `pinch-zoom` since 13. (The widely copied claim that iOS only supports `auto`/`manipulation` is outdated.) `touch-action: none` on the canvas stops panning, pinch-zoom, and double-tap zoom *for touches that start on the canvas*.
- Safari additionally fires proprietary `gesturestart/gesturechange/gestureend`. On **macOS Safari** trackpad pinch arrives only as `GestureEvent` (with `scale`), not as `wheel` + `ctrlKey` as in Chrome/Firefox. Both paths are needed; both need `preventDefault()` from a non-passive listener. (https://danburzo.ro/dom-gestures/ , https://kenneth.io/post/detecting-multi-touch-trackpad-gestures-in-javascript)
- `wheel` listeners on window/document/body are passive by default in Chrome; register on the canvas with `{ passive: false }` to `preventDefault()` page scroll and ctrl-wheel page zoom.
- `overscroll-behavior` is supported from Safari 16 but "has no effect on scroll containers that have no scrollable overflow" (BCD), so pull-to-refresh/rubber-banding is best prevented structurally: a non-scrolling `position: fixed; inset: 0; overflow: hidden` root plus `overscroll-behavior: none` on `html, body`.
- `getCoalescedEvents()`: Chrome 58, Firefox 59 (Android returns empty), Safari 18.2. It returns a new array of new event objects per call: pure garbage, and only useful for drawing apps that need the sub-frame path. A camera only needs the latest position. `getPredictedEvents()` has the same support.
- iOS edge-swipe back/forward navigation cannot be prevented from page script; only a standalone PWA avoids it.
- Long-press text selection/callout on iOS: `-webkit-user-select: none; -webkit-touch-callout: none` on the canvas and overlay root.

### 1.8 Resize and DPR detection

- Correct device-pixel canvas size comes from `ResizeObserver` with `box: 'device-pixel-content-box'` (`devicePixelContentBoxSize`): Chrome 84, Firefox 108 (93-107 buggy), **Safari: not supported**. `clientWidth * devicePixelRatio` is wrong under fractional DPR / fractional layout. Safari also does not change `devicePixelRatio` on page zoom. Clamp to `device.limits.maxTextureDimension2D`. (https://webgpufundamentals.org/webgpu/lessons/webgpu-resizing-the-canvas.html , BCD `api/ResizeObserverEntry.json`)
- Where `devicePixelContentBoxSize` exists the observer also fires on DPR changes (window dragged between monitors, browser zoom). On Safari, DPR changes need a one-shot `matchMedia('(resolution: <dpr>dppx)')` listener re-armed after each change.
- Rendering cost scales with DPR squared; webgpufundamentals suggests capping (for example `min(2, dpr)`).

### 1.9 Device loss handling

Toji's best-practice (Oct 2024): attach `device.lost.then(...)` immediately; `reason` is `'destroyed'` or `'unknown'`; always request a **new adapter** before a new device (adapters expire); if the adapter request fails, GPU access may be temporarily blocked; test with `device.destroy()` and Chrome's `about:gpucrash`. Devices are independent of canvases, so recovery does not need a new canvas or a reload. Figma ships mid-session fallback driven by the same signal. (https://toji.dev/webgpu-best-practices/device-loss.html , https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)

---

## 2. Prior art and what to take from it

### 2.1 GPU tilemap techniques

| Technique | How | Verdict for us |
|---|---|---|
| One quad + tile-index data texture, atlas/array lookup in the fragment shader | Shader maps pixel -> tile coord -> `textureLoad` of tile id -> sample art. Vertex count independent of map size; chunk edits are small texture writes. `wgpu-tilemap` and paavohtl's renderer (single draw call, 512^3 voxels, 200-300 us/frame on desktop) are both this. | **Take it.** Zero per-tile CPU work per frame, edits are cheap, neighbor lookups (for dithering) are just more loads. Cost is fragment work, which is tiny here. |
| Instanced quads, one per tile | Instance buffer of visible tiles rebuilt as the camera moves. | Reject for terrain: tens of thousands of instances at far zoom (section 3.9) and CPU work every time the visible set changes. Keep for entities. |
| Prebuilt per-chunk vertex buffers | Mesh per chunk, rebuilt on edit. | Reject: most memory, slowest edits, no benefit over the data-texture approach for uniform grids. |

Sources: https://blog.paavo.me/gpu-tilemap-rendering/ (Apr 2021), https://crates.io/crates/wgpu-tilemap

### 2.2 Atlas vs `texture_2d_array`

Array textures give each tile its own layer: clamp/repeat and mipmaps work per layer, so **bleeding is impossible by construction**, and a tile id maps directly to a layer index with no UV math. Constraints: every layer has the same size, and only 256 layers are guaranteed. Atlases allow arbitrary sprite sizes but need extruded padding (at least 1 px; 2^k px if k mip levels are used) and half-texel-safe UVs. Take: **array for fixed-size tiles, padded atlas for variable-size entity sprites.** A 2d-array bound only as a 2d-array is also compatibility-mode safe.

### 2.3 Crisp pixel art at fractional zoom

Survey of nine variants (nearest, CSantos, Cole Cecil, RNavega, Klems, Inigo Quilez, Ben Golus, "fat pixel"): all the good ones use a **bilinear** sampler and move the UV so interpolation happens only in a one-screen-pixel band at texel seams, using `fwidth` so it adapts to any zoom/DPR automatically. The most compact form (Inigo Quilez):

```
let px   = uv * tex_size;
let seam = floor(px + 0.5);
let d    = fwidth(px);
let uv2  = (seam + clamp((px - seam) / d, vec2(-0.5), vec2(0.5))) / tex_size;
```

Requirements: bilinear filtering and **premultiplied alpha** (otherwise edges shimmer). This covers magnification; for minification (far zoom) use real mipmaps with trilinear filtering. Sources: https://jorenjoestar.github.io/post/pixel_art_filtering/ , https://gist.github.com/d7samurai/9f17966ba6130a75d1bfb0f1894ed377 , https://colececil.dev/blog/2017/scaling-pixel-art-without-destroying-it/

### 2.4 Variants and edge dithering in-shader

Common practice in shader tilemaps: hash the integer world tile coordinate to choose a variant, flip, or small tint; blend toward neighboring terrain near tile edges using a noise or dither mask (Godot hex-tilemap blending shader uses a small seamless noise texture; classic CPU approach is 32 transition tiles from 8 neighbor bits). Integer hashes (PCG-style) are exact on every GPU, so the result is identical across clients without being sim state. Factorio shows the opposite extreme: its transition rules are so elaborate ("insane", FFF-333) that terrain must be cached in a scrolled texture because re-rendering per frame was too slow (5 ms on old integrated GPUs). Lesson: keep transitions a **local, stateless function** of the tile and its 4-8 neighbors so they can be evaluated per pixel with no caching layer. Sources: https://godotshaders.com/shader/hexagonal-tilemap-with-blending/ , https://www.gamedev.net/tutorials/_/technical/game-programming/tilemap-based-game-techniques-handling-terrai-r934/ , https://www.factorio.com/blog/post/fff-333 , https://factorio.com/blog/post/fff-199

### 2.5 Factorio rendering FFFs

- FFF-251: the bottleneck is CPU-side draw submission; fix was batching into one big vertex buffer, shrinking per-sprite data (144 -> 80 bytes), and submitting queued draws together. Max zoom-out benchmark: ~25,000 sprites per frame. Take: one instance buffer, small fixed-size records, a handful of draws; size the entity budget in the tens of thousands.
- FFF-264 / FFF-281: big atlases exist to keep consecutive draws on one texture; mipmaps matter when zoomed out (a 256 px sprite drawn at 32 px). Take: mipmaps on everything, atlas grouping by draw layer.
- FFF-227/333: terrain is the special case that gets its own path. Take: terrain is a separate pass from entities.

Sources: https://www.factorio.com/blog/post/fff-251 , https://factorio.com/blog/post/fff-264 , https://www.factorio.com/blog/post/fff-281 , https://factorio.com/blog/post/fff-227

### 2.6 Anchoring DOM to a GPU canvas

- **MapLibre GL JS `Marker`**: the map renders on the main thread; on each `move` event (fired inside the map's render frame) every marker sets `element.style.transform = translate(Xpx, Ypx) ...`; positions are rounded to whole pixels only when movement ends (`subpixelPositioning` opt-out) to avoid jitter while moving and blur at rest. One string and one style write per marker per frame. Desync appears when camera updates and DOM writes land in different frames. (https://github.com/maplibre/maplibre-gl-js/blob/main/src/ui/marker.ts)
- **deck.gl**: same thread, same frame; HTML overlays are positioned from the same viewport object the GL layers use.
- **Google Maps** drove the synchronous `transferToImageBitmap` path precisely because unsynchronized worker presentation broke DOM overlays.
- **Figma**: C++/WASM renderer on the main thread, DOM UI around it; they render anything that must track the canvas *in* the canvas and keep DOM for chrome.

Take: (1) camera, GPU submit, and DOM anchor writes must happen in the same main-thread rAF callback from the same camera values; (2) use `transform` only, never `left/top`; (3) round to device pixels at rest, not while moving; (4) anything that must be pixel-locked to the world and is numerous should be drawn in the canvas, not the DOM.

---

## 3. Recommendations per open question

### 3.1 Where the renderer runs, and in what language (decided together with anchoring)

**Recommendation: render on the main thread, in TypeScript, as a thin "byte ferry": the camera, input, GPU command encoding, and overlay anchoring all run in one rAF callback; everything heavy (sync decode, interpolation, prediction, drawable extraction, chunk texel building) runs in Rust in a worker and hands the main thread finished bytes.** Confidence: **medium-high**. Main alternative rejected: Rust (wgpu) renderer in a worker with OffscreenCanvas.

Why, weighing the four forces together:
- *Overlay swim*: only same-thread, same-frame camera + DOM writes are guaranteed to be presented together (1.3, 1.6, 2.6). The reference game's collect buttons are exactly this case. A worker renderer needs either the `transferToImageBitmap` sync path (per-frame hop plus main-thread work, erasing the benefit) or accepts swim.
- *Input-to-photon*: input exists only on the main thread; the camera is now purely client-local with no sim round trip, so the shortest possible path is event -> camera -> uniform -> submit in the same thread and frame. A worker can only add latency.
- *GC*: the unavoidable per-frame wrapper objects (1.4) are the same in every language; TypeScript makes the avoidable ones easiest to eliminate, wgpu adds per-call descriptor garbage, web-sys adds friction and glue. The main thread's frame is about 15-25 API calls with plain numbers.
- *Binary size / dependency weight*: TypeScript adds nothing to the WASM download (a stated mobile concern), needs no WASM instance or wasm-bindgen glue on the main thread, and keeps wgpu (large dependency tree, std-heavy) out of a project with a zero-dependency ethos. wgpu's main selling points (native targets, WebGL fallback) are non-goals.
- *"Main thread does only what is necessary"*: honored in spirit. With terrain as one draw and entities as one draw per layer (3.3, 3.5), main-thread work per frame is well under 1 ms and independent of world size. The renderer is an estimated 1.5-2.5k lines of TS.
- *Risk avoided*: WebGPU-in-worker on iOS Safari is the least-proven cell in the support matrix.

Accepted cost: a janky game UI framework on the main thread will stutter the canvas. Mitigation is the low-GC state observation path (section 4) so game UI work is small and change-driven.

Frame handoff (detail in 3.5): with `SharedArrayBuffer`, the worker publishes complete frames into a triple buffer and the main thread uploads the newest with one `writeBuffer` per stream from a long-lived shared view. Without cross-origin isolation the same interface works by ping-ponging two transferable `ArrayBuffer`s (2-3 small objects per frame of garbage). The interface does not change; this is `runtime-and-packaging.md`'s call.

This keeps Rust as the language of everything substantive; the deviation from "Rust for everything that reasonably can be" is a small TS renderer and camera. Flagged for Tyler (section 6).

### 3.2 WebGPU support, no-fallback viability, supported browsers

**No fallback is viable on mobile today.** Confidence: **high** for iOS (every device on iOS 26+, i.e. iPhone 11 and later; 85% measured), **medium** for Android (74% measured; gaps are pre-Android-12 devices, no-Vulkan-1.1 devices, and Samsung Xclipse until ~Chrome 154). For a friends-co-op prototyping engine that is acceptable. Alternative rejected: a WebGL2 fallback (doubles the renderer; explicitly a non-goal).

Cheap extra reach: **design the renderer inside the compatibility-mode subset and request `featureLevel: 'compatibility'`**, upgrading nothing. The design below already complies (instance data in vertex buffers, no storage buffers in the vertex stage, 2d-array textures only ever bound as 2d-array, textures <= 4096, integer data textures, one color attachment). Browsers that do not know the option ignore it. Confidence: **medium** (not yet exercised by us; treat as a constraint, not a test commitment).

**Supported-browser proposal** (a Tyler question; default):
- Tier 1 (tested every release): current and previous major of Chrome/Edge desktop (Windows, macOS, ChromeOS), Chrome Android (Android 12+), Safari macOS and iOS/iPadOS (today: Safari 26 and 27, which implies OS 26+).
- Tier 2 (expected to work, bugs fixed opportunistically): Firefox desktop on Windows (141+) and macOS (147+); Chrome Linux on supported GPUs.
- Unsupported: Firefox Android and Firefox Linux (no release WebGPU), iOS 18 and older, Android without core or compatibility WebGPU. Startup shows a clear "this browser/device lacks WebGPU" screen via an engine-provided capability check that the game styles.

### 3.3 Terrain rendering design (feeds the art contract and zoom budget)

Recommendation (confidence **medium**, pending the spike on phone fill rate). Alternative rejected: instanced quads per tile.

- **Tile page texture**: one 2D unsigned-integer texture (for example 2048x2048 `r16uint` per tile layer, or one `rgba16uint` for up to four layers) divided into chunk-sized pages; a chunk occupies a slot while resident on the client. 2048^2 at 32x32 chunks is 4096 slots, far above any subscription cap. Written with `writeTexture` when a chunk arrives or changes, never per frame.
- **Chunk indirection texture**: a small `r16uint` texture (for example 64x64) mapping (chunk coord minus window origin) to page slot, `0xFFFF` = not resident. Updated only when residency changes. Because it is keyed by residency and not by the camera, the worker can own it entirely; the main thread contributes only the camera uniform.
- **One full-viewport draw** for all terrain layers. Fragment shader: screen pixel -> world position (camera-relative: integer camera tile origin + float offset, so precision is independent of distance from the world origin) -> tile coord (integer math) -> chunk -> slot -> tile visual id -> art. Non-resident chunks render a neutral placeholder color.
- Neighbor lookups for dithering go through the same indirection, so **chunk borders need no aprons** and no special cases. Do neighbor loads only for pixels within the blend band of a tile edge.
- Tile visual table in a uniform buffer (64 KiB = 4096 vec4 slots): first array layer, variant count, flags (flip/rotate allowed), dither priority and band width.
- Frame draw list: terrain (1 draw) + entity layers (about 4-8 instanced draws) + optional debug. Constant, so no render bundles, no indirect draws, no per-chunk CPU work per frame.

### 3.4 The art contract

Confidence: **medium** (shape is sound; details are taste). Alternative rejected: a single general atlas for everything with nearest-neighbor sampling (bleeds under mipmaps, shimmers at fractional zoom).

- **Tiles**: the game's asset script emits a PNG sheet of square tiles of one size (`tile_px`, per-game config; 16 or 32) plus a manifest. The engine loads it with `createImageBitmap` + `copyExternalImageToTexture` (`premultipliedAlpha: true`, no color-space conversion) into a `texture_2d_array` (`rgba8unorm`), one layer per tile image, engine-generated mipmaps down to 1x1. 256 layers guaranteed; more only if `adapter.limits` allows, else a second array. No compressed formats.
- **Tile -> sprite mapping**: the *game's Rust* is the source of truth: a `tile_visual(layer, tile) -> u16` function run when a chunk is loaded or modified (not per frame) fills the page texture; a static `TileVisual` table (first layer, variant count, flags, dither priority/band) is uploaded once. Resource overlays (grass + coal) are a second tile layer composited in the same shader.
- **Variants and per-tile randomness**: `hash(tile_x, tile_y, world_seed)` in-shader (integer PCG, identical on all GPUs) picks variant, optional flip/rotation, and an optional tiny brightness jitter. Baked noise lives in the variant art itself (the reference game's script).
- **Edge dithering**: in-shader, stateless. For a pixel within `band` art-texels of a tile edge, load the neighbor's visual; if the neighbor has higher priority, replace this pixel with the neighbor's art when `bayer4x4(art_texel_coord) < coverage(distance)`. The mask is evaluated on the **art-texel grid**, so dither dots are the same size as art pixels. Fade the effect out as zoom drops below about 1 screen px per art texel.
- **Crispness**: bilinear sampler + the `fwidth` seam formula (2.3) for magnification; trilinear mips for minification; premultiplied alpha blending; canvas sized in true device pixels (3.10). No camera or zoom snapping is required for stability; optional "snap camera to device pixels when idle" flag for maximal sharpness (default on), and no integer-zoom snapping (default off).
- **Entity sprites**: padded atlas PNG(s) (2 px extrusion, mip chain limited to 2 levels beyond base, or downscaled variants baked by the script) + manifest: sprite id -> rect, pivot, size in tiles, optional frame count. The engine defines the manifest format; packing is the game's script (the reference game ships one; no engine tool, no npm dependency).
- **Shapes and indicators**: one instanced "uber-quad" pipeline; record `kind` selects sprite, circle/ring (SDF with `fwidth` AA; the reference game's players), rounded rect, **progress bar**, **radial progress**, and **tile ghost** (tinted sprite or rect with valid/invalid color and optional pulsing). Sizes in world units, stroke widths optionally in screen px. No in-canvas text: text is DOM.
- The collect-button fill is DOM and should be a CSS animation started once with the known 2 s duration (zero per-frame JS); in-world progress (a smelting furnace) uses the progress drawable.

### 3.5 Render-data extraction (Rust -> GPU instance buffers, no per-frame JS allocation)

Confidence: **medium-high** on the interface, **medium** on the handoff (depends on SAB availability). Alternative rejected: game returns JS objects/typed arrays per frame, or the engine introspects game state generically.

- The game implements one hook, called once per rendered frame on the client side of the module:
  `fn extract(&self, view: &FrameView, out: &mut DrawList)`.
  `FrameView` carries the interpolation time, the visible world rect (with margin), zoom, and the cursor tile. `DrawList` is an engine-owned, preallocated, fixed-capacity buffer in linear memory with typed push methods (`sprite`, `circle`, `rect`, `bar`, `radial`, `ghost`), each writing one fixed-size record (proposed 32 bytes: `pos: [f32;2]` camera-window-relative, `size: [f32;2]`, `sprite_or_kind: u16`, `layer: u8`, `flags: u8`, `color: u32`, `param: f32` (progress/rotation), `pick_id: u32`, 4 bytes spare).
- Layers are a small fixed set of buckets (proposed 8); each bucket is a contiguous range, optional y-sort within a bucket done in Rust. No depth buffer. Overflow drops the record and bumps a counter surfaced in debug stats.
- Capacity default 65,536 records (2 MiB), per-game config. (Factorio's far-zoom frame is ~25k sprites.)
- Handoff: the worker writes into one of three frame slots in shared memory and atomically publishes `(slot, counts per layer, frame header)`. The main thread, in rAF, takes the newest published slot and calls `queue.writeBuffer(instanceBuf, 0, sharedView, slotOffset, usedBytes)` with a view created once at startup. Memory must be preallocated so `memory.grow` never invalidates the view (ties to the arena question in `runtime-and-packaging.md`).
- Positions are in world space relative to the camera *window origin* (integer tiles), not relative to the live camera, so the main thread can apply the newest camera to a one-frame-old DrawList with no visible error: remote entities are already rendered ~100 ms in the past, and the camera is what must be instant.
- **Cursor-attached drawables**: a record flag `ANCHOR_CURSOR_TILE` makes `pos` relative to the snapped cursor tile, which the main thread supplies as a uniform. The 2x2 furnace ghost therefore tracks the pointer with zero added latency even though the game's validity color arrives a frame later.
- The frame header also carries an optional `camera_target` (see 3.7) and the UI-state version counter.
- Chunk texel uploads use a separate shared ring of "upload commands" (`target, slot, srcOffset, len`) drained by the main thread at frame start using reused `writeTexture` descriptor objects, with a per-frame byte budget to avoid hitches when many chunks arrive.

### 3.6 Camera ownership, report rate, and look-ahead

Confidence: **high** on ownership, **medium** on the numbers. Alternative rejected: sending the camera on every frame or on every input event.

- **Ownership**: the camera is main-thread TypeScript state (position f64 in tiles, zoom, velocity, viewport in CSS and device px), integrated by time in rAF. Each frame it is written to a small fixed **camera block** in shared memory (seqlock-guarded: pos, velocity, zoom, zoom rate, viewport half-extents in tiles, DPR, frame time). That single write feeds everything else with no messages: the renderer uniform, the overlay transform, the game's client-side Rust (the reference game's player follows it by reading this block), and the reporter.
- **Report** (non-action, unlogged, no prediction): `{center, half-extents in tiles, velocity, zoom rate}` about 40 bytes. Send **on change only**, at most **10 Hz**, plus immediately (rate limit bypassed) when the *desired chunk set* changes and once when motion ends; nothing while idle. In multiplayer the network worker reads the camera block on its own timer, so the main thread never posts camera messages; in single-player the sim worker's subscription logic reads the same block directly.
- **Look-ahead**: the subscription rect is the viewport rect expanded by a constant one-chunk ring, unioned with the viewport translated by `velocity * T_lead` and expanded by `zoom_rate * T_lead`, where `T_lead = clamp(RTT + generation budget + 1 report interval, 0.3 s, 1.0 s)`, capped at 2 chunks of lead per axis. With exponential-friction inertia the fling's resting point is exactly `p + v * tau`, so include it: the destination of a fling is prefetched the moment the finger lifts. **Hysteresis**: subscribe at ring 1, unsubscribe only beyond ring 2, so hovering on a chunk boundary does not thrash.
- The look-ahead function is shared engine Rust used by the host, which also clamps extents and zoom to the per-game cap (the untrusted-viewport rule in `sync.md`). The client sends raw camera + velocity rather than a chunk list so the host stays authoritative and the message stays tiny (about 400 B/s worst case).
- **How a game reads the camera on the client**: `engine::client::camera()` returns the latest camera block snapshot to the game's Rust each client frame/tick. Whether the reference game's follower position is ephemeral presence or sim state is an open Tyler question in `reference-game.md` and is not settled here; either way the input is this snapshot.

### 3.7 Who drives the camera (Tyler question; recommended default)

Default: the engine's camera is user-driven, and the engine exposes three cheap controls: **constraints** (world bounds, zoom range within the engine cap), **programmatic moves** (`moveTo`/`easeTo`), and an optional per-frame **follow target** delivered in the frame header by the game's client Rust (applied by the main thread on the same frame as that DrawList, with pan input disabled or treated as an offset). Do not build a "WASD moves a sim player, camera follows" input mode until a game needs it; the follow hook makes it possible later without redesign. Confidence: **medium**.

### 3.8 Gestures and the engine/game input split

Gestures. Confidence: **high**. Alternative rejected: Touch Events + Mouse Events separately, or a gesture library (dependency).
- Pointer Events on the canvas only; `setPointerCapture` on pointerdown; track up to two active pointers in fixed slots (no maps/arrays allocated per event). Do not call `getCoalescedEvents()`.
- One pointer drag = pan (world point under the finger stays under the finger). Two pointers = simultaneous pan by midpoint delta and zoom by distance ratio about the midpoint. Wheel = zoom about the cursor with `zoom *= exp(-deltaY * k)` (normalize `deltaMode`; larger `k` when `ctrlKey`, which is a Chrome/Firefox trackpad pinch). macOS Safari trackpad pinch via `gesturechange.scale`. Wheel notches ease toward a target zoom over ~100 ms; pinch is direct.
- Inertia: velocity from a fixed ring of the last ~80 ms of samples using event timestamps; exponential decay with time constant ~325 ms; cancelled by any new pointerdown; all time-based (30/60/120 Hz safe).
- WASD: `event.code` (layout-independent), speed proportional to visible extent so it feels the same at any zoom, with short acceleration ramp.
- Browser gesture suppression: canvas gets `touch-action: none`, `user-select: none`, `-webkit-touch-callout: none`; non-passive `wheel` on the canvas with `preventDefault()`; non-passive `gesturestart/gesturechange` `preventDefault()`; the engine documents (and offers a helper for) the required page CSS: fixed, non-scrolling root, `overscroll-behavior: none`, `height: 100dvh`, `viewport-fit=cover`. iOS edge-swipe navigation cannot be blocked; recommend installing as a PWA.

Input split. Confidence: **medium-high**. Alternative rejected: the engine forwarding raw DOM events to the game.
- **DOM-over-canvas hit testing is the browser's job**: the overlay root is a sibling above the canvas with `pointer-events: none`; game widgets set `pointer-events: auto`. Events on widgets never target the canvas, so the engine, which listens only on the canvas, never sees them. Pointer capture keeps a drag that started on the world alive when it passes under a widget.
- The engine turns raw input into **semantic world events** for the game: `tap` (movement under ~8 CSS px and under ~300 ms; carries world pos, tile, `pick_id`, button/modifiers), `hover` changes (mouse only, emitted only when tile or `pick_id` changes), `longpress`, and, when the game switches the input mode from `camera` to `tool`, `dragstart/drag/dragend` for one-pointer drags (two-finger pan/zoom still works). Events are written to a fixed-size ring the game's client Rust drains; the game turns them into game actions. A TS callback surface is also offered for UI-only reactions.
- **Picking**: tiles by pure math from the camera (synchronous, free). Entities by a reverse scan of the latest published DrawList for records with a non-zero `pick_id` whose shape contains the point: synchronous on the main thread, allocation-free, O(records) only on pointer events, and guaranteed to match what is on screen including interpolation. The game can still do semantic queries in Rust if it needs more. Alternative rejected: a GPU id-buffer readback (async `mapAsync`, garbage, latency).
- **Hover / placement ghost**: the engine maintains the cursor tile (mouse position, or viewport center / last tap on touch; game-selectable) and exposes it in `FrameView` and as the shader uniform used by cursor-attached drawables (3.5). The game emits the ghost and its validity; the engine draws it.
- **Keyboard focus**: key listeners on `window`; ignore events whose target is `input, textarea, select, [contenteditable]` or when `isComposing`; ignore when modifier chords belong to the browser; clear all key state on `blur`, `visibilitychange`, and `pointercancel` to avoid stuck keys. The game can also call `engine.input.suspend()/resume()` for modal UI.

### 3.9 Overlay anchoring

Confidence: **medium** (mechanism sound; style-recalc cost and text crispness on iOS to be confirmed in the spike). Alternative rejected: per-anchor `left/top`, or reading layout (`getBoundingClientRect`) each frame.

- API: `const a = engine.overlay.anchor(element, worldX, worldY, options)`; `a.set(x, y)`; `a.remove()`. The engine owns a single **anchor layer** element.
- Mechanism: each anchor element stores its world offset (relative to a floating origin tile) once in custom properties `--wx/--wy` and uses a static rule: `transform: translate(calc(var(--z) * var(--wx) * 1px), calc(var(--z) * var(--wy) * 1px)) translate(-50%, -100%)`. Per frame the engine writes **at most two properties on one element**: the layer's `transform: translate(tx, ty)` when the camera moved, and `--z` (CSS px per tile) when zoom changed. Panning is therefore a compositor-only change regardless of anchor count; zooming costs one style recalc over N anchors and no layout. Nothing is scaled, so text stays crisp. Writes are skipped when values are unchanged (idle camera = zero work, zero garbage); otherwise 1-2 short strings per frame.
- Written in the same rAF callback and from the same camera values as the GPU uniform, so the canvas and the DOM present together (the point of 3.1). Translation is rounded to device pixels at rest only.
- The floating origin is re-based when the camera is more than ~50k CSS px away, to stay inside browser layout-unit precision; rebasing rewrites `--wx/--wy` for all anchors (rare).
- Offscreen culling: anchors outside the viewport plus margin get `visibility: hidden` toggled only on transitions.
- Budget guidance: DOM anchors are for tens of elements (collect buttons, a tooltip). Anything in the hundreds (per-entity bars, labels) must be in-canvas drawables.
- Fallback if the spike dislikes the custom-property approach: MapLibre-style per-anchor `translate()` writes (N strings per frame), optionally via CSS Typed OM where available.

### 3.10 Zoom range as a numeric budget

Confidence: **medium**. Alternative rejected: expressing limits in pixels per tile (makes the visible-tile worst case depend on monitor size).

- Define zoom limits in **tiles across the viewport's long axis**, which makes the worst case device-independent:
  - Max zoom-out: **256 tiles** on the long axis (short axis follows aspect ratio; worst case square, 256 x 256 = 65,536 tiles; typical 16:9 is 256 x 144 = 36,864). On a 1920 px wide desktop that is 7.5 CSS px per tile; on a phone in portrait (844 px tall) 3.3 CSS px (about 10 device px) per tile.
  - Max zoom-in: **12 tiles** on the long axis.
- With 32 x 32 chunks: at most 8 x 8 = 64 visible chunks; with the one-chunk ring 10 x 10 = **100 subscribed chunks**; with full look-ahead on one axis at most about 120. Proposed host clamp: viewport extents <= 256 tiles per axis, subscription <= 128 chunks per client (scale by chunk size: <= ~131k tiles). At 4 bytes per tile (two u16 layers) the worst-case raw burst is ~512 KB, and a 2048^2 tile page texture (4096 slots) is ample.
- Entity budget 65,536 drawables (3.5).
- **Far zoom needs no separate representation for terrain**: the full-viewport shader costs the same at every zoom, and mipmapping the tile array down to 1 x 1 makes each tile converge to its average color, which *is* the map view. Dithering and per-tile jitter fade out below ~1 screen px per art texel to avoid noise. For entities the engine passes zoom in `FrameView` so the game can skip small drawables or swap to icon sprites; the engine does not impose an LOD scheme.

### 3.11 Resize, DPR, backgrounding, device loss

Confidence: **high** on approach.
- **Resize/DPR**: `ResizeObserver` with `device-pixel-content-box` (try/catch fallback to `content-box` times `devicePixelRatio`, rounded, for Safari), plus a re-armed one-shot `matchMedia('(resolution: Ndppx)')` for DPR changes on Safari. The observer only records the new size; the canvas `width/height` is set at the start of the next rAF and the frame is rendered immediately after, so there is no cleared-canvas flash. Clamp to `maxTextureDimension2D`. **Render-scale cap**: effective DPR capped (default 2, per-game config) to bound fill-rate and battery on DPR-3 phones. Canvas configured once per device: preferred format, `alphaMode: 'opaque'`, single color attachment, no depth, no MSAA. Overlay uses `env(safe-area-inset-*)`; canvas is full-bleed.
- **Backgrounding**: on `visibilitychange` to hidden: stop scheduling rAF, cancel inertia, clear key/pointer state, stop camera reports (subscriptions stay as last reported). On visible: reset the frame clock (no giant dt), re-check size/DPR, tell the sync layer so interpolation re-bases instead of fast-forwarding. What the single-player sim does while hidden (worker timers are throttled) is a simulation question (section 4).
- **Device loss**: every GPU object is a cache of CPU-side state, and recovery is "mark everything dirty". `device.lost` -> state `Lost` -> new adapter -> new device -> reconfigure the same canvas -> recreate pipelines/buffers -> re-fetch art (HTTP cache; do not retain ImageBitmaps) -> re-upload every resident chunk page, indirection table, tables -> resume. Camera, input, overlay, and the sim never stop. If the adapter is null or loss repeats (twice within ~10 s), emit a fatal `rendererLost` event so the game can show a reload prompt. `uncapturederror` is logged; init is wrapped in error scopes in dev builds. Tested by calling `device.destroy()` behind a test flag that treats `'destroyed'` as a real loss (ties to `testing.md`).

---

## 4. Cross-domain interactions

- **runtime-and-packaging / cross-thread**: the recommended handoff (camera block, DrawList triple buffer, upload ring, input event ring) wants `SharedArrayBuffer`, hence cross-origin isolation. Without it everything still works via two ping-ponged transferables and a posted camera message, at a few objects of garbage per frame. The renderer decision does not hinge on SAB, but the zero-GC claim does.
- **runtime / WASM memory**: long-lived main-thread views over WASM memory require that memory never grows after startup (or is shared memory with preallocated maximum). Supports the "preallocate a fixed arena" option.
- **runtime / worker topology**: this proposal puts *no WASM on the main thread* and assumes one "client worker" holding sync decode, interpolation, prediction, extraction, and chunk texel building. Worker-side frame production needs its own clock: worker rAF (Chrome 69, Firefox 99, Safari 16.4) or a main-thread rAF tick via `Atomics.notify`.
- **runtime / zero-GC definition**: WebGPU imposes a floor of about 4-5 wrapper objects per frame, and DOM events allocate their own event objects. Propose the measurable definition be "no allocation proportional to entities, chunks, or time; at most a small constant number of short-lived browser-created objects per frame", not literal zero.
- **runtime / JS-WASM boundary**: the main thread never calls into WASM in this design, so the wasm-bindgen-vs-hand-rolled-ABI question is confined to workers and the server.
- **world / chunk layout**: the renderer wants per-chunk, per-layer `u16` visual ids produced by a game function at load/modify time; chunk size of 32 assumed in budgets (any power of two works). Camera-relative integer tile origin solves rendering precision far from the origin. Dithering needs neighbor *visuals* across chunk borders, which the indirection texture provides only if the neighbor is resident; at the subscription edge the shader treats missing neighbors as "same as self". If the client regenerates pristine terrain from the seed, the ring of look-ahead chunks makes this invisible.
- **sync / untrusted viewport**: host clamp proposed at <= 256 tiles per axis and <= 128 chunks per client; camera report <= 10 Hz at ~40 bytes; look-ahead and hysteresis computed host-side by shared engine Rust. Subscription behavior for hidden tabs (keep, shrink, or drop after a timeout) is sync's call.
- **sync / interpolation**: extraction samples interpolated state at a time chosen per frame; the one-frame handoff delay should be included in the interpolation delay budget. After a visibility resume the time base must re-anchor.
- **simulation**: single-player sim in a hidden tab (throttled worker timers): pause vs catch up. Not a client decision, but the client is what detects visibility.
- **client "low-GC way to observe state"** (a Requirement, not listed as an open question): recommend a fixed-layout UI-state block in shared memory written by the game's Rust with a version counter, read through typed-array accessors; the overlay polls the version in rAF and touches the DOM only on change. Needs an owner (here or runtime).
- **testing**: device-loss injection, a per-frame allocation counter (for example Chrome's `performance.measureUserAgentSpecificMemory` is too coarse; use DevTools allocation sampling in CI via CDP), golden-image tests need a fixed DPR and the hash-based variants make frames deterministic.
- **reference-game**: collect buttons = overlay anchors + CSS animation for the 2 s fill; furnace ghost = cursor-attached drawable; players = circle drawables; furnace click = `tap` with `pick_id`; resource layer = second tile layer. On touch devices there is no hover, so ghost placement UX needs a choice (section 6).
- **mobile page discard**: on iOS/Android the likelier failure is the OS killing the backgrounded page. Fast resume (persistence, reconnect, camera restore) matters more than device-loss recovery there; the client should persist the camera locally.

---

## 5. Needs a spike

One combined client spike (2-3 days), because three recommendations rest on behavior I could not verify from sources:

1. **Full-viewport terrain shader on real phones**: indirection + tile load + neighbor dithering + fat-pixel sampling at max zoom-out, DPR cap 2, on one mid-range Android (Mali or Adreno) and one iPhone. Pass: steady 60 fps with GPU time under ~6 ms. If it fails, fall back to one instanced quad per visible chunk (same data textures) and drop neighbor lookups at far zoom.
2. **Main-thread frame allocation floor on Chrome, Safari, Firefox**: confirm about 5 objects per frame with reused descriptors; confirm whether Safari/Firefox accept a `GPUTexture` directly as an attachment view; confirm `writeBuffer`/`writeTexture` from a SAB-backed view on all three (especially Safari).
3. **Overlay anchoring on iOS Safari**: 50 anchors using the custom-property mechanism during pan and pinch; verify zero swim against the canvas, crisp text, and style-recalc cost; compare with per-anchor transforms.

Not a spike: worker rendering. It is rejected on architecture (input and DOM live on the main thread), not on feasibility.

---

## 6. Questions for Tyler

1. **TypeScript renderer and camera on the main thread.** This bends "Rust for everything that reasonably can be": Rust still produces all frame data, but the ~2k-line GPU ferry, camera, and input are TS with no WASM on the main thread. Recommended default: **accept**, because it is the only placement with zero overlay swim and minimum input latency, and it adds nothing to the WASM download.
2. **Who drives the camera?** Recommended default: user-driven engine camera plus game-set constraints, programmatic `moveTo/easeTo`, and an optional follow-target hook; no "WASD moves a sim player" mode until a game needs it.
3. **Supported browsers.** Recommended default: Tier 1 = current and previous major of Chrome desktop/Android and Safari macOS/iOS (OS 26+); Tier 2 = Firefox desktop (Windows, macOS) and Chrome Linux; Firefox Android/Linux and iOS 18 or older unsupported, with a clear capability screen.
4. **Android reach via compatibility mode.** Recommended default: treat the compatibility subset as a design constraint (it costs almost nothing in this renderer) and request it, but make no testing commitment for those devices.
5. **Zoom range.** Recommended default: 12 to 256 tiles across the long axis (host clamps to 256 tiles per axis and 128 chunks per client), render-scale cap DPR 2, snap-to-device-pixel at rest on, integer-zoom snapping off.
6. **Tile art resolution for the reference game.** Recommended default: 16 x 16 art pixels per tile (dither dots read as deliberate pixel art); the engine supports any single square size per game.
7. **Touch placement UX (no hover on phones).** Recommended default: tap positions the ghost, a DOM confirm button places it; on desktop the ghost follows the mouse and click places.

## Spike results

- **Desktop-testable parts** (per-frame WebGPU allocation floor, `writeBuffer` from shared memory): see `spikes/zero-gc-webgpu/RESULT.md`.
- **Real-phone parts** (terrain fill-rate, anchoring on iOS Safari): not run; deferred as manual device checks in ADRs 0018 and 0019.
