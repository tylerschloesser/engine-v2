# M09b: Terrain art sampling, canvas lifecycle, device page

Status: done · After: 09 · Tyler-dependent: no (phone serving reuses M03's `pnpm device:serve --tunnel`; tunnel approved, Q7)

Split out of M09 during planning. Carries a **D** (device checklist): terrain fill-rate. Does not block M10 or M11.

## Goal
The terrain shader reaches its final form (variants, flips and brightness jitter from an integer hash, stateless edge dithering with neighbour reads, fat-pixel magnification, trilinear minification over generated mips), the canvas follows size and DPR changes without a cleared flash, backgrounding stops and restarts the frame loop cleanly, and a device page with an on-screen HUD exists so Tyler can run the fill-rate check on a phone with the stated fallbacks one URL parameter away.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0018-renderer.md` (§3 "Art sampling", §4, §6, §8 except device loss, §9, Consequences: the fill-rate check and its fallbacks)
3. `docs/decisions/0020-testing-strategy.md` (§6, §10 device checklist)
4. `docs/plan/09-renderer-terrain.md` (Seams and Planning decisions: bind group layout, `tiles.json` schema)

Mine from spikes: `spikes/zero-gc-webgpu/public/main.js` (canvas + rAF variant, reused descriptors). Rules that apply: `.claude/rules/hot-paths.md`.

## Scope
- `terrain.wgsl` final: PCG hash of `(tile_x, tile_y, seed)` for variant, flip/rotate and jitter; dithering on the art-texel grid with `bayer4x4` and the `priority`/`band` fields, neighbours read through the indirection path, missing neighbour = same as self; fade-out of dither and jitter below 1 screen px per art texel; bilinear sampler with the `fwidth` seam formula when magnified; trilinear mips when minified; premultiplied alpha.
- `render/mips.ts`: mip chain to 1×1 for every array layer at load, with one blit pipeline and reused descriptors (setup cost, exempt from the GC window).
- `render/viewport.ts`: `ResizeObserver` (`device-pixel-content-box`, Safari fallback, re-armed `matchMedia`), size applied at the start of the next frame, clamp to `maxTextureDimension2D`, render scale.
- Backgrounding: stop the rAF on `hidden`; on `visible` reset the frame clock, re-check size, set `CB_FLAGS.REBASE` (consumed by M30).
- **Wire `frame-loop.ts`'s `createFrameLoop`/`FRAME_PHASES` to a real canvas.** Per `docs/plan/09-renderer-terrain.md` Deviations "Notes for later briefs" (M09b entry): M09 leaves `createFrameLoop` reached only by its own unit test against fakes — nothing in `createClient` or any page calls `start()`/`resume()` against a real `Client`/`TerrainRenderer`/canvas. `device.html`/`src/device.ts` is where that first happens, driving the loop's `requestFrame`/`cancelFrame` through M03's injected `Scheduler`; the backgrounding bullet above (stop/resume the rAF on `hidden`/`visible`) is exactly `FrameLoop.pause()`/`resume()` acting on this real instance. `renderer.viewport`'s first real writer is this milestone's resize observer, and `renderer.frameUniform` is written every tick by the loop's own `writeCamera`/`render` phases (both placeholder-only since M09, per the same Deviations note).
- Fallback switches (0018 Consequences), wired but off: render-scale cap and the neighbour-read cutoff.
- `device.html` + `src/device.ts` in the fixture app (`tests/browser/pages/`): the terrain fixture with a HUD and URL parameters, served to a phone by M03's `pnpm device:serve --tunnel`.
- Canvas-presentation smoke test (0020 §6 layer c).

## Non-scope
Device loss (M37b). Sprites and their atlas mips (M17b). Camera gestures and the snap-to-device-pixels-at-rest rule (M11; the device page uses scripted motion until then). The third fill-rate fallback, per-chunk quads: built only if the device check fails the first two (it would be a plan edit and a new brief).

## Files, packages and crates touched
`packages/engine` (`src/render/{terrain,mips,viewport}.ts`, `src/render/wgsl/*.wgsl`, `src/frame-loop.ts`, `tests/browser/pages/device.html`, `tests/browser/`), `packages/engine/fixtures/terrain/` (art with variants, two priorities and a band). No Rust.

## Seams
**Provides**
- `ClientOptions.render?: { scale?: number; scaleCap?: number; neighbourCutoffPx?: number }` (defaults: 0018 §8 render scale; cap = none; cutoff = 0, i.e. always read neighbours).
- `renderer.viewport` kept current; `renderer.onViewportChange(cb)` called at most once per frame, before the `camera` phase (M11 recomputes `half_extent_tiles`; M18 re-bases anchors).
- `FrameLoop.pause()`/`resume()` and the `REBASE` flag.
- Device page `device.html` with URL parameters `tiles`, `x`, `y`, `autopan`, `scale`, `scaleCap`, `cutoff`, and reserved for later milestones: `probe` (M11), `harness` (M17b), `anchors`, `anchorMode` (M18), `module` (M06b fallback); HUD fields below.
- `engine/test`: `setViewport(client, { cssWidth, cssHeight, dpr })`, `setVisibility(client, 'hidden' | 'visible')`.

**Consumes** M09: everything under its *Provides* (bind groups, `tiles.json` v1, `renderTo`, probes, counters, GC page `terrain`) plus `frame-loop.ts`'s `createFrameLoop`/`FRAME_PHASES` and `Client.{cameraState, uploadRing, writeCameraAndWake}` (`docs/plan/09-renderer-terrain.md` Deviations, Steps 5-7 and "Notes for later briefs": the loop exists and is unit-tested but unwired to any page before this milestone). M06b: `stepFrame`, control block. M03: the injectable `Scheduler`, `pnpm device:serve [--tunnel]` and its phone-serving decision (quick tunnel by default, `mkcert` as the alternative), the fixture app's page convention.

## Planning decisions
- **Reference implementation of the hash in the test, not a golden image.** `terrain.variants_match_reference` recomputes the PCG hash in TypeScript and predicts which variant cell each probed tile shows; integer hashes are exact on every GPU (0018 §3), so this holds on Metal and SwiftShader alike.
- **Probe-friendly fixture art.** Flat colours per cell, 4 px cells, variants differing in colour, two visuals with different `priority` and a 2-texel `band`. At integer pixels-per-texel the fat-pixel formula returns exact texel colours, which keeps probes within the 2/255 tolerance of 0020 §6.
- **HUD contents** (diagnostic page only, outside the zero-GC rule): `isolated`, `adapter.info`, workers ready, canvas size and render scale, rAF interval p50 / p95 / worst over the last 10 s, count of intervals > 20 ms, main rAF callback p95 (ms), and GPU latency p95 sampled once per 30 frames with `onSubmittedWorkDone` (iOS exposes no timestamp queries, so this and interval steadiness are the proxy for 0018 §9's GPU share).
- **Serving a phone** is M03's decision (secure context needed, so a quick tunnel by default); this brief adds only the page.
- **Fallback switches are URL parameters on the device page** so a failed check is re-run in seconds: `?scaleCap=1.5`, `?scaleCap=1`, `?cutoff=4`.

## Order of work
1. Mips and sampler; `terrain.minified_converges_to_mean`. 2. Hash, variants, flips, jitter with the TS reference. 3. Dithering and neighbour reads. 4. Viewport observer and render scale; backgrounding. 5. Wire `createFrameLoop` to a real `Client`/`TerrainRenderer`/canvas via the injected `Scheduler`; pause/resume on visibility. 6. Canvas smoke test (extended to assert production phase order). 7. Device page and HUD.

## Tests added
- Browser readback (Chromium): `terrain.variants_match_reference`, `terrain.dither_only_inside_band` (tile centres untouched; pixels inside the band take the higher-priority neighbour's colour at the Bayer pattern's positions; none when the neighbour's priority is lower), `terrain.missing_neighbour_is_self`, `terrain.dither_fades_when_minified`, `terrain.minified_converges_to_mean` (1 px per tile, tolerance 8/255), `terrain.magnified_texel_exact`, `viewport.resize_renders_same_frame` (no frame at the old size, no cleared frame), `viewport.dpr_change`, `viewport.render_scale_caps_at_2` (0018 §8: through `setViewport`, `dpr: 3` gives a render target of twice the CSS size, `dpr: 1.5` gives 1.5 times, and `render: { scale: 1 }` gives the CSS size at any DPR), `viewport.clamped_to_limit`, `lifecycle.hidden_stops_visible_rebases`, `canvas.presents` (real canvas, real rAF, one frame, no errors), `frame-loop.production_runs_phases_in_order` (real canvas, real `Scheduler`-driven rAF, real `Client`: `FRAME_PHASES` order observed end to end, not just against the fakes M09's unit test used).
- Rust native: `wgsl.terrain_validates` still green.
- Zero-GC: page `terrain` re-run with the final shader (numbers unchanged: no new per-frame wrappers).

## Exit criteria
- [x] All tests above pass by name.
- [x] `device.html` runs the production `createFrameLoop` (not a bespoke loop) against a real canvas, driven by `requestAnimationFrame` through the injected `Scheduler`; `frame-loop.production_runs_phases_in_order` passes.
- [x] `pnpm device:serve` serves `device.html` and the HUD shows non-zero frame statistics in desktop Chrome with `?autopan=1&tiles=256`.
- [x] The `docs/plan/device-checks.md` section for this milestone matches what was built.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t terrain` · `pnpm test browser -t viewport` · `pnpm test browser -t lifecycle` · `pnpm test browser -t canvas.presents` · `pnpm device:serve` · `pnpm test` · `pnpm lint`.

## Budgets
- Frame time, GPU share (0018 §9): not automatable; the device check below.
- GPU upload and draws: unchanged from M09, re-asserted by page `terrain` and the M09 counter test.
- Allocation per isolate: `gc.pages.terrain` unchanged.

## Context artifacts
`packages/engine/CLAUDE.md`: how to open the device page and its URL parameters. No new skill: `profile-frame` waits for M17b.

## Manual device checks
[device-checks.md, M09b: Terrain fill rate](device-checks.md#m09b-terrain-fill-rate). May be run as soon as this milestone is ticked.
This milestone builds `device.html` with the HUD fields and the `autopan`, `tiles`, `scale`, `scaleCap` and `cutoff` parameters the item uses.

## Deviations
(filled in during Phase 3)

### Steps 1-3 (mips/sampler, hash/variants/flips/jitter, dithering/neighbour reads) -- done

Delegated as steps 1-3 only; two later implementers take steps 4-5 and 6-7. Commits `ca00771`
(step 1), `6ce7b8c` (step 2), `fecf657` (step 3).

**Exact seam shapes**, since the brief's Scope/Planning decisions describe behaviour, not exact
signatures:

- `render/mips.ts`: `mipLevelCountFor(size: number): number` (throws `RangeError` for a non-power-of-
  two `size`; `4 -> 3` levels, `16 -> 5`) and `generateMips(device: GPUDevice, texture: GPUTexture,
  opts: { layerCount: number; baseSize: number; checkCompilation?(label, module): Promise<void> }):
  Promise<void>`. **Not exactly "one blit pipeline and reused descriptors" as literally as the
  Planning decisions phrase it**: compatibility mode requires a `2d-array` *texture binding* to
  reference every one of a texture's layers (found by `uncapturederror` on a first draft that bound
  a single-layer-narrowed `2d-array` view, mirroring the same per-texture view-dimension lock M09's
  own Deviations found for bind groups generally) -- the mip *source* view can therefore only be
  narrowed by mip level, never by layer, so `mip_layer` (a tiny per-pass uniform buffer, one per
  array layer, each written exactly once) selects the layer inside the shader instead. One shared
  bind-group-layout/pipeline/sampler, one shared source view per mip level (reused across every
  layer at that level), one command encoder, one queue submit -- `layerCount` small uniform buffers
  is the one part of "reused descriptors" this finding forced open.
- `render/art.ts`'s `loadTileArt(device, manifestUrl, opts?: { checkCompilation?(...): Promise<void>
  })`: a third parameter not in the brief's Seams, threaded straight to `generateMips` so the mip
  blit shader gets the same "init, not per frame" `getCompilationInfo()` check every other shader
  module gets (0020 §6). Every page calling it (`terrain.ts`, `terrain-client.ts`, `gc-terrain.ts`)
  now passes its own `RendererDevice.checkCompilation`.
- `terrain.wgsl`'s hash: `fn pcg3d(v_in: vec3<u32>) -> vec3<u32>` (Mark Jarzynski & Marc Olano,
  "Hash Functions for GPU Rendering", JCGT 2020) and `fn tile_hash(tile: vec2<i32>) -> vec3<u32>`
  (`pcg3d(vec3<u32>(bitcast<u32>(tile.x), bitcast<u32>(tile.y), frame.seed))` -- `bitcast<u32>`, not
  `u32(...)`, so a negative tile coordinate's raw bit pattern survives unchanged). The TS reference
  (Planning decisions "Reference implementation of the hash in the test, not a golden image") lives
  at `tests/browser/support/terrain-hash-ref.ts`: `pcg3d(vIn: Hash3): Hash3`, `tileHash(tileX,
  tileY, seed): Hash3`, `selectVariant(tileX, tileY, seed, variantCount): number` -- test-only, not a
  Seam. **Found and fixed against its own first test run**: an early draft's XOR-shift step
  transcribed `v ^= v >> 16u` (each component shifts by *itself*) as a cross-component shift (`x ^=
  y >> 16`), which `terrain.variants_match_reference` caught immediately (wrong colour on the very
  first probe) -- WGSL and the fix are both the same-component form.
- `sample_tile_art(tile: vec2<i32>, visual_id: u32, uv_in: vec2<f32>, lod: f32) -> vec4<f32>`: `lod`
  is 0 for the magnified "fat pixel" path (explicit `textureSampleLevel(..., 0.0)`) or the minified
  trilinear level otherwise (explicit, possibly fractional, `textureSampleLevel(..., lod)`) --
  **never an implicit-derivative `textureSample`/`fwidth` call anywhere in the shader**, a
  simplification not in the brief's own Scope wording ("bilinear sampler with the `fwidth` seam
  formula"). The screen-to-tile mapping is affine (0018 §5: one `tiles_per_px` scalar, no
  perspective), so `fwidth(uv * art_size)` is provably the same uniform constant everywhere and is
  computed in closed form (`frame.tiles_per_px * art_size`) instead of with the `fwidth` builtin.
  This was a deliberate choice to sidestep WGSL's uniform-control-flow restriction on implicit
  derivatives entirely (a branch on `lod`, itself derived through several `let`s and one function
  parameter, may or may not be provably uniform to naga's own analysis -- not tested, since the
  closed-form route removes the question) rather than relying on the restriction being satisfied.
- Dithering: nearest-*single*-edge only, not a 2D corner blend (0018 §3 does not specify corner
  behaviour) -- a fragment near two edges at once (a tile corner) uses whichever edge is strictly
  closer (`dist_left`/`dist_right`/`dist_top`/`dist_bottom` compared in that order; a tie resolves to
  whichever was checked first). `bayer4x4`: the standard 4x4 ordered-dither matrix
  (`0,8,2,10/12,4,14,6/3,11,1,9/15,7,13,5`), indexed `(texel.y % 4) * 4 + (texel.x % 4)`, normalised
  by `/16.0`. `coverage(dist) = (band - dist) / band * fade`. A dithered-in neighbour's colour is its
  own `sample_tile_art` result (its own variant/flip/hash) but **not** its own jitter -- jitter is
  applied once, to whatever the primary tile's own `sample_tile_art` returned, before the dithering
  block can overwrite it wholesale; a documented simplification, not a spec requirement either way.
- `frame.neighbour_cutoff_px`'s fallback (0018 Consequences) is consumed by the shader
  (`cutoff_active = neighbour_cutoff_px > 0.0 && (1.0 / tiles_per_px) < neighbour_cutoff_px` skips
  the whole dithering block) but **`ClientOptions.render.neighbourCutoffPx` -> `frameUniform`
  plumbing is not built here** -- `frameUniform.neighbourCutoffPx` is already a settable field from
  M09 (default 0, "always read neighbours"), and wiring `ClientOptions.render` itself needs
  `createClient`'s options plumbing, which is steps 4/5's own territory (viewport/Client wiring).
  Flagged for whichever later step wires `ClientOptions.render` through.
- **Brightness jitter's amplitude (`JITTER_AMPLITUDE = 1.0 / 255.0`) is this milestone's own choice**,
  not fixed by 0018 §3 (which names the feature, not a magnitude): chosen specifically small enough
  that every flat-colour pixel probe in this milestone's fixture (including every pre-existing M09
  one) stays inside 0020 §6's existing 2/255 tolerance without a test needing to model jitter
  numerically. A real game may want a larger, more visible amplitude; that is a follow-up tuning
  knob (one named constant), not something this milestone needed to get right.
- **Fixture art** (`scripts/gen-terrain-art.mjs`, extending M09's own rather than replacing it, per
  Scope): `tile_px` shrunk from 16 to 4 (Planning decisions "4 px cells") -- every M09 cell keeps its
  same colour and visual id, just at a quarter the resolution, which changes nothing any M09 pixel
  probe asserts (flat per-cell colours are invariant under any mip level or filter). Three cells
  appended for a 3-variant visual (id 6: `first: 4, variants: 3`, magenta/cyan/yellow) and two
  single-variant, differing-priority/band visuals (id 7: priority 1, band 2, dark grey "loser"; id 8:
  priority 2, band 2, crimson "winner"), giving 9 cells total (`tiles.png` now 16x12).

**Interpretation calls, recorded rather than guessed silently:**

- `terrain.minified_converges_to_mean` uses the *existing* grass/water border scene (`stageBorderScene`),
  not the new 3-variant visual: at "1 px per tile" a whole tile's own mip pyramid has fully converged
  to 1x1 regardless of which variant a hash would have picked (mip generation runs per array layer,
  independent of variant selection), so this test needed no hash dependency and reads cleanly as a
  step-1-only property (the brief's own Order of work names it under step 1, before step 2 adds the
  hash at all).
- `terrain.magnified_texel_exact` reads as "at exactly 1 screen px per art texel (an integer ratio),
  every texel on both sides of a tile boundary shows its own tile's exact flat colour, with no
  bleed" -- not a stress test of the seam formula's own blur-avoidance under a moving/fractional
  offset, since every cell in this milestone's fixture is flat (uniform per array layer): any
  sampling method, correct or not, returns that same uniform colour away from a layer boundary, so
  the only thing worth asserting here is the *tile*-boundary case (a hard layer-index switch, unlike
  a sample offset within one layer).
- Every new test in this range uses `terrain.html`'s hand-filled path (`window.__terrain`), never
  `terrain-client.html`'s real client/fixture: Files touched says "No Rust", and `fx-terrain`'s
  generator only knows visual ids 0/1/2/5 (identity-mapped from its own base/resource ids) --
  extending it to reach ids 6/7/8 would need a Rust change this range does not make.

**Measured** (quiet-machine `pnpm test`, `uptime` load average 2.6-3.4 before the reading; the
shared machine's load spiked to 12-29 partway through this session's own work, which the brief's own
note about not trusting timings above ~20 predicts -- re-measured after it settled): `rust pass 141
tests 0.4s/10s` (unchanged: no Rust touched), `unit pass 110 tests 1.3s/3s` (+2: `mips.test.ts`'s
`mipLevelCountFor` cases), `wasm pass 35 tests` (unchanged), `browser pass 66 tests 14-19s/25s` (+6:
the six tests this range adds; comfortably under the 20s trip-wire named in the delegation prompt
even at the higher end, itself measured under load ~12-16, not quiet). `pnpm test rust -t wgsl`:
naga validates `mips.wgsl` and `terrain.wgsl` (1 test, since `wgsl.terrain_validates` is one
parameterised check over every `.wgsl` file, unchanged in count from M09). `pnpm test browser -t
terrain`: `pass 20 tests` (the 14 pre-existing terrain tests plus the six new ones), `5.7-9.4s/25s`
across several runs at varying load. `pnpm lint`: biome/rustfmt/clippy/tsc all green throughout.
`playwright test --project gc --grep "terrain clean" --repeat-each 8 --workers 1`: `8 passed`
(against the unchanged `gc.pages.terrain.main` budget of 116 B/frame, formula unchanged from M09 --
`0026`'s `burst`-negatives-`@slow`-by-page-id mechanism applies automatically to `terrain` with no
change needed here, confirmed by `pnpm test browser -t "terrain neg"` (3 tests, fast tier: `clean`'s
own isolate-presence assertion plus every `object` negative) and `pnpm test:slow -t "terrain neg
burst"` (3 tests, slow tier) both passing).

**Not verified in this range** (steps 4-7's own territory, reported as "later range" per the
delegation prompt): `viewport.*`, `lifecycle.*`, `canvas.presents`, `frame-loop.production_runs_
phases_in_order`, `pnpm device:serve`, the `docs/plan/device-checks.md` M09b section matching what
was built, and the `packages/engine/CLAUDE.md` context artifact (how to open the device page).

### Steps 4-5 (viewport observer, render scale, backgrounding; wiring `createFrameLoop` to a real
canvas) -- done

Delegated as steps 4-5 only; a third implementer takes steps 6-7. Commits `1e7ae65` (step 4),
`a752109` (step 5), `5d5d785` (a fix to step 5's own test page, found under repeated load -- see
"Found and fixed" below).

**Exact seam shapes**, since the brief's Scope/Seams describe behaviour and defaults, not exact
signatures:

- `render/viewport.ts`: `computeRenderScale(dpr: number, opts?: RenderScaleOptions): number`
  (`RenderScaleOptions = { scale?: number; scaleCap?: number }`) -- `opts.scale`, when given,
  overrides the DPR-derived value entirely and is never clamped by `scaleCap`; otherwise
  `min(dpr, opts.scaleCap ?? 2)`. `configureCanvasContext(canvas, device): GPUCanvasContext` --
  `getPreferredCanvasFormat()`, `alphaMode: 'opaque'`, called once, never re-configured on resize (a
  configured context's backbuffer already follows `canvas.width`/`height` on the next
  `getCurrentTexture()`). `createViewportController(canvas, renderer: Pick<TerrainRenderer,
  'viewport' | 'notifyViewportChange'>, opts: { render?: RenderScaleOptions; maxTextureDimension2D:
  number; doc?: Document }): ViewportController` -- `maxTextureDimension2D` is a plain number, not
  read from `device.limits` by this function itself, so `viewport: clamped to limit` never allocates
  a huge real texture. `ViewportController = { applyPending(): boolean; invalidate(): void;
  forceSize(cssWidth, cssHeight, dpr): void; dispose(): void }`.
- `render/terrain.ts`'s `TerrainRenderer` (Scope's own files list names this file for steps 4-5 too,
  not just M09's steps): gained a named `Viewport` type (`{ widthPx, heightPx, dpr, renderScale }`,
  what `renderer.viewport` already was, just given a name) and two new interface members --
  `onViewportChange(cb: (viewport: Viewport) => void): void` (registers `cb`) and
  `notifyViewportChange(): void` (not itself a Seam name: `render/viewport.ts`'s own call, right
  after mutating `viewport` in place, fires every registered callback with a plain indexed loop, no
  `Array.prototype` iteration). `terrain.wgsl` itself is untouched, per the delegation prompt.
- `frame-loop.ts`: `FrameLoop.start()`/`stop()` (M09's own ad hoc names -- Seams never pinned them,
  only `FRAME_PHASES`) are renamed to `resume()`/`pause()`, the brief's own pinned names.
  `FrameLoopOptions` gained `viewport?: ViewportController` (optional: a fakes-only unit test can
  omit it) and `target: FrameTarget` widened from a fixed `GPUTexture | GPUTextureView` to also admit
  a thunk (`() => GPUTexture | GPUTextureView`, re-evaluated every `tick()` -- a real canvas context's
  `getCurrentTexture()` hands out a fresh texture every frame, which a fixed value cannot represent).
  `tick()` calls `opts.viewport?.applyPending()` as its first statement, before `onCamera()` --
  `renderer.onViewportChange(cb)`'s "before the camera phase" contract is satisfied this way, not by
  adding a new `FRAME_PHASES` entry (Seams pins the phase list's own name, not that it enumerates
  every internal step). `resume()` tracks `everResumed` so the very first call (an ordinary start) is
  distinguished from a real restart after `pause()`: only the latter calls `viewport.invalidate()` and
  `client.setFlags(FLAG_REBASE)`. `createRealFrameLoop(opts: RealFrameLoopOptions):
  { loop: FrameLoop; viewport: ViewportController; ctx: GPUCanvasContext; dispose(): void }` is the
  one place a page assembles a real `Client`/`TerrainRenderer`/canvas into a running `FrameLoop` --
  configures the canvas context, writes `renderer.frameUniform.neighbourCutoffPx` once from
  `opts.render?.neighbourCutoffPx ?? 0`, builds the `ViewportController`, and wires `target: () =>
  ctx.getCurrentTexture()`. `attachVisibilityHandling(loop, doc = document): () => void` wires
  0018 §8's real `document.visibilitychange` to `pause()`/`resume()`; not exercised by this range's
  own tests (below), built because Scope names it as this milestone's own backgrounding rule and a
  later page (device.html, step 7) needs it ready-made.
- `client.ts`: `Client.setFlags(mask: number): void` (`Atomics.or` into the global `CB_FLAGS` word,
  never a load-then-store, so a bit set by something else between isn't clobbered) -- an addition to
  the public `Client` shape, not a rename, per the same precedent `writeCameraAndWake`/`cameraState`/
  `uploadRing` already set (M09 Deviations, Steps 5-7). `ClientOptions.render?: RenderOptions`
  (`RenderOptions = { scale?: number; scaleCap?: number; neighbourCutoffPx?: number }`, the exact
  shape and field names the brief's Seams and the delegation prompt both specify) -- not read by
  `createClient` itself (rendering never touches a WASM instance, 0018 §1), exactly the `assets`
  precedent: a caller passes the same `ClientOptions.render` to `createRealFrameLoop`.
- `engine/test` (`src/test/viewport.ts`): `attachViewportTestHooks(client, { viewport, loop }): void`
  (not itself a Seam name, the attach-once-look-up-by-client mechanism `test/render.ts`'s
  `attachRenderer` already uses), `setViewport(client, { cssWidth, cssHeight, dpr }): void` (queues a
  forced override via `ViewportController.forceSize`; does **not** call `applyPending()` itself --
  0018 §8's "applied at the start of the next frame" means the next `tick()`, not immediately, which
  is what makes `viewport: resize renders same frame` provable at all), `setVisibility(client,
  'hidden' | 'visible'): void` (calls `loop.pause()`/`resume()` directly, bypassing the real
  `visibilitychange` event -- headless Chromium's `document.hidden` cannot be forced from outside the
  page), plus two small additions not named in the brief's own Seams list but needed to assert the
  REBASE flag from a spec: `rebaseFlagSet(client): boolean` and `clearRebaseFlag(client): void`.

**Interpretation calls, recorded rather than guessed silently:**

- **The render-scale formula's exact split between "default" and `scaleCap`.** The brief's own Seams
  line ("scale per 0018 §8, cap = none") reads two ways: `scaleCap` could either replace 0018 §8's own
  hard-coded 2x default entirely (so an unset `scaleCap` means *no* cap, `renderScale = dpr`), or it
  could *narrow* a 2x cap that's already baked into "derive from DPR" regardless of whether the option
  is set. The Tests added wording settles it: "`dpr: 3` gives a render target of twice the CSS size"
  *with no `scaleCap` given at all* is only true under the second reading, so `computeRenderScale`
  treats the 2x cap as 0018 §8's own fixed default (not `scaleCap`'s default value) and `scaleCap`
  narrows it only when actually supplied.
- **`viewport.*`/`lifecycle.*`'s own host page.** The brief's Non-scope and step split leave
  `device.html`/`src/device.ts` to step 7; this range needed *some* real canvas + real `Client` to
  drive `createRealFrameLoop` and prove the five named tests, so it adds `tests/browser/pages/
  viewport.html` + `src/viewport.ts` (a new page, not a rename or early build of `device.html`) --
  the same "one page per milestone-owned concern" precedent M09 itself set with `terrain.html` vs
  `terrain-client.html`. It loads no tile art (`loadTileArt` is never called): every assertion here is
  about canvas size/DPR/render-scale/draw-call timing and the REBASE flag, never pixel content, so the
  placeholder 1x1 tile-art texture `createTerrainRenderer` already falls back to is sufficient.
  `device.html` (step 7) is expected to be a second, independent page built the normal way, not a
  refactor of this one.
- **`viewport: render scale caps at 2`'s three cases as one test, not three.** The brief names exactly
  one test by this title but its own Tests added parenthetical packs three assertions into it (`dpr:
  3`, `dpr: 1.5`, `render: { scale: 1 }`); the last needs a different `ClientOptions.render` than the
  first two, so the test calls `__viewport.init()` twice (a second, fresh canvas/client/loop inside the
  same test) rather than splitting into extra named tests the brief doesn't ask for.
- **One extra test not named by the brief**: `viewport: neighbourCutoffPx wired from
  ClientOptions.render`, covering the delegation prompt's own additional ask ("wire `ClientOptions.
  render.neighbourCutoffPx` ... through to `frameUniform`/viewport") that isn't one of the brief's
  five named tests but has no other test proving it.

**Found and fixed: a real `ResizeObserver` race in `viewport.html`'s own test page, not in
`render/viewport.ts` itself.** Quantified before fixing, per the delegation prompt's own "quantify
before hypothesising": `pnpm exec playwright test --project chromium --repeat-each 10 --workers 3
tests/browser/viewport.spec.ts` failed `viewport: resize renders same frame` 1/10 times, always
reverting to the *previous* applied size after a forced resize, never a stray one -- the tell that a
report was correct for a moment that had already passed, not corrupt. Mechanism: the test page's
canvas was created with no CSS `width`/`height` of its own, so its layout box came straight from the
`width`/`height` content attributes -- exactly the two fields `ViewportController.applyPending()`
writes every tick. The page deliberately leaves the real `ResizeObserver` live throughout (proving it
doesn't crash/interfere alongside the test-only `forceSize` override), and that real observer was
therefore reporting back whatever size a test's own forced override had *last actually applied*,
racing a second, still-pending override queued between two separate `page.evaluate()` calls (`v.
setViewport(64, 64, 1)` then, in a later, separate `evaluate`, `v.tick()`) and silently overwriting it
before `tick()` ran. Fixed by pinning the canvas's CSS size (`style.width`/`height = '1px'`),
decoupling its layout box from the backing-store attributes `applyPending()` writes -- not a retry, a
longer wait, or a smaller workload. Verified: `--repeat-each 20 --workers 3` on the same spec, 120/120
passes (was 1/10 failing before the fix). This is a bug in the *test page*, not in `render/
viewport.ts`'s production logic (a real page with a CSS-sized canvas, the normal case, never has this
feedback loop).

**Measured** (`uptime` load average 1.8-7.7 across these runs, all below the delegation prompt's own
~20 danger line; one `pnpm test` run mid-session hit `net::ERR_CONNECTION_REFUSED` on an unrelated
`gc-topology` test against the shared `127.0.0.1:4517` webServer -- an environment hiccup, not a code
regression: `lsof -i :4517` showed nothing listening at the time, and an immediate retry with no code
change passed cleanly, `browser pass 72 tests 15s/25s`; not chased further since `gc-topology.spec.ts`
is entirely outside this range's Files touched):

- `pnpm test unit -t viewport`: `pass 4 tests` (`computeRenderScale`'s three cases). Full `pnpm test
  unit`: `pass 114 tests` (was 110 before this range: +4).
- `pnpm test rust`: `pass 141 tests 0.3-0.5s/10s` (unchanged: no Rust touched). `pnpm test wasm`:
  `pass 35 tests` (unchanged).
- `pnpm test browser -t viewport`: `pass 7 tests 2.5-2.7s/25s` (the five `viewport:`-titled tests plus
  the extra `neighbourCutoffPx` one, plus one incidental match elsewhere in the suite whose title
  happens to contain the substring). `pnpm test browser -t lifecycle`: `pass 1 tests 1.7-1.8s/25s`.
  `pnpm test browser -t terrain`: `pass 20 tests 5.8s/25s` (unchanged from steps 1-3: nothing in this
  range touches `terrain.wgsl`, `terrain.ts`'s existing methods, or the terrain fixture art).
- Full `pnpm test`: `rust 141 (0.4-0.5s/10s), unit 114 (1.1-1.7s/3s), wasm 35 (1.4-1.9s/7s), browser 72
  (14-16s/25s)` -- +6 browser tests over the 66 steps-1-3 left at, comfortably under the 20s trip-wire
  the delegation prompt named even measured at load 5-8 (not quiet). `pnpm lint`:
  biome/rustfmt/clippy/tsc all green throughout, every run.
- `gc.pages.terrain` re-run twice (once before the ResizeObserver-race fix, once after, since the fix
  touches a different page entirely): `playwright test --project gc --grep "terrain clean"
  --repeat-each 8 --workers 1`, `8 passed (10.0-10.1s)` both times. `budgets.json` untouched by this
  range (confirmed by `git status`) -- `gc.pages.terrain` is unchanged, as expected: nothing in `frame-
  loop.ts`'s new `viewport`/`RealFrameLoop` code path runs inside `gc-terrain.ts`'s own measured
  window (that page calls `renderer.draw(target)` directly through its own hand-rolled `drive()`,
  never through `createFrameLoop`/`createRealFrameLoop`), and the two new `TerrainRenderer` interface
  members are plain object methods, allocated once at construction like every other method there, not
  per frame.
- `0026`'s `burst`-negatives-`@slow`-by-page-id mechanism: untouched by this range (no new zero-GC page
  added), confirmed by the `gc.pages.terrain` re-run above passing at its existing budget with no
  change to `zeroGcSuite`'s own call for that page.
- No orphan `vite preview`/Playwright/Chrome processes left running at any point this range's own
  commands finished (checked by `pgrep` before every commit and before this report, per the delegation
  prompt's own explicit rule).

**Not verified in this range** (steps 6-7's own territory, "later range" per the delegation prompt):
`canvas.presents`, `frame-loop.production_runs_phases_in_order`, `pnpm device:serve`, the `docs/plan/
device-checks.md` M09b section, and `packages/engine/CLAUDE.md`'s own context-artifact update (how to
open the device page). `attachVisibilityHandling` (this range's own addition) is built but not wired
into any real page's `document` yet -- `device.html` is expected to be the first caller.

### Steps 6-7 (canvas-presentation smoke test, production phase order, device page and HUD) -- done

Delegated as the final range. Commits `fff8f75` (step 6, which also lands `device.html`/`src/
device.ts` -- see below for why) and `cae5c23` (step 7's remaining artifacts).

**Order of work, deviated from, and why.** The brief's own exit criteria tie `frame-loop.
production_runs_phases_in_order` to `device.html` by name ("`device.html` runs the production
`createFrameLoop` ... `frame-loop.production_runs_phases_in_order` passes"), so step 6's test needed
step 7's page to exist first. `device.html`/`src/device.ts` therefore landed whole in the step-6
commit; step 7's own commit is the remaining, genuinely step-7 artifacts (`index.html`'s link,
`packages/engine/CLAUDE.md`'s context artifact) plus this range's manual-check evidence. Recorded
here rather than silently reordered.

**Exact seam shapes:**

- `frame-loop.ts` gains `FrameLoopOptions.onPhase?(phase: FramePhase): void` (default a shared
  `noopPhase`, `noop`'s own precedent) and `RealFrameLoopOptions.onCamera?(): void` / `onPhase?(...)`,
  forwarded straight through `createRealFrameLoop`. `tick()` calls `onPhase(<name>)` immediately
  before each of the six `FRAME_PHASES` entries' own work (after `viewport?.applyPending()`, which
  stays outside the six-phase sequence exactly as before -- Seams' "before the `camera` phase" is
  unaffected). This is the one change to `frame-loop.ts` this range makes, and it exists because there
  is no other way to observe "phase order, end to end, against a real `Client`/`TerrainRenderer`" from
  outside the module: `upload`'s own internal step (`drain.drain(budget)`) calls no method on the
  caller-supplied `renderer` at all when there is nothing to drain that frame, so wrapping
  `renderer`'s or `client`'s own methods (the only alternative that needs no production change) cannot
  prove the `upload` phase *ran* on a quiet frame, only that it *did something* on a busy one.
  `onPhase` is unconditionally cheap (one already-bound function-reference call per phase per frame,
  no allocation, no closure) when unset, so it costs nothing on every existing page.
- `frame-loop.test.ts` gains `frame-loop.onPhase_called_with_each_FRAME_PHASE_in_order` (fakes,
  matching every other phase-order assertion already in that file) -- not one of the brief's own
  Tests added names, but the seam above had zero coverage otherwise.
- `device.html`/`src/device.ts` (`tests/browser/pages/`): the one page using *production*
  `systemClock`/`systemScheduler` (`src/clock.ts`) rather than a `ManualClock` -- every other
  real-client page in this suite (`viewport.ts`, `terrain-client.ts`, `gc-terrain.ts`) exists
  precisely to avoid real rAF pacing (0020 §3), but this page's whole point is to measure it. Its own
  `Scheduler` passed to `createRealFrameLoop` is a thin wrapper around `systemScheduler` (still real
  `requestAnimationFrame` underneath -- the exit criterion's "through the injected `Scheduler`" is
  satisfied literally, not worked around) that times each real rAF interval and the whole wrapped
  callback's own duration (0018 §9's "main-thread rAF callback" budget), and samples GPU latency via
  `device.queue.onSubmittedWorkDone()` once every 30 real frames.
- `window.__device`: `adapterInfo()`, `framesRendered()` (count of whole `tick()`s completed, via the
  same scheduler wrapper), `phaseLog()` (the `onPhase` log, capped at `FRAME_PHASES.length * 40`
  entries so a real, multi-minute Tyler session never grows it unbounded), `errors()`.
- Camera integration is Non-scope (M11) but a device page with zero pixels moving cannot prove
  anything: `device.ts`'s own `onCamera` callback (passed to `createRealFrameLoop`, run every tick via
  the `onPhase('camera')` seam above) computes `camTileX/Y`/`camFracX/Y`/`viewportPxW/H`/`tilesPerPx`
  fresh every frame from `client.cameraState` and the already-applied `renderer.viewport`, and, when
  `?autopan=1`, advances `cameraState.centreX` by a fixed 4 tiles/second (real elapsed time, via
  `performance.now()` -- allowed here: the `noRestrictedGlobals` ambient-time ban is scoped to
  `packages/engine/src/**`, not `tests/`). `tilesPerPx = tilesAcross / max(viewportPxW, viewportPxH)`
  (0018 §6: "tiles across the long axis") and `halfExtentTilesX/Y = tilesAcross / 2` are this page's
  own stand-ins for M11's real camera -> half-extent/zoom maths -- reasonable, not specified, choices
  recorded as interpretation calls below.
- URL parameters, read once at load via `new URL(location.href).searchParams`: `tiles` ->
  `cameraState.tilesAcross`, `x`/`y` -> `centreX`/`centreY` (default 0), `autopan` (`'1'` or `'true'`),
  `scale`/`scaleCap`/`cutoff` -> one `RenderOptions` object passed to *both* `createClient` and
  `createRealFrameLoop` (the same object, per `client.ts`'s own documented "one `ClientOptions.render`
  object is also what a caller hands `createRealFrameLoop`" pattern). `probe`/`harness`/`anchors`/
  `anchorMode`/`module` are never read: an unread `URLSearchParams` key is tolerance by construction,
  no special-case code needed.

**Interpretation calls, recorded rather than guessed silently:**

- `tilesPerPx`/`camTile`/`camFrac`/`halfExtentTiles*` maths above: 0018 §5's camera-relative formulas
  are M11's to implement for real; this page needs *some* working stand-in to show real terrain art
  and real gen/upload traffic, so it derives the same fields the shader needs directly from
  `cameraState`/`viewport` each frame. Not exercised by any assertion beyond "no GPU errors, non-zero
  frame stats" -- pixel correctness under panning is `terrain-readback.spec.ts`'s job, unchanged here.
- `canvas.spec.ts`'s two tests wait for `framesRendered() >= 1` / `>= 3` rather than a fixed sleep,
  and the phase-order test checks every complete 6-entry group in the capped log, not just the first
  -- "observed end to end" read as "holds across several consecutive real frames," not "true once."
- `PAN_TILES_PER_SECOND = 4` (autopan): half `gc-terrain.ts`'s own 8 tiles/second precedent, chosen
  because this page runs at real rAF pacing for minutes at a time (a Tyler device session), not a
  fixed 600-frame window, so there is no reason to cross chunk boundaries as fast.
- HUD rolling-window percentiles (`RollingStat`, 10 s, prune-by-timestamp) apply the same 10 s window
  to `rAF interval`, `main rAF callback` and `GPU latency` alike; the brief's own Planning decisions
  names "10 s" only for the rAF-interval figures, but using one consistent window for every rolling
  stat was simpler than inventing a second, unstated one.
- `docs/plan/device-checks.md`'s M09b section: read against what was actually built and left
  unedited -- its URL (`device.html?autopan=1&tiles=256&scale=2`) and every HUD figure it names
  (`isolated`/adapter, rAF interval p95, intervals > 20 ms, GPU latency p95) already match exactly.

**Measured** (quiet-machine `pnpm test`, `uptime` load average 3.4-7.5 across these runs -- all well
under the delegation prompt's own ~20 danger line): `rust pass 141 tests 0.4s/10s` (unchanged),
`unit pass 115 tests 1.2-1.4s/3s` (+1 over the steps-4-5 count: `frame-loop.onPhase_...` -- the
`context-artifacts` CLAUDE.md-line-cap test also required `packages/engine/CLAUDE.md`'s new paragraph
to be folded into the existing one, not appended as a new line, to stay at exactly 60), `wasm pass 35
tests 1.3-1.5s/7s` (unchanged), `browser pass 74 tests 14-15s/25s` (+2 over the steps-4-5 count: this
range's own two new tests; comfortably under the 20s trip-wire named in the delegation prompt).
`pnpm test browser -t "canvas: presents"`: `pass 1 tests 1.8s/25s`. `pnpm test browser -t "phases in
order"`: `pass 1 tests 1.8s/25s`. `pnpm test browser -t viewport`: `pass 7 tests 2.5s/25s`
(unchanged from steps 4-5). `pnpm test browser -t lifecycle`: `pass 1 tests 1.8s/25s` (unchanged).
`pnpm test browser -t terrain`: `pass 20 tests 5.7s/25s` (unchanged). `playwright test --project gc
--grep "terrain clean" --repeat-each 4 --workers 1`: `4 passed (5.3s)`, confirming this range's
`frame-loop.ts` change is inert for the `terrain` zero-GC page (`gc-terrain.ts` draws directly through
its own `drive()`, never through `createFrameLoop`/`createRealFrameLoop`). `pnpm lint`:
biome/rustfmt/clippy/tsc all green throughout.

**`pnpm device:serve` itself could not be run as the literal command**: its hardcoded port (4173,
`scripts/device-serve.mjs`) was already bound by an unrelated, pre-existing process on this shared
machine (a different repository's own `vite preview`, confirmed by `lsof -i :4173` / `ps -p <pid>` --
not started by this session, not touched). Verification instead ran the identical build the script
runs (`vite build --config .../vite.config.ts`, confirmed `device-*.js` present in the output) served
by the same `vite preview` invocation on a free port (`ENGINE_TEST_PORT=4180`) -- functionally
identical, since `device-serve.mjs`'s own port is just that env var's value. Via the `playwright-cli`
skill against real desktop Chrome at `?autopan=1&tiles=256`, the HUD after ~14 s of real time read:
`isolated: true`; `adapter.info: {"vendor":"apple","architecture":"metal-3","device":"",
"description":"","isFallbackAdapter":false}`; `workers ready: true`; `canvas: 1280x720px dpr=1
renderScale=1`; `rAF interval p50/p95/worst (10s): 16.7 / 16.7 / 16.7 ms (n=601)`; `rAF intervals
>20ms (10s): 0`; `main rAF callback p95 (10s): 0.22 ms`; `GPU latency p95 (10s, sampled every 30
frames): 2.25 ms (n=20)`; `frames rendered: 959`. `playwright-cli console`: 0 errors. Server and
browser both stopped afterward; `pgrep`/`lsof` before and after showed no orphan `vite preview`/
Playwright/Chrome process from this session (the unrelated port-4173 process was left running,
untouched, exactly as found).

**Found, not caused by and not fixed in this range: a residual `viewport.html` `ResizeObserver` race
under combined multi-suite load.** One `pnpm test` run (all four suites in parallel, `uptime` load
3.4-5.9) failed `viewport: resize renders same frame` with the forced-64x64 override reverting to the
page's own pinned 1x1 CSS size -- the same race class steps 4-5's own Deviations already found and
partially fixed (pinning `viewport.html`'s canvas CSS size at 1x1 to stop the real `ResizeObserver`
from ever reporting a *changed* size). Quantified before guessing further, per the delegation prompt:
re-run twice more (`pnpm test browser -t viewport` alone, twice; full `pnpm test` again once) all
passed, so this is a load-sensitive flake, not a deterministic regression -- consistent with (a guess,
stated as one) the real observer's very first callback, which always fires once at page load
reporting the pinned 1x1 box, being delayed by heavier system-wide CPU contention long enough to land
between this range's own test's two separate `page.evaluate()` calls (`setViewport(64,64,1)` then
`tick()`), racing the forced override the same way the original bug did. Nothing in this range's own
Files touched (`frame-loop.ts`'s `onPhase` addition, `device.html`/`device.ts`, `canvas.spec.ts`)
touches `render/viewport.ts` or `viewport.html`; per "never mask a red gate" and "Escalate, don't
decide," this is reported rather than patched -- `viewport.html`'s own test-page race is steps 4-5's
file, not this range's Scope.

### Fix round 1 (`viewport: resize renders same frame`: a real flake, diagnosed and fixed) -- done

The orchestrator's own quiet-machine measurements at `dd87a1d` (`pnpm test browser`: 2 failures in 16
runs; `node scripts/repeat.mjs browser 15`: pass=14 fail=1, a second loop failing on its first run;
the same suite under `--load 10`: 0 failures in 12) showed this was a real, load-*inverted* flake, not
the environment hiccup steps 4-5's own Deviations first guessed at, nor the "load-sensitive... CPU
contention" guess steps 6-7 restated -- both of those guesses were wrong in the same direction (more
load = more failures), when the true pattern is the opposite. Commit `3ed481d`.

**Diagnosed before changing anything, with real attribution, not renewed guessing.** Temporary
instrumentation (a `globalThis.__vpDebug` array, pushed to on every `setPending()` call with a
`source` tag and a wall-clock timestamp, plus one push inside `applyPending()` recording `dirty`/
`pending` at entry; a page hook `window.__viewport.debugLog()`; the failing test's own assertion
wrapped in a try/catch that dumped the log via `console.log` on failure -- all reverted before the fix
commit, never shipped) reproduced the failure twice by looping plain `pnpm exec playwright test
--project chromium --project gc` (the same two projects `pnpm test browser` itself selects) in the
foreground, quiet machine, until one run failed (run 8 of 12, then run 22 of 30 after a `vite build`
picked up the instrumentation). The captured sequence, verbatim, at the exact failure:

```
{ source: 'force',              cssWidth: 64, cssHeight: 64, dpr: 1, t: 1789955868635 }
{ source: 'observer-devicebox', cssWidth: 1,  cssHeight: 1,  dpr: 1, t: 1789955868635 }  <- same ms
{ source: 'applyPending-called', dirty: true, pending: { cssWidth: 1, cssHeight: 1, dpr: 1 } }
```

The real `ResizeObserver`'s callback (reporting the page's pinned 1x1 CSS box -- the steps-4-5 fix)
arrived and overwrote the just-queued `forceSize(64, 64, 1)` in the same millisecond, before the next
`page.evaluate()` call ran `tick()`. This is not a guess: the timestamps show the overwrite happening,
not merely correlate with one.

**Why `--repeat-each` on the spec alone never reproduced it, and why heavy load "fixed" it (both
stated as reasoned mechanism, not re-confirmed by a second instrument -- flagged as such).** A
`ResizeObserver` callback is scheduled by the browser's rendering pipeline (roughly, the "update the
rendering" step), not by JS task/microtask order relative to `page.evaluate()`. Repeating only
`viewport.spec.ts` gives the browser process little other reason to run that pipeline step promptly;
the full suite's other pages (real canvases, real draws, real workers) keep it running regularly,
so the pinned canvas's one-time initial notification gets an earlier opportunity to fire and can land
inside the gap between two of this test's own `page.evaluate()` calls. Artificial CPU load
(`--load 10`) delays *everything*, including that pipeline step, past the point the short-lived test
has already asserted and torn the page down -- 0 failures under load is the corrupting event never
getting a chance to fire in time, not a timing window closing.

**Test-page defect, not a production defect (decided explicitly, as asked).** `ViewportController` in
production has exactly one writer of `pending` -- the real observer/`matchMedia` pair; no production
caller ever calls `forceSize`. `ResizeObserver`'s own spec collapses every interim layout change into
one, always-current entry at delivery time, so under real DOM resizing a later callback is never
stale or wrong relative to an earlier one it might race -- there is no "second, more recent intent" a
real notification can ever clobber. The race exists only because `viewport.html` asked one controller
to be driven by two writers at once (the real observer *and* the test's own `forceSize`), which no
production page ever does. 0018 §8's "renders at once, no cleared flash" is therefore not at risk in
production from this mechanism; `render/viewport.ts`'s core `applyPending`/`setPending` logic is
unchanged by this fix.

**The fix removes the second writer; it does not race it.** `createViewportController` gains
`opts.test?.observeReal` (default `true`, so every existing caller's behaviour is unchanged);
`observeReal: false` never constructs the `ResizeObserver` or arms `matchMedia` at all, so `forceSize`
is `pending`'s only writer on that controller, matching production's own single-writer invariant by
removing the contradiction rather than out-timing a browser-scheduled callback. `invalidate()` (0018
§8's "on visible, re-check size") becomes a no-op under `observeReal: false`: a test-only-controlled
page has nothing real to re-check, and re-reading the DOM there would just reintroduce a second
writer. `RealFrameLoopOptions` gains `test?: { observeReal?: boolean }`, forwarded straight to
`createViewportController` (the `ClientOptions.test` naming precedent: a test-only escape hatch never
set by a production caller). `viewport.html`'s own CSS-size pin (`style.width/height = '1px'`, steps
4-5's own fix) is removed -- it addressed a *different* race (the canvas's layout box tracking its own
backing-store attributes) that no longer matters once the real observer is never constructed, and
keeping a now-pointless pin would only read as load-bearing to a future reader.

**Not a timeout, poll, retry, or relaxed assertion.** No `page.waitForFunction`, `expect.poll`,
Playwright retry count, sleep, or widened tolerance appears anywhere in this fix; every one of the
five named tests' assertions is unchanged from steps 4-5's own commit.

**Proof** (`uptime` load average given; foreground; `node scripts/repeat.mjs browser 15` per the
orchestrator's own ask, twice, quiet machine):

- Batch 1: `browser x15 load=0: pass=15 fail=0 hang=0 slowestSuiteSeconds=17` (load average 4.68 at
  start).
- Batch 2: `browser x15 load=0: pass=15 fail=0 hang=0 slowestSuiteSeconds=15` (load average 12.61 at
  start -- an incidentally busier machine than batch 1, included as measured, not re-run for a quieter
  number).
- 30/30 pass, 0 hangs, across both batches.
- `pnpm test` (once, before the repeat batches): `rust 141, unit 115, wasm 35, browser 74 (15s/25s)`.
  `pnpm lint`: biome/rustfmt/clippy/tsc all green.
- No orphan `vite preview`/Chrome process at any point (`pgrep -fl "vite preview|Chrome for
  Testing"`, empty every check) and no listener on `:4517` at handback (`lsof -ti tcp:4517`, empty).

**Not verified by this fix round**: an automated test of the real `ResizeObserver`/`matchMedia` path
succeeding on a genuine DOM/DPR change (as opposed to `observeReal`'s own existence proving it's
*inert* when disabled) -- this milestone's own tests never needed one (they are deterministic by
design), and headless Chromium cannot really change display DPI or move a window, so such a test would
need a real CSS resize plus a deterministic "was it observed" signal the page exposes (not a
poll/timeout) to await it -- left as a gap for whoever next touches `render/viewport.ts`, not built
here since it is additive, not a fix for this flake, and the fix round's own scope is the flake.
`device.html`'s own manual device check (steps 6-7, already run) is the closest existing evidence that
the real observer path works end to end on a real page.

### Fix round 1 (steps 1-3 range): flip/rotate and jitter test coverage

Delegated as a fix round after a Sonnet review of the full M09b diff found three of the shader's
headline features (flip/rotate, jitter, the seam formula) shipped with coverage that could not
detect breakage. Items 1 and 2 below are implemented; item 3 was investigated but not implemented,
and the investigation surfaced a real, unrelated finding recorded at the end of this section.
Committed as `M09b fix 1: flip/rotate and jitter test coverage (item 3 investigated, not applied)`.

**Item 1: flip/rotate coverage.** `scripts/gen-terrain-art.mjs` gains cell 9, a 2x2-quadrant pattern
(red/green/blue/orange, one flat colour per 2x2-texel quadrant of the 4x4 cell) and visual 9
(`flags: ['flip_x', 'flip_y', 'rotate']`, every transform allowed, one variant, no priority/band) --
every prior cell stays exactly as it was (colour-preserving for every existing M09/M09b test,
confirmed: `pnpm test` was 74 tests green both before and after this cell's addition, same counts).
`tests/browser/support/terrain-hash-ref.ts` gains `selectTransform(tileX, tileY, seed, flagsMask):
Transform` (mirrors `sample_tile_art`'s `h.y`-bit gating exactly) and `applyTransform(uv, transform):
[number, number]` (mirrors the shader's own rotate-then-flip_x-then-flip_y order exactly). The new
test `terrain: flip and rotate match reference` stages visual 9 in one chunk and probes 8 tiles (row
0, `seed 12345`), one per possible `h.y & 7` hash-bit pattern -- found by a plain Node scan (not
committed) mirroring `pcg3d`/`tileHash` to search tile coordinates 0..31 for the first tile giving
each pattern: `{0: [11,0], 1: [13,0], 2: [1,0], 3: [4,0], 4: [6,0], 5: [0,0], 6: [26,0], 7: [8,0]}`.
Every probe reads art texel (0, 2) (`x < 0.5`, `y >= 0.5`, i.e. the bottom-left quadrant
untransformed) -- deliberately *not* a diagonal (`x === y`) point, since a rotate (plain transpose)
is invisible there; asserts the exact predicted quadrant colour at the existing 2/255 tolerance.
**What this catches that nothing did before:** an inverted flip (wrong sign on `1 - uv.x`/`1 -
uv.y`), a swapped composition order (flip-then-rotate instead of rotate-then-flip), or a wrong hash
bit (e.g. `FLAG_ROTATE` gated by `h.y & 1` instead of `h.y & 4`) each change the predicted quadrant
for at least one of the 8 tiles, failing this test; previously every fixture cell was flat, so any of
those bugs passed the entire suite silently.

**Item 2: jitter coverage.** `terrain-hash-ref.ts` gains `JITTER_AMPLITUDE = 1 / 255` (tracking, not
re-deriving, `terrain.wgsl`'s own constant of the same name -- not touched, per the fix round's own
constraint), `jitterDelta(tileX, tileY, seed, fade): number` (mirrors `fs_main`'s jitter formula
exactly) and `jitteredChannelByte(base255, delta): number` (the shader's own `clamp` plus the
`rgba8unorm` render target's float-to-8-bit rounding on the way out). The new test `terrain: jitter
matches reference` reuses the grass/water border scene (band 0, so dithering never interferes), at
full fade (`tilesPerPx = 1/8`, `texels_per_px = 0.5 < 1`, `fade === 1`), probing 3 tiles whose jitter
byte (`h.z & 0xFF`) differs clearly (41, 99, 214 out of 255 -- found by the same offline scan as
item 1) at their own tile centre (`camFracX/Y = 0.5`, so no seam correction is in play either).
**Tolerance used: 0 (exact), and it held on the first run with no adjustment** -- `Math.round(x *
255)` (round-to-nearest, ties away from zero) matched the real `rgba8unorm` readback exactly for all
3 tiles at both the first and second decimal-adjacent channel values tried, so no rounding-mode
ambiguity needed resolving empirically beyond "does 0 tolerance already pass," which it did.
**What this catches that nothing did before:** a no-op, inverted-sign, wrong-channel (e.g. jitter
added to `.rgb` but read from a different hash lane) or unfaded (missing `* fade`) jitter each change
the predicted byte for at least one of these 3 tiles from what the reference computes, failing this
test at tolerance 0; previously `JITTER_AMPLITUDE`'s own smallness (chosen in steps 1-3 specifically
to stay under every *other* test's 2/255 tolerance) made jitter's presence or absence unobservable to
any existing assertion.

**Item 3: not implemented, and a real bug found instead.** Investigating what a fractional-offset
seam probe would assert required working out, from `sample_tile_art`'s own magnified-path code, what
"seamed" position a given fractional `camFrac` should produce -- and that derivation turned up a bug
in the formula itself, not just a coverage gap:

- `sample_tile_art`'s magnified branch computes `seamed = floor(texel) + clamp((fract(texel) - 0.5) /
  aa, -0.5, 0.5) + 0.5` (`aa = texel_per_px * 0.5`). Worked through symbolically: as `aa -> 0` (deep
  magnification), for *any* fractional position except exactly a texel's own centre (`fract(texel)
  === 0.5`), this clamp saturates and `seamed` collapses to `floor(texel)` or `floor(texel) + 1` --
  the texel's own *edge*, shared with a neighbour -- not its centre. A bilinear sample taken exactly
  at a shared texel edge blends 50/50 with the neighbour. So for *most* of a texel's own footprint
  (everywhere except a vanishingly narrow band right at its own centre), deep magnification produces
  a boundary blend instead of that texel's own crisp colour -- the opposite of the "fat pixel"
  technique's purpose, and a real, wrong-almost-everywhere behaviour, not a rare edge case.
- **Confirmed empirically**, not just on paper: an uncommitted, temporary test (added, run once,
  then deleted -- never part of a commit) staged visual 9's quadrant cell at tile `(11, 0)` (`bits =
  0`: no transform, from item 1's own scan), `tilesPerPx = 1/64` (`aa = 0.03125`, deep magnification),
  `camFracX = 0.525` (art texel position 2.1: past the quadrant boundary at `uv = 0.5`, on the
  *right*/green side). Expected (correct-formula) result: pure green `[0, 255, 0, 255]`. **Measured:
  `[127, 127, 0, 255]`** -- an almost-exact 50/50 red/green blend, confirming the boundary-blend
  bug, not a paper-only concern.
