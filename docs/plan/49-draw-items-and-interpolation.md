# M49: Drawing items along the forecast

Status: not started · After: 48 · Tyler-dependent: no

Later-phase brief: goal, exit criteria and open questions. Filled in at the start of its phase.

## Goal
`transport::draw_items(view, style, out)` draws every visible item as a game-styled sprite at its forecast position for the frame's render time, mapped through the line's segments (straights and arcs), culled to the visible rect and skipped below a pixel size; a native-versus-`.wasm` DrawList golden pins it; a zero-GC page proves the per-frame path allocates nothing with thousands of items moving.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0076-transport-lines-engine-game-split.md` (§4, §5)
3. `docs/architecture/renderer.md` ("The DrawList", "Frame budget and hot path")
4. `docs/decisions/0078-transport-forecast-replication.md` (§2: `pos(t)`, `path`)
Rules that apply: `.claude/rules/hot-paths.md`. Skills: `gc-test`, `profile-frame`.

## Scope (sketch)
- `transport/draw.rs` (client role, floats allowed): `ItemStyle { fn sprite(item) -> (SpriteId, layer, size, colour), min_px_per_tile }`; `draw_items` iterates lines whose chunk set meets `view.visible()` (a per-chunk line list derived on the replica), evaluates `pos_at` at `view` render time, maps through segments (arc evaluation with a small table, client-side float), emits `DrawList::sprite`; no allocation per frame.
- `FrameView::render_time()` exposure if not already there (M30 attached it to presences).
- `fx-belts` drawables golden (`drawlist_belts_hash_golden`, native and `tests/wasm/drawlist.test.ts`), a fixture page `belts.html` with a moving stream (the `gc-belts` page: `gc.pages.gc-belts` rows measured per the `gc-test` skill, strict worker budgets, main with the WebGPU floor).
- A motion check in the browser: `belts-motion.spec.ts` reads the DrawList over stepped frames and asserts items advance monotonically along a straight line at the configured speed between corrections (`analyseMotion`-style, with the window origin added; no multiple-of-64 strip, 0069 §8).

## Seams
**Provides:** `transport::draw::{ItemStyle, draw_items}`, `FrameView::render_time`, `belts.html` page and `gc-belts` budget rows, `belts-motion.spec.ts`.
**Consumes:** M43 segments, M47 `pos_at`, `DrawList` (0018), `InterpDelay::render_time` (M30).

## Exit criteria
- [ ] `drawlist_belts_hash_golden` matches native and `.wasm`.
- [ ] `gc-belts clean` passes on every isolate with 2,000 items moving in view; the `object` control trips the client isolate.
- [ ] `belts-motion.spec.ts` passes; an injected one-frame backward step reddens it.
- [ ] `pnpm test` and `pnpm lint` are green.

## Open questions (answered by earlier phases)
- M47: the forecast's exact `pos_at` signature and whether runs carry a `period`.
- M43: whether `pos_to_world` lives in the sim-grade module (integer) or is reimplemented in floats here (planning decision of M43).

## Deviations
(filled in during execution)
