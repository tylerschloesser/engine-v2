# M17b: Sprite atlas, frame-time budget, `profile-frame`

Status: not started · After: 17, 09b · Tyler-dependent: no

Split out of M17 during planning. PLAN.md lists it under M20b's After (M33 is the first milestone to draw a sprite); M18 and M19 do not need it. Carries one manual desktop check (Safari and Firefox).

## Goal
The sprite half of the art contract works: `sprites.png` + `sprites.json` load into a padded atlas with two mip levels, and the uber-quad pipeline draws the sprite kind with pivot, size in tiles, frames and `FLIP_X`. The worst-case frame of 0018 §6 (65,536 records) is measured against the desktop proxy of 0018 §9 in the slow tier: this is the repo's first frame-time exit criterion, so the `profile-frame` skill is written here.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0018-renderer.md` (§3 "Art sampling" for sprites, §4 `sprites.png`, §9, Consequences: the Safari/Firefox deferral)
3. `docs/decisions/0020-testing-strategy.md` (§4 demotion rule, §9 performance and baselines)
4. `docs/plan/17-drawlist-and-sprites.md` (Seams, Planning decisions)
5. `docs/plan/09b-terrain-art-and-lifecycle.md` Deviations, "Fix round 2" — before touching the magnified-sampling formula, see the Planning decisions note below

Mine from spikes: `spikes/zero-gc-webgpu/tests/harness.mjs` (CDP tracing session, reading trace events between `performance.mark`s: the frame profile uses the same session). Rules that apply: `.claude/rules/hot-paths.md`.

## Scope
- `render/atlas.ts`: fetch + validate `sprites.json`, upload `sprites.png` (`premultipliedAlpha: true`), mip level 1 via M09b's blit; the sprite table (rect, pivot + size per sprite id) as two small data textures (see Planning decisions).
- `uberquad.wgsl`: sprite kind (rect lookup by sprite id, frame index from `param` when `frames > 1`, pivot, `FLIP_X`, bilinear + fat-pixel as terrain, premultiplied blending).
- Rust: `DrawList::sprite` already exists (M17); add `SpriteId` constants helper for fixtures only.
- Slow-tier benchmark `bench.frame_worstcase`; baseline file; `.claude/skills/profile-frame/`.
- The manual Safari/Firefox harness page mode.
- GPU memory counter: `gpuBytes`, the sum of the byte sizes of every texture and buffer the renderer creates (page, indirection, tile art with mips, atlas, sprite data textures, instance buffer, uniforms), added up at creation.

## Non-scope
Sprite animation clocks (a game passes the frame in `param`). Text. A second atlas (0018 Consequences). Reference-game art (M20). Frame time on the reference game's worst-case view and on phones (M36, M39).

## Files, packages and crates touched
`packages/engine` (`src/render/atlas.ts`, `src/render/drawables.ts`, `src/render/wgsl/uberquad.wgsl`, `scripts/profile-frame.mjs`, `tests/browser/`, `tests/browser/pages/device.html`), `packages/engine/fixtures/drawables/` (generated `sprites.png`), `.claude/skills/profile-frame/SKILL.md`, `scripts/suites.mjs` (slow-tier registration).

## Seams
**Provides**
- `ClientOptions.assets.sprites?: string` (URL of `sprites.json`).
- `sprites.json` schema v1: `{ "version": 1, "image": "sprites.png", "padding": 2, "sprites": { "<sprite id 0..4095>": { "rect": [x, y, w, h], "pivot": [px, py], "size": [w_tiles, h_tiles], "frames": 1 } } }`; frames are laid out left to right from `rect`; limits of 0018 §4 validated with the offending id in the message.
- `pnpm bench:frame` (slow tier member) and `packages/engine/baselines/frame.json`.
- `engine/test` counter `gpuBytes`.
- `profile-frame` skill wrapping `scripts/profile-frame.mjs`.
- Device page mode `?harness=1` (below).

**Consumes** M17: `DrawList`, uber-quad pipeline, counters, GC page `drawables`. M01: `scripts/suites.mjs` slow tier. M09b: `mips.ts`. M09: `art.ts` patterns, `renderTo`/probes. M04: CDP harness. M36 later re-points the benchmark at the reference game.

## Planning decisions
- **If sprite sampling reuses `terrain.wgsl`'s magnified ("fat pixel") formula or a close copy of it, anchor on `floor(texel + 0.5)`, not `floor(texel)`.** `docs/plan/09b-terrain-art-and-lifecycle.md` Deviations ("Fix round 2") found that formula shipped inverted for most of M09b: anchoring on the texel's own floor and adding `+ 0.5` after clamping saturates to a shared texel *edge* instead of the texel's own *centre*, blending ~50/50 with the neighbour under magnification at any offset that isn't exactly a texel centre. Every M09b probe written before that fix sits exactly at a texel centre, where the buggy and fixed formulas agree trivially — so a guarding test here must probe at a fractional offset, not a centre, or it will pass against a regression the same way M09b's own tests did. `terrain.seam_matches_reference` (`terrain-hash-ref.ts`'s `seamSnap`) is the existing example to copy, both for the corrected formula and for how to write a probe that actually exercises it.
- **Frame-time criterion lands here, not in M09.** Terrain alone puts almost nothing on the CPU; the shares of 0018 §9 (main rAF callback, client-worker `frame`) are dominated by the 2 MiB `writeBuffer`, `extract` and the sort, which first exist at full size in M17. `bench.frame_worstcase` renders the `drawables` fixture with 65,536 records at maximum zoom-out under real rAF (`--disable-frame-rate-limit --disable-gpu-vsync`, as the spike did), 300 frames after 120 warm-up, and takes medians from trace events between marks: the rAF callback task on `CrRendererMain`, and a `performance.measure` around `frame` on the client worker. It must meet 0018 §9's desktop proxy numbers and stay within 25 % of the checked-in baseline (0020 §9); it gates on Tyler's Mac only and records elsewhere.
- **`profile-frame` skill contents.** When to use it (a frame-time benchmark fails or a renderer/extract change is suspected); the one command (`node scripts/profile-frame.mjs [--fixture drawables] [--frames 300]`), which writes a trace JSON and prints one table: main callback p50/p95, worker `frame` p50/p95, top five self-time functions per thread, against the budget rows; how to read it; when to update the baseline. Written by the session after it has run the procedure once (0021 §4).
- **Sprite table in data textures, not uniforms (0024 §11).** 4,096 sprites × 32 bytes is 128 KiB, over the 16 KiB compatibility-mode binding limit (0018 §7). Decision: a 64 × 64 `rgba32float` data texture pair read with `textureLoad` instead of a uniform array (one texture for rect, one for pivot + size). It keeps one bind group, needs no storage buffers, and `rgba32float` is loadable (not filterable) in compatibility mode.
- **Manual harness shape for Safari and Firefox** (0018 deferral; the CDP instrument is Chromium-only). `?harness=1` on `device.html` steps 120 + 600 frames of the `drawables` page's script with the real renderer, then prints: any `uncapturederror`, the result of the `GPUTexture`-as-view probe, whether `writeBuffer` and `writeTexture` accepted SAB-backed views (or the staged-copy path engaged), and `memory.buffer.byteLength` per instance. Tyler records allocations with the browser's own tool around the 600-frame run.

## Order of work
1. Fixture sprite sheet script + manifest validation. 2. Atlas upload, mips, data textures. 3. Sprite kind in the shader with probes. 4. Benchmark + baseline. 5. Run the profile once by hand; write the skill. 6. `?harness=1`.

## Tests added
- `unit` suite: `sprites.schema_errors`.
- Browser (Chromium): `counters.gpu_bytes_within_budget` (on page `drawables` with sprites loaded, `gpuBytes` is non-zero and within `counters["render.gpuBytes"]`, whose value and `formula` come from the GPU-side figure of 0015 §5 and 0018 Consequences).
- Browser readback (Chromium): `sprite.pivot_and_size_probe`, `sprite.flip_x`, `sprite.frames_by_param`, `sprite.no_bleed_at_mip1` (neighbouring atlas cell of a contrasting colour never appears; relies on the 2 px extrusion), `sprite.layering_with_shapes`.
- Rust native: `wgsl.uberquad_validates` still green.
- Zero-GC: page `drawables` with sprites present (number unchanged).
- Slow tier: `bench.frame_worstcase`.

