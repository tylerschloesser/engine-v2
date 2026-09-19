# M17b: Sprite atlas, frame-time budget, `profile-frame`

Status: not started · After: 17 (09b for `mips.ts`) · Tyler-dependent: no

Split out of M17 during planning. M20 (reference game v0) needs it; M18 and M19 do not. Carries one manual desktop check (Safari and Firefox).

## Goal
The sprite half of the art contract works: `sprites.png` + `sprites.json` load into a padded atlas with two mip levels, and the uber-quad pipeline draws the sprite kind with pivot, size in tiles, frames and `FLIP_X`. The worst-case frame of 0018 §6 (65,536 records) is measured against the desktop proxy of 0018 §9 in the slow tier: this is the repo's first frame-time exit criterion, so the `profile-frame` skill is written here.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0018-renderer.md` (§3 "Art sampling" for sprites, §4 `sprites.png`, §9, Consequences: the Safari/Firefox deferral)
3. `docs/decisions/0020-testing-strategy.md` (§4 demotion rule, §9 performance and baselines)
4. `docs/plan/17-drawlist-and-sprites.md` (Seams, Planning decisions)

Mine from spikes: `spikes/zero-gc-webgpu/tests/harness.mjs` (CDP tracing session, reading trace events between `performance.mark`s: the frame profile uses the same session). Rules that apply: `.claude/rules/hot-paths.md`.

## Scope
- `render/atlas.ts`: fetch + validate `sprites.json`, upload `sprites.png` (`premultipliedAlpha: true`), mip level 1 via M09b's blit; the sprite table (rect, pivot + size per sprite id) as two small data textures (see Planning decisions).
- `uberquad.wgsl`: sprite kind (rect lookup by sprite id, frame index from `param` when `frames > 1`, pivot, `FLIP_X`, bilinear + fat-pixel as terrain, premultiplied blending).
- Rust: `DrawList::sprite` already exists (M17); add `SpriteId` constants helper for fixtures only.
- Slow-tier benchmark `bench.frame_worstcase`; baseline file; `.claude/skills/profile-frame/`.
- The manual Safari/Firefox harness page mode.

## Non-scope
Sprite animation clocks (a game passes the frame in `param`). Text. A second atlas (0018 Consequences). Reference-game art (M20). Frame time on the reference game's worst-case view and on phones (M36, M39).

## Files, packages and crates touched
`packages/engine` (`src/render/atlas.ts`, `src/render/drawables.ts`, `src/render/wgsl/uberquad.wgsl`, `scripts/profile-frame.mjs`, `tests/browser/`, `tests/browser/pages/device.html`), `packages/engine/fixtures/drawables/` (generated `sprites.png`), `.claude/skills/profile-frame/SKILL.md`, `scripts/suites.mjs` (slow-tier registration).

## Seams
**Provides**
- `ClientOptions.assets.sprites?: string` (URL of `sprites.json`).
- `sprites.json` schema v1: `{ "version": 1, "image": "sprites.png", "padding": 2, "sprites": { "<sprite id 0..4095>": { "rect": [x, y, w, h], "pivot": [px, py], "size": [w_tiles, h_tiles], "frames": 1 } } }`; frames are laid out left to right from `rect`; limits of 0018 §4 validated with the offending id in the message.
- `pnpm bench:frame` (slow tier member) and `packages/engine/baselines/frame.json`.
- `profile-frame` skill wrapping `scripts/profile-frame.mjs`.
- Device page mode `?harness=1` (below).

**Consumes** M17: `DrawList`, uber-quad pipeline, counters, GC page `drawables`. M01: `scripts/suites.mjs` slow tier. M09b: `mips.ts`. M09: `art.ts` patterns, `renderTo`/probes. M04: CDP harness. M36 later re-points the benchmark at the reference game.

