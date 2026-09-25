# 0034: Provisional `./render` exports subpath

Status: Accepted (2026-09-24). Amends [0017](0017-packaging-and-build.md) §2 (exports map). Implemented by M20 (`docs/plan/20-reference-game-v0.md`).

## Context

[0017](0017-packaging-and-build.md) §2 fixes the exports map as `.`, `./worker`, `./server`, `./server/node`, `./server/bun`, `./server/deno`, `./vite`, `./virtual`, `./test`, `./package.json`, closed except for the Durable Object adapter it names as a future addition. It has no subpath for rendering, because until M20 nothing outside `packages/engine` needed one: [0018](0018-renderer.md) §1 ("rendering never touches a WASM instance") and `createClient`'s own doc comments on `ClientOptions.render`/`assets` (`packages/engine/src/client.ts`) record that `createClient` deliberately does not read `RenderOptions` or `assets` itself — the caller assembles the render loop and hands the pieces to both `createClient` and the renderer. Every internal test/device page already did this assembly through relative imports into `packages/engine/src/*` (`tests/browser/pages/src/device.ts`, `slice.ts`).

M20 (`docs/plan/20-reference-game-v0.md`) is the first milestone to build that assembly from *outside* `packages/engine`: `games/reference` is a `workspace:*` consumer of the built package (0017 §1/§8), so it cannot reach `src/*` by relative import. Its dev page (real terrain, pan and zoom) needs `createRealFrameLoop`, `attachVisibilityHandling`, `initDevice`, `createTerrainRenderer`, `loadTileArt`, `systemClock`/`systemScheduler`, and `installPageStyles` — all previously unreachable from outside the package. `packages/engine/CLAUDE.md`'s own rule ("Add an exports subpath only together with the file that backs it") anticipates exactly this case. M20 added one new file, `packages/engine/src/render.ts`, re-exporting those names and their supporting types, and one new `"./render"` entry in `package.json`'s `exports` map, pointing at `dist/render.d.ts`/`dist/render.js` — done unilaterally there because the alternative blocked M20's Goal outright, and the addition is purely additive and matches the package's own stated extension process (`docs/plan/20-reference-game-v0.md` Deviations).

No existing test asserts a closed or fixed exports map: the tarball-install test of 0017 §8 does not exist yet. M35 (`docs/plan/35-packaging-and-adapters.md`, "Exports map freeze") is the milestone that does: it fixes `packages/engine/package.json` against "0017 §2 plus any subpath a later ADR added" and builds the `unit` test that checks it. This ADR is what M35 needs to find.

## Decision

**1. `./render` is added to the exports map, provisionally.** `package.json`'s `exports` gains:

```jsonc
"./render": { "types": "./dist/render.d.ts", "default": "./dist/render.js" }
```

backed by `packages/engine/src/render.ts`, re-exporting exactly the eight names/types M20 needed: `systemClock`, `systemScheduler` (and `Clock`/`Scheduler` types) from `clock.ts`; `createRealFrameLoop`, `attachVisibilityHandling`, `FRAME_PHASES` (and `FramePhase`/`RealFrameLoop`/`RealFrameLoopOptions` types) from `frame-loop.ts`; `installPageStyles` from `input/page-css.ts`; `loadTileArt`, `ManifestError` (and `LoadedArt`/`TilesManifest` types) from `render/art.ts`; `initDevice`, `NoAdapterError`, `ShaderCompilationError` (and `AdapterInfo`/`RendererDevice` types) from `render/device.ts`; `createTerrainRenderer` (and `FrameUniformValues`/`TerrainRenderer`/`Viewport` types) from `render/terrain.ts`. `camera/transform.ts`'s `pxPerTile` is deliberately left out — M20 inlines that one-line formula in `main.ts` rather than adding a ninth export.

**2. The subpath is provisional, not final.** 0017 §2's map is stated as fixed; this amendment is an exception made under time pressure at M20's gate (new published surface, decided unilaterally rather than referred up front), not a considered closure of the map. It stands until M35 rules on it.

**3. M35's "Exports map freeze" (`docs/plan/35-packaging-and-adapters.md`) decides `./render`'s final shape.** Two outcomes are live: (a) keep `./render` as its own subpath, on the grounds that render-loop assembly is legitimately the caller's concern (0018 §1) and a second game will need the same pieces; or (b) fold render-loop assembly into `createClient` itself, so a game needs no render imports at all, and drop the subpath. What should decide between them: whether a second game, or the reference game's own M20b page, ever needs anything from `engine/render` beyond the eight names above. If nothing more is ever needed and one caller (M20b) is the only consumer, folding the assembly into `createClient` removes a public surface for no loss; if a second consumer needs the same low-level pieces independently, or needs to compose them differently than `createClient` would, the subpath earns its keep. M35 has the evidence M20 doesn't: a second game, or at least the reference game's later pages, to check against.

## Alternatives rejected

- **Wait for M35 and block M20 on it.** Rejected: M20's Goal (a real dev page with terrain, pan and zoom, built from `games/reference`) is unreachable without some public surface for the render pieces, and M35 (After: 29, 35b) is not next in sequence.
- **Route the render pieces through `createClient` now** (folding assembly in, per outcome (b) above) instead of a new subpath. Rejected for M20: `createClient`'s existing contract (`client.ts` doc comments) already commits to *not* touching WASM from rendering and to the caller assembling the loop; changing that contract mid-milestone is a bigger, better-informed decision than M20's brief calls for, and is exactly the question left open for M35.

## Consequences

The exports map now has one subpath (`./render`) not accounted for in 0017 §2's closed list, flagged provisional rather than silently left for M35 to discover as drift. M35's "Exports map freeze" section must explicitly rule on it (see `docs/plan/35-packaging-and-adapters.md`, amended in the same commit as this ADR) rather than treating 0017 §2 as the sole final-state reference. If M35 chooses outcome (a), this ADR's decision becomes permanent and 0017 §2 is updated to include it as ordinary, non-provisional surface. If M35 chooses outcome (b), `render.ts` and the subpath are removed and this ADR's Status line is marked superseded by M35's own ADR.

## Sources

- `packages/engine/src/render.ts` (header comment and export list), read 2026-09-24.
- `packages/engine/package.json` `exports`, read 2026-09-24.
- `docs/plan/20-reference-game-v0.md`, Deviations section (search "engine/render"), read 2026-09-24.
- `packages/engine/src/client.ts`, doc comments on `RenderOptions` and `ClientOptions.assets`, read 2026-09-24.
- `docs/plan/35-packaging-and-adapters.md`, "Exports map freeze" scope bullet, read 2026-09-24.
