# M09: Renderer terrain data path

Status: not started · After: 08b · Tyler-dependent: no

Split during planning: full art sampling (variants, jitter, edge dithering, fat-pixel filtering, mips) and the canvas lifecycle (resize, DPR, render scale, backgrounding) are **M09b** (`09b-terrain-art-and-lifecycle.md`). This brief proves the whole data path with the simplest shader that can be probed exactly.

## Goal
Generated chunks from M08b's `TerrainFeed` appear on a WebGPU target: the client worker converts tiles to texels through `tile_visual`, stages them into the chunk-upload ring, and the main-thread ferry drains the ring under a per-frame byte budget into the page and indirection textures; one full-viewport draw maps pixel → tile → chunk → slot → texel → art. Readback tests with semantic pixel probes are the gate. This is the first GPU test in the repo, so M10 (CI) follows it.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0018-renderer.md` (§1, §2 first paragraph for `tile_visual`, §3, §4 `tiles.png`/`tiles.json`, §5, §7)
3. `docs/decisions/0007-world-model.md` (§4 tile layout and "Upload path"; the client cache budget in §7)
4. `docs/decisions/0020-testing-strategy.md` (§6 rendering layers and probe rules, §8, §9 counters)

Mine from spikes: `spikes/zero-gc-webgpu/public/main.js` (reused descriptors, offscreen target stepping, the five-wrapper frame, `writeBuffer` overload with offset and size), `tests/harness.mjs` (adapter assertion). Rules that apply: `.claude/rules/hot-paths.md`.

## Scope
- `render/device.ts`: adapter + device (`featureLevel: 'compatibility'`, limits checked not raised, 0018 §7), canvas configure, the `GPUTexture`-as-view startup probe (0018 §1), `uncapturederror` and `getCompilationInfo()` surfaced as errors; fills `checkSupport`'s `no-adapter`.
- `render/terrain.ts` + `render/wgsl/terrain.wgsl`: page texture, indirection texture, visual-table uniform, tile-art `texture_2d_array`, frame uniform (0018 §5 camera-relative maths in `i32`), one triangle, one draw. Sampling in this milestone: `textureLoad`, variant 0 only, nearest, no dithering, non-resident = neutral colour.
- `render/upload.ts`: drain `uploadRing` at frame start under the byte budget with reused descriptor objects.
- `render/art.ts`: fetch and validate `tiles.json`, `createImageBitmap` + `copyExternalImageToTexture` per cell into array layers (no mips yet).
- `frame-loop.ts`: the single rAF callback as a fixed, ordered phase list on the injected `Scheduler`: `camera` (no-op until M11) → `writeCameraBlock` + `CB_FRAME_REQ` + wake → `upload` → `render` → `overlay` (M18) → `ui` (M16).
- Rust: `TileTexel`, `ClientSide::tile_visual`, `Registry::{set_base_visual, set_resource_visual}`, `VisualTables`, `Uploader` (upload set, conversion while staging, indirection window), export `upload_stage`.
- Client worker body: after `frame`, call `upload_stage(free)` and copy staged blocks into `uploadRing`.
- Fixture game `fixtures/terrain/` (`fx-terrain`) with a generated flat-colour `tiles.png`; pages `terrain.html` (readback + GC) in the fixture app.

## Non-scope
M09b's list above. Sprites, DrawList, instance buffer (M17). Camera integration and gestures (M11): here the camera is set by `engine/test.setCamera` or a fixed `CameraState`. Tile deltas from the network (M15b calls `Uploader::enqueue_chunk` or `patch_tile` for dirty chunks). Device loss and `rendererLost` (M37b). `CHUNK_BITS` other than 5 (see Planning decisions).

## Files, packages and crates touched
`packages/engine` (`src/render/*`, `src/frame-loop.ts`, `src/worker/client.ts`, `src/test/*`, `src/abi.ts`, `scripts/embed-wgsl.mjs`, `tests/browser/`), `packages/engine/crates/engine` (`client/texel.rs`, `client/upload.rs`, `Registry` additions, `abi/registry.rs`), `packages/engine/fixtures/terrain/`.

