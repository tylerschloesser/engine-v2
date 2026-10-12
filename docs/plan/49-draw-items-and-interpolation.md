# M49: Drawing items along the forecast

Status: not started · After: 48c · Tyler-dependent: no (the item clock's visible lead is his to judge at M53/M55; the default proceeds)

Rewritten on 2026-10-12 against the code as built (the survey is the manager's `m49-research.md`; the old sketch assumed `pos_at` at the render time, a browser `analyseMotion` and a float `pos_to_world`, none of which hold).

## Goal
`transport::draw_items` draws every visible item of every held line as a game-styled sprite at its position on the item clock, mapped through the line's segments by the exact integer geometry, culled to the visible rect and skipped below a pixel size, allocating nothing per frame; a native-versus-`.wasm` DrawList golden pins it; a zero-GC page proves the per-frame path with about 2,000 items moving; a motion test pins that items advance monotonically at the configured speed between corrections.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (§2, A8, **A12: the item clock**), `docs/decisions/0076-transport-lines-engine-game-split.md` (§4, §5)
3. `docs/architecture/renderer.md` ("The DrawList", "Frame budget and hot path")
4. `packages/engine/crates/engine/src/transport/follow.rs` (`Follower`, `FRun`, `pos_at`, `step`), `transport/geometry.rs` (`pos_to_world_slot`, `point`, `tile_box`), `client/frame_view.rs` (`with_render_time`, `visible`, `px_per_tile`), `client/drawlist.rs` (`sprite`), `client/texel.rs` (`ClientSide::extract`), `fixtures/drawables/tests/drawlist_golden.rs` and `tests/wasm/drawlist.test.ts` (the golden pattern), `tests/browser/pages/src/gc-drawables.ts` (the page pattern), `src/test/headless-client.ts` (`draws`).
Rules: `.claude/rules/hot-paths.md`, `.claude/rules/determinism.md` (the golden: native and `.wasm` bits equal). Skills: `gc-test`, `run-tests`, `profile-frame`.

## Scope
- **The item clock (0078 A12).** `FrameView` gains `with_transport(&Transport, host_now: f64)` (a builder like `with_prediction`, so `FrameView::new`'s 16 call sites stay) and the readers `transport_follow()`/`item_time()`: `item_time = clamp(host_now, T, T + 1)` with `T` the follower's tick (`forecast_tick()`), `host_now` the client's host-clock estimate in ticks (what `core.render_time()` is derived from). An item at run position `p` with stop `s` and line speed `v` is drawn at `max(p - v * (item_time - T), s)`, floored to a `u32` position; a result below 0 is drawn at 0 (the front) until the next tick's step moves it (no hop within a frame). No backward extrapolation, no history.
- **`transport/draw.rs`** (client role; floats allowed in the fraction only): `ItemStyle { fn sprite(&self, item: u16) -> ItemSprite { sprite: SpriteId, layer: u8, size: [f32; 2], color: u32 }; fn min_px_per_tile(&self) -> f32 }`; `draw_items<G: Game>(view: &FrameView<G>, style: &impl ItemStyle, out: &mut DrawList) -> DrawItemsStats { lines: u32, items: u32, culled: u32 }` (stats for M50's extract-time-per-1,000-items row; no allocation). Lines: iterate the held lines and keep one whose segments' tile boxes meet `view.visible()` (make `tile_box` `pub(crate)`); runs: a new `Follower::for_each_item(slot, frac, &mut impl FnMut(item, pos))` walking runs once (never `pos_at` per item); position to world by `pos_to_world_slot` (integer; `pos >= len` or no segments: skip); cull per item against the visible rect; `px_per_tile() < min_px_per_tile`: draw nothing, stats say so. `unknown` lines draw nothing.
- **`fx-belts` client.** `type Client = BeltsClient` whose `extract` calls `draw_items` with a fixture style (sprite from the item kind, size half a tile, colour by kind, layer 2, `min_px_per_tile` 4). `tests/drawlist_belts.rs`: `drawlist_belts_hash_golden` drives a real `GameInstance` pair (the drawables driver's shape) on the 1/64 `SaturatedView { jam_pct: 20, period: 20 }` world for 16 ticks with real frames, `t_ms` advanced 50 ms per tick and one `frame` at +25 ms, the camera on the stream; `assert_golden_hash!("drawlist_belts_hash", ..)`; `tests/wasm/drawlist.test.ts` gains `drawlist_belts_hash_matches_native_golden` driving the same steps through the raw ABI and reading the same `.hash`. Native no-alloc: `no_alloc_drawlist.rs` gains a case on the belts fixture (`extract` with 2,000 items in view: 0 B).
- **Zero-GC page `gc-belts`** (`tests/browser/pages/gc-belts.html`, `src/gc-belts.ts`, from `gc-drawables.ts`): `fixtureWasm('belts')`, `SaturatedView { jam_pct: 0, period: 0 }` at scale 32 (about 2,048 items over 64 tiles), the camera over the stream, `drive()` stepping one sim tick and one frame; `budgets.json` `gc.pages.gc-belts` rows measured per the `gc-test` skill (strict worker budgets, main with the WebGPU floor); `gc-belts.spec.ts` with `zeroGcSuite(.., controlKinds: ['object', 'burst'])`.
- **Motion test** (netcode, not browser: `analyseMotion` is gone): `tests/netcode/belts-motion.test.ts` `belts/items_advance_on_the_item_clock`: `HeadlessClient.draws()` gains the window origin (`recordWorldPos`); one 1/64 saturated line, 12.5 ms frames for 60 ticks; every drawn item's world x pinned exactly against `pos_to_world(floor(p - 24 * frac))` from `lineItems` and the harness clock; x strictly decreasing frame to frame for every item between corrections; the lead over `render_time` pinned (ticks). Inject: a backward step (`frac` negated for one frame) reddens it. Fits the fast netcode budget (7.7 s of 10 today: keep it under 0.3 s) or goes `@slow` with a fast 10-tick sibling.
- Docs: `docs/architecture/renderer.md` (items in the DrawList, the item clock in one sentence), `docs/architecture/sync-and-netcode.md` (one sentence: what is drawn at `T + frac`, 0078 A12), `fixtures/belts/CLAUDE.md`, `tests/netcode/CLAUDE.md`, the engine crate's `CLAUDE.md` line for `transport/` (`draw.rs`).

## Non-scope
- The lagged follower (items at the render time: M49b, conditional); art and the reference style (M51); the dense-viewport frame budget (M50; this milestone hands it `DrawItemsStats` and the extract time per 1,000 items in Deviations); arcs beyond what `pos_to_world_slot` does today; smoothing a correction's snap (0078 §5: it snaps).

## Files, packages and crates touched
- `packages/engine/crates/engine/src/transport/{draw.rs (new), follow.rs, geometry.rs, mod.rs}`, `client/{frame_view.rs, core.rs}`, `tests/no_alloc_drawlist.rs`, `CLAUDE.md`.
- `packages/engine/fixtures/belts/{src/lib.rs, src/client.rs (new), tests/drawlist_belts.rs (new), tests/golden/*.hash, CLAUDE.md}`.
- `packages/engine/tests/wasm/drawlist.test.ts`, `tests/browser/pages/{gc-belts.html, src/gc-belts.ts}`, `tests/browser/gc-belts.spec.ts`, `tests/netcode/belts-motion.test.ts`, `src/test/headless-client.ts`, `budgets.json`, `tests/netcode/CLAUDE.md`; `docs/architecture/{renderer,sync-and-netcode}.md`.

## Seams
**Provides:** `transport::draw::{ItemStyle, ItemSprite, draw_items, DrawItemsStats}`, `FrameView::{with_transport, item_time}`, `Follower::for_each_item`, the `gc-belts` page and rows, the belts DrawList golden, `HeadlessClient.draws()` with world positions. **Consumes:** M43 segments and the integer geometry, M47 `Follower`/`forecast_tick`, the DrawList (0018), `FrameView` (M30's render time).

## Planning decisions
- **Items are drawn on the item clock, `T + frac`, not the render time** (0078 A12). The follower knows the items exactly at `T` and nothing earlier (stops absorb motion: a history is not invertible, and a lagged follower buffers two sections for the delay); the render time trails `T` by 4-5 ticks, so drawing there extrapolates backward (jams sawtooth, items vanish at joins). So items lead the entities by the interpolation delay; the lead is constant along a belt and shows only where an item is made or taken (a spawner, a sink, an inserter: about 250 ms early). Tyler judges it on the device with reference entities (M53/M55); M49b (the lagged follower) is the fix if he does not accept it.
- **Integer geometry on the client.** `pos_to_world_slot` is exact integer code already written for this (M43 built it that way, against its own plan): the fraction is floored to a 1/256-tile position (8 positions a frame at speed 24, 60 fps). No float arc table.
- **Held lines, not chunk lists.** There is no per-chunk line list on the replica; iterating the held lines with a segment-box test is allocation-free and O(held lines × segments) per frame (1,584 × ≤16 in the mixed view). A chunk-keyed list is M50's lever if the extract time says so.
- **The motion test lives in the netcode suite**: a `HeadlessClient` on a virtual clock gives exact pins; a browser spec would re-create `analyseMotion` (deleted in Phase 4) for less.

## Order of work
1. `FrameView::with_transport`/`item_time`; `Follower::for_each_item`; `transport/draw.rs`; `no_alloc_drawlist.rs` case; `-t no_alloc`, `-t forecast_`, `-t follow` green.
2. `fx-belts` client and style; the native golden; the wasm golden (same hash); `-t drawlist`.
3. `HeadlessClient.draws()` origin; `belts-motion.test.ts` with its inject.
4. `gc-belts` page, rows measured (the `gc-test` skill's procedure: clean runs, `object` and `burst` controls, formulas in `budgets.json`), spec.
5. Docs; Deviations with the extract time per 1,000 items (native, `Mixed` centre view and the gc page's world); `pnpm test`, `pnpm lint`.

## Tests added
Rust: `drawlist_belts_hash_golden`, a `no_alloc_drawlist` belts case, `follow` unit tests for `for_each_item` (frac 0, frac 1, a stop, a front crossing). Wasm: `drawlist_belts_hash_matches_native_golden`. Netcode: `belts/items_advance_on_the_item_clock`. Browser: `gc-belts` clean plus `object`/`burst` controls.

## Exit criteria
- [ ] `drawlist_belts_hash_golden` matches native and `.wasm`, and the belts no-alloc case reads 0 B with 2,000 items in view.
- [ ] `gc-belts clean` passes on every isolate with about 2,000 items moving in view; the `object` control trips the client isolate.
- [ ] `belts/items_advance_on_the_item_clock` passes with exact pins; the backward-step inject reddens it.
- [ ] The extract time per 1,000 items is in Deviations (for M50).
- [ ] `pnpm test` and `pnpm lint` green; every new test has an inject-fail-revert recorded; bench within noise of 1.2638 ms (the bench's frames phase runs `extract`: `fx-belts`' no-op client becomes real, so the bench may move; if it does, the cost is attributed and recorded, and the baseline moves only with the reason in the commit).

## Verification commands
`pnpm test rust -t drawlist_belts` · `pnpm test rust -t no_alloc_drawlist` · `pnpm test wasm -t drawlist` · `pnpm test netcode -t items_advance` · `pnpm test browser -t gc-belts` · `pnpm test:slow rust -t slow_tick_belts_large` (three runs) · `pnpm test && pnpm lint`

## Budgets
- `belts-tick` 1.2638 ms (see the last exit criterion); netcode suite 10 s (7.7 s used); browser suite 60 s (47 s used); `gc.pages.gc-belts` rows new; `bench.frame_worstcase` unchanged.

## Context artifacts
`docs/architecture/renderer.md`, `docs/architecture/sync-and-netcode.md`, `packages/engine/fixtures/belts/CLAUDE.md`, `packages/engine/tests/netcode/CLAUDE.md`, `packages/engine/crates/engine/CLAUDE.md`.

## Manual device checks
none (M57; the lead is judged with reference entities at M53/M55).

## Deviations
(filled in during execution)