## Planning decisions
- **Frame-time criterion lands here, not in M09.** Terrain alone puts almost nothing on the CPU; the shares of 0018 §9 (main rAF callback, client-worker `frame`) are dominated by the 2 MiB `writeBuffer`, `extract` and the sort, which first exist at full size in M17. `bench.frame_worstcase` renders the `drawables` fixture with 65,536 records at maximum zoom-out under real rAF (`--disable-frame-rate-limit --disable-gpu-vsync`, as the spike did), 300 frames after 120 warm-up, and takes medians from trace events between marks: the rAF callback task on `CrRendererMain`, and a `performance.measure` around `frame` on the client worker. It must meet 0018 §9's desktop proxy numbers and stay within 25 % of the checked-in baseline (0020 §9); it gates on Tyler's Mac only and records elsewhere.
- **`profile-frame` skill contents.** When to use it (a frame-time benchmark fails or a renderer/extract change is suspected); the one command (`node scripts/profile-frame.mjs [--fixture drawables] [--frames 300]`), which writes a trace JSON and prints one table: main callback p50/p95, worker `frame` p50/p95, top five self-time functions per thread, against the budget rows; how to read it; when to update the baseline. Written by the session after it has run the procedure once (0021 §4).
- **Sprite table in data textures, not uniforms.** 4,096 sprites × 32 bytes is 128 KiB, over the 16 KiB compatibility-mode binding limit (0018 §7). Decision: a 64 × 64 `rgba32float` data texture pair read with `textureLoad` instead of a uniform array (one texture for rect, one for pivot + size). It keeps one bind group, needs no storage buffers, and `rgba32float` is loadable (not filterable) in compatibility mode.
- **Manual harness shape for Safari and Firefox** (0018 deferral; the CDP instrument is Chromium-only). `?harness=1` on `device.html` steps 120 + 600 frames of the `drawables` page's script with the real renderer, then prints: any `uncapturederror`, the result of the `GPUTexture`-as-view probe, whether `writeBuffer` and `writeTexture` accepted SAB-backed views (or the staged-copy path engaged), and `memory.buffer.byteLength` per instance. Tyler records allocations with the browser's own tool around the 600-frame run.

## Order of work
1. Fixture sprite sheet script + manifest validation. 2. Atlas upload, mips, data textures. 3. Sprite kind in the shader with probes. 4. Benchmark + baseline. 5. Run the profile once by hand; write the skill. 6. `?harness=1`.

## Tests added
- `unit` suite: `sprites.schema_errors`.
- Browser readback (Chromium): `sprite.pivot_and_size_probe`, `sprite.flip_x`, `sprite.frames_by_param`, `sprite.no_bleed_at_mip1` (neighbouring atlas cell of a contrasting colour never appears; relies on the 2 px extrusion), `sprite.layering_with_shapes`.
- Rust native: `wgsl.uberquad_validates` still green.
- Zero-GC: page `drawables` with sprites present (number unchanged).
- Slow tier: `bench.frame_worstcase`.

## Exit criteria
- [ ] All fast tests above pass by name.
- [ ] `pnpm bench:frame` meets the desktop proxy of 0018 §9 on Tyler's Mac and `baselines/frame.json` is checked in.
- [ ] `.claude/skills/profile-frame/SKILL.md` exists and its command was run in this session.
- [ ] The manual item below is written into `docs/plan/device-checks.md`.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t sprite` · `pnpm test browser -t drawables` · `pnpm bench:frame` · `node packages/engine/scripts/profile-frame.mjs` · `pnpm test` · `pnpm lint`.

## Budgets
- Frame time, desktop proxy (PRE-PLAN §7 row 1, 0018 §9): `bench.frame_worstcase`.
- Allocation per isolate: unchanged from M17.
- Memory, GPU: atlas + instance buffer as 0018 Consequences; the data textures add 128 KiB.

## Context artifacts
Creates the `profile-frame` skill (0021 §4; PLAN.md listed it under M17 before the split). `packages/engine/CLAUDE.md`: `pnpm bench:frame`, baseline update rule.

## Manual device checks
`docs/plan/device-checks.md`, item **M17b-harness-desktop** (Tyler's Mac, Safari current and Firefox current):
1. `pnpm device:serve`, open `http://127.0.0.1:4173/device.html?harness=1` (loopback is a secure context; no tunnel needed). In Safari: Web Inspector → Timelines → JavaScript Allocations, record, press "run" on the page, stop after it prints. In Firefox: Profiler with "JS Allocations" enabled, same steps.
2. **Pass:** the page prints no GPU errors and unchanged memory sizes; the allocation timeline over the 600 frames shows no growth beyond roughly the main-thread budget × 600 (≈ 70 KB) and no GC pause markers.
3. **Fail →** validation error on a SAB-backed upload: make the staged-copy path (M09) the default for that browser. Visible periodic GC: capture the allocation call tree, open a plan edit naming the site. Probe differences are recorded only (0016's budget is by formula).

## Deviations
(filled in during Phase 3)
