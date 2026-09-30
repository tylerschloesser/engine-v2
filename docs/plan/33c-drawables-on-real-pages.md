# M33c: Drawables on real pages

Status: not started · After: 33 · Tyler-dependent: no

Written by the orchestrator at M33's gate (2026-09-30). M33's implementer found that no production page draws a drawable. `engine/render` (`packages/engine/src/render.ts`) exports terrain, art, device and upload, but not `createDrawablesRenderer`, `attachDrawables` or `loadSpriteAtlas`. The only way to reach a client's `DrawListSlot` is `clientTestHandle(client).drawListSlot`, which is test-only. The engine's own pages (`tests/browser/pages/src/gc-drawables.ts`, `drawables.ts`) wire drawables from `src/` directly. So the reference game has drawn terrain only since M20b. Its player circle (M20b), ghost and furnace (M33) exist in the DrawList and are asserted there, but never reach a pixel. M17b's Provides already names the intended seam, `ClientOptions.assets.sprites?: string`; this milestone carries it through to a production page.

## Goal
A game page built only from the public `engine` entry points draws its DrawList: the reference game shows the player circle and range ring, a placed furnace, and the construction ghost. A pixel readback on the reference page proves each one, and the reference page's zero-GC test runs with drawables attached.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0018-renderer.md` (Decision: the drawables pass, the sprite atlas, frame ordering)
3. `docs/plan/17b-sprites-and-frame-budget.md` (Provides: `ClientOptions.assets.sprites`, `sprites.json` schema; Deviations)
4. `docs/plan/33-reference-furnace.md` (Deviations: sprite atlas entry, `PREDICTED` handling, the R1 ruling)
Mine: `packages/engine/tests/browser/pages/src/gc-drawables.ts` (the production-topology wiring to copy from). Rules that apply: `.claude/rules/hot-paths.md`.

## Scope
1. **Public seam.** One public way for a page to draw its client's DrawList through the terrain renderer's pass. Preferred: an `engine/render` helper that takes the client, the device and the terrain renderer. It builds the drawables renderer from the client's DrawList slot, loads the atlas named by `ClientOptions.assets.sprites` when present, and attaches it. The slot may go on the public `Client` as a read-only field, or stay internal behind the helper; choose one and record why. Export whatever types the helper's signature needs. `clientTestHandle` keeps its field for tests.
2. **Reference game.** `games/reference/src/game.ts` passes `assets.sprites` and calls the helper. Nothing in `games/reference` imports from `packages/engine/src`.
3. **Pixel proof on the reference page** (a browser test, stepped, under 3 s): readback at the own player's circle centre differs from terrain there, and so does readback inside a placed furnace's footprint. With construction mode on, the ghost's pixels change tint across a shoreline tile. Use `engine/test`'s readback helpers.
4. **Zero-GC.** The reference page's `reference clean` zero-GC test (M20b/M33) runs with drawables attached. If its budget in `budgets.json` would need to change, stop and report.
5. **M33's carried criterion.** `playwright-cli` on `pnpm --filter reference dev`: the ghost tracks the pointer and changes tint crossing a shoreline. Paste a screenshot path and the commands.

## Non-scope
New drawable kinds, art changes, the furnace panel (M33b), the device page (`?harness=1`), frame-bench re-pointing (M36).

## Files, packages and crates touched
`packages/engine` (`src/render.ts`, `src/render/` plus a new helper file if needed, `src/client.ts` only if the slot goes public, tests) and `games/reference` (`src/game.ts`, `tests/browser/`). No Rust change is expected; if one is needed, report first.

## Seams
**Provides:** the public helper (name it; later briefs M33b, M34 and M36 consume it) and its exported types. `ClientOptions.assets.sprites` honoured on production pages.
**Consumes:** `createDrawablesRenderer`, `attachDrawables`, `loadSpriteAtlas`, `DrawListSlot` (M17, M17b); `sprites.json` and the furnace atlas entry (M33); `engine/test` readback (M09).

## Tests added
Browser: `reference_draws_player_furnace_and_ghost` (Scope 3). If the helper has branches (no `sprites` asset, say), one engine browser test on the atlas-less path.

## Exit criteria
- [ ] The reference page draws through public entry points only (`git grep "engine/src\|packages/engine/src" games/reference` is empty).
- [ ] `reference_draws_player_furnace_and_ghost` passes, and fails with `attachDrawables` removed from the helper (both lines pasted).
- [ ] `reference clean` zero-GC passes with drawables attached, no budget changed.
- [ ] M33's carried criterion is verified with `playwright-cli` (the ghost tracks the pointer, tint changes at a shoreline), with evidence in Deviations.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t reference_draws` · `pnpm test browser -t reference` · `pnpm --filter reference dev` with `playwright-cli`.