## Seams
**Provides**
- Rust: `pub struct TileTexel { pub base: u16, pub resource: u16 }`, `TileTexel::from_tables(t: Tile) -> TileTexel`; `trait ClientSide<G>` gains `fn tile_visual(t: Tile) -> TileTexel` with the default of 0018 §2 (M09 runs before M12 in PLAN order, so it creates the trait here with `G` unbounded and this one method; the uploader is generic over `C: ClientSide<G>`. M12 adds the `G: Game` bound, `Game::Client` and the remaining methods as shells with empty default bodies, which M16b–M18 fill, so fixtures keep compiling). `Registry::set_base_visual(&mut self, base_id: u8, visual: u16)`, `Registry::set_resource_visual(&mut self, resource_id: u8, visual: u16)` (named like M07's `set_base_traits`). `Uploader::{on_frame(&CameraBlock, &TerrainStore), enqueue_chunk(ChunkCoord), patch_tile(TilePos, Tile), requeue_all()}`: `enqueue_chunk` re-converts a whole resident chunk from `copy_chunk` (M15b calls it for dirty chunks, or `patch_tile` for single tiles); `requeue_all` is for M37b.
- ABI (M02's rule): client export `upload_stage(max_records: u32) -> u32` (records staged into `RegionId::ChunkTexels`, sized here as 16 blocks of 4,112 bytes, one preallocated view pair per block).
- TS: `ClientOptions.assets: { tiles: string }` (URL of `tiles.json`; M17b adds `sprites`); `FrameLoop` phases by name; `renderer.viewport: { widthPx, heightPx, dpr, renderScale }` mutated in place (M09b's observer and M11's camera read it); `renderer.frameUniform` (M11 and M17 write camera and cursor fields into the same buffer).
- `engine/test`: `renderTo(client, { width, height })` (caller-supplied `rgba8unorm` target), `readPixels(client): Promise<Uint8Array>`, `tileCentrePx(camera, tx, ty, out)`, `expectPixel(pixels, x, y, rgba, tol)`, counters `drawCalls`, `uploadBytes`, `uploadRecords`, `pageSlotsUsed`.
- `tiles.json` schema v1 (below).

**Consumes** M06: `uploadRing`, `CameraState`, `writeCameraBlock`, control block. M06b: client worker body, `stepFrame`, `setCamera`, `untilQuiescent`, `asHarness`, `CameraBlock`. M07: `Tile`, `Registry`, `TerrainStore::{slot_of, copy_chunk, is_cached, drain_cache_events}`, `CacheEvent::{Loaded, Evicted}` (the cache slot **is** the page slot, 0018 §3). M08b: `TerrainFeed` (it fills the cache from the gen workers; M09 does not touch its queue), `engine::view::lookahead_chunks`, `gen.idle()`. M02/M03: ABI rule, `Scheduler`, fixture app, `openPage`. M04: `installGcPage`, `zeroGcSuite`, `budgets.json` (`gc.pages`, `counters`), `expectWithinBudget`; M10 lists GPU tests by grepping `expectAdapter|readback`, so readback specs keep "readback" in their file names. M08b's Deviations "Notes for later briefs" (`docs/plan/08b-gen-workers-and-queue.md`) also apply: `gen.idle`, `callParked` (one-line addition to wire a `gen`/`sim` kind for worker-side test reads), the `client` isolate's `waitForWake` figure to watch as gen traffic grows, and the `browser` suite's 19 s/25 s trip-wire before this milestone's own browser tests land.

## Planning decisions
- **`TileTexel::from_tables` registration (PRE-PLAN §10 gap).** The game calls `r.set_base_visual(id, visual)` and `r.set_resource_visual(id, visual)` inside `Game::register` (until M12 lands `Game`, the fixture registers through whatever hook M07/M08 fixtures use to fill the `Registry`). The engine keeps `VisualTables { base: [u16; 256], resource: [u16; 256] }`, initialised to the identity per layer (0018 §2) with `resource[0] = 0`, in an instance-wide cell written once after `register`; `from_tables` takes no table argument because 0018 fixes its signature. Visual ids are one namespace of 1,024 shared with `tiles.json`, so a real game registers at least its resource layer.
- **Upload-ring record layout.** Fixed records of 4,112 bytes: header `{ kind: u16, slot: u16, count: u16, _pad: u16, seq: u32, _reserved: u32 }` + 4,096-byte payload. `1 CHUNK`: 1,024 `rg16uint` texels for page slot `slot`, row-major. `2 PATCH`: `count` ≤ 512 entries `{ slot: u16, index: u16, texel: [u16; 2] }`. `3 INDIR`: `count` ≤ 1,024 entries `{ x: u8, y: u8, value: u16 }` (`0xFFFF` = none). A fixed record keeps each chunk contiguous in one slot, so `writeTexture` reads it through that slot's preallocated view with no assembly step. Golden-bytes test fixes it.
- **Which chunks upload.** 0008 §5: ring 1 plus the look-ahead chunks upload; ring 2 is generated only. `Uploader` keeps one bit per cache slot ("texels on the GPU"). `on_frame` runs when cache events arrived or the camera's chunk rectangle changed: it clears the bit and stages `INDIR` none for every `Evicted`, then queues cached, not-yet-uploaded chunks inside ring 1 + `lookahead_chunks`, nearest first.
- **Byte budget accounting.** The drain charges 4,096 per `CHUNK` and 64 per `PATCH` or `INDIR` entry (a proxy for per-call cost), stops before the record that would pass the budget of 0018 §3, and always takes at least one. `INDIR` records for a chunk are staged after its `CHUNK`, so a slot is never addressed before its texels exist. `upload_stage` is called with `min(ring free slots, 16)`, which bounds the worker's conversion burst to 16 chunks per frame.
- **`writeTexture` from a SAB view is unverified** (the spike proved `writeBuffer` only). Probe at init inside an error scope; on rejection copy each record into one preallocated non-shared 4,112-byte staging array first. Both paths allocate nothing. The WebKit scene below catches a Safari difference automatically.
- **Visual table comes from `tiles.json` on main**, not from the worker: `array<vec4<u32>, 1024>` with `x = first | variants << 16`, `y = flags | priority << 16`, `z = band`, `w` reserved. 0018 §8's "re-enqueue … the table" therefore needs no ring record.
- **Bind group layout** (the "exact WGSL" deferral; shader text is written here and in M09b): group 0: `0` frame uniform `{ cam_tile: vec2<i32>, cam_frac: vec2<f32>, viewport_px: vec2<f32>, tiles_per_px: f32, seed: u32, cursor_tile: vec2<i32>, cursor_valid: u32, neighbour_cutoff_px: f32 }`, `1` page `texture_2d<u32>`, `2` indirection `texture_2d<u32>`, `3` visual table, `4` tile art `texture_2d_array<f32>`, `5` sampler. WGSL lives in `.wgsl` files; `scripts/embed-wgsl.mjs` writes a checked-in `wgsl.generated.ts`, and a unit test fails when it is stale. `naga` validates every `.wgsl` in the Rust native suite (dev-dependency; 0017 §7 leaves those unrestricted).
- **`tiles.json` schema v1.** `{ "version": 1, "image": "tiles.png", "tile_px": 16, "columns": 16, "visuals": { "<visual id>": { "first": 0, "variants": 1, "flags": [], "priority": 0, "band": 0 } } }`. `image` is relative to the manifest URL; cells are numbered row-major; a visual's variants are consecutive cells; `flags` ⊂ `"flip_x" | "flip_y" | "rotate"`. Limits of 0018 §4 are validated with messages naming the offending id. M09 uses `first` only; M09b uses the rest.
- **`CHUNK_BITS` is 5 here.** 0003 allows 4, 5 or 6, but 0007 §4, 0008, 0015 and 0018 §3 state slab, slot and page sizes for 32 × 32 only. M09 derives every size from one `CHUNK_EDGE` constant and fails at init on any other value. 0024 §9 records the inconsistency and this rule; generalising is a later, separate decision.
- **Frame-time exit criterion: none here or in M09b.** Terrain cost is GPU fill-rate, which only a phone shows (M09b device check); the main-thread and worker shares of 0018 §9 become meaningful with 65,536 drawables. The first frame-time criterion and the `profile-frame` skill therefore land in M17b.

## Order of work
1. Rust texel conversion, tables, `Uploader`, record golden. 2. Device init and an empty frame on the offscreen target; `renderTo`/`readPixels`. 3. Fixture art script + `art.ts`. 4. Shader and bind groups; first probe scene with a hand-filled page texture. 5. Worker staging → ring → drain; residency from `CacheEvent`s. 6. Frame loop phases. 7. Counters, GC scenario, WebKit scene.

## Tests added
- Rust native: `texel.default_identity`, `texel.registered_tables`, `texel.override_shows_aux` (fixture overrides `tile_visual` for depletion), `upload.record_layout_golden`, `upload.stage_respects_max`, `upload.indir_after_chunk`, `upload.toroidal_window_pm31`, `wgsl.terrain_validates`.
- `unit` suite: `manifest.schema_errors`, `upload.budget_stops_and_takes_one`, `wgsl.generated_is_fresh`, `device.requests_compatibility_defaults` (0018 §7: `render/device.ts` keeps its adapter and device request descriptors as the module constants `ADAPTER_REQUEST` and `DEVICE_REQUEST`; the test asserts `featureLevel === 'compatibility'`, no `requiredLimits` and no `requiredFeatures`).
- `browser` suite, `terrain-readback.spec.ts` (Chromium): `terrain.probe_tile_colours` (probes both sides of a chunk border and a resource tile), `terrain.nonresident_is_neutral`, `terrain.patch_one_texel`, `terrain.far_from_origin_exact` (camera near ±2^23 gives the same pixels as near 0), `terrain.nothing_outside_viewport`, `device.view_probe_both_paths` (0018 §1: with the start-up probe forced to each result through a test-only option, `terrain.probe_tile_colours`' scene passes with no `uncapturederror`, and the path chosen unforced is recorded beside `adapter.info`), `terrain.upload_budget_while_panning` (600 stepped frames of scripted pan: `uploadBytes` per frame ≤ budget, `drawCalls == 1`, all ring-1 chunks resident at rest).
- Zero-GC: page id `terrain` through `zeroGcSuite({ pageId: 'terrain', path, expectAdapter: true })`, driven by a scripted pan so chunks are generated, converted, uploaded and evicted inside the window (0016 §2); isolates `main`, `client`, `gen0`. `@slow`: `terrain.probe_tile_colours` on Playwright WebKit.

## Exit criteria
- [ ] All tests above pass by name; every GPU test records `adapter.info` and fails on a null adapter, `uncapturederror` or a non-empty `getCompilationInfo()`.
- [ ] `budgets.json` holds `counters["render.uploadBytesPerFrame"]`, `counters["render.drawCallsTerrain"] = 1`, and `gc.pages.terrain` with `main` derived by 0016 §1's formula (this is the first WebGPU page, as M04 expects) and its `formula` text; the page passes with its generated negative controls.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t texel` · `pnpm test rust -t upload` · `pnpm test rust -t wgsl` · `pnpm test unit -t manifest` · `pnpm test browser -t terrain` · `pnpm test:slow -t terrain` · `pnpm test` · `pnpm lint`.

## Budgets
- GPU upload per frame and constant draws (PRE-PLAN §7, 0018 §3): counters `uploadBytes`, `drawCalls` in `terrain.upload_budget_while_panning`.
- Allocation per isolate (0016): page `terrain`; its `main` number is per-page, and M17 sets the final one on the page with the full frame.
- Memory: page texture + indirection as 0018 Consequences; `pageSlotsUsed` ≤ the client cache size of 0007 §7.

## Context artifacts
`packages/engine/CLAUDE.md`: `src/render/` layout, "WGSL is edited in `.wgsl`, then `node scripts/embed-wgsl.mjs`", and the probe-not-screenshot rule of 0020 §6. Extend `hot-paths.md` globs if `src/frame-loop.ts` is not covered. `run-tests` skill: add where readback artefacts (actual/expected PNG) are written.

## Manual device checks
None here. Fill-rate needs the full shader and a camera: `device-checks.md`, M09b item.

## Deviations
(filled in during Phase 3)

### Step 1 (Rust: texel conversion, tables, `Uploader`, record golden) -- done

Exact seam shapes, since the brief's prose abbreviates several:

- `pub trait ClientSide<G = ()>` (`crates/engine/src/client/texel.rs`): the brief says "`G`
  unbounded"; giving it a default of `()` lets a fixture write `impl ClientSide for Fixture {}`
  and instantiate `Uploader<Fixture>` without ever naming `G`, with no loss of generality (M12
  still supplies its own `G: Game` and drops the default).
- `pub struct Uploader<C: ClientSide<G>, G = ()>` (`client/upload.rs`), matching. `Uploader::new`
  panics (`assert_eq!`) when `dims.edge() != 32`, the same style `ChunkDims::new` already uses for
  its own bits check -- not a `Result`, per Planning decisions "`CHUNK_BITS` is 5 here" ("fails at
  init").
- `Registry` gained `base_visual(u8) -> u16` / `resource_visual(u8) -> u16` getters (not named in
  the brief) alongside the named `set_base_visual`/`set_resource_visual`, so
  `client::texel::install_visual_tables(&Registry)` -- also not named in the brief, the function
  that snapshots a filled-in `Registry` into the instance-wide cell -- never needs `Registry`'s
  private fields. A fixture (or, from M12, `Game::register`'s tail) calls
  `reg.set_base_visual(..)` / `set_resource_visual(..)` then `install_visual_tables(&reg)` once.
- `Instance::upload_stage(&mut self, max_records: u32, out: &mut [u8]) -> u32`: the ABI export
  itself is exactly `upload_stage(max_records: u32) -> u32` as specified (numbers only, per
  0014 §2), but the *trait* method needs the `ChunkTexels` region handed in, the same shape
  `gen_chunk`'s `Instance` method takes `out: &mut [u8]` while its export takes none. `abi::mod.rs`'s
  new `upload_stage` dispatcher fetches `RegionId::ChunkTexels` via `rt.layout.bytes_mut` and
  forwards it. `Uploader` itself exposes `stage(&mut self, max_records: u32, store: &TerrainStore,
  region: &mut [u8]) -> u32` (not in Provides -- an implementation detail a fixture's own
  `upload_stage` impl calls, passing its own `TerrainStore`), doing the CHUNK-then-INDIR-then-PATCH
  priority ordering.
- `view::lookahead_chunks`'s `velocity: (i32, i32)` only reads the *sign* of each axis (its own doc
  comment). `Uploader::on_frame` passes `(sign_i32(camera.velocity[0]), sign_i32(camera.velocity[1]))`
  rather than duplicating `TerrainFeed`'s private Q24.8 conversion for a value only ever compared to
  zero.
- `Uploader`'s nearest-first sort duplicates `view::nearest_first`'s private squared-distance
  helper as `chunk_dist_sq` (that helper isn't `pub`); ring-1 chunks and the up-to-2 look-ahead
  chunks are pooled into one `scratch_candidates` buffer (capacity 256, "0018 §6's 121 chunks"
  worst case) and sorted together, rather than two separate orderings.
- `requeue_all` (M37b's seam) is implemented minimally here: clears every "on GPU" bit and forces
  the next `on_frame` to rescan ring 1 + look-ahead from scratch. It does **not** replay every
  chunk resident outside that window -- a fuller device-loss re-enqueue (0018 §8: "ask the worker to
  re-enqueue every resident chunk") is M37b's own extension; flagged here rather than guessed at,
  since M09 has no device-loss test to drive the exact shape.
- `PAGE_SLOTS = 1_024` and the `Uploader::uploaded` bit-array are sized to the fixed 1024x1024 page
  texture (0018 §3), independent of a store's configured `CacheCapacity` -- a game must configure
  its client cache to <= 1,024 chunks for terrain rendering to address every cached slot; nothing
  here enforces that bound (Non-scope: cache capacity is 0007 §7's own concern).
- ABI: `ABI_VERSION` 4 -> 5 (`crates/engine/src/abi/registry.rs`, `packages/engine/src/abi.ts`), one
  new export `upload_stage: { role: 'client', params: 1, result: 'u32' }`.

Measured: `pnpm test rust` 139 tests (was 129; +10: 3 `texel`, 6 `upload`, 1 `traits`),
`pnpm test wasm` 32 (unchanged count, ABI-registry mirror test covers the new export),
`pnpm test` overall: rust 139 (0.4s/10s), unit 90 (1.1s/3s), wasm 32 (1.4s/7s), browser 63
(21s/25s -- unchanged, no browser test added this step). `pnpm lint` green after `pnpm format`
(rustfmt reformatted the new test files' struct literals).

### Steps 2-4 (device init, fixture art, terrain shader and bind groups) -- done

Delegated separately from step 1, with the delegation prompt explicitly permitting `terrain-
readback.spec.ts` to land against a **hand-filled page/indirection texture** rather than the real
worker -> ring -> drain data path (step 5). No `fixtures/terrain` Rust crate exists yet: every test
in this range drives `render/device.ts`/`terrain.ts`/`art.ts` directly from `terrain.html`'s page
script, with no worker and no ABI instance at all. `Uploader`/`ClientSide`/`upload_stage` from step 1
are untouched and still exactly where a step-5 successor needs them.

**Exact seam shapes**, since several differ from the brief's prose:

- `render/device.ts`: `ADAPTER_REQUEST: GPURequestAdapterOptions = { featureLevel: 'compatibility' }`,
  `DEVICE_REQUEST: GPUDeviceDescriptor = {}` -- **`featureLevel` is a `requestAdapter()` option, not
  `requestDevice()`'s** (checked against
  https://webgpufundamentals.org/webgpu/lessons/webgpu-compatibility-mode.html and Chrome's own
  "What's new in WebGPU 146" post, 2026-09-20; 0018 §7's prose names neither call). `initDevice(opts?:
  { test?: { forceViewProbe?: boolean } }): Promise<RendererDevice>`, `RendererDevice = { device,
  adapterInfo, viewProbePasses, errors(): string[], checkCompilation(label, module): Promise<void> }`.
  The `GPUTexture`-as-view probe (0018 §1) runs inside a `pushErrorScope('validation')` at `initDevice`
  time; `checkSupport()`'s `no-adapter` now does a real `requestAdapter(ADAPTER_REQUEST)` call and is
  `async` (was a bare `Promise.resolve(...)` wrapper before).
- `engine/test` (`src/test/render.ts`): `renderTo(renderer: Renderable, opts: { width, height }):
  RenderTarget` and `readPixels(target): Promise<PixelBuffer>` where `PixelBuffer = { width, height,
  data: Uint8Array }` -- **the brief says `renderTo(client, ...)` / `readPixels(client):
  Promise<Uint8Array>`**; there is no `Client` in this milestone's scope (rendering is main-thread-only
  and no worker exists for a hand-filled scene), and `expectPixel`/`tileCentrePx` need a pixel's width
  to index it with no other place to carry it, hence the small struct instead of a bare buffer.
  `Renderable = { device: GPUDevice; draw(target: GPUTexture): void }` (structural, not `TerrainRenderer`
  specifically). `tileCentrePx`'s camera parameter is `CameraFrame`, a structural subset of
  `FrameUniformValues` (`camTileX/Y`, `camFracX/Y`, `viewportPxW/H`, `tilesPerPx`) -- kept local to
  `test/render.ts` (step 2) rather than importing `render/terrain.ts` (step 4), so the two files have
  no dependency in either direction.
- `render/art.ts` **owns `VISUAL_TABLE_ENTRIES`/`VISUAL_TABLE_BYTES`** (1,024 x 16 B = 16,384),
  not `render/terrain.ts`: `buildVisualTable` is what actually lays the bytes out, and step 3 precedes
  step 4 in the Order of work, so `terrain.ts` imports and re-exports them instead of the other way
  round. `validateManifest(value: unknown): TilesManifest` throws `ManifestError` naming the offending
  id/field; `MAX_VISUALS = 1024`, `MAX_CELLS = 256` (0018 §4). The visual table's `flags` bit
  assignment (`flip_x = 1, flip_y = 2, rotate = 4`) is this milestone's own choice: 0018 §3 fixes only
  that the field exists. `loadTileArt(device, manifestUrl): Promise<LoadedArt>` resolves the image URL
  against **`manifestRes.url`** (the fetch response's own, absolute, redirect-resolved URL), not the
  caller's `manifestUrl` string -- `new URL(relative, base)` requires `base` itself to be absolute, and
  a caller-supplied `manifestUrl` of `/terrain/tiles.json` is not one.
- `render/terrain.ts` (`createTerrainRenderer(device, opts: { colorFormat, viewProbePasses })`): the
  bind group layout is an **explicit `GPUBindGroupLayout`**, not `layout: 'auto'` -- this milestone's
  shader never references `art_sampler` (binding 5: `textureLoad` only, no filtering yet), and an
  auto-derived layout only includes bindings a pipeline's shader stages statically reference, so
  `buildBindGroup`'s entry for an omitted binding 5 would be invalid. Every texture bound with a
  non-default view dimension needs **`textureBindingViewDimension: '2d-array'`** at *texture creation*
  time in compatibility mode (0018 §7's "each texture bound with one view dimension" turned out to mean
  this, not just the bind group layout's own `viewDimension` field) -- found by
  `device.view_probe_both_paths`'s own `uncapturederror`, on both the placeholder and the real tile-art
  texture. The indirection texture is explicitly zero-filled to `INDIR_NONE` (`0xFFFF`) once at
  construction: WebGPU zero-initialises new textures, but `0` is a valid page slot here, not "none", so
  `terrain.nonresident_is_neutral` would otherwise read garbage (slot 0's stale content) instead of the
  neutral colour. `TerrainRenderer` also exposes test/step-5 hand-fill methods not named in the brief's
  Seams (`writePageChunk`, `writePageTexel`, `writeIndir`, `writeVisualTable`, `setTileArray`) plus
  `drawCalls()`/`pageSlotsUsed()` counters.
- `terrain.wgsl`'s `visual_table` binding is `var<uniform> visual_table: VisualTable` where `struct
  VisualTable { entries: array<vec4<u32>, 1024> }` -- **a fixed-size array cannot be a uniform-address-
  space variable's type directly** in WGSL (verified against https://www.w3.org/TR/WGSL/, 2026-09-20;
  the brief's Planning decisions write the bare array type). Chunk/local tile math uses `tile.x >>
  CHUNK_BITS` (arithmetic shift, sign-extending for negative `i32`) and toroidal indirection addressing
  via `chunk & INDIR_MASK` (`63`) -- exactly `rem_euclid(64)` for a two's-complement `i32`, including
  negative values, which is what makes `terrain.far_from_origin_exact` work: chunk `(1<<18, 1<<18)` and
  chunk `(0, 0)` share the same masked cell since `1<<18` is a multiple of 64. Neutral colour is
  `vec4(32/255, 32/255, 32/255, 1)`, chosen to round-trip exactly through an `rgba8unorm` readback.
- `scripts/embed-wgsl.mjs` exports a pure `generate()` (and `outFile`), imported directly by
  `src/render/wgsl.generated.test.ts` (`wgsl.generated_is_fresh`) so the freshness check never shells
  out. `wgsl.generated.ts` is excluded from Biome's `files.includes` (`biome.json`, alongside the
  existing `src/bindings` exclusion): Biome's own line-wrap reformatting of the generated file's one
  long string literal made it disagree with `generate()`'s raw output after every `pnpm format`.
- `crates/engine/tests/wgsl.rs`: `naga = { version = "30", features = ["wgsl-in"] }` (dev-dependency,
  0017 §7 leaves those unrestricted) parses and validates every `.wgsl` file under
  `src/render/wgsl/`, natively, no GPU.
- `tests/browser/support/gpu.ts`: `expectAdapter(testInfo, info): void` (records `adapter.info` as a
  Playwright annotation, fails -- via `expect` -- on `null`, never skips) and
  `expectNoGpuErrors(errors): void`. Not named in the brief's Seams, but its own text says M10 finds
  every GPU test by grepping `expectAdapter|readback`, so this name is now load-bearing.
- `tests/browser/pages/public/terrain/{tiles.png,tiles.json}`: a checked-in 64x16 sheet of four 16px
  flat-colour cells (visuals 0/1/2/5: black/grass-green/water-blue/ore-orange), generated by
  `scripts/gen-terrain-art.mjs` (which uses `scripts/lib/png.mjs`, a from-scratch ~80-line PNG encoder
  -- no PNG-writing devDependency existed and none was added). Served at `/terrain/*` because
  `tests/browser/pages/vite.config.ts` has no explicit `publicDir` override, so Vite's default
  (`<root>/public`) copies it into the built `dist/` the browser suite's `vite preview` serves.
- Added `@webgpu/types@0.1.74` as an exact-pinned devDependency (this TypeScript's `lib.dom.d.ts` has
  no WebGPU types yet). Not yet reflected in 0017 §10's toolchain-pin table (an accepted ADR, out of
  scope to edit here) -- an orchestrator decision on whether that table needs a formal amendment.

**Which browser tests landed against the hand-filled path, and what step 5 changes:** all five --
`terrain.probe_tile_colours`, `terrain.nonresident_is_neutral`, `terrain.far_from_origin_exact`,
`terrain.nothing_outside_viewport`, `device.view_probe_both_paths` -- pass today by writing
page/indirection/visual-table bytes directly through `TerrainRenderer`'s test setters, with no worker
and no `TerrainStore`/`Uploader` involved. Step 5 does not change any pixel these tests assert (the
shader and its data layout are already final); it re-points *how the bytes arrive* -- `render/upload.ts`
draining the real `uploadRing` instead of `terrain.html`'s direct `writePageChunk`/`writeIndir` calls --
and adds `terrain.patch_one_texel` and `terrain.upload_budget_while_panning` (not landed here: both
need the real ring and a scripted pan). `terrain-readback.spec.ts` itself is expected to gain a second
scene-setup path (real ring) alongside the hand-filled one, or to be re-pointed wholesale, at the
orchestrator's/step-5 implementer's discretion.

**Interpretation calls the brief left open**, recorded rather than guessed silently:
- `terrain.nothing_outside_viewport`: read as "nothing beyond a resident chunk's on-screen footprint
  shows anything but the neutral colour" (a 64x64 target, one resident chunk at its centre, every
  corner probed neutral) -- the brief names the test but not what "outside" means, and this is the
  reading that doesn't collapse into a duplicate of `nonresident_is_neutral`.
- `device.view_probe_both_paths`: runs the border-probe scene once with `forceViewProbe: false`, once
  with `forceViewProbe: true` (both on fresh pages, since a `GPUDevice` cannot un-probe itself), asserts
  identical pixels both ways, and separately records the real, unforced probe result next to
  `adapter.info` (measured below) rather than asserting a specific value for it -- Chrome's own
  behaviour here is exactly what's being observed, not a thing to pin down as "must be true".

**Measured** (quiet-machine `pnpm test`, `uptime` load average 2.6-5.6 before each run):
`rust pass 140 tests 0.4s/10s` (+1: `wgsl.terrain_validates`), `unit pass 98 tests 1.2s/3s` (+8:
3 `art`, 1 `device`, 1 `wgsl.generated`, 3 `test/render`), `wasm pass 32 tests 1.4s/7s` (unchanged),
`browser pass 68 tests 20s/25s` (+5, **well inside the 19-20s/25s trip-wire**: the five new tests'
own durations, from `test-results/browser/report.json`, are `device.view_probe_both_paths` 323ms,
`probe_tile_colours` 231ms, `nonresident_is_neutral` 217ms, `far_from_origin_exact` 263ms,
`nothing_outside_viewport` 253ms -- about 1.3s total). `pnpm lint`: biome 0.3s, rustfmt 0.1s, clippy
0.3-8.7s (cold vs. warm target dir), tsc 0.6-0.8s, all green. Real adapter recorded by every GPU test
here: `{"vendor":"apple","architecture":"metal-3","device":"","isFallbackAdapter":false}` (headless
Chromium, Tyler's Mac); the real, unforced `GPUTexture`-as-view probe reports `true` (this Chromium
accepts a bare `GPUTexture` as a render-pass attachment `view`, consistent with 0018 §1's "Chrome
140+").

No budgets file entries added yet (`counters["render.uploadBytesPerFrame"]`,
`counters["render.drawCallsTerrain"]`, `gc.pages.terrain`): all three are step 6/7's own (the frame
loop, the ring drain and the zero-GC page don't exist yet).

### Steps 5-7 (worker staging, frame-loop phases, counters/GC page/WebKit scene) -- done

Delegated as one continuation from the step-1/2-4 predecessors' stopping point. Commits
`d9e948e` (step 5), `1219d79` (step 6), plus this milestone's own step-7 commit.

**`fixtures/terrain` (`fx-terrain`), the Rust crate steps 2-4 deferred.** Gen and Client roles
(`Sim` rejected). `Worldgen for FixtureTerrain` is deterministic, not real worldgen: chunk (0, 0)
is grass (`Tile::new(1, 0, 0)`) with one ore tile at local index 5 (`Tile::new(1, 5, 0)`), chunk
(1, 0) is water (`Tile::new(2, 0, 0)`), everywhere else `Tile::VOID`. Base/resource layer ids
(1/2/5) double as visual ids through `ClientSide`'s *default* identity table -- no
`Registry::set_base_visual`/`install_visual_tables` call needed, since those ids already match
`tests/browser/pages/public/terrain/tiles.json`'s grass/water/ore (the same sheet the hand-filled
scenes from steps 2-4 use, so pixel expectations carry over unchanged). Client-role `init` declares
`RegionId::GenIn` (`TerrainFeed::gen_in_bytes`) and `RegionId::ChunkTexels`, sized
`MAX_STAGE_BATCH * RECORD_BYTES` = 16 * 4,112 = 65,792 bytes (`MAX_STAGE_BATCH = 16`, a
crate-local const matching `worker/client-upload.ts`'s own `UPLOAD_BATCH_MAX`). `FixtureRole::
Client`'s `uploader: Box<Uploader<FixtureTerrain>>` is boxed (clippy `large_enum_variant`: the
`Gen(GenCore<..>)` variant is ~48 B, `Client{..}` was 1,344 B unboxed). `frame()` runs
`feed.on_frame(camera, terrain)` then `uploader.on_frame(camera, terrain)`, in that order, every
call; `upload_stage` forwards to `uploader.stage(max_records, terrain, out)`.

**`worker/client-upload.ts`** (`createUploadPump`): mirrors `client-gen.ts`'s shape exactly. `want =
min(ring.freeSlots(), UPLOAD_BATCH_MAX)` computed *before* calling `upload_stage`, per Planning
decisions -- this is what makes it safe for `Uploader::stage` to never have a staged-but-undelivered
record (the ring is never asked to hold more than it currently has room for). The copy loop uses
`copyBytes(ring.slotView(claimed), 0, region.u8, i * RECORD_BYTES, RECORD_BYTES)` (`RECORD_BYTES =
4112`, matching `client::upload::RECORD_BYTES` exactly) -- no per-slot cached view needed on this
side, since `region.u8` (the `ChunkTexels` `RegionView`) is a stable, already-live-updated whole-
region view. Wired into `worker/client.ts`'s `body()` as `uploadPump.pump()`, called every wake
after `genPump.pump()`, unconditionally (same "costs nothing on a page with no `Uploader`" shape).

**Found and fixed: `sab/layout.ts`'s `uploadRing.slotBytes` was wrong (4,112, not 4,120).** M06 sized
it before the record layout existed (its own comment permits "an owning milestone may revise its own
row"). The ring's *own* 8-byte per-slot header (`sab/ring.ts`) sits on top of `slotBytes`, so a
4,112-byte `slotBytes` left only 4,104 payload bytes -- 8 short of one whole `RECORD_BYTES` (4,112)
record, which the design requires never to span slots ("keeps each chunk contiguous in one slot").
Fixed to 4,120. `sab/ring.ts` also gained `RingProducer.freeSlots()` (Planning decisions' own
"min(ring free slots, 16)") and `RingConsumer.slotCount()` (lets `render/upload.ts` precompute one
derived view per slot at setup, never mid-drain).

**`render/upload.ts`** (`createUploadDrain(consumer, renderer, opts?: { sabWriteTextureOk?: boolean
})`): `drain(budgetBytes)` walks the ring via the *slot-level* `RingConsumer` API (`peek`/
`slotView`/`release`; one record is exactly one slot, `popInto`'s message-spanning path is never
needed), charging `CHUNK_BYTE_COST = 4096` or `count * ENTRY_BYTE_COST` (`ENTRY_BYTE_COST = 64`,
matching `client::upload`'s own accounting exactly) per record, stopping before the record that
would exceed budget but always taking at least one. Reused scratch: `indirScratch: IndirEntry[]`
(1,024, `INDIR_MAX_ENTRIES`) and one `patchTexelScratch: Texel`, both mutated in place.

**The `writeTexture`-from-a-SAB-view probe (Planning decisions), implemented, not just recorded.**
`render/device.ts`'s `probeWriteTextureFromSharedView(device)`: inside a validation error scope,
`writeTexture`s a throwaway `rg16uint` 1x1 texture from a `Uint16Array` over a real
`SharedArrayBuffer`; `RendererDevice.sabWriteTextureOk` is the result (`false`, not a probe failure,
when the global itself is absent -- never throws on a non-isolated caller). `render/terrain.ts`
gained `writePageChunkBytes(slot, le16: Uint16Array)` (`le16.length === CHUNK_EDGE*CHUNK_EDGE*2`,
already the wire layout -- no `Texel[]` conversion, unlike `writePageChunk`, which now just fills
`chunkScratch` and forwards to the same private `writeChunkTexture` helper). `render/upload.ts`'s
CHUNK handling picks a path once, from `opts.sabWriteTextureOk` (default `false`): **fast** --
`chunkViews: Uint16Array[]`, one per ring slot, precomputed entirely at `createUploadDrain`
construction (`consumer.slotCount()` iterations, each `new Uint16Array(payload.buffer,
payload.byteOffset + 16, 2048)`) so no view is ever derived mid-drain; **fallback** -- one
preallocated non-shared `stagingU16`/`stagingU8` pair, filled with a manual byte loop. Both paths
allocate nothing per record, matching Planning decisions exactly. **Measured on this machine**:
`sabWriteTextureOk` is `true` on both headless Chromium (`vendor: apple, architecture: metal-3`) and
headless WebKit (`vendor/architecture/device/description: apple`) -- no Safari difference found
here; `terrain: probe tile colours` records the value as its own `sabWriteTextureOk` annotation on
every run (both the fast-tier chromium test and its `@slow` WebKit repeat) so a future run on a
browser that *does* reject the SAB view is visible without re-deriving anything.

**`Client` gains `cameraState`/`uploadRing`/`writeCameraAndWake(): number`** (`src/client.ts`) --
not a rename of anything under Seams' Provides, an addition: `frame-loop.ts` needs direct,
production-shaped access to exactly these three things, and the existing `clientTestHandle`
machinery is documented test-only ("later milestones add members" was its own forward-looking
comment). `writeCameraAndWake` is fire-and-forget (writes the block, bumps `CB_FRAME_REQ`, wakes,
returns the new value) -- no ack spin; that stays `engine/test.stepFrame`'s own job.
`ClientOptions.assets: { tiles: string }` is added but not read by `createClient` itself (rendering
never touches a WASM instance, 0018 §1): a caller passes the same `assets.tiles` string to both
`createClient` and `render/art.ts`'s `loadTileArt` directly, so no plumbing was needed beyond the
type existing.

**`frame-loop.ts`** (`createFrameLoop`): `FRAME_PHASES = ['camera', 'writeCamera', 'upload',
'render', 'overlay', 'ui']`. `tick()` runs them in order once; `start()`/`stop()` drive
`scheduler.requestFrame`/`cancelFrame`. `onCamera`/`onOverlay`/`onUi` default to no-ops (M11/M18/
M16). **Not exercised by any browser test in this milestone**: `writeCameraAndWake`'s fire-and-forget
semantics are correct for a real 60 Hz loop (the render phase draws whatever the worker managed to
stage since the last wake -- one frame of latency is the intended tradeoff) but wrong for the
deterministic, pixel-exact tests steps 5/7 need (a chunk staged *this* frame must be visible in the
*same* synchronous check), so every real-client test reimplements the phase sequence with `engine/
test.stepFrame`'s lockstep instead of calling into `createFrameLoop`. Verified instead by
`frame-loop.test.ts` against fake `Client`/`TerrainRenderer`/`Scheduler` objects (phase order, no-op
defaults, `start`/`stop` wiring) -- not named in the brief's own Tests added list, added because the
module otherwise had zero coverage.

**`engine/test` (`src/test/render.ts`): `renderTo`/`readPixels` now overloaded, not just
renderer-shaped.** `renderTo(renderer: Renderable, opts)` (steps 2-4's shape, kept: `far_from_origin_
exact`, `nothing_outside_viewport` and `device.view_probe_both_paths` still hand-fill textures, no
client) and `renderTo(client: Client, opts)` (new): the latter fully drains `client.uploadRing`
(no budget -- a test convenience `src/test/**`'s hot-paths exemption allows) via a fresh
`attachRenderer`-paired `TerrainRenderer`, draws once, and remembers the `RenderTarget` in a
`WeakMap<Client, RenderTarget>` so `readPixels(client)` (also newly overloaded, alongside the
original `readPixels(target: RenderTarget)`) can read it back with no target argument. `attachRenderer
(client, renderer)` is the one-time pairing call every real-client test/page makes right after
`client.ready`.

**Real-client browser tests (`terrain-client.html`/`.ts`, a new page beside `terrain.html`)**:
`probe_tile_colours` and `nonresident_is_neutral` are re-pointed exactly as instructed (real
`createClient()` + `fx-terrain`, `setCamera`/`setHalfExtent`/`idle()` for the former, nothing at all
for the latter). `far_from_origin_exact`, `nothing_outside_viewport` and `device.view_probe_both_
paths` are **not** re-pointed: all three exist to probe the *shader's* own camera-relative maths and
the view-as-attachment startup probe, neither of which depends on how texels arrived, so they stay
on `terrain.html`'s hand-filled path (steps 2-4's own tests, untouched).

**`patch_one_texel` -- interpretation call.** Not one of the two tests the brief names as needing a
real client, and giving it one would need a mechanism this milestone has no other reason to build:
`Uploader::patch_tile`/`enqueue_chunk` are M15b's own seam (network deltas), and there is no ABI
export or test hook that reaches them from a real running client without inventing one (an ad hoc
raw WASM export can't reach `export_instance!`'s macro-hygienic `__ENGINE_SLOT` from outside the
macro invocation; a raw pointer stashed during `Instance::init` would dangle, since `init` returns
an owned value moved into `Runtime<T>` afterwards). Implemented instead as a direct, real-ring
integration test of `render/upload.ts`'s own CHUNK-then-PATCH handling: `terrain.html` gained
`createTestRing`/`stageRecord(bytes)`/`drainRing(budgetBytes)` (a real `uploadRing`-shaped SAB,
`createRing(4120, 4)`, driven by hand-built little-endian records, no worker), proving the
CHUNK-then-PATCH-on-top-of-it path `terrain-readback.spec.ts`'s original hand-filled tests never
exercised (they only ever called `writePageChunk`/`writePageTexel` on the renderer directly, never
through `render/upload.ts` at all).

**`upload_budget_while_panning`**: `terrain-client.ts` gained `panAndDrive(frames, dtMs,
panPerFrameX, panPerFrameY, budgetBytes)`, running the whole 600-frame scripted pan inside one
`page.evaluate` call (600 separate round trips would itself risk the browser-suite budget) and
returning every frame's own `uploadBytes`. "Ring-1 chunks resident at rest" is checked by
`gen.chunkHash(client, 0, 0)`/`(1, 0)` both non-null after the pan plus a settling `idle()` --
**not** a reconstruction of `view::visible_rect`/`expanded(1)`'s exact rectangle in TypeScript (that
would couple a test to Rust-internal view math for no real gain, since this fixture's only two
chunks with distinguishable content are exactly (0, 0) and (1, 0)). "`drawCalls == 1`" is checked
by rendering exactly once, after the pan, not once per simulated frame (0018 §1's "constant draws"
claim is about one draw *regardless of upload traffic*, not about issuing 600 draws).

**Not covered by any test here: a CHUNK split from its own INDIR across two separate frames by the
byte budget.** The ordering (`Uploader::stage`'s own CHUNK-before-INDIR priority, proven natively by
`upload.indir_after_chunk`) makes this safe by construction -- a slot's page texels land before its
indirection entry regardless of which `drain()` call each one falls in -- but no browser test drives
a budget small enough to force the split and then reads pixels mid-way to prove it stays correct.
Flagged per the delegation prompt rather than added silently: it would need a deliberately tiny
budget (splitting one CHUNK record from its INDIR across exactly two `driveFrame` calls) plus a
pixel read in between.

**Found and fixed: a lost-wake-shaped race in `idle()`'s first draft, not in production code.**
`stepFrame`'s ack (`W_ACK`) is stored by `body()` *before* `uploadPump.pump()` runs (same ordering
`genPump.pump()` already had), so a test that does `stepFrame(); drain(); checkGenStatsForIdle()`
can observe an empty gen queue on a step whose own `upload_stage` call hasn't reached the ring yet.
`untilQuiescent` doesn't have this problem (it polls ring stats over macrotasks instead of trusting
one lockstep return), but `engine/test.gen.idle` ends with `untilQuiescent`, which would poll the
full 10 s and reject here since nothing but this page's own test code ever drains `uploadRing`.
`terrain-client.ts`'s own `idle()` is a from-scratch loop instead, requiring 8 *consecutive* frames
with both an idle gen queue and a zero-record drain before declaring done -- found because the
real-client tests were flaky specifically when run alongside other terrain tests (worker OS-thread
contention shifts which side of the race wins), not in isolation.

**Found and fixed: `scripts/lib/adapters.mjs`'s fast-tier `@slow` exclusion was a no-op.**
`(?!.*@slow)` (no anchor) is tested by Playwright at every possible start position in the title; once
the scan position moves past the literal `@slow` text, the negative lookahead trivially succeeds and
`.*` matches the empty remainder, so the pattern matches *any* string containing `@slow` anywhere,
not just ones that don't. Found by this milestone's own new `terrain: probe tile colours webkit
@webkit-gpu @slow` test still running under `pnpm test` (fast tier) after being added. The sibling
`vitest` adapter two lines above already anchors both its own tags with `^`; fixed `playwright`'s
fast-tier tag to match (`^(?!.*@slow)`; the slow tier's `(?=.*@slow)` needed no anchor -- a positive
lookahead satisfiable at position 0 has no equivalent problem). `scripts/lib/adapters.test.mjs`
gained a regression test asserting the compiled pattern's actual `RegExp.test()` behaviour, not just
its source string. This is shared test-runner infrastructure, not specific to this milestone, but the
fix was necessary for the new `@slow` tag to mean anything.

**`playwright.config.ts`'s `webkit` project**: `grep: /@engines/` widened to `/@engines|@webkit-gpu/`.
A plain `@engines` tag would also pick the test up in `firefox` (same grep), where 0020 §6's own
null-adapter-headless finding would fail `expectAdapter` outright; `@webkit-gpu` is a second, narrower
tag only `webkit`'s own grep recognises. `terrain-readback.spec.ts`'s `runProbeTileColours` helper is
shared between the fast-tier chromium test and the new `terrain: probe tile colours webkit
@webkit-gpu @slow` test so the two scenes can never drift apart.

**`gc-terrain.html`/`.ts`** (the `terrain` zero-GC page, `gc-test` skill's "Production-topology
pages" shape): a real device/renderer plus a real `createClient()` over `fx-terrain`, parked before
`__pageReady`. `drive()` bundles the scripted pan (`gc-gen.ts`'s own 8 tiles/second), `harness.
stepFrame`/`stepTick`, one budgeted `uploadDrain.drain(DEFAULT_UPLOAD_BUDGET_BYTES)` and one
`renderer.draw(target)` into a fixed 64x64 offscreen target -- so generation, conversion, upload and
(over a longer run) eviction all happen inside the measured window, per 0016 §2. `installGcPage`
gained an `opts.adapter?: object | null` parameter (default `null`, unchanged for every other page):
the first page to pass a real one, since `gc-loop`/`topology`/`echo`/`gen` have no WebGPU at all.
`controlKinds: ['object', 'burst']` (no `post-message`), same reasoning as `gen`/`echo`/`topology`.
The `net` isolate (spawned by this page's `host: { kind: 'remote' }` topology, same as `gen`'s) is
deliberately not in `budgets.json`'s `gc.pages.terrain.isolates`, for the same reason `gen`'s own
Deviations give: it never enters `runBlockingLoop`, so there is no mechanism to apply a negative
control to it.

**Measured** (`playwright test --project gc --grep "terrain clean" --repeat-each 8 --workers 1`,
this machine): `main` a constant 111.35-111.39 B/frame across all 8 clean runs (`draw`/`drain`'s own
`writeTexture`/`writeBuffer`/`submit` wrapper objects plus harness overhead); `client`/`gen0` a
constant 2.5067-2.52 B/frame each, comfortably under the fixed 8 B/frame strict-worker figure every
other page's worker rows already use. `budgets.json`'s `gc.pages.terrain.main.bytesPerFrame = 120`
(ceil(111.39) = 112, + 8 B margin, 0016 §1's own convention) -- **provisional**, per the Budgets
section's own "M17 sets the final one on the page with the full frame" (this shader has no sprites/
DrawList yet). `client`/`gen0` both `bytesPerFrame: 8` (the fixed figure, not a derived one).
`counters["render.uploadBytesPerFrame"] = 65536` (`render/upload.ts`'s own `DEFAULT_UPLOAD_BUDGET_
BYTES`, 0018 §3's default) and `counters["render.drawCallsTerrain"] = 1`.

**Measured** (quiet-machine `pnpm test`, `uptime` load average 3.6-4.7 before each run; one run at
an elevated ~9.4 load-average spike read `browser pass 77 tests 25s/25s WARN over budget`, right at
the edge -- reported per the delegation prompt rather than smoothed over): `rust pass 140 tests
0.4s/10s` (unchanged), `unit pass 102 tests 1.4-1.5s/3s` (+4 `frame-loop.*`, +1 `adapters` regression;
was 98), `wasm pass 35 tests 1.4s/7s` (+3, the registry/allowlist iteration tests picking up the new
`fx-terrain` fixture; unchanged from steps 2-4's own count of what those tests scan), `browser pass
77 tests 23-24s/25s` (was 68 after steps 2-4: the two re-pointed tests don't change the count, +2
new readback tests -- `patch_one_texel`, `upload_budget_while_panning` -- brings it to 70 [matches
the step-5 commit's own measurement], +7 zero-GC `terrain` tests -- clean + object/burst x 3
isolates -- brings it to 77. The `@webkit-gpu @slow`-tagged WebKit repeat never counts here at all,
fast tier or slow: `pnpm test`'s own composed grep excludes any `@slow`-tagged title once the
adapters.mjs anchor fix below landed; it only ever ran under `pnpm test:slow`). New/changed test
durations (`test-results/browser/report.json`): readback --
`probe_tile_colours` 331ms, `nonresident_is_neutral` 197ms, `patch_one_texel` 256ms, `far_from_origin_
exact` 235ms, `nothing_outside_viewport` 266ms, `upload_budget_while_panning` 351ms; zero-GC --
`terrain clean` 575ms, `neg object {main,client,gen0}` 651/767/910ms, `neg burst {main,client,gen0}`
1267/1720/1775ms (about 7.7s total across all 7, run in parallel with everything else across 3
workers, not serially). Existing multi-engine (`@engines`) repeats in the fast tier, from the same
report: `determinism: golden reproduced` webkit 564ms / firefox 864ms; `sab.ring_both_directions`
webkit 1000ms / firefox 899ms; `workers.spawn_local` webkit 463ms / firefox 847ms -- unchanged by
this milestone, listed because the delegation prompt asked for them. `terrain: probe tile colours
webkit @webkit-gpu @slow` (only under `pnpm test:slow`): chromium 369ms, webkit 783ms; both report
a real adapter (`vendor: apple`, `architecture: metal-3` on Chromium, `apple`/`apple`/`apple` on
WebKit) and `sabWriteTextureOk: true`. `pnpm lint`: biome/rustfmt/clippy/tsc all green (clippy
needed the `Uploader` boxing fix above).

### Notes for later briefs

- **M09b** (art sampling, canvas lifecycle): `renderer.frameUniform`/`renderer.viewport` exist as
  plain mutable objects with placeholder defaults (`frameUniform.tilesPerPx = 1`, everything else
  0; `viewport = { widthPx: 0, heightPx: 0, dpr: 1, renderScale: 1 }`) -- nothing in this milestone
  writes `viewport` at all, or `frameUniform` outside test setup and `frame-loop.ts`'s own
  `writeFrameUniform(renderer.frameUniform)` call. M09b's resize observer is the first real writer
  of `viewport`.
- **M11** (camera integration): `frame-loop.ts`'s `onCamera` hook and `Client.writeCameraAndWake`
  are the two seams to fill -- `onCamera` should mutate `client.cameraState` from input/gestures
  before each tick; the write-and-wake mechanics underneath are already production-shaped and need
  no change. `createFrameLoop`'s `tick()` is fire-and-forget by design (Deviations above); M11 is
  also where a *stepped* variant might be reconsidered if a deterministic frame-time test needs one.
- **M15b** (network deltas): `Uploader::enqueue_chunk`/`patch_tile` are called from nowhere in this
  milestone except native Rust tests (`client/upload.rs`'s own `#[cfg(test)]` module) -- `patch_
  one_texel`'s own Deviations entry above explains why a real end-to-end trigger wasn't built here.
- **M17** (sprites, DrawList, frame-time budget): `gc.pages.terrain.main.bytesPerFrame = 120` is
  explicitly provisional (this shader has no sprites yet); re-derive it once the full frame exists,
  per the Budgets section's own "M17 sets the final one" line.
- **M37b** (device loss): `Uploader::requeue_all` (from step 1) is unchanged and still minimal
  (clears "on GPU" bits, doesn't replay chunks resident outside ring 1 + look-ahead) -- see step 1's
  own Deviations.
- Cross-thread correctness of a CHUNK split from its own INDIR across two frames by the byte budget
  is safe by construction (Rust-side ordering, native `upload.indir_after_chunk`) but has no browser
  test proving it end-to-end (see this section's own "Not covered" entry) -- a candidate for M10 or
  M17b if a regression there is ever suspected.
- `scripts/lib/adapters.mjs`'s fast-tier `@slow` exclusion was fixed as part of this milestone
  (Deviations above); any other suite that starts using `@slow`-tagged Playwright tests benefits
  automatically, no further action needed.
