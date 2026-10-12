# M50: Dense viewport frame budget

Status: not started · After: 49 · Tyler-dependent: no

Rewritten on 2026-10-12 against the code as built (the manager's survey `m50-research.md` in the session scratchpad; the sketch's figures were the `SaturatedView` world's, items were not skipped at maximum zoom-out on a 1280 px canvas, a sprite per lane tile would overflow the DrawList, and `bench-gate.mjs` has no belts entry).

## Goal
A viewport full of belts at maximum zoom-out, and the same world at mid zoom with items visible, stay under the frame budgets on the desktop proxies (`bench.frame_belts`, real rAF, in the `frame-bench` suite) with a DrawList that drops nothing; the record count at maximum zoom-out is pinned under the cap with margin. If a proxy is missed, the fallback of 0076 (belt tiles through an animated tile visual) is decided here by measurement and recorded by ADR before any code.

## Read first
1. `docs/architecture/README.md`
2. `docs/architecture/renderer.md` ("The DrawList", "Frame budget and hot path": the proxies, main 1.3 ms and worker 2.7 ms p50, 0018 §9)
3. `docs/decisions/0076-transport-lines-engine-game-split.md` (Alternatives rejected: the tile-visual fallback), `docs/decisions/0069-*.md` §6 (a cap row pins a measured count under the cap with margin, never the cap)
4. `packages/engine/tests/browser/frame-bench.spec.ts` and `tests/browser/pages/src/frame-bench.ts` (the real-rAF pattern: park, `attachTunnelSessions`, `INSTALL_WORKER_WRAP`, `mf-`/`wf-` marks read by `support/frame-trace.ts`, warm-up 120 and 300 timed frames, `recordCount`/`dropped` from the drawables slot, `gate('frame', ..)`), `frame-bench-reference.spec.ts` (the pan: `games/reference/src/bench.ts` `steer()`), `scripts/lib/bench-gate.mjs` (`BENCHES`, `decide`, `promote`), `baselines/frame.json`, `tests/browser/pages/src/gc-belts.ts` (the belts world on a page), `packages/engine/crates/engine/src/transport/geometry.rs` (the sorted `(y, x, line, offset)` tile index, `lines_at`), `fixtures/belts/src/client.rs`, `crates/engine/src/transport/draw.rs`.
Rules: `.claude/rules/hot-paths.md`. Skills: `profile-frame`, `run-tests`.

## Scope
- **Belt tiles drawn by the fixture.** `Transport` gains an allocation-free `for_each_tile_in(rect: TileRect, f: &mut dyn FnMut(TileCoord, LineId))` on `TransportRead` (a `partition_point` per visible row over the sorted tile index, consecutive entries of one tile reported once: the two lanes of a belt tile are one tile), with a unit test (a rect over two lanes and an arc, counts exact). `BeltsClient::extract` draws one belt sprite (atlas id 2, 1 x 1, layer 1) per belt tile in `view.visible()` before the items; `FixtureStyle::MIN_PX_PER_TILE` becomes 8 (at 256 tiles across on 1280 px the view is 5 px a tile: items are skipped there, drawn at 64 across). `ItemSprite.size` is removed: the uberquad shader sizes a sprite from the atlas (`uberquad.wgsl`), so the field did nothing (the docs of `ItemStyle` say so); the belts DrawList golden is re-blessed with the attribution.
- **The page** `tests/browser/pages/belts-bench.html` + `src/belts-bench.ts` from `frame-bench.ts`: `fixtureWasm('belts')`, the `SaturatedView { jam_pct: 0, period: 0 }` world at scale 1 (2,974 lines, 36,864 belt tiles, 294,912 items: 0076's worst case; `BENCH_CAPS` 32,768 / 393,216), chunk pacing lifted as `beltsBenchWorld` does (the join must settle within the spec's wait), the camera over the stream, a 1280 x 720 canvas; two scenes selected by the query string: `zoom=max` (256 tiles across: about 36,864 belt sprites, no items) and `zoom=64` (64 across: about 2,829 belt sprites and up to 18,432 items); a slow triangle-wave pan along x (12 tiles/s, in `onCamera` as the reference bench's `steer()`), held until the spec releases it; `window.__frameBench` as the drawables page plus `linesHeld` (so the spec waits for the view's lines) and `records` per frame.
- **`bench.frame_belts @slow`** in `tests/browser/frame-bench-belts.spec.ts`: both scenes in one test (warm-up 120, 300 timed frames each; smoke 5 and 20 under SwiftShader), `gate('frame-belts', sample)` against `baselines/frame-belts.json` with `BENCHES['frame-belts']` added to `bench-gate.mjs` (gated `zoomoutMainP50Ms`, `zoomoutWorkerP50Ms`, `midMainP50Ms`, `midWorkerP50Ms`; `limits` 1.3 / 2.7; `minDeltaMs` 0.1; `conditions` written by hand), hard assertions `dropped == 0` in both scenes, `engineMemGrows` 0, the record count at maximum zoom-out with the pan held pinned by **`counters.render.beltsViewRecords`** (`assertBudget`: `exact` the measured count, `ceiling` 49,152 = 75 % of `CAPACITY`, `source` the derivation), the mid-zoom count pinned exact in the spec. No upload-backlog assertions (a flat fixture world uploads no terrain). `profile-frame.mjs` accepts `belts`.
- **The decision.** If either scene's worker or main p50 is over its limit on this machine, write the ADR for the tile-visual fallback (`tiles.json` `frames`, a tick in the terrain `FrameUniform`, a derived belt `aux` bit) before any code and stop; else Deviations state the headroom per scene and the fallback is "not needed" (recorded in 0076's Consequences by the manager).
- Docs: `renderer.md` (the belts bench and its two scenes in the frame-budget section), `fixtures/belts/CLAUDE.md` (the bench page, ≤ 60 lines), `packages/engine/CLAUDE.md` (`bench:frame` now runs three benches) if it lists them.

