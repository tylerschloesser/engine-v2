# M50: Dense viewport frame budget

Status: not started · After: 49 · Tyler-dependent: no

Later-phase brief: goal, exit criteria and open questions. Filled in at the start of its phase.

## Goal
A viewport full of belts at maximum zoom-out, and the same world at mid zoom with items visible, stay under the frame budgets on the desktop proxies (`bench.frame_belts`, real rAF, in the `frame-bench` suite), with a DrawList that drops nothing. If the proxy is missed, the fallback of 0076 (belt tiles through an animated tile visual instead of sprites) is decided here by measurement and recorded by ADR.

## Read first
1. `docs/architecture/README.md`
2. `docs/architecture/renderer.md` ("Frame budget and hot path": the proxies, the fallbacks)
3. `docs/decisions/0076-transport-lines-engine-game-split.md` (Alternatives rejected: the tile-visual fallback)
4. `packages/engine/tests/browser/frame-bench-reference.spec.ts` (the pattern) and `games/reference/CLAUDE.md` "The bench page"
Skills: `profile-frame`, `gc-test`.

## Scope (sketch)
- A belts bench page in the fixture app (`belts-bench.html`) on M45's world (or a viewport-sized slice): maximum zoom-out (about 37,000 belt sprites drawn by the fixture's `extract`, items skipped by `min_px_per_tile`), then mid zoom (64 tiles across: about 2,300 belts and up to 18,000 items), a slow pan; `bench.frame_belts` in `frame-bench-belts.spec.ts` against `baselines/frame-belts.json` with the 0018 §9 proxy limits (main 1.3 ms, worker 2.7 ms) and `dropped == 0`.
- A `render.beltsViewRecords` counter row: measured records at maximum zoom-out plus margin, under 65,536 (0069 §6: not the cap itself).
- The fallback decision if missed: an animated tile visual (frame index from the global tick in the terrain shader, a `frames` field in `tiles.json`) with belts also written as a derived tile `aux` bit; an ADR before any code.

## Seams
**Provides:** `bench.frame_belts`, `baselines/frame-belts.json`, `render.beltsViewRecords`, the fallback decision (ADR or "not needed").
**Consumes:** M49 `draw_items`, the frame-bench harness (M36), `profile-frame`.

## Exit criteria
- [ ] `bench.frame_belts` passes both scenes on the baseline machine; the baseline is recorded with conditions.
- [ ] `render.beltsViewRecords` is asserted and can trip (a doubled sprite emission reddens it).
- [ ] The fallback is decided: an ADR exists, or Deviations states the measured headroom that makes it unnecessary.
- [ ] `pnpm test`, `pnpm lint` and `pnpm test:slow frame-bench` are green.

## Open questions (answered by earlier phases)
- M49: the per-item record cost in the worker (`extract` time per 1,000 items).
- M45: how many lines and items a viewport slice of the standard world holds.

## Deviations
(filled in during execution)
