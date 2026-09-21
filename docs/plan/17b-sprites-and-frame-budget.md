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
(filled in during Phase 3)