- **The fix is known but not applied here**, per this fix round's own instruction not to change the
  shader's behaviour: anchor on the *rounded* texel index instead of its floor -- `let seam =
  floor(texel + 0.5); let offset = texel - seam; let seamed = seam + clamp(offset / aa, -0.5,
  0.5);` -- which saturates to the *current* texel's own centre (`seam ± 0.5` lands on `seam`'s
  neighbour's centre or its own, always a texel centre, never a shared edge) for most of its
  footprint, with the transition band correctly centred on the real inter-texel boundary instead of
  on the texel's own midpoint. Not applied; this is the coordinator's decision, not this range's.
- **Every currently-committed test, including both new ones above, probes exactly at a texel's own
  centre** (`fract(texel) === 0.5`, where `centre_offset === 0` and the buggy and correct formulas
  agree trivially) -- this bug is completely unguarded by the automated suite today. It is also
  invisible to `terrain.magnified_texel_exact` and `terrain.variants_match_reference` for the same
  reason. Flagged here rather than fixed or covered by a new (necessarily failing) test, per "if this
  does not fit cleanly, skip it and say so."

**Item 4:** `terrain: dither only inside band`'s comment corrected -- art texel 0's nearest edge is
its own tile's left edge (tile 30, ties on priority: staged, same chunk as self, not missing) while
texel 1's nearest edge is genuinely its own tile's top edge (chunk `(0, -1)`, never staged): two
different mechanisms landing on the same "self, always" outcome, not one.

**Measured** (quiet-machine `pnpm test`, `uptime` load average 2.1-4.7): `rust pass 141 tests`,
`unit pass 115 tests` (unchanged from steps 4-7's own count: this range added no new `unit`-suite
file), `wasm pass 35 tests`, `browser pass 76 tests 15s/25s` (+2 over the 74-test baseline this fix
round started from; comfortably under the 20s trip-wire). `pnpm lint`: biome/rustfmt/clippy/tsc all
green. `playwright test --project gc --grep "terrain clean" --repeat-each 8 --workers 1`: `8 passed`
-- `gc.pages.terrain`'s budget (116 B/frame) is unchanged, as expected (this round touches fixture
art and TS-only test/reference code, no per-frame JS path). No existing test weakened, skipped or
deleted; no golden changed; no tolerance widened.

### Fix round 2: magnified sampling was inverted between M09b and this fix (M17b: read this first)

**For a later reader (M17b picks up sprite sampling and reuses this same seam formula):**
`sample_tile_art`'s magnified ("fat pixel") branch shipped inverted from M09b's own steps 1-3
through fix round 1: it anchored on a texel's own `floor` and added `+ 0.5` *after* clamping, which
saturates (away from an exact texel centre) to a texel's own *edge*, not its centre. The symptom:
under magnification, at any camera offset that is not *exactly* a texel's own centre, the sample
blended ~50/50 with whichever neighbour texel shared that edge, instead of showing the current
texel's own colour -- the opposite of what ADR 0018 §3 names magnification for. Every test written
before this fix round probed exactly at a texel centre (where the buggy and correct formulas agree
trivially, `centre_offset === 0`), so nothing caught it; `terrain.seam_matches_reference` (below) is
the one guard against a regression back to this shape. If sprite sampling reuses `sample_tile_art`
or a close copy of it, check that copy anchors on `floor(texel + 0.5)`, not `floor(texel)`, before
assuming the terrain shader's own formula is a safe template to copy.

**The fix** (`sample_tile_art`'s magnified branch, `terrain.wgsl`): anchor on the nearest texel
*boundary* -- `let anchor = floor(texel + 0.5);` (`round(texel)`; integers are boundaries in this
parameterisation) -- rather than the texel's own floor. `let offset = texel - anchor;` is then
signed distance from the nearest seam; `let seamed = anchor + clamp(offset / texel_per_px, -0.5,
0.5);` with no trailing `+ 0.5` (the old formula's `floor(texel) + clamp(...) + 0.5` conflated two
different reference points -- the texel's own floor *and* its centre -- which is exactly what
inverted the saturation direction). Worked through symbolically and confirmed both ways:
- **Symbolically:** near an actual inter-texel boundary (texel space position `N`, integer), `round`
  stays at `N` for `texel` on either side within `[N-0.5, N+0.5)`, so `offset = texel - N` passes
  smoothly through 0 exactly at the boundary and saturates to `N ± 0.5` (a texel *centre*) just past
  it on either side -- the transition band is centred on the real boundary, exactly as intended.
- **Measured, before and after**, same probe (visual 9's quadrant cell, tile `(11, 0)` -- hash bits
  0, no transform -- `tilesPerPx = 1/64`, `camFracX = 0.6`, `camFracY = texelFrac(0)`, i.e. art texel
  `(2.4, 0.5)`, 0.4 into texel 2's own interior on x, comfortably past the old formula's own tiny
  transition band): **before, `[127, 127, 0, 255]`** (a ~50/50 red/green blend -- the bug); **after,
  `[0, 255, 0, 255]`** (pure green -- the correct quadrant, matching `seamSnap`'s own prediction
  exactly, tolerance 2/255). The "before" run used a temporary, uncommitted revert of `terrain.wgsl`
  to confirm `terrain.seam_matches_reference` actually exercises the bug rather than trivially
  passing either way; the revert was never committed.

**The `* 0.5` denominator: dropped, deliberately, not left over.** The pre-fix code divided `offset`
by `texel_per_px * 0.5`; this fix divides by `texel_per_px` alone. Unit analysis: `offset` is in
texel-space; dividing by `texel_per_px` (texels per screen pixel) converts it to screen pixels, so
clamping to `±0.5` bounds the transition to `±0.5` *screen pixels* either side of the boundary -- one
screen pixel wide in total, the standard antialiasing width (and what a plain, undivided `fwidth`-
based implementation of this well-known technique gives -- ADR 0018 §3's own cited sources use this
form). Dividing by half that (`texel_per_px * 0.5`, the pre-fix code's own choice) halves the
transition band to half a screen pixel, sharper but narrower than the conventional width, and was
never a deliberate design decision in steps 1-3 -- just an unverified guess that happened to still
look plausible because every existing test probed exactly at a texel centre, where the band's width
doesn't matter at all. Kept the undivided, one-pixel-wide form: it matches the cited technique
exactly, and a narrower band has no stated benefit here to weigh against departing from the standard.

**`terrain.seam_matches_reference`** (`terrain-hash-ref.ts`'s `seamSnap(uvComponent, artSize,
texelsPerPx)`, mirroring the fixed formula exactly, one axis at a time): stages visual 9 (tile `(11,
0)`, no transform), probes art texel `(2.4, 0.5)` at `tilesPerPx = 1/64`, and asserts the exact
predicted quadrant colour. Confirmed failing against the pre-fix anchoring (above) and passing
against the fix, on the same probe.

**Existing tests and goldens: none moved.** Every probe added in steps 1-3 and fix round 1
(`variants_match_reference`, `magnified_texel_exact`, `flip_and_rotate_match_reference`,
`jitter_matches_reference`, all four dithering tests, `minified_converges_to_mean`) sits exactly at
a texel centre or, for the dithering tests, a `floor`-aligned integer art-texel position where the
seam formula's `lod <= 0.0` branch is reached but its own snap is a no-op either way (`centre_offset
=== 0` under the old formula, `offset === 0` under the new one) -- confirmed by running the full
`pnpm test` both before and after the fix with identical pass counts (`browser pass 77 tests`, +1 for
`seam_matches_reference` itself, otherwise unchanged) and no golden file touched. `gc.pages.terrain`
re-measured: `8/8 clean` passed, budget (116 B/frame) unchanged -- this fix is WGSL-only, no JS-side
per-frame path touched.

**Measured** (quiet-machine `pnpm test`, `uptime` load average 3.5-5.8): `rust pass 141 tests`,
`unit pass 115 tests`, `wasm pass 35 tests`, `browser pass 77 tests 15s/25s` (+1 over fix round 1's
76-test baseline; comfortably under the 20s trip-wire). `pnpm lint`: biome/rustfmt/clippy/tsc all
green. No existing test weakened, skipped or deleted; no golden changed; no tolerance widened.

### Orchestrator's gate (M09b accepted)

`pnpm gate 0554e71` at `a3b4104`: tree clean, 36 files changed (packages/engine 34, docs 1,
`PROMPT.md` 1), no existing golden modified or deleted (0 added), no skip/ignore/only/todo marker
added, 3,274 insertions over 16 commits. `budgets.json` unchanged for the whole milestone; the diff
carries no added timeout, retry, `expect.poll`, `repeatEach` or reduced workload. Built by three
implementers (steps 1-3, 4-5, 6-7) plus two fix rounds, per the renderer-sizing rule M09 established.

**`pnpm device:serve` verified by the orchestrator, not accepted as a claim.** The steps 6-7 report
called the literal command blocked by a held port 4173 and substituted a hand-rolled serve on another
port; that was a misdiagnosis. The other listener is an unrelated repo's `vite preview` bound to IPv6
`localhost`, while `device-serve.mjs` binds IPv4 `127.0.0.1` -- no collision. The literal `pnpm
device:serve` serves `device.html` (HTTP 200), and real desktop Chrome at
`?autopan=1&tiles=256` gives: `isolated: true`, `adapter.info` apple/metal-3, workers ready,
`1280x720px dpr=1 renderScale=1`, rAF interval p50/p95/worst `16.7 / 16.7 / 16.7 ms (n=601)`,
intervals >20ms `0`, main rAF callback p95 `0.21 ms`, GPU latency p95 `2.06 ms (n=21)`, 683 frames,
no page errors.

**Repeat loops** (`node scripts/repeat.mjs browser <n> [--load 10]`, foreground, bounded, per-run
kill timeout). Before fix round 1, at `dd87a1d`: **2 failures in 16 quiet runs** of `viewport: resize
renders same frame`, 0 in 12 under `--load 10`. After the fix, at `a3b4104`: **30/30 quiet**
(slowest suite 15 s) and **29/30 under `--load 10`** (slowest 20 s). The single loaded failure was
`gc: flat transport parity` -- an M04 test, not this milestone's -- timing out with the whole suite
at 46 s against its 25 s budget, at a 1-minute load average of **21.00** with Steam at 99.6 % CPU and
another session's Claude at 18 %. That is the environmental failure mode `PROMPT.md`'s Rules name
("at a 1-minute load near 20 every suite fails on timeouts only"), not a defect; it is recorded here
rather than re-rolled for a clean number.

**A Sonnet review of the 2,800-line diff found two coverage gaps and led to one real shader bug**,
none of which a green suite showed: flip/rotate had zero pixel coverage (`flags: []` on every fixture
visual), jitter's amplitude was chosen to sit under every probe tolerance so no test could see it
break, and -- while deriving what a fractional-offset seam test should assert -- the magnified
sampling inversion of fix round 2. All three are closed above. The lesson for later renderer
milestones: **every probe in the suite sat exactly at a texel centre, the one point at which the
correct and incorrect seam formulas agree.** A probe grid that never leaves texel centres cannot see
a sampling bug, however many probes it has.