## Budgets
`browser` suite: 37 s of 48 s quiet at M33; the new test is under 3 s. Zero-GC per the `reference clean` row.

## Context artifacts
`packages/engine/CLAUDE.md` or `games/reference/CLAUDE.md`: one line on how a game page draws its DrawList (the helper), whichever is the map a game author reads.

## Manual device checks
None new. The M34 and M39 device checks already expect visible circles.

## Deviations
- **Seam (Provides).** `attachClientDrawables(client: Client, device: RendererDevice, renderer: TerrainRenderer, opts: { colorFormat: GPUTextureFormat }): Promise<AttachedDrawables>` and type `AttachedDrawables = { drawables: DrawablesRenderer; spriteAtlasLoaded: boolean; setEnabled(on: boolean): void }`, both exported from `engine/render` (`packages/engine/src/render/client-drawables.ts`). It builds the renderer over `client.drawListSlot`, loads `client.assets.sprites` when set (atlas-less path: skipped, `spriteAtlasLoaded` false), calls `attachDrawables`, and per frame, inside the terrain pass callback, runs `drawables.acquire()` plus the DrawFrame uniform write. The page still runs `client.pick.acquire()` first (`createRealFrameLoop` does).
- **Slot public.** `Client` gained read-only `drawListSlot: DrawListSlot` and `assets: ClientOptions['assets']` (chosen over internal-only: an internal slot would make `engine/render` import `client.ts` and the loader, against 0018 section 1). `clientTestHandle.drawListSlot` stays. Two fakes (`frame-loop.test.ts`, `upload.test.ts`) got the new required fields added; no assertion changed.
- **Uniform without allocation.** Writing the drawables uniform from `renderer.frameUniform` doubles added 24 B/frame (a second `writeFrameUniform@game`, 14400 B over 600 frames) and `reference clean` failed: `main` 250.35 B/frame against 234. Fixed without touching `budgets.json`: `TerrainRenderer.stagedFrameUniform` (read-only bytes of its last write) and `DrawablesRenderer.bindTerrainFrame` / `writeFrameUniformFromTerrain(windowOriginX, windowOriginY, cursorTileX, cursorTileY, cursorValid)` copy the camera fields as raw bytes. `reference clean` now passes at the existing 234.
- **`engine/test`** now also exports `readPixels` (already implemented; the brief asked for its readback helpers). `renderTo` is not usable here: it makes an `rgba8unorm` target and the reference renderer's pipeline uses the canvas format (`bgra8unorm` on this machine), so `__pixelAt` builds the target itself and passes it to `readPixels`.
- **Game and pages.** `game.ts` passes `assets.sprites: '/sprites.json'` and returns `drawables` from `startGame`; `gc-entry.ts` adds `client.pick.acquire()` to `drive` (so the gc page draws drawables); `test-entry.ts` adds `__pixelAt(x, y)` (centre pixel of a 32 px frame, pass on vs off). Five comments naming `packages/engine/src/...` in `games/reference` were reworded so the exit-criterion `git grep` is empty.
- **Defect found, not fixed (decision needed).** The reference game's colour constants use 0xRRGGBBAA but `Draw::color` is r = low byte (`packDrawColor`). `GHOST_VALID = 0x40ff_4090` draws r=0x90,g=0x40,b=0xff,a=0x40 (a faint violet/grey, measured on the page: on-minus-off = -9,-16,+14 over sand), `GHOST_INVALID` draws dark red at full alpha (r=0x90,g=0x40,b=0x40,a=0xff), and `GHOST_UNKNOWN`, `FURNACE_TINT_PREDICTED = 0xffff_ff99` (cyan, opaque) are wrong the same way; the circle and ring colours in `sim/src/client.rs` should be checked. Fixing changes `sim/tests/ghost.rs` (lines 163, 172) and `tests/helpers/game.ts` `GHOST`, so I stopped. `reference_draws_player_furnace_and_ghost` therefore asserts the valid and invalid tints differ, not their hue.
- **Pixel test.** `reference_draws_player_furnace_and_ghost` (`games/reference/tests/browser/draws.spec.ts`), 2.8 s. Thresholds: opaque draws > 40 summed RGB difference, the translucent ghost > 15. Fails with `attachDrawables` commented out of the helper: `Error: player circle pixel differs from terrain ... Expected: > 40 Received: 0`. Passes under `ENGINE_GPU=swiftshader` (4.2 s), as does `reference clean` (adapter `swiftshader`).
- **playwright-cli (Scope 5).** `pnpm --filter reference dev --port 5199 --strictPort`; `playwright-cli open http://localhost:5199/ --browser=chrome`; five clicks on the lower Collect button (3 s apart) gave Stone 5; `click "[data-craft-recipe='0']"` gave Furnace 1; `click .build-button`; `mousemove 640 480 / 760 500 / 860 560 / 300 250` with a `screenshot` after each. Screenshots (not committed) in `/private/tmp/claude-501/-Users-tyler-repos-engine-v2/0e638fa8-a827-4ce7-925d-9240622b589c/scratchpad/`: `m33c-start.png` (circle and ring drawn), `m33c-ghost-land.png`, `m33c-ghost-shore.png`, `m33c-ghost-water.png` (2x2 ghost follows the pointer, strong tint over water), `m33c-ghost-valid-land.png` (faint tint over land). Tint changes between land and water; the hue is the byte-order defect above.
- **Notes for M33b, M34, M36.** A second consumer of the camera uniform must go through `stagedFrameUniform`, not the double fields, if it is inside a zero-GC window.