## Exit criteria
- [ ] All fast tests above pass by name; `budgets.json` holds `counters["render.gpuBytes"]` with its `formula`.
- [ ] `pnpm bench:frame` meets the desktop proxy of 0018 §9 on Tyler's Mac and `baselines/frame.json` is checked in.
- [ ] `.claude/skills/profile-frame/SKILL.md` exists and its command was run in this session.
- [ ] The `docs/plan/device-checks.md` section for this milestone matches what was built.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t sprite` · `pnpm test browser -t drawables` · `pnpm bench:frame` · `node packages/engine/scripts/profile-frame.mjs` · `pnpm test` · `pnpm lint`.

## Budgets
- Frame time, desktop proxy (PRE-PLAN §7 row 1, 0018 §9): `bench.frame_worstcase`.
- Allocation per isolate: unchanged from M17.
- Memory, GPU: atlas + instance buffer as 0018 Consequences; the data textures add 128 KiB. Measured by `gpuBytes` in `counters.gpu_bytes_within_budget`.

## Context artifacts
Creates the `profile-frame` skill (0021 §4; PLAN.md listed it under M17 before the split). `packages/engine/CLAUDE.md`: `pnpm bench:frame`, baseline update rule.

## Manual device checks
[device-checks.md, M17b: Desktop Safari and Firefox harness run](device-checks.md#m17b-desktop-safari-and-firefox-harness-run). Run on the Mac with plain `pnpm device:serve` (loopback is a secure context; no tunnel).
This milestone builds `device.html?harness=1` for it (Planning decisions, "Manual harness shape").

## Deviations

### Steps 1-3 (fixture sprite sheet + `sprites.json` v1; atlas upload/mips/data textures; sprite kind
in `uberquad.wgsl` with probes) -- done

Delegated as steps 1-3 only; steps 4-6 (benchmark, `profile-frame` skill, `?harness=1`) are a second
implementer's, built against the exact seam shapes below.

**Files added**: `packages/engine/src/render/atlas.ts` (+ `atlas.test.ts`), `packages/engine/scripts/
gen-sprite-art.mjs`, `packages/engine/tests/browser/sprite-readback.spec.ts`. **Files changed**:
`src/render/drawables.ts`, `src/render/wgsl/uberquad.wgsl` (+ regenerated `wgsl.generated.ts`),
`src/test/render.ts` (`readTextureMip`), `src/client.ts` (`ClientOptions.assets.sprites`),
`tests/browser/pages/src/drawables.ts`, `tests/browser/support/drawables-window.d.ts`,
`budgets.json`, `packages/engine/fixtures/drawables/src/lib.rs` (`sprite_id` module).

**Where the generated fixture art actually lives (deviates from the brief's own "Files touched"
line).** The brief lists `packages/engine/fixtures/drawables/` for "generated sprites.png", but that
directory is the Rust crate `fx-drawables` and has no `public/` of its own -- the exact same shape
`fixtures/terrain/` (M09b) has for `tiles.png`. Followed that precedent literally:
`scripts/gen-sprite-art.mjs` writes `sprites.png`/`sprites.json` into `tests/browser/pages/public/
drawables/`, Vite's `publicDir` for the browser-suite fixture app, so `drawables.html` fetches them
at `/drawables/*` under both `vite dev` and the built `vite preview` the browser suite runs against.

### Exact seam shapes, as landed

- **`sprites.json` v1** (`render/atlas.ts`'s `validateSpritesManifest`/`SpritesManifest`/
  `SpriteEntry`): exactly the brief's own schema. `padding` is validated (non-negative integer) but
  not otherwise consumed by `loadSpriteAtlas` -- it documents the atlas's own extrusion width for a
  human/asset-script reader; nothing in the loader re-derives bleed protection from it (the atlas
  image already has the padding baked in by the asset script). **`pivot` is a normalised `[0, 1]`
  fraction of the sprite's own footprint** (this cut's own reading, not fixed by 0018 §4, which names
  the field's existence only, not its units): `pivot: [0, 0]` is the sprite's own top-left corner,
  `[1, 1]` its bottom-right, matching a common sprite-engine convention and keeping it
  resolution-independent the same way `size` (tiles, not pixels) already is. Validated to `[0, 1]` on
  each axis. `frames`' own layout ("frames are laid out left to right from rect") needs no per-frame
  rect list: frame `i`'s rect is `rect` shifted by `i * rect.w` in x, computed in the shader from
  `param` (`floor(max(param, 0.0))`), not looked up -- `frames` itself is read only by `loadSpriteAtlas`'s
  own bounds check (`rect.x + rect.w * frames <= image.width`), never uploaded to the GPU: the shader
  has no way to *clamp* a frame index against a sprite's own frame count (it isn't in either data
  texture), so an out-of-range `param` reads whatever atlas pixels sit past the sprite's own last
  frame -- a caller's own responsibility, not validated at draw time (Non-scope: "a game passes the
  frame in `param`").
- **`render/atlas.ts`'s `loadSpriteAtlas(device, manifestUrl, opts?)`** returns `LoadedSpriteAtlas =
  { atlasTexture, rectTexture, pivotSizeTexture, manifest, gpuBytes }`. `atlasTexture`:
  `rgba8unorm`, `mipLevelCount: 2`, `textureBindingViewDimension: '2d-array'` (a single layer --
  compatibility mode requires a `2d-array` *binding* to reference a texture's layers at all, even one
  layer, the same finding M09b's own `render/mips.ts` Deviations already made), `usage: TEXTURE_BINDING
  | COPY_DST | COPY_SRC | RENDER_ATTACHMENT` (`COPY_SRC` is not a production need -- added only so
  `sprite.no_bleed_at_mip1`'s own `readTextureMip` can read it back; found by `uncapturederror` on
  this cut's first run of that test). `rectTexture`/`pivotSizeTexture`: `rgba32float`, 64x64, no mips,
  `usage: TEXTURE_BINDING | COPY_DST`. Mip 1 is blit by a **new, local one-pass function**
  (`blitSpriteMip1`), not `render/mips.ts`'s own `generateMips`: that function chases a full pyramid
  to 1x1 through `mipLevelCountFor`, which requires a power-of-two *square* size -- a sprite atlas is
  neither (0018 §4 fixes it at exactly 2 levels, independent axes, ≤ 4096² each). `blitSpriteMip1`
  reuses `MIPS_WGSL` (the same shader module/technique, one bilinear tap per destination texel) with
  its own bind-group-layout/pipeline/one-layer uniform buffer, doing exactly one level-0-to-1 pass.
- **`DrawablesRenderer` grows two members**: `setSpriteAtlas(atlas: LoadedSpriteAtlas): void` (swaps
  the atlas + two data textures into the renderer's one bind group and rebuilds it -- the same
  "placeholder, then install" shape `TerrainRenderer.setTileArray` already uses; before the first
  call, three tiny placeholders exist: a 2x2 2-mip atlas and two 1x1 data textures, never addressed
  by a real `sprite_id`) and `gpuBytes(): number` (`INSTANCE_BUFFER_BYTES` (2,097,152, fixed) +
  `DRAW_FRAME_UNIFORM_BYTES` (48, fixed) + the currently-installed atlas's own `gpuBytes`, updated on
  every `setSpriteAtlas` call). The bind group layout is now five entries, not one: `binding 0` (the
  DrawFrame uniform) gained `FRAGMENT` visibility alongside its existing `VERTEX` (the sprite
  fragment's own `frame.tiles_per_px` read -- **found by `uncapturederror` on this cut's first test
  run**: every prior uber-quad kind read the frame uniform from the vertex stage only), `binding 1`
  `atlas_tex` (`texture_2d_array<f32>`, `FRAGMENT`), `binding 2` `atlas_sampler` (`filtering`,
  `FRAGMENT`), `binding 3`/`4` `sprite_rect_tex`/`sprite_pivot_size_tex` (`texture_2d<f32>`,
  `unfilterable-float`, `VERTEX` -- read there, not `FRAGMENT`, since geometry is what needs pivot/
  size; `fs_main` gets `sprite_rect`/`sprite_world_size` as flat varyings instead of a second
  `textureLoad`).
- **`uberquad.wgsl`'s sprite kind**: `vs_main` looks up `pivot`/`box_size` (`sprite_pivot_size_tex`)
  and `sprite_rect` (`sprite_rect_tex`) by `sprite_id = kind_layer_flags & 0xFFFu` (the low 12 bits of
  the packed `kind_sprite`, 0018 §2) when `kind == KIND_SPRITE`; geometry is `quad_tiles = (raw_uv -
  pivot) * box_size`, where `raw_uv` is **always the unflipped `quad_uv(vertex_index)`**, never the
  early-flipped `uv` every other kind's geometry uses -- `FLIP_X` is deliberately decoupled from
  position for a sprite: only the *sampled* uv (`sample_uv`, passed to `fs_main` as `out.uv`) mirrors,
  so flipping a sprite never moves its own world footprint (a documented design choice, not specified
  either way by 0018 §2, which names the flag but not its exact interaction with a pivot). Every
  non-sprite kind's own vertex math is untouched (`pivot`/`box_size`/`box_uv` default to `0.5`/
  `inst_size`/the pre-existing flipped `uv`). `fs_main`'s sprite branch: `frame_rect = sprite_rect`
  shifted by `floor(max(param, 0)) * rect.w` in x; `scale = frame_rect.zw * frame.tiles_per_px /
  sprite_world_size` (atlas texels per screen pixel, per axis, mirroring `terrain.wgsl`'s own
  `texels_per_px` generalised off a single scalar since a sprite's rect and world size need not share
  one aspect ratio); `lod = clamp(max(0, log2(max(scale.x, scale.y))), 0, 1)` (`SPRITE_MAX_LOD = 1`,
  since only 2 mip levels exist, unlike tile art's full pyramid); magnified path (`lod <= 0`) anchors
  on `floor(texel + 0.5)`, exactly `terrain.wgsl`'s fixed seam formula (the binding rule), redone
  per-axis; minified path is a plain explicit-level `textureSampleLevel`. Output: `frag_rgb =
  sample.rgb * in.color.rgb`, `alpha = sample.a` (a sprite's own `Draw.color` is a *tint*, not a fill
  colour -- every test in this cut draws sprites with `color: [255, 255, 255, 255]`, i.e. no tint, so
  the sampled atlas colour comes through exactly).
- **Premultiplied blending: a known, inert gap, not fixed here.** The atlas is uploaded with
  `premultipliedAlpha: true` (Scope), but the uber-quad pipeline's own blend state (fixed at pipeline
  creation, shared by every kind including sprite) is *straight* alpha (`srcFactor: 'src-alpha'` on
  colour, M17's own choice for shapes, recorded in its Deviations). Premultiplied atlas content
  blended through a straight-alpha equation is wrong for a *semi-transparent* sprite edge, but every
  sprite in this cut's own fixture is fully opaque everywhere (`alpha = 255`), where premultiplied and
  straight colour are numerically identical -- so no test here can see the discrepancy. Flagged for
  whichever later milestone's game passes real semi-transparent sprite art through this pipeline:
  either the blend equation needs to become genuinely premultiplied (affecting every existing shape
  test's own blending, M17's territory to revisit) or the atlas upload needs to stop premultiplying.
- **`ClientOptions.assets.sprites?: string`** (`src/client.ts`): the field exists (widened from
  `{ tiles: string }` to `{ tiles: string; sprites?: string }`). **Superseded by Fix round 1, below**
  (the coordinator moved the real-page wiring into this cut instead of leaving it for cut 2): at
  initial landing it was read by no real page (`drawables.html`, this cut's own test page, has no
  `Client`/`ClientOptions` at all -- M17's own "hand-filled scene, no worker, no ABI instance"
  precedent -- and calls `loadSpriteAtlas` with a literal string directly); `gc-drawables.ts` now
  threads it through for real.
- **Fixture `sprites.png`/`sprites.json`** (`scripts/gen-sprite-art.mjs`, 96x64 atlas, mip 1 48x32):
  three sprites, `EXTRUDE_PX = 2` (the manifest's own `padding`).
  - id 0 **"quad"** (`fx-drawables::sprite_id::QUAD`): 8x8, four 4x4 flat quadrants (red/green/blue/
    yellow, TL/TR/BL/BR), `pivot: [0.25, 0.75]`, `size: [2, 1]` tiles, 1 frame -- an off-centre pivot
    on both axes and a non-square size, so a swapped w/h or an unapplied pivot moves the quadrant
    boundaries a probe checks. Reused for `sprite.flip_x` (the quadrant pattern is asymmetric on both
    axes) and `sprite.layering_with_shapes`.
  - id 1 **"strip"** (`sprite_id::STRIP`): three 8x8 frames left to right (cyan/magenta/orange),
    `pivot: [0.5, 0.5]`, `size: [1, 1]`, 3 frames.
  - id 2 **"bleed"** (`sprite_id::BLEED`): 32x32 flat red, immediately next to an unlisted 32x32 flat
    blue block, separated only by each side's own 2px extruded padding -- deliberately bigger than
    the other two sprites so its own minified (mip 1) footprint is large enough to target reliably
    (see "no_bleed_at_mip1", below). No manifest entry for the blue block: it exists only as raw atlas
    pixels, addressed indirectly through mip 1's own averaging, never drawn.
  - `fixtures/drawables/src/lib.rs`'s new `sprite_id` module (Scope: "add `SpriteId` constants helper
    for fixtures only") names these three. At initial landing, none were read by `extract()`; **Fix
    round 1** wires `QUAD` in (`Entity.sprite: bool`, below) -- `STRIP`/`BLEED` are still reached only
    through `drawables.html`'s own hand-filled probes.

### `sprite.no_bleed_at_mip1`: found the wrong tool for the job, switched, and it worked

**First attempt (on-screen sampling) could not be made to fail the way every other probe in this
suite does.** Drew "bleed" at a camera zoomed out enough to force `lod = 1` (fully minified,
`texels_per_px = 2` exactly) and probed screen pixels near the sprite's own right edge, expecting a
red/blue blend to appear when the fixture's own `EXTRUDE_PX` was temporarily set to `0` and
regenerated. It never did, at two different camera scales (`tilesPerPx = 1/16`, then `1/12`) and
across the sprite's whole screen footprint (verified with a full horizontal pixel scan, not a guess).
**Diagnosed, not just retried**: the hardware's own texel-centre sampling bias (`coordinate = uv *
levelWidth - 0.5`) means a screen pixel chosen to land off a *geometry* texel centre can still land
exactly on a *mip-sampling* texel centre by that same bias, at this atlas's own resolution and the
screen sizes reachable at exactly the `lod = 1` threshold (texel-to-pixel ratio is inherently 2:1
right at that threshold, so every reachable device pixel's own mip-space coordinate landed on an
integer). This is the same class of trap the brief's own binding rule names for the fat-pixel formula
("every readback probe sits off texel centres"), rediscovered one level removed, in the mip sampler's
own bias rather than the seam formula.

**Fixed by testing the actual mechanism instead of the sampling math around it.** Added `src/test/
render.ts`'s `readTextureMip(device, texture, mipLevel, width, height): Promise<PixelBuffer>` (the
same `copyTextureToBuffer` + `mapAsync` shape `readPixelsFromTarget` already uses, generalised with an
explicit mip level and caller-given dimensions -- `GPUTexture` exposes only its base level's own
`width`/`height`) and `window.__drawables.readAtlasMip1()`. `sprite.no_bleed_at_mip1` now reads the
atlas's own generated mip 1 directly and asserts texel `(18, 10)` (measured: the last texel of
bleed's own padded block) is pure red, `(19, 10)` (the unlisted neighbour's first texel) is pure blue
-- a hard, unblended edge in mip 1 itself, because every mip 1 texel on bleed's own side pools two mip
0 texels that are either both real content or both that content's own extruded copy, never one of
each. This tests the actual thing the 2px extrusion protects (whether padding, not the neighbour,
ended up inside the mip average nearest the edge) rather than a fragile screen-space coincidence.
**Verified failing without the fix**: regenerated the fixture with `EXTRUDE_PX = 0` (bleed and its
neighbour touch directly, no gap) -- `expectPixel(18, 10)` failed (`got 0, want 255`, i.e. no longer
pure red), confirming the test exercises the extrusion for real. Reverted (`EXTRUDE_PX` back to `2`,
atlas regenerated); `git status` shows only the intended `sprites.png`/`sprites.json` as new,
untracked files.

### Failability, every new browser test: injected, verified red, reverted

Per the brief's binding instructions ("say what a wrong implementation would still pass ... prove
failability by injection"), each of the six sprite-kind tests (`counters.gpu_bytes_within_budget` is
a direct measurement, not proved by injection) was proven by a temporary, reverted edit:

| Test | Injected fault | File / branch | Result before revert |
|---|---|---|---|
| `sprite.pivot_and_size_probe` | `quad_tiles = (box_uv - vec2(0.5, 0.5)) * box_size` (pivot ignored) | `uberquad.wgsl` `vs_main` | `expectPixel(40, 28)` failed (green channel 0, wanted 255) |
| `sprite.seam_matches_reference` | Fix round 1: see its own section below | `uberquad.wgsl` `fs_main`, `KIND_SPRITE` | `expectPixel(41, 21)` failed (red channel 128, wanted 255 -- a 50/50 red/green blend) |
| `sprite.flip_x` | `sample_uv = raw` (flip decoupling dropped) | `uberquad.wgsl` `vs_main` | `expectPixel(30, 28)` failed (red channel 255, wanted 0) |
| `sprite.frames_by_param` | `frame_rect.x += 0.0 * frame_index * rect.z` (frame offset dropped) | `uberquad.wgsl` `fs_main`, `KIND_SPRITE` | `expectPixel(32, 32)` failed at `param=1` (red channel 0, wanted 255) |
| `sprite.no_bleed_at_mip1` | fixture regenerated with `EXTRUDE_PX = 0` | `scripts/gen-sprite-art.mjs` | `expectPixel(18, 10)` failed (red channel 0, wanted 255) |
| `sprite.layering_with_shapes` | `alpha = 0.0` unconditionally (sprite never covers anything) | `uberquad.wgsl` `fs_main`, `KIND_SPRITE` | `expectPixel(30, 28)` failed (red channel 10, wanted 255 -- the rect showed through) |

Every injection was reverted immediately after confirming the red result (`git diff` empty on
`uberquad.wgsl`/`scripts/gen-sprite-art.mjs` before the next step); `pnpm test browser -t sprite` was
green (6 tests) at every commit boundary.

### `counters.gpu_bytes_within_budget`: measured, not estimated

**Superseded by Fix round 1, below** (the coordinator required the counter to cover the whole
renderer, not drawables alone, and the budget to come from 0015 §5's own GPU-side figure rather than
measured-plus-headroom). At initial landing: `budgets.json`'s `counters.render.gpuBytes = 2,400,000`,
measured on `drawables.html` (drawables' own share only) at 2,258,992 B exactly.
**Bug found and fixed while measuring, still true after Fix round 1**: `loadSpriteAtlas`'s first
draft read `bitmap.width`/`bitmap.height` *after* `bitmap.close()` to compute `gpuBytes` --
`ImageBitmap.close()` zeroes those properties (confirmed empirically: the atlas rendered correctly
throughout, since `atlasTexture`'s own size was already captured before the close, but `gpuBytes`
itself read back as `131,076`, i.e. `SPRITE_TABLE_BYTES * 2 + 4`, as if the image were 1x1). Fixed by
capturing `imageWidth`/`imageHeight` into local `const`s before `bitmap.close()` and using those
throughout; not a production-visible bug (nothing else read `bitmap.width`/`height` after the close),
found only because this cut measured the counter by hand rather than trusting the formula.

### Fix round 1 (coordinator review, three items)

Three gaps found by the coordinator's own review of steps 1-3, each committed separately
(`053e722`, item 1; `16e709c`, items 2 and 3 together -- their commit message explains why: the
budget's correct value and formula can only be set once the page exercising both halves exists).

**Item 1: the binding injection was missing.** None of the original five sprite tests proved that
anchoring on `floor(texel)` instead of `floor(texel + 0.5)` fails at a fractional offset. Investigated
before adding anything (quantify before hypothesising): a plain anchor swap on *this* formula's own
shape (`anchor`, `offset = texel - anchor`, `seamed = anchor + clamp(offset / scale, ±0.5)`, no extra
bias) is provably a no-op whenever the clamp saturates -- worked algebraically both ways (`anchor =
floor(texel)` vs `floor(texel + 0.5)` always differ by exactly 1 when they disagree at all, and their
respective offsets differ by exactly ∓1, so `anchor + clamped` lands on the *same* value, the texel's
own centre, either way). Terrain's own historical bug was not a plain anchor swap: it kept an extra,
now-mismatched `+ 0.5` and decoupled the offset from the anchor (`fract(texel) - 0.5`), which is what
actually broke the cancellation and pushed the saturated result to a texel *edge* instead. Reproducing
that exact shape in the sprite kind's own formula is what the injection below does. A probe whose
*seamed* position sits close to (not past) the real quadrant boundary was needed to tell the two
anchor choices apart even with the historically-accurate injection, since a probe deep in a texel's
own interior still converges to the same texel centre under both. Found by an exact-fraction (not
floating-point) search over camera/pixel combinations for the "quad" sprite: `sprite.
seam_matches_reference` (`tests/browser/sprite-readback.spec.ts`) -- `tilesPerPx = 1/24`, pixel `(41,
21)` on a 64x64 target, exact raw uv `(43/96, 5/16)`, `seamSnap` (imported from `terrain-hash-ref.ts`,
unmodified -- this kind's own formula is structurally identical, redone per-axis) predicts seamed
texel `(3.5, 2.5)`, the top-left red quadrant. Verified failing: injecting `anchor = floor(texel)`,
`offset = fract(texel) - 0.5`, `seamed = anchor + clamp(offset / scale, ±0.5) + 0.5` into `uberquad
.wgsl`'s sprite fragment branch made the probe read `[128, 65, 0, 255]` -- almost exactly a 50/50
red/green blend at the boundary, matching the historical bug's own textbook symptom exactly -- instead
of pure red. Reverted immediately (`git diff` on `uberquad.wgsl` empty before the commit).

**Item 2: `gpuBytes` now covers the whole renderer.** `TerrainRenderer` gained `gpuBytes()`: the fixed
page texture (`PAGE_TEXTURE_EDGE² × 4`, exactly 4 MiB), indirection texture (`INDIR_TEXTURE_EDGE² × 2`),
visual-table buffer (`VISUAL_TABLE_BYTES`), frame uniform (`FRAME_UNIFORM_BYTES`), plus the installed
tile array's own byte count. That last figure needed a new source: `render/art.ts`'s `LoadedArt`
gained a `gpuBytes` field (summed across every mip level `mipLevelCountFor(tile_px)` produces,
`cellCount × Σ_level max(1, tile_px >> level)² × 4`), and `TerrainRenderer.setTileArray` gained a
**required** (not optional) second `gpuBytes` parameter -- deliberately not optional, so a caller can
never silently under-count by forgetting it. Every real page's own `setTileArray(art.texture)` call
site (11 of them: `connected-terrain.ts`, `device.ts` x2, `gc-connected-terrain.ts`, `gc-drawables.ts`,
`gc-input.ts`, `gc-slice.ts`, `gc-terrain.ts`, `slice.ts`, `terrain-client.ts`, `terrain.ts`) was
updated to `setTileArray(art.texture, art.gpuBytes)` -- a mechanical, one-line change at each, caught
immediately by `tsc` (`tests/browser/pages/tsconfig.json`, a separate config from `tests/tsconfig.json`
that the main typecheck run does not cover -- found the hard way, by running it explicitly after the
main typecheck passed clean). `render/upload.test.ts`/`src/frame-loop.test.ts`'s own fake
`TerrainRenderer` stand-ins each gained a trivial `gpuBytes() { return 0 }`.
`window.__drawablesTest.gpuBytes()` (`gc-drawables.ts`) now returns `renderer.gpuBytes() +
drawablesRenderer.gpuBytes()`, the whole renderer, not drawables' own share alone.
**Budget value and formula, per the coordinator's own binding instruction ("from the GPU-side figure
in 0015 §5 / 0018 Consequences, not measured + headroom")**: `budgets.json`'s
`counters.render.gpuBytes` is now `20,971,520` (`20 * 1024 * 1024`) -- 0015 §5's own "~20 MiB
GPU-side ([0018])" line, the same figure 0018 Consequences' own "4 MiB page + 2 MiB instances + art"
breakdown names (art itself unsized there). Not measured-plus-headroom, unlike every other counter row
in this file: a real game's own tile art and sprite atlas dwarf this milestone's tiny fixtures, so a
fixed-headroom-over-measured convention would be a meaningless number here, revisited only once a real
game's assets exist to measure against. Measured on the real page (item 3, below): **6,478,928 B**,
comfortably inside 20 MiB with room to spare.

**Item 3: the rendering half's wiring finished, moved out of cut 2.** `gc-drawables.ts` builds one
`assets = { tiles: '/terrain/tiles.json', sprites: '/drawables/sprites.json' }` object and threads it
into both `createClient({ ..., assets })` and the two real asset loaders (`loadTileArt(device.device,
assets.tiles, ...)`, `loadSpriteAtlas(device.device, assets.sprites, ...)`) -- the first real page to
build one shared object this way; every other real-client page still types each asset URL a second
time (unchanged by this cut, a bigger refactor than this fix round's own scope). The sprite atlas
loads and installs (`drawablesRenderer.setSpriteAtlas`) once, in one-time setup, never touched again
inside `drive()`. `fx-drawables` gained `Entity.sprite: bool` and `Action::Spawn`'s own `sprite`
field (every genesis entity explicit `sprite: false`, so `drawlist_fixture_hash_golden` is byte-
identical, re-verified: `cargo nextest run -p fx-drawables` still blesses `07e82d2cb76fe412`);
`extract()` now calls `out.sprite(e.layer, pos, sprite_id::QUAD)` instead of `out.circle(...)` when
`e.sprite`. The population loop marks every 10th of its 300 entities (`SPRITE_EVERY = 10`, 30 of 300)
as a sprite, so the measured window's own DrawList genuinely contains sprite-kind records, not just
circles ("page `drawables` with sprites present", Tests added).
**Budgets stayed exactly as they were, no widening needed.** `pnpm test browser -t "drawables clean"`
passes at the existing, unchanged `gc.pages.drawables.isolates.main` budget (117 B/frame): loading and
installing the atlas is one-time setup (0016 §2, the same exemption `loadTileArt` already has), and
drawing a sprite reuses the *same* per-non-empty-layer instanced draw call a circle already used --
nothing about the measured window's own wrapper shape changed, so the coordinator's own fallback
("force the budget to 1, read `windowByFn`, report the attribution") was never needed.
`counters.gpu_bytes_within_budget` moved from `drawables.html` (`sprite-readback.spec.ts`, which could
only ever measure drawables' own share -- test removed there) to `gc-drawables.html`
(`tests/browser/gc-drawables.spec.ts`), the one real page with both renderers: no separate page was
cheaper to build, since `gc-drawables.html` already exists with everything item 3 needed.

### Notes for cut 2 (steps 4-6: benchmark, `profile-frame` skill, `?harness=1`)

- **`fx-drawables` cannot yet produce a 65,536-record frame; three separate things are missing, none
  built here (per the delegation prompt: "record that; don't build it")**:
  1. **No bulk-spawn action.** `Action::Spawn` creates exactly one entity per dispatched action; the
     `drawables` zero-GC page's own 300-entity population loop already does this one-by-one (one
     `dispatchRaw` + `stepFrame` + `stepSimTickSync` per entity) as one-time setup. Scaling that same
     loop to 65,536 iterations is ~218x slower and is very unlikely to fit inside a benchmark's own
     setup budget; a bulk `Action::SpawnMany { count, ... }` (or a `genesis`-time population, if the
     benchmark's world can be fixed rather than built by dispatch) is needed.
  2. **The camera needs to be zoomed out to the true worst case.** 0018 §6's 65,536-drawable worst
     case is 256x256 tiles at maximum zoom-out (`tilesAcross = 256`); every existing `drawables`-page
     camera (both the readback pages and the zero-GC page's own wide-population camera,
     `tilesAcross = 24`) is far narrower. `extract()`'s own `visible()` clipping means fewer than
     65,536 entities would ever reach the DrawList at a narrower zoom even with 65,536 entities
     spawned.
  3. **`SMALL_ZOOM_THRESHOLD` would drop entities at exactly the zoom the benchmark needs.**
     `extract()` skips `Entity.small` entities once `FrameView::zoom() > 32.0` (`fixtures/drawables/
     src/lib.rs`) -- at `tilesAcross = 256`, every entity marked `small` would be silently excluded
     from the DrawList, undercounting the benchmark's own record count unless every benchmark entity
     is spawned with `small: false`, or the fixture's own zoom-skip logic is bypassed/reconsidered for
     this scenario.
  - `Action::Spawn`'s existing `layer: u8` field (fix round 1, M17) already lets a bulk-spawn action
    spread entities across DrawList layers if the benchmark wants that; not itself a blocker.
  - `extract()` now has a sprite-drawing branch (Fix round 1: `Entity.sprite: bool` -> `DrawList::
    sprite(e.layer, pos, sprite_id::QUAD)`), so cut 2's benchmark can spawn entities with `sprite:
    true` directly if it wants the sprite kind's own atlas/data-texture reads exercised under load --
    no further Rust change needed for that part.
- **`ClientOptions.assets.sprites` is now read for real** by `gc-drawables.ts` (Fix round 1, moved into
  this cut from cut 2's own territory) -- `device.html` (steps 4-6's own `?harness=1` page) still needs
  its own wiring, the same way `options.assets.tiles`/`options.render` are already read there: a
  page's own explicit call, not something `createClient` touches.
- **`atlasTexture`'s `COPY_SRC` usage** (added for `readTextureMip`) is a production no-op but is now
  part of the texture's own creation flags; if a later cut tightens GPU memory/usage flags for
  production, this is the one flag in this cut's own additions that exists purely for test
  introspection, not rendering.
- **Premultiplied-blending gap** (see Deviations above): inert today (every fixture sprite is fully
  opaque), real once a game's own sprite art has soft edges.

### Verified (commands and results, final state after Fix round 1)

- `pnpm test unit -t sprites` -> `unit pass 3 tests`. `pnpm test rust -t wgsl` -> `rust pass 2 tests`
  (`wgsl_terrain_validates`, `wgsl_uberquad_validates`).
- `pnpm test browser -t sprite` -> `browser pass 6 tests` (`sprite-readback.spec.ts`: `pivot_and_
  size_probe`, `seam_matches_reference`, `flip_x`, `frames_by_param`, `no_bleed_at_mip1`,
  `layering_with_shapes`; `counters.gpu_bytes_within_budget` moved off this file, see below).
  Individual durations (`playwright test --project chromium -g "sprite"`, this machine):
  `sprite.pivot_and_size_probe` ~485ms, `sprite.seam_matches_reference` 304ms, `sprite.flip_x`
  ~508ms, `sprite.frames_by_param` ~583ms, `sprite.no_bleed_at_mip1` ~488ms, `sprite.layering_
  with_shapes` ~530ms.
- `pnpm test browser -t drawables` -> `browser pass 9 tests` (+1 over steps 1-3: `counters.gpu_
  bytes_within_budget` now lives here). `counters.gpu_bytes_within_budget` alone (`playwright test
  --project gc -g "gpu_bytes"`): 356ms.
- `pnpm test browser -t draw` -> `browser pass 14 tests` (M17's own suite, unaffected). Full `pnpm
  test browser` -> `browser pass 144 tests 22s/25s` (+1 over steps 1-3's 143: `sprite.seam_matches_
  reference`; the `gpu_bytes` test moved, not duplicated).
- `cargo nextest run -p fx-drawables` -> `7/7 pass`, golden hash unchanged (`drawlist_fixture_hash_
  golden` still blessed to `07e82d2cb76fe412` -- confirms `Entity.sprite`/`Action::Spawn.sprite`
  changed no genesis-driven `Draw` bytes). `cargo clippy --workspace --all-targets -- -D warnings` ->
  clean.
- `pnpm test unit` -> `unit pass 202 tests` (unchanged by the fix round: no new `unit`-suite file).
  `pnpm test wasm` -> `wasm pass 49 tests` (unaffected). `pnpm test rust` -> `rust pass 322 tests`
  (unaffected: the fix round's own Rust change adds a struct field, not a test).
- `pnpm exec tsc --noEmit -p tsconfig.json`, `-p tests/tsconfig.json` and `-p tests/browser/pages/
  tsconfig.json` (the third config the main typecheck run does not cover -- this is where every
  `setTileArray` call-site error actually surfaced) -> all clean. `pnpm format` (`biome check
  --write` + `cargo fmt`) -> no fixes needed after the final state.
- `pnpm test`/`pnpm test:slow`/`pnpm lint` (the full runs) were not run (delegation prompt: "Don't run
  the full suites; I am the gate").

### Not verified in this range (steps 4-6's own territory)

`pnpm bench:frame`, `baselines/frame.json`, `.claude/skills/profile-frame/`, `?harness=1`, the
`docs/plan/device-checks.md` M17b section, and `packages/engine/CLAUDE.md`'s own context-artifact
line (`pnpm bench:frame`, baseline update rule) -- all named by the brief's own Context artifacts/
Exit criteria for steps 4-6, not this range. `packages/engine/CLAUDE.md`'s Rendering paragraph does
not yet mention `render/atlas.ts`; left for cut 2 or a later editor, since the brief's own Context
artifacts line for this milestone names only the `bench:frame`/baseline addition.

## Steps 4-6 (benchmark, `profile-frame` skill, `?harness=1`)

Base: `2d17dce` (steps 1-3 plus fix round 1, committed and gated). Commits `cde88b1`/`7009d1d`/
`a083813`/`261523d`.

### Known-from-cut-1 blockers, resolved

**Bulk spawn**: `fx-drawables` gained `Action::SpawnMany { origin, cols, rows, spacing, layer,
sprite }` (`fixtures/drawables/src/lib.rs`), spawning a `cols x rows` grid of `small: false`
entities in one admitted action -- `genesis`/`Action::Spawn` untouched, `drawlist_fixture_hash_
golden` unchanged (`07e82d2cb76fe412`, re-verified: `cargo nextest run -p fx-drawables`, 7/7 pass).
**Camera**: `frame-bench.ts` sets `cameraState.tilesAcross = 256` (0018 §6's own zoom figure) with
`halfExtentTilesX/Y = 130` over a 256x256, spacing-1 grid -- `visible()`'s clip sees exactly 65,536
records (`DrawList::CAPACITY`), asserted in `frame-bench.spec.ts` (`recordCount === 65_536`).
**`SMALL_ZOOM_THRESHOLD`**: sidestepped, not touched -- every `SpawnMany`-spawned entity is hard-coded
`small: false` in `apply()`, so the zoom-256 camera never exercises the drop path for this scene.

**A fourth blocker found here, not anticipated in cut 1's own notes**: `host::mod::SIM_TX_BYTES`
(64 KiB, one connection's whole per-tick built frame) would silently truncate a single 65,536-entity
`SpawnMany` dispatch's own delta. Fixed by batching: `frame-bench.ts` dispatches `BATCH_COLS = 128`
entities per `SpawnMany` call, 512 calls total (one 128-entity row-half per tick), each batch's own
one-tick delta staying comfortably under the cap. Not a fix to the constant itself (Non-scope,
`host::mod.rs`'s own "provisional... a real join-burst budget is 0010's pacing/backpressure").

### The real hang: a running worker never processes `Runtime.evaluate`

Found empirically, cost the most debugging time of this range: `worker/shell.ts`'s blocking loop
(`Atomics.wait`, notify, run `body()`, `Atomics.wait` again) never returns to the isolate's own
message pump under normal operation, so a CDP `Runtime.evaluate` sent to a worker that is merely
"idle, waiting for the next wake" -- not parked -- sits pending forever; only the park protocol's own
`W_YIELD`/`W_PARKED` handshake (`resumeWorkers`'s own doc comment: "a parked worker is not blocked")
actually returns control to the event loop. `tests/browser/gc/instrument.ts`'s own comment ("a
production worker cannot call `performance.mark` itself") names half of this; the other half --
that *reaching* an unparked worker from the outside at all requires parking it first, regardless of
what you want to do with it -- was not documented anywhere and is the reason `bench.frame_worstcase`
parks every worker, installs the `call1` wrapper, resumes, and only then calls `start()` (real rAF),
rather than installing it mid-benchmark the way a first draft tried (hung at 30 s/120 s test
timeouts twice before the cause was isolated with a standalone Playwright script outside the test
framework, sequentially narrowing: page-only polling worked instantly; adding CDP worker attachment
still worked; adding the *naming* `Runtime.evaluate` call was the exact point it hung).

### `wf-*`/`mf-*` mark placement: what each side actually measures

`mf-s-<n>`/`mf-e-<n>` (`frame-bench.ts`'s own `instrumentedScheduler`) bracket the *whole* rAF
callback -- camera integration, the real `drawablesRenderer.acquire()` (SAB-backed `writeBuffer`),
`renderer.writeFrameUniform`/`draw()` (terrain's triangle plus `attachDrawables`' own drawables
layers in the same pass). `wf-s-<n>`/`wf-e-<n>` (the CDP-injected `call1` wrapper) bracket *only* the
client role's `frame(t_ms)` WASM export -- extract + counting sort (M17's own "frame(t_ms) now runs:
build FrameView -> extract -> sort" scope) -- not the surrounding `drawlistPump.publish()` or the
net/gen/upload/input pumps `worker/client.ts`'s `body()` also runs on the same wake, since none of
those are reachable through `self.__engineInstance.call1`. 0018 §9's own prose ("drain rings, apply
network frames, interpolate, extract, sort and publish") reads as the *concept* of one frame-
producing wake, wider than the raw export call; this cut measures the dominant, extract/sort-bound
part of it (confirmed by `profile-frame.mjs`'s own CPU profile: `copyBytes`/`publish` are worker-side
but outside the `wf-*` window and do show up in the *page's* own CPU profile as separate top-five
entries) rather than the whole wake, because nothing reachable from outside the worker can bracket a
JS-level span spanning several pump calls without editing `worker/client.ts` itself (a hot-path
production file, out of reach for CDP-only instrumentation). Flagged for whoever next revisits this
number.

### Sample-count asymmetry: `main` vastly outpaces `worker` under uncapped rAF

At 65,536 records the worker's own per-call cost (~2.1-2.6 ms measured) is well above main's
(~0.6-0.7 ms); with `--disable-frame-rate-limit --disable-gpu-vsync` main races far ahead of real
device pacing (roughly 1,500+ fps observed), so several main frames' own `CB_FRAME_REQ` advances
routinely coalesce into one worker wake before `bench.frame_worstcase`'s own 300-main-frame window
closes -- measured 22-24 `wf-*` pairs against 301-302 `mf-*` pairs, consistently, across a dozen runs.
This is real, expected behaviour of this benchmark's own deliberately uncapped pacing at this record
count (0018 §1's coalescing tolerance, exercised for real), not a bug: every individual sample is a
genuine, uncoalesced measurement, just fewer of them on the worker side. `workerMs.length > 0` is the
only assertion made on the count; `profile-frame`'s own SKILL.md documents the asymmetry so a future
reader does not mistake a low worker frame count for a broken park/resume sequence. Left as-is rather
than inflating the main-frame target to force more worker samples (considered, rejected: the brief's
own "300 frames after 120 warm-up" is `bench.frame_worstcase`'s literal window size, and enlarging it
to chase a worker sample count would be a unilateral reinterpretation of that number).

### `bench.frame_worstcase`: measured (this session, Tyler's Mac)

Five consecutive clean runs, `pnpm exec playwright test --config packages/engine/playwright.config.ts
--project frame-bench` (quiet, load average ~2.9-3.1 at measurement time): main p50 0.618-0.660 ms,
worker p50 2.131-2.302 ms -- every run comfortably under both 0018 §9's desktop proxy (main <=
1.3 ms, worker <= 2.7 ms) and the checked-in baseline's 25% tolerance. **Both failure paths verified
by injection, then reverted** (binding rule): a temporary 0.4 ms busy-wait in `frame-bench.ts`'s
`onCamera` pushed main p50 to 1.020 ms -- under the 1.3 ms absolute budget but over the baseline's
0.802 ms tolerance line, failing exactly that assertion (`main p50 vs baseline 0.642ms: 1.020ms
exceeds 0.802ms`); a temporary 1.0 ms busy-wait inside the CDP-injected worker wrapper pushed worker
p50 to 3.209 ms, over the absolute 2.7 ms budget, failing that assertion instead. Both reverted
(`git diff` empty on `frame-bench.ts`/`frame-bench.spec.ts` before the next commit); five more clean
runs confirmed the revert. `baselines/frame.json` was written from one representative clean run
(records=65,536, frames main=302/worker=23, main p50/p95 0.642/0.699 ms, worker p50/p95 2.241/
2.492 ms) with the machine, flags and load average recorded in its own `conditions` field.

### `profile-frame`: run in this session

`node packages/engine/scripts/profile-frame.mjs` (no args), twice, after `pnpm format`. Table from
the second run:

```
bench.frame_worstcase profile: records=65536 frames main=302 worker=22 warmup=120
  main   p50=0.666ms p95=0.714ms  budget<=1.3ms  baseline.p50=0.642ms (+25%=0.802ms)
    top self-time (300.46ms sampled):
      150.322ms  writeBuffer@:0
      71.763ms  mark@:0
      69.243ms  (program)@:0
      6.692ms  (idle)@:0
      0.496ms  requestAnimationFrame@:0
  worker p50=2.595ms p95=2.782ms  budget<=2.7ms  baseline.p50=2.241ms (+25%=2.801ms)
    top self-time (250.75ms sampled):
      150.960ms  copyBytes@worker-auto-ZcU9N8lO.js:191
      25.525ms  publish@worker-auto-ZcU9N8lO.js:550
      19.331ms  _ZN4core5slice20copy_from_slice_impl17hcd56f5bb7b2e5ee3E@game.wasm:1
      13.764ms  (program)@:0
      9.377ms  mark@:0
```

`writeBuffer`/`copyBytes` dominating both sides matches M17's own Planning decisions ("the shares of
0018 §9 ... are dominated by the 2 MiB `writeBuffer`, `extract` and the sort, which first exist at
full size in M17"). `mark@:0`'s own ~9-23% share on each side is this tool's own instrumentation
overhead (`performance.mark` calls), named as such in the SKILL.md so it is not mistaken for a real
cost.

### `device.html?harness=1`: a Run button was needed, not just a page mode

The brief's own Planning decisions text describes the probes to print but not a UI; `docs/plan/
device-checks.md`'s own M17b section (pre-existing, unedited by this cut) already said "record,
press 'run' on the page, stop after it prints" -- read literally, this requires a clickable control
so Tyler's own DevTools recording brackets only the measured 120+600 steps, not page/asset/WASM
setup. Added a `<button id="harness-run">Run</button>`; setup (device/client/renderer/population)
runs immediately and `window.__pageReady` fires once the button appears (the existing "`__pageReady`
marks setup done" convention, `packages/engine/CLAUDE.md`'s "Adding a browser spec" -- decoupled from
"the harness run finished", which only matters to a human waiting on the button). **Found by this
step's own Chromium verification, not by inspection**: the button existed and was visible but every
`page.click()` failed ("`<canvas>` intercepts pointer events") until given `position: fixed` --
`device.html`'s own canvas covers the whole viewport with `position: fixed`, and CSS paints
positioned elements after non-positioned in-flow ones regardless of DOM order, so a plain in-flow
button always renders *under* it. Fixed with inline `position:fixed;z-index:1000` on the button.
Verified end to end in Chromium (`playwright-core`'s `chromium.launch`, a throwaway Node script, not
committed): navigate, wait for `__pageReady`, click `#harness-run`, wait for the HUD text to contain
"harness=1 result", read it back --

```
device.html?harness=1: starting…
setup complete -- press Run to start the 120 warm-up + 600 measured frames.
warm-up: 120 frames…
measured: 600 frames…

harness=1 result (stop your DevTools recording now):
  uncapturederror: none
  GPUTexture-as-view probe: true
  writeTexture from SAB view: accepted
  writeBuffer from SAB view (drawablesRenderer.acquire, 720 calls): accepted (no uncapturederror)
  memory.buffer.byteLength per instance:
    client: 51707904
    sim: 102039552
    gen0: 5570560
```

Every probe's own Chromium result is recorded here only as proof the mechanism works end to end
(the page loads, the button is reachable, every field prints); the actual Safari/Firefox pass/fail
(`M17b-harness-desktop-safari`/`-firefox` in `docs/plan/device-checks.md`) is Tyler's own manual run,
not performed by this session. `docs/plan/device-checks.md`'s M17b section needed no edit: its
existing wording already matched what was built once the Run button existed.

### Verified (commands and results, steps 4-6)

- `pnpm test browser -t sprite` -> `browser pass 6 tests` (unchanged from steps 1-3/fix round 1).
  `pnpm test browser -t drawables` -> `browser pass 9 tests` (unchanged).
- `pnpm test wasm -t drawlist` -> `wasm pass 2 tests` (unaffected by `Action::SpawnMany`).
- `cargo nextest run -p fx-drawables` -> 7/7 pass, golden unchanged (`07e82d2cb76fe412`).
  `cargo clippy -p fx-drawables --all-targets -- -D warnings` -> clean.
- `pnpm exec tsc --noEmit -p packages/engine/tests/browser/pages/tsconfig.json` and `-p packages/
  engine/tests/tsconfig.json` -> both clean at every step's own final state.
- `playwright test --config packages/engine/playwright.config.ts --project chromium --grep
  "canvas|frame-loop"` -> 3/3 pass (device.html's own automated coverage, unaffected by the
  `harness=1` addition or the new `runHarness`/`clientTestHandle`/`asHarness` imports).
- `pnpm bench:frame` -> full rebuild + `bench.frame_worstcase` green, numbers as above.
- `node packages/engine/scripts/profile-frame.mjs` -> ran clean, table as above, `test-results/
  profile-frame/trace.json` written.
- `pnpm format` (`biome check --write` + `cargo fmt`) run before every commit; clean (no fixes
  needed) at the final state of each.
- `pnpm test`/`pnpm test:slow`/`pnpm lint` (the full runs) were not run (delegation prompt: "I am
  the gate").

### Not verified in this range

`M17b-harness-desktop-safari`/`-firefox` (`docs/plan/device-checks.md`): Tyler's own manual run, on
real hardware, not this session's to perform. The full `pnpm test:slow` (which would exercise the
`frame-bench` leg through `scripts/suites.mjs` exactly as `pnpm bench:frame` does standalone) was not
run, per the delegation prompt.

### Fix round 1 (coordinator review): the record-count check was tautological

`frame-bench.spec.ts`'s own `setup.recordCount === 65_536` compared `window.__frameBench.recordCount`
-- a page-side `GRID_SIDE * GRID_SIDE` *constant* (`frame-bench.ts`) -- against the same literal
constant restated in the spec. It could not fail: it said nothing about what `extract()`/`visible()`
actually produced, published or drew.

**Fixed**: `DrawablesRenderer` already has a real `recordCount()`/`drawListDropped()` (M17, reading
the last-`acquire()`d slot's own header fields); `window.__frameBench.recordCount()`/`.dropped()`
now call through to those instead of exposing a constant. `bench.frame_worstcase` reads both twice --
once after warm-up (at least one real published frame exists), once more at the end of the timed
window -- asserting `recordCount === 65_536` and `dropped === 0` each time.

**The coordinator's own hypothesis for *why* it would under-count (viewport aspect ratio deriving
`half_extent_tiles` from `tilesAcross`, leaving ~38k of 65,536 records visible) does not apply to
this scene**: `frame-bench.ts` never calls `client.camera.tick()` (the only place `camera/
transform.ts`'s own `halfExtentTiles()` -- the viewport-aspect-ratio formula -- runs); it sets
`cameraState.halfExtentTilesX/Y = 130` directly, a fixed square independent of the canvas's own
pixel viewport, and `writeCameraBlock` writes `state.halfExtentTilesX/Y` into `CameraBlock.half_
extent_tiles` verbatim (`camera/block.ts`, no recompute); `FrameView::visible()`'s own `visible_tile_
rect` reads `camera.half_extent_tiles` directly (`game_instance.rs`), not `tiles_across`. **The
finding, run before any other change, with the old tautological check simply removed and the real
one added in its place**: `recordCount() === 65536` on the very first run -- the workload was
already the true worst case; the old check was vacuous, not wrong-and-hiding-a-shortfall.
**Verified the new check is not itself vacuous, by injection**: temporarily set `halfExtentTilesX/Y
= 70` (too small) -- the real check failed with `Expected: 65536, Received: 21025` (145² tiles, the
smaller square that setting actually clips to), exactly the kind of shortfall the coordinator's own
concern was about, caught for real this time. Reverted (`git diff` empty on `frame-bench.ts` before
the next commit); five more clean runs after reverting all read `records=65536` and pass.

**Item 2 (the brief's "make the worst case real") needed no geometry change**, per the finding above
-- already real. **Item 5** (`device.html?harness=1`): checked; its own printed output never claims a
record count (`POPULATE_COUNT = 300` is that page's own deliberately modest population, printed
nowhere -- that check is about SAB/GPUTexture probes and allocation growth, not a worst-case record
count, Planning decisions "Manual harness shape"), so no fix applied there.

**Re-measured, baseline replaced**: five consecutive clean runs under the corrected test (`records=
65536` every time), main p50 0.619-0.646 ms, worker p50 2.121-2.237 ms -- statistically the same
numbers as before this fix round (expected, since the workload did not change) but now backed by a
real assertion instead of a vacuous one. `baselines/frame.json` rewritten with the median of the five
runs' own medians (main p50/p95 0.637/0.691 ms, worker p50/p95 2.152/2.344 ms) and a `conditions`
field recording the fix and the injection proof.

### Fix round 2 (coordinator review, four items)

**Item 1: isolation.** `bench.frame_worstcase` failed on the coordinator's own gate inside `pnpm
test:slow` (worker p50 2.775ms against the 2.7ms budget, 1-minute load 28 at that moment) --
structural, not a real regression: `frame-bench`'s own leg of the `browser` suite ran *concurrently*
with that suite's own other legs (`runSuite`'s `Promise.all`), including the slow tier's zero-GC
`burst` negative controls, which exist to burn CPU. **Fixed**: `frame-bench` moved out of `browser`'s
`legs` into its own top-level entry in `scripts/suites.mjs`, `solo: true`. `scripts/test.mjs`'s Phase
2 now splits `selected` into `concurrent`/`solo`, runs `concurrent` via the existing `Promise.all`,
then runs every `solo` suite one at a time, afterward -- `frame-bench` (`suites.mjs`'s own
registration order keeps it last) now starts only once every other slow-tier suite's own process,
Playwright included, has fully exited. Budget/tolerance/record count/frame counts/flags: unchanged.

**Item 2: shown.** `pnpm test:slow`, full, twice, foreground (`uptime` before each):

```
11:36  up 6 days, 15:25, 5 users, load averages: 3.44 3.98 4.61
$ pnpm test:slow
rust        pass 0 tests    0.2s
unit        pass 2 tests    1.4s
wasm        pass 3 tests    13s
browser     pass 44 tests   24s
frame-bench pass 1 tests    5.1s
```
```
bench.frame_worstcase: records=65536 frames=304/23 warmup=120 swiftshader=false
  main   p50=0.637ms p95=0.683ms budget<=1.3ms baseline.p50=0.637ms (+/-25%)
  worker p50=2.158ms p95=2.573ms budget<=2.7ms baseline.p50=2.152ms (+/-25%)
```

```
11:38  up 6 days, 15:27, 5 users, load averages: 7.91 5.21 5.02
$ pnpm test:slow
rust        pass 0 tests    0.3s
unit        pass 2 tests    1.3s
wasm        pass 3 tests    13s
browser     pass 44 tests   23s
frame-bench pass 1 tests    5.1s
```
```
bench.frame_worstcase: records=65536 frames=304/23 warmup=120 swiftshader=false
  main   p50=0.644ms p95=0.687ms budget<=1.3ms baseline.p50=0.637ms (+/-25%)
  worker p50=2.168ms p95=2.268ms budget<=2.7ms baseline.p50=2.152ms (+/-25%)
```

Both runs' own `frame-bench` line prints *after* `browser`'s own line finishes (5s wall each, not
overlapping it) -- confirming isolation, not merely a clean result. The benchmark's own printed
tables are read from `test-results/frame-bench/output.log` (`scripts/test.mjs`'s quiet-on-pass
contract writes a passing suite's own stdout there, not to the terminal).

**Item 3: sample-size floor.** `expect(workerMs.length).toBeGreaterThan(0)` let a single sample stand
in for the whole worker p50/p95. Replaced with `WORKER_SAMPLE_FLOOR = 12`, reasoned from this
session's own repeated measurement at this exact scene (20-24 `wf-*` pairs per window, every run
across both fix rounds, on real hardware -- never below 20; 12 leaves headroom for real jitter
without accepting a starved worker). **Verified by injection**: a temporary 20ms busy-wait inside the
CDP-injected `call1` wrapper dropped the count to 7, failing exactly this assertion (`Expected: >=
12, Received: 7`); reverted, re-confirmed clean (23 samples, pass). **Found while doing item 5**: the
same floor, unconditional, also failed under `CI=true ENGINE_GPU=swiftshader` (2 samples -- a real,
expected effect of SwiftShader's own far higher per-call cost at 65,536 records, not a starvation
bug: the earlier `recordCount`/`dropped` checks, which run before this one and are hardware-
independent, had already passed in that same run). Gated the sample-floor check behind `isSwiftShader`
the same way the budget/baseline checks already are (warn, not fail) -- re-verified: `CI=true
ENGINE_GPU=swiftshader` now prints `warn: client worker frame() marks captured: 1 below floor 12
(0020 §10: ...)` and the test passes; the real-hardware injection above still fails hard afterward
(re-run to confirm the gating didn't quietly defang it).

**Item 4: `counters.gpu_bytes_within_budget`'s own nit.** `gpuBytes > 0` was satisfied by the page
texture (terrain's own fixed 4 MiB) alone, regardless of whether `setSpriteAtlas` ever ran.
`DrawablesRenderer.gpuBytes` gained an exported `DRAW_FRAME_UNIFORM_BYTES` (was private);
`gc-drawables.ts` gained `window.__drawablesTest.terrainGpuBytes()` (`renderer.gpuBytes()` alone, the
same object `gpuBytes()`'s own total already adds it to, but read independently). The spec now
recomputes the expected drawables-side total from exported constants alone (`CAPACITY`/`DRAW_BYTES`/
`DRAW_FRAME_UNIFORM_BYTES`, `render/drawables.ts`; `SPRITE_TABLE_BYTES`, `render/atlas.ts`) plus the
fixture atlas's own known, documented pixel dimensions (`scripts/gen-sprite-art.mjs`'s `WIDTH = 96`/
`HEIGHT = 64`, mip 1 halved to 48x32 by `render/atlas.ts`'s own `mip1W`/`mip1H` formula) -- entirely
independent of `DrawablesRenderer.gpuBytes()`'s own internal arithmetic -- and asserts `gpuBytes() -
terrainGpuBytes() === EXPECTED_DRAWABLES_GPU_BYTES` (computed: 2,258,992 B, which matches this
milestone's own earlier "drawables' own share only" measurement in steps 1-3's Deviations exactly,
an independent cross-check that the recomputation is right). `pnpm test browser -t gpu_bytes` -> 1
test pass at this exact value.

**Item 5: CI treatment, confirmed and cited.** Ran `CI=true ENGINE_GPU=swiftshader pnpm exec
playwright test --config packages/engine/playwright.config.ts --project frame-bench` directly: every
budget/baseline/sample-floor check that would otherwise fail prints a `warn:` line instead and the
test still passes overall (`records=65536` -- the correctness checks are unaffected, as they should
be). Code path: `frame-bench.spec.ts`'s `const isSwiftShader = process.env.ENGINE_GPU ===
'swiftshader'`, read by `assertOrWarn` (main/worker vs the 0018 §9 budget and the `baselines/
frame.json` tolerance) and, after this fix round, by the `WORKER_SAMPLE_FLOOR` check too -- matching
0020 §10 ("Real-GPU rendering and timing runs happen only on Tyler's Mac") and the exact same
convention `tests/wasm/worldgen-bench.test.ts` already uses for its own machine-dependent number.

**`packages/engine/CLAUDE.md`**: one sentence in the `pnpm bench:frame` row updated to name the new
`frame-bench` suite/`solo: true` instead of the old "browser suite leg" shape; line count unchanged
(60, the coordinator's own prior fix in `384cff6` already brought it to the cap).

### Verified (commands and results, Fix round 2)

- `pnpm test:slow`, full, twice, foreground -- both green, numbers and `uptime` above.
- `pnpm test browser -t gpu_bytes` -> `browser pass 1 tests`. `pnpm test browser -t drawables` ->
  `browser pass 9 tests` (unchanged count).
- `node scripts/test.mjs frame-bench --tier slow` (targeted) -> `frame-bench pass 1 tests`.
- `pnpm exec tsc --noEmit` on `tsconfig.json`, `tests/tsconfig.json` and `tests/browser/pages/
  tsconfig.json` -> all clean.
- `pnpm format` -> no fixes needed at the final state.
- Every injection in this fix round (item 1's isolation is structural, not provable by a single
  injected value; items 3 and the SwiftShader gate were each proven failing, then reverted, as
  recorded above).
