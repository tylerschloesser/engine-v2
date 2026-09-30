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
(filled in during Phase 3)