### Gate (orchestrator) and ruling R1: colour byte order
- `pnpm gate d607468`: tree clean, 15 files, no goldens, `budgets.json` unchanged, +329/-11.
- **R1.** `Draw::color` is byte 0 = r, byte 3 = a (`packDrawColor`, M17 Deviations). All seven reference constants in `sim/src/client.rs` are written `0xRRGGBBAA`, so every one renders wrong: `PLAYER_COLOR` `0x40c0_40ff` is a 25 %-alpha violet, not an opaque green. Fix at the source of the mistake: add a Rust `pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> u32` beside `Draw` in the engine crate (the Rust twin of `packDrawColor`, with a doc line naming the byte order), rewrite the seven constants through it with their intended hues, and add one engine native test pinning `rgba(1,2,3,4) == 0x0403_0201`. The existing tests that pin these constants' numeric values (`sim/tests/ghost.rs` around 163/172, `GHOST` in `tests/helpers/game.ts`) may be updated to the new values. That changes an expected constant, not a behaviour. `extract_hash_*` goldens that move only because of the colour bytes may be regenerated, each listed with old and new hash. Tighten `reference_draws_player_furnace_and_ghost` to assert hue, not just difference: circle pixel green > red, valid ghost green > red, invalid ghost red > green. It must fail with the old constants: paste the line.
- **R1 done.** `engine::client::rgba(r, g, b, a) -> u32` (`const fn`, in `client/drawlist.rs`, re-exported from `engine::client`) plus native test `rgba_packs_byte0_as_red` (`rgba(1,2,3,4) == 0x0403_0201`). All seven constants in `sim/src/client.rs` now go through it with the intended hues: player `(40,c0,40,ff)`, ring `(40,c0,40,60)`, furnace white, ghost valid `(40,ff,40,90)`, invalid `(ff,40,40,90)`, unknown `(c0,c0,c0,90)`, predicted furnace `(ff,ff,ff,99)`. Pinned values updated: `ghost.rs` colours `[0x40ff_4090, 0xff40_4090, 0xc0c0_c090]` -> `[0x9040_ff40, 0x9040_40ff, 0x90c0_c0c0]` and the edge-water `0x40ff_4090` -> `0x9040_ff40`; `place_predict.rs` predicted tint `0xffff_ff99` -> `0x99ff_ffff`; `GHOST` in `tests/helpers/game.ts` `{ valid 0x40ff4090, invalid 0xff404090, unknown 0xc0c0c090 }` -> `{ 0x9040ff40, 0x904040ff, 0x90c0c0c0 }`. Goldens regenerated (`pnpm golden:bytes`, only these two moved): `extract_hash_player_circle` `58c2d6cad9192e34` -> `3ef62f1c7615b34e`; `extract_hash_ghost_and_furnace` `013ed85fc4dd7355` -> `54f2542f20240d45`.
- **Hue assertions.** `reference_draws_player_furnace_and_ghost` now asserts circle green change > red change, valid ghost green > red, invalid ghost red > green. Under the old constants it fails with `Error: player circle is green: green moves more than red ... Expected: > 7 Received: -19`. Passing with the new ones (`browser pass 1 tests 2.9s/48s`) and under `ENGINE_GPU=swiftshader` (`browser pass 1 tests 2.8s/48s`). The earlier "Defect found, not fixed" bullet is resolved by this.
