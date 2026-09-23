# M18: Picking, overlay anchoring, `FrameCx`

Status: not started · After: 17, 09b · Tyler-dependent: no

Carries a **D**: overlay anchoring on iOS Safari. Order against M19 does not matter: both start from M12's `FrameCx` shell, and whichever lands first adds the `ClientSide::frame` call (M19's brief says the same).

Sized at the limit (estimate ≈ 1,600 lines). Pre-agreed cut if the session runs long: everything under "Rust side" below moves to a new `18b-framecx-and-follow.md` (M20b would then wait for it).

## Goal
Main-thread side: taps and hovers carry the `pick_id` of what is on screen, found by scanning the newest DrawList slot; game DOM elements anchor to world positions or to Rust-published slots through the custom-property mechanism, written in the same rAF as the GPU submit. Rust side: `ClientSide::frame` runs every produced frame with a `FrameCx` that exposes the camera block, the frame's input events and `follow`; a cursor-anchored ghost works end to end for mouse and for the touch tap-then-confirm flow.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0019-camera-input-and-overlay.md` (§1 "Follow target", §4 "Picking", "Cursor tile and ghost", "Input over DOM UI", §5, Consequences)
3. `docs/decisions/0003-game-facing-api.md` (`ClientSide::frame`; "Outside the deterministic core")
4. `docs/decisions/0016-zero-gc-definition.md` (§2: the overlay line in the exemptions; the deferred string constant)

Mine from spikes: none. Rules that apply: `.claude/rules/hot-paths.md`.

## Scope
Main-thread side
- `input/pick.ts`: scan per 0019 §4 over long-lived typed views of each triple-buffer slot; shape containment per `kind`; `pick_id` written into `tap`, `longpress`, `hover` and `drag*` events and ring records; hover pick at most once per rAF and only when the pointer or the slot changed.
- `overlay/anchors.ts`: the anchor layer, the injected static rule, `client.overlay.anchor` and `anchorSlot`, floating origin and re-base, visibility toggling on transitions, the at-most-two-writes rule, slot anchors from the header's anchor table; the per-anchor `translate()` fallback mode behind an option.
- Frame loop: a new first phase `acquire` (take the newest DrawList slot once), so camera follow, picking, overlay and render all use the same slot.
- `client.input.emit(code: number, a = 0, b = 0): boolean` (0024 §7c): the TypeScript-to-`ClientSide` channel for client-local UI intent. It writes one record of a new kind 7 ("game": `code u32` in the `pick_id` field, `a`/`b` as `i32` in the tile field, all else zero) into M11's 32-byte `inputRing` layout; the record surfaces in `FrameCx::input()` in ring order, is not delivered to `client.input.on`, is never dropped by `InputQueue` overflow, and `emit` returns `false` when the ring is full. M33 is the first consumer (construction mode).
- Device page: `device.html?anchors=50` (50 text buttons anchored to tiles, each over a pickable in-canvas ring; 4 slot anchors on moving circles; `&anchorMode=translate`), and one new HUD field on `device.html`, `pick_id`: the `pick_id` of the last `tap` event from `client.input.on` (`-` when the tap hit no drawable; unchanged by a tap on a DOM button, which never reaches the canvas).

Rust side
- `client/frame_cx.rs`: fills M12's `FrameCx` shell; `frame(t_ms)` order becomes build `FrameView` → `ClientSide::frame` → `extract` → header (`follow`, anchors) → sort → publish → clear `InputQueue`. `FrameCx::ui_dirty()` (0024 §7d) sets M16b's client-side dirty flag, so `ui` re-runs this frame when `frame` changed state the `Ui` depends on; the `PartialEq` gate is unchanged.
- `DrawList::anchor(slot, pos)`.
- Main: `camera.setFollow` from the slot header in the frame that draws that slot.