## Non-scope
- The reference game's belt art and entities (M51); phones (M57); a zero-GC page for the real-rAF loop (`gc-belts` covers the stepped path); a per-chunk line list on the replica (if `draw_items`' held-line walk shows in the worker p50, record the figure; M51+ decides).

## Files, packages and crates touched
- `packages/engine/crates/engine/src/transport/{mod.rs, geometry.rs, draw.rs}` (+ a unit test), `fixtures/belts/src/client.rs`, `fixtures/belts/tests/golden/*.hash` (re-bless), `fixtures/belts/CLAUDE.md`.
- `packages/engine/tests/browser/pages/{belts-bench.html, src/belts-bench.ts}`, `tests/browser/frame-bench-belts.spec.ts`, `baselines/frame-belts.json` (new), `budgets.json` (`counters.render.beltsViewRecords`), `scripts/lib/bench-gate.mjs` (`BENCHES`), `scripts/profile-frame.mjs`, `docs/architecture/renderer.md`, `packages/engine/CLAUDE.md`.

## Seams
**Provides:** `bench.frame_belts`, `baselines/frame-belts.json`, `counters.render.beltsViewRecords`, `TransportRead::for_each_tile_in`, the fallback decision. **Consumes:** M49 `draw_items`/`BeltsClient`, the frame-bench harness (M36), M45's `SaturatedView` world, `profile-frame`.

## Planning decisions
- **The worst case is `SaturatedView`, not `Mixed`.** Every tile of the view belts (36,864 belt tiles, 56 % of `CAPACITY`) and every lane is packed (8 items a tile at mid zoom): 0076's own figures. `Mixed` holds about 13,200 belt tiles in the same view.
- **One sprite per belt tile, from the tile index.** A sprite per lane tile (73,728) overflows the list; the sorted index yields the tiles of a rect in O(rows x log N + entries) with no allocation and reports a tile once. The reference game's belts are entities (M51) and draw through the entity path; this query stays useful for any game whose belts are not entities.
- **Items skipped at maximum zoom-out by the fixture's own LOD** (8 px a tile), the brief's intent; a game chooses its own cutoff.
- **The record count is pinned at the held camera**, the panned count varies with the phase.
- **The pages serve the dev-profile `.wasm`** (`opt-level` 1), as every frame bench does: the proxies were set under the same profile.

## Order of work
1. `for_each_tile_in` + unit test; `BeltsClient` belt sprites, `MIN_PX_PER_TILE` 8, `ItemSprite.size` removed; goldens re-blessed; `-t drawlist`, `-t no_alloc_drawlist` (the belts case: 0 B with belt sprites too), `-t transport_` green.
2. The page; `linesHeld` wait; both scenes rendering (check `dropped == 0` by hand first).
3. The spec, `BENCHES` entry, first baseline promoted at 1-min load under 4 with `conditions` written; the budget row; `profile-frame.mjs`.
4. Measure both scenes three times at quiet load; the decision; docs; Deviations (headroom per scene, records per scene, join time, the worker p50 split if `profile-frame` shows the held-line walk).

## Tests added
Rust: `transport_tiles_in_rect` (or as named). Browser (slow): `bench.frame_belts @slow` (two scenes, `counters.render.beltsViewRecords`).

## Exit criteria
- [ ] `bench.frame_belts` passes both scenes on this machine; `baselines/frame-belts.json` recorded with conditions; `dropped == 0` in both.
- [ ] `counters.render.beltsViewRecords` is asserted and can trip (a doubled sprite emission reddens it).
- [ ] The fallback is decided: an ADR exists, or Deviations states the measured headroom per scene.
- [ ] `pnpm test`, `pnpm lint` and `pnpm test:slow frame-bench` green; every new test has an inject-fail-revert recorded; `belts-tick` within noise.

## Verification commands
`pnpm test rust -t tiles_in_rect` · `pnpm test rust -t drawlist_belts` · `pnpm test rust -t no_alloc_drawlist` · `pnpm test wasm -t drawlist` · `pnpm test:slow frame-bench -t frame_belts` (three runs) · `pnpm test:slow rust -t slow_tick_belts_large` (three runs) · `pnpm test && pnpm lint`

## Budgets
- 0018 §9 proxies main 1.3 ms / worker 2.7 ms p50; `CAPACITY` 65,536 with the row's ceiling 49,152; `belts-tick` 1.2638 ms; the `frame-bench` suite is slow-tier (no fast budget moves).

## Context artifacts
`docs/architecture/renderer.md`, `packages/engine/fixtures/belts/CLAUDE.md`, `packages/engine/CLAUDE.md`.

## Manual device checks
none (M57).

## Deviations
(filled in during execution)
