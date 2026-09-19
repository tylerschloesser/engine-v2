# M09b: Terrain art sampling, canvas lifecycle, device page

Status: not started · After: 09 · Tyler-dependent: no (phone serving reuses M03's `pnpm device:serve --tunnel` and its stated default)

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

**Consumes** M09: everything under its *Provides* (bind groups, `tiles.json` v1, `renderTo`, probes, counters, GC page `terrain`). M06b: `stepFrame`, control block. M03: the injectable `Scheduler`, `pnpm device:serve [--tunnel]` and its phone-serving decision (quick tunnel by default, `mkcert` as the alternative), the fixture app's page convention.

## Planning decisions
- **Reference implementation of the hash in the test, not a golden image.** `terrain.variants_match_reference` recomputes the PCG hash in TypeScript and predicts which variant cell each probed tile shows; integer hashes are exact on every GPU (0018 §3), so this holds on Metal and SwiftShader alike.
- **Probe-friendly fixture art.** Flat colours per cell, 4 px cells, variants differing in colour, two visuals with different `priority` and a 2-texel `band`. At integer pixels-per-texel the fat-pixel formula returns exact texel colours, which keeps probes within the 2/255 tolerance of 0020 §6.
- **HUD contents** (diagnostic page only, outside the zero-GC rule): `isolated`, `adapter.info`, workers ready, canvas size and render scale, rAF interval p50 / p95 / worst over the last 10 s, count of intervals > 20 ms, main rAF callback p95 (ms), and GPU latency p95 sampled once per 30 frames with `onSubmittedWorkDone` (iOS exposes no timestamp queries, so this and interval steadiness are the proxy for 0018 §9's GPU share).
- **Serving a phone** is M03's decision (secure context needed, so a quick tunnel by default); this brief adds only the page.
- **Fallback switches are URL parameters on the device page** so a failed check is re-run in seconds: `?scaleCap=1.5`, `?scaleCap=1`, `?cutoff=4`.

## Order of work
1. Mips and sampler; `terrain.minified_converges_to_mean`. 2. Hash, variants, flips, jitter with the TS reference. 3. Dithering and neighbour reads. 4. Viewport observer and render scale; backgrounding. 5. Canvas smoke test. 6. Device page and HUD.

## Tests added
- Browser readback (Chromium): `terrain.variants_match_reference`, `terrain.dither_only_inside_band` (tile centres untouched; pixels inside the band take the higher-priority neighbour's colour at the Bayer pattern's positions; none when the neighbour's priority is lower), `terrain.missing_neighbour_is_self`, `terrain.dither_fades_when_minified`, `terrain.minified_converges_to_mean` (1 px per tile, tolerance 8/255), `terrain.magnified_texel_exact`, `viewport.resize_renders_same_frame` (no frame at the old size, no cleared frame), `viewport.dpr_change`, `viewport.clamped_to_limit`, `lifecycle.hidden_stops_visible_rebases`, `canvas.presents` (real canvas, real rAF, one frame, no errors).
- Rust native: `wgsl.terrain_validates` still green.
- Zero-GC: page `terrain` re-run with the final shader (numbers unchanged: no new per-frame wrappers).

## Exit criteria
- [ ] All tests above pass by name.
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