## Non-scope
Presence sampling and uplink (M19: it gives meaning to `frame`'s `presence` argument). Interpolated positions behind `cx.view()` (M30). Reference-game button and progress bar (M20b). GPU picking (rejected, 0019).

## Files, packages and crates touched
`packages/engine` (`src/input/pick.ts`, `src/overlay/anchors.ts`, `src/frame-loop.ts`, `src/camera/camera.ts`, `src/client.ts`, `src/test/*`, `tests/browser/`, `tests/browser/pages/device.html`), `packages/engine/crates/engine` (`client/frame_cx.rs`, `client/drawlist.rs`), `packages/engine/fixtures/overlay/` (`fx-overlay`: pickable circles, slot anchors, a ghost and a follow toggle).

## Seams
**Provides**
- TS on `Client`: `overlay.anchor(el, worldX, worldY, opts?)` → `{ set(x, y), remove() }`, `overlay.anchorSlot(el, slot)` → `{ remove() }` (0019 §5 signatures). `ClientOptions.overlay?: { root?: HTMLElement; mode?: 'properties' | 'translate' }` (default root: the canvas's parent; the engine appends one anchor-layer element there and **re-parents each anchored `el` into it**).
- `client.input.emit(code, a = 0, b = 0): boolean` (0024 §7c), `FrameCx::ui_dirty()` (0024 §7d), and `InputEvent` kind 7 "game" (`code()`, `a()`, `b()` accessors), consumed by M33.
- `pickAt(cssX, cssY): number` internal, used by the semantic layer; `engine/test`: `pickAt(client, cssX, cssY)`, counters `styleWrites`, `pickScanned`.
- **`FrameCx<'a, G>`** (this brief owns the shape; it fills M12's shell, and M19 adds nothing to it beyond using `frame`'s `presence` argument):
  - `view() -> &FrameView<G>`: the same value `extract` receives (M17: `WorldRead`, ticks, `visible`, `zoom`, `cursor_tile`, `me`), built before `frame` runs
  - `camera() -> &CameraBlock` (M06b: centre, velocity, `tiles_across`, half extents, `dpr`; M17: `viewport_px: [f32; 2]` at offset 72, device pixels, which is what `FrameView::px_per_tile()` reads): what the reference game's spring reads
  - `dt_ms() -> f32` (difference of successive `frame_time_ms`, clamped to 0..100)
  - `input() -> &[InputEvent]`: the events drained from `inputRing` since the previous `frame`, oldest first, at most 64, valid for this call only
  - `follow(&mut self, target: Option<WorldPos>)`
  - `ui_dirty(&mut self)` (0024 §7d; M20b is the first user)
  - no `dispatch` (see Planning decisions)
- The call of `ClientSide::frame(&mut self, cx: &mut FrameCx<G>, presence: &mut G::Presence)` (M12 declared it) once per `frame(t_ms)`, before `extract`. If M19 has not landed, the engine passes a scratch `G::Presence` it then ignores; if it has, M19's kept value.
- `DrawList::anchor(&mut self, slot: u8, pos: WorldPos)` (64 slots); header fields `follow_valid`, `follow`, `anchor_mask`, `anchors` (offsets in M17).
- `device.html` parameters `anchors`, `anchorMode` and HUD field `pick_id` (device item M18-pick reads it).
- `budgets.json`: `gc.pages.anchors` (its `main` = the strict number + the overlay string constant, spelled out in `formula`).

**Consumes** M12: `FrameCx` shell, `ClientSide`. M16b: the `ui` call policy and its client-side dirty flag. M17: slot header layout, `Draw` layout and kind constants, `FrameView`, triple-buffer reader, GC page `drawables`. M11: semantic events, `inputRing`, `InputQueue`, `camera.setFollow`, `camera.cursorTile`, `transform.ts`, injection helpers. M09b: `renderer.onViewportChange(cb)` (`Viewport = { widthPx, heightPx, dpr, renderScale }`; `notifyViewportChange()` fires every registered callback with a plain indexed loop right after `viewport` is mutated in place, at most once per frame, before the camera phase runs — the contract this milestone's anchor re-base runs against), `device.html` (its `anchors`/`anchorMode` URL parameters are reserved there but never read yet — `docs/plan/09b-terrain-art-and-lifecycle.md` Deviations, Steps 6-7: an unread `URLSearchParams` key is tolerated by construction, so this milestone can start reading them with no other change needed on that page). M03: `pnpm device:serve --tunnel`. M17b (optional): sprite pivots from `sprites.json` for sprite picking; without it a sprite picks by its `pos`/`size` rectangle. M04: `installGcPage`, `zeroGcSuite`, `budgets.json`, `pnpm gc reliability`.

## Planning decisions
- **How input reaches the game's Rust (PRE-PLAN §10 gap).** As a borrowed slice, `cx.input()`, of the same 32-byte records main wrote (M11 layout), including `pick_id`. `frame` has `&mut self`, so the game copies what it needs (selection, tool state, ghost rotation) into its `Client` value and `extract` reads it from `&self`. A slice costs nothing, keeps ordering, and needs no callback registration inside WASM.
- **`FrameCx` has no `dispatch`.** Action `seq` is assigned on main so `client.dispatch` can return it synchronously (0003); a second issuer inside the worker would need a reserved `seq` space and a second `onActionResult` path. A game turns a tap into an action in `client.input.on('tap', …)`; Rust-side input is for view state. Reopening this takes an ADR.
- **Containment per kind.** Circle, ring (outer radius) and radial: distance from `pos` ≤ `size.x / 2`. Rect, bar, ghost, sprite: the axis-aligned box of `pos` and `size` (sprite pivot applied when M17b's table is loaded). With `SCREEN_PX_STROKE` a minimum pick radius of 6 CSS px applies. The pointer is converted once to window-origin-relative f32 tiles. The scan reads the `pick_id` column first and touches the other fields only for non-zero ids.
- **Anchored elements are re-parented** into the engine's anchor layer. The mechanism needs `--z` and the layer transform to be inherited, which only descendants get; `remove()` detaches the element and leaves it to the caller.
- **Overlay string constant.** GC page `anchors` mounts exactly 50 static anchors and 4 slot anchors and pans and zooms continuously for the window. Its `main` budget = M17's strict number + the constant, where the constant is the maximum excess over 20 clean runs (`pnpm gc reliability`) plus 16 B; both the constant and the derivation go into the page's `formula` text and the measurement into Deviations (closes 0016's deferral together with M17's number). The strict pages (`input`, `drawables`) keep running with no anchors mounted and hover picking active, which proves that an anchor-free engine writes no styles.
- **Fallback is built, off by default.** `mode: 'translate'` writes one `translate()` per visible anchor per moving frame from the same rAF callback (0019 Consequences). About 60 lines; it lets the device check switch mechanisms with a URL parameter instead of a new milestone.
- **"Follow with user offset"**: closed in M11 as not in v1; `cx.follow` takes a position, so a game adds its own offset.

## Order of work
1. `acquire` phase; slot views; `pick.ts` with unit tests on hand-built slots. 2. `pick_id` in events and records. 3. Anchor layer: static anchors, two-write rule, re-base, visibility. 4. `FrameCx`, `ClientSide::frame`, `cx.input()`. 5. `DrawList::anchor` + slot anchors. 6. `follow`. 7. Ghost flows. 8. GC scenario and constant; fallback mode; device page.

## Tests added
- `unit` suite: `pick.contains_per_kind`, `pick.front_to_back_order`, `pick.skips_zero_id_and_cursor_anchored`, `overlay.rebase_math`, `overlay.align_offsets`.
- Rust native: `framecx.input_slice_order_and_clear`, `input.game_record_round_trip`, `input.game_record_survives_overflow`, `framecx.ui_dirty_reruns_ui`, `drawlist.anchor_table_and_mask`, `framecx.follow_written_to_header`.
- Browser (Chromium): `pick.tap_reports_entity_pick_id`, `pick.hover_once_per_raf_on_change`, `pick.matches_interpolated_frame_on_screen` (pick uses the slot being drawn, not a newer one), `overlay.anchor_tracks_world_point` (element rect vs `worldToScreen` within 0.5 px through pan and zoom; reading layout is allowed in tests only), `overlay.idle_writes_nothing`, `overlay.pan_one_write_zoom_two` (`styleWrites` counter), `overlay.slot_anchor_follows_rust`, `overlay.rebase_beyond_50000px`, `overlay.offscreen_hidden_on_transition_only`, `overlay.widget_click_not_a_tap`, `overlay.translate_mode_equivalent`, `framecx.tap_visible_in_frame`, `framecx.emit_visible_in_frame` (`client.input.emit(3, 1, 2)` arrives as one kind-7 event with the same three values; allocates nothing), `follow.centres_in_same_frame_pan_ignored_zoom_works`, `ghost.mouse_tracks_cursor_tile`, `ghost.touch_tap_then_confirm`.
- Zero-GC: page id `anchors` through `zeroGcSuite`; strict pages unchanged. Per ADR 0026, `anchors`' `burst` negatives are `@slow` automatically (only `gc-loop` stays fast-tier); its clean test must show `presentIsolates` containing every isolate this page names before its verdict check.

## Exit criteria
- [ ] All tests above pass by name.
- [ ] `budgets.json` has `gc.pages.anchors` with the constant in its `formula`; pages `anchors`, `input` and `drawables` pass.
- [ ] Source scan: no `getBoundingClientRect`, `offsetWidth` or other layout read under `src/overlay/` or `src/input/`.
- [ ] In desktop Chrome `device.html?anchors=50` shows `pick_id` on the HUD: a click on a ring sets it to that ring's id, a click on empty ground to `-`, a click on an anchored button leaves it unchanged (asserted by the `anchors` browser test reading the HUD text).
- [ ] The `docs/plan/device-checks.md` section for this milestone matches what was built.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test unit -t pick` · `pnpm test unit -t overlay` · `pnpm test rust -t framecx` · `pnpm test browser -t pick` · `pnpm test browser -t overlay` · `pnpm test browser -t ghost` · `pnpm test browser -t anchors` · `pnpm test` · `pnpm lint`.

## Budgets
- Allocation per isolate (0016): strict main number with no anchors; separate overlay line with 50 + 4 anchors.
- Frame time, main share (0018 §9): worst-case hover pick scans 65,536 records; `bench.frame_worstcase` (M17b) is re-run with hover active and must stay inside its threshold.

## Context artifacts
`packages/engine/CLAUDE.md`: "overlay code never reads layout; at most two style writes per frame". `packages/engine/crates/engine/CLAUDE.md`: `frame` mutates, `extract` reads; input arrives as `cx.input()`.

## Manual device checks
[device-checks.md, M18: Picking and overlay anchoring](device-checks.md#m18-picking-and-overlay-anchoring).
This milestone builds `device.html?anchors=50` for it (50 text buttons anchored to tiles, each over an in-canvas ring, plus 4 slot anchors on moving circles), the `&anchorMode=translate` switch, and the last tap's `pick_id` on the HUD.

## Deviations
(filled in during Phase 3)
