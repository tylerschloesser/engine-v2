# M09b: Terrain art sampling, canvas lifecycle, device page

Status: not started · After: 09 · Tyler-dependent: no (phone serving reuses M03's `pnpm device:serve --tunnel`; tunnel approved, Q7)

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
- [ ] All tests above pass by name.
- [ ] `device.html` runs the production `createFrameLoop` (not a bespoke loop) against a real canvas, driven by `requestAnimationFrame` through the injected `Scheduler`; `frame-loop.production_runs_phases_in_order` passes.
- [ ] `pnpm device:serve` serves `device.html` and the HUD shows non-zero frame statistics in desktop Chrome with `?autopan=1&tiles=256`.
- [ ] The `docs/plan/device-checks.md` section for this milestone matches what was built.
- [ ] `pnpm test` and `pnpm lint` are green.

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
