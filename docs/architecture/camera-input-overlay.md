# Camera, input, picking and overlay

The camera, all pointer/keyboard input, entity picking and the anchoring of game DOM to world positions are engine-owned, main-thread TypeScript. No WASM runs on this thread. The camera never mutates the world and is not an action ([0001](../decisions/0001-camera-and-presence.md)): it runs at display rate with no round trip, and the sim's host only hears about it as a rate-limited subscription report. Code: `packages/engine/src/camera/`, `src/input/`, `src/overlay/`; wiring in `src/client.ts` (`createClient`) and `src/frame-loop.ts`; the Rust consumers are in `packages/engine/crates/engine/src/client/` (`camera.rs`, `input.rs`, `frame_cx.rs`, `drawlist.rs`). The game's part is a DOM overlay (`games/reference/src/ui/`) plus Rust that reads input events and publishes a ghost and anchors. Decision record: [0019](../decisions/0019-camera-input-and-overlay.md), amended by [0061](../decisions/0061-wheel-zoom-bounded-accumulator.md) and [0066](../decisions/0066-phase-3-decisions-client-renderer-input.md).

## Per-frame flow

Listeners only record; one rAF callback decides (the convention is in `packages/engine/CLAUDE.md`, "Listeners record, rAF integrates"). Order inside one frame (`frame-loop.ts` phases). The loop itself only calls the page-supplied `onCamera()` hook (`frame-loop.ts`, `camera` phase); the page's hook calls `client.camera.tick(dtMs)`, which does steps 2 onward for the camera (the reference game does this in `src/game.ts`, with `dtMs` from its own `performance.now()`):

1. `acquire`: `client.pick.acquire()` pulls the newest DrawList slot (`render/drawlist-slot.ts`), which also carries the follow target in its header.
2. `camera`: `setFollow` from that header, then `CameraIntegrator.integrate(state, viewport, dtMs)` (`camera/camera.ts`), then `SemanticRecognizer.recognize(...)` (`input/semantic.ts`), which reads the same pointer slots.
3. `writeCameraBlock` (`camera/block.ts`) publishes the camera; the GPU uniform is filled from the same `CameraState`.
4. `onOverlay` calls `client.overlay.update()` (`overlay/anchors.ts`). The frame loop does not call it itself. Like `onCamera`, a page wires it: `onOverlay: () => client.overlay.update()` (the reference game does in `src/game.ts`; a stepped test entry calls it from its own `__stepFrame`).

Canvas and DOM therefore present from the same camera values in the same callback.

## Camera

`CameraState` (`camera/state.ts`) is a plain mutable object: centre (f64 tiles; world coordinates can exceed f32's exact range), velocity, `tilesAcross` (tiles across the long axis), zoom rate, half extents, dpr, `frameTimeMs`, cursor tile, device-pixel viewport. A fresh camera opens at `DEFAULT_TILES_ACROSS = 32` ([0066](../decisions/0066-phase-3-decisions-client-renderer-input.md) item 11). `camera/transform.ts` holds the pure math, shared by the camera, picking and the overlay: `worldToScreen`, `screenToWorld`, `tileUnderPoint`, in CSS pixels, world X right and Y down, one `pxPerTile = max(viewport w, h) / tilesAcross` for both axes (the short axis shows fewer tiles, so the half extents differ).

`createCameraIntegrator` handles, once per frame: one-pointer pan (the world point under the finger stays under it), two-pointer pan plus zoom about the midpoint, wheel zoom about the cursor, WASD, inertia, `moveTo`, bounds, the follow target and the at-rest device-pixel snap. Every zoom source goes through one primitive that clamps (`applyZoomTo`), so pinch, wheel and macOS `gesturechange` obey the same limits.

- **Constraints:** `client.camera.setConstraints({ bounds?, minTiles?, maxTiles? })`; defaults 12 and 256 tiles (`DEFAULT_MIN_TILES`/`DEFAULT_MAX_TILES`), configurable per game. `bounds` clamps the centre. The host's view clamp (`Welcome.viewMaxTilesPerAxis`, applied by `setViewClamp` in `client.ts`) can only narrow `maxTiles`, never widen it.
- **Programmatic control:** `moveTo(x, y, { tiles?, durationMs? })` eases (cubic in-out, default 400 ms; 0 jumps) and is cancelled by any user input. `client.camera.read(out)` fills a caller-owned object. `worldToScreen`/`screenToWorld` are exposed on `client.camera`.
- **Follow:** the game's client Rust calls `FrameCx::follow(Some(pos))` (`client/frame_cx.rs`); the main thread centres on it in the frame that draws that DrawList. While set, pan input is ignored and zoom still works; `None` returns control. There is no "WASD moves a sim player" mode; a follow offset is the game's job (it passes a position).
- **Inertia:** velocity from a ring of the last 80 ms of pointer samples, exponential decay with time constant 325 ms, cancelled by any `pointerdown`; stops below 4 CSS px/s.
- **Persistence:** `camera/persistence.ts` saves to `localStorage` key `engine:camera:v1:<ClientOptions.cameraKey ?? 'default'>` when motion ends (`onMotionEnd`) and restores at start (`client.camera.restored`). A game passes its world id as `cameraKey`. Saving on `visibilitychange` (stated in 0019 §1) is not wired; only the motion-end save exists.

### Camera block and the report

`camera/block.ts` writes one 80-byte seqlock-guarded SAB record per frame (`CameraBlockView`, `writeCameraBlock`; offsets are the `CAM_OFF_*` constants): centre, velocity, `tiles_across`, zoom rate, half extents, dpr, `frame_time_ms`, cursor tile and validity, device-pixel viewport. Nothing is posted. The Rust mirror is `client::CameraBlock` (`client/camera.rs`); the layouts agree byte for byte (test `workers.camera_block_reaches_wasm`). The client worker reads the block through `FrameCx::camera()` and builds the host report with `CameraBlock::to_report()` (centre, half extents and velocity rounded to integers and saturated). The report is sent on change only (keepalive batches omit it), capped at 10 Hz by a credit bucket (`CAMERA_MIN_INTERVAL_MS = 100`, credit cap 200 ms, `client/core.rs`) inside the 50 ms batch pacing; rate, clamps, rings and look-ahead are in [0010](../decisions/0010-rates-and-subscriptions.md), semantics in [0001](../decisions/0001-camera-and-presence.md). The camera is never in `apply`, the log, snapshots or hashes.

## Input

All listeners are installed by `createClient` and write fixed slots (no allocation, no work beyond field writes; the `record*` functions are also what `engine/test`'s `injectPointer`/`injectWheel`/`injectKey` call, so tests never dispatch DOM events).

- **Pointers** (`input/pointers.ts`): Pointer Events on the canvas only, `setPointerCapture` on down, at most `MAX_POINTERS = 2` slots (a third touch is ignored), `getCoalescedEvents()` is never called. A press and release inside one rAF gap (macOS tap-to-click) is a `quickTap` latch. macOS Safari's trackpad pinch arrives only as `gesturechange.scale` into `GestureState`; on iOS a touch pinch fires `gesture*` too, but the pointer path owns it. `gesturestart`/`gesturechange` listeners are non-passive and `preventDefault`.
- **Wheel** (`input/wheel.ts`): the listener sits on the overlay root (`ClientOptions.overlay.root`, default the canvas's parent) so the wheel also works over game widgets; the cursor position uses a canvas rect cached on resize/scroll, never `getBoundingClientRect` per event. `Δlog(tiles) = deltaY × 0.002`, ×25 for line and ×500 for page `deltaMode`, ×10 with `ctrlKey` (Chrome/Firefox trackpad pinch). The outstanding accumulator saturates at ln 2 (`WHEEL_MAX_PENDING_LOG`) so one burst is at most one doubling; the camera eases it with a 22 ms time constant. An element marked `data-wheel-own` (or inside one) keeps its own scroll and records nothing.
- **Keys** (`input/keys.ts`): WASD by `event.code` into a bitmask on `window`; pan speed is proportional to the visible extent with a 120 ms ramp up and 80 ms down. Ignored when the target is `input, textarea, select, [contenteditable]`, when `isComposing`, or with Ctrl/Meta/Alt held.
- **Focus** (`input/focus.ts`): `blur`, a hide `visibilitychange` and `pointercancel` clear every slot (pointers, gesture, hover, wheel, keys).
- **Page CSS** (`input/page-css.ts`, `installPageStyles()`, opt-in): canvas `touch-action: none; user-select: none; -webkit-touch-callout: none`, a fixed full-viewport root, `overscroll-behavior: none`, `100dvh`, and a viewport meta with `viewport-fit=cover`. It deliberately omits `user-scalable=no`. iOS edge-swipe navigation cannot be blocked from script.
- **Desktop vs mobile:** WASD and wheel move the camera on desktop; drag and pinch on touch.

### Semantic events

`createSemanticRecognizer` (`input/semantic.ts`) turns slots into events the game consumes, delivered two ways: `client.input.on(type, cb)` with one reused event object, and 32-byte records (`input/record.ts` `writeInputRecord`; Rust `client/input.rs` `InputEvent`) in a SAB ring that Rust reads as `FrameCx::input()` (a borrowed slice; the game copies what it needs, because `extract` is `&self`).

- `tap` (moved < 8 CSS px and held < 300 ms: world position, tile, `pick_id`, button, modifiers), `hover` (mouse only, only when tile or `pick_id` changes), `longpress` (500 ms), and after `client.input.setMode('tool')` `dragstart`/`drag`/`dragend` for one-pointer drags (two-finger pan and zoom still work). `suspend()`/`resume()` cover modal UI.
- `client.input.emit(code, a, b)` writes a kind-7 `game` record from TypeScript to Rust (how a DOM mode switch reaches `ClientSide`); it is not delivered to `on`, is never dropped by `InputQueue` overflow, and returns false if the ring is full. A full ring otherwise drops and counts, never blocks ([0024](../decisions/0024-planning-amendments.md) §7c).
- **Cursor tile:** the mouse's tile under the pointer, or for touch the tile of the last tap. It is published in the camera block and as a shader uniform. The game draws its ghost with `ANCHOR_CURSOR_TILE` (`client/drawlist.rs`), resolved in the vertex shader from the live camera, so the ghost tracks the pointer with no latency while its validity colour arrives a frame later ([0066](../decisions/0066-phase-3-decisions-client-renderer-input.md) item 8). Touch placement is tap (cursor tile, ghost), DOM confirm button anchored to the tile, then dispatch.
- **Input over DOM:** the overlay root is the page's own element (default the canvas's parent, `ClientOptions.overlay.root`); the engine's anchor layer inside it has `pointer-events: none` and each anchored element gets `pointer-events: auto` (`overlay/anchors.ts`), so the browser's hit test keeps widget events off the canvas. The engine does no DOM-rectangle exclusion.

### Picking

Tiles by arithmetic (`tileUnderPoint`). Entities by `scanDrawListForPick` / `createPicker` (`input/pick.ts`): scan the newest DrawList slot front to back (layers high to low, reverse submission order within a layer) for the first record with `pick_id != 0` and without `ANCHOR_CURSOR_TILE` whose shape contains the point. Strokes drawn in screen pixels get a minimum pick radius of 6 CSS px (`MIN_STROKE_PICK_RADIUS_PX`). It is synchronous, allocation-free, and answers exactly what is on screen including interpolation. Taps pick on the event; hover picks at most once per rAF, when the pointer or slot changed. The pointer is converted once to world tiles relative to the slot's `window_origin` (the camera-centre tile snapped down to a multiple of 64, `snap_window_origin`, so DrawList hashes do not move with sub-chunk camera motion). Games needing semantics (what a tile means) query `WorldRead` in Rust instead.

## Overlay anchoring

`createOverlay` (`overlay/anchors.ts`) owns one anchor layer element inside the overlay root and re-parents each anchored element into it (so a game's CSS for anchored elements needs `--z` and the layer transform inherited).

- `client.overlay.anchor(el, worldX, worldY, { align? })` returns a handle with `set(x, y)` and `remove()`; `anchorSlot(el, slot)` follows a position the game's Rust publishes with `DrawList::anchor(slot, pos)` (64 `ANCHOR_SLOTS`; read through a long-lived `Float32Array`, `--wx/--wy` rewritten only for slots that changed).
- Each anchor stores its offset from a floating origin tile once, in `--wx/--wy`, under one static CSS rule per `align` (`center`, `top`, `bottom`). Per frame `update()` writes at most two properties on the layer: `transform` if the camera moved, `--z` (CSS px per tile) if zoom changed. Panning is compositor-only for any anchor count; an idle camera writes nothing; nothing is scaled, so text stays crisp. The origin re-bases (all `--wx/--wy` rewritten) when the camera is over `REBASE_THRESHOLD_PX = 50_000` CSS px from it. Anchors outside the viewport plus 64 px get `visibility: hidden`, toggled on transitions only. Translation is rounded to device pixels only at rest.
- `OverlayOptions.mode: 'translate'` writes one `transform` per visible anchor (the MapLibre style); built, off by default, selectable by a page for a device comparison.
- Budget: tens of anchors; hundreds belong in the canvas as drawables ([renderer](renderer.md)).
- Known gaps ([0066](../decisions/0066-phase-3-decisions-client-renderer-input.md)): the first anchor shows at the layer origin for one frame, because the layer transform is written by the next `update()`; on small Android screens Chrome's touch adjustment can snap a tap near a drawn ring to an overlaid button.

## Invariants

- Hot path: listeners, `integrate`, `recognize`, the picker, `writeCameraBlock` and `update()` allocate nothing in steady state: views, scratch objects and event objects are built in constructors; no closures, literals or `subarray()` (`src/camera/block.ts` is checked by `sab.no_alloc_syntax`). See [hot-paths](../../.claude/rules/hot-paths.md). `frameTimeMs` is rAF's own timestamp, forwarded into the frame loop's own `tick(tMs)` (a different call from `client.camera.tick(dtMs)`), not a clock read. `attachVisibilityHandling` (`frame-loop.ts`) is page opt-in (the reference game uses it) and pauses the frame loop while hidden, so no camera block or report is produced then.
- `overlay/anchors.ts` never reads layout (`getBoundingClientRect`, `offsetWidth`). Its only per-frame allocation is the one or two short transform strings while the camera moves.
- Camera state must never enter the sim: no camera-derived value in `apply`/`tick`.
- The wheel and gesture listeners must be non-passive and on elements (canvas, overlay root), not `window`, where Chrome makes them passive.
- WebKit fires `gesturestart`/`gesturechange` for every two-finger touch and Chrome none; `GestureEvent` has no `offsetX/Y`, so a non-finite point falls back to the canvas centre. Do not infer "page zoomed" from gesture events (use `visualViewport.scale`).
- Wheel constants and the default zoom were tuned from a real bug (a ctrl-wheel burst crossed the whole range); change them with a device round, not by feel.

## Tests

- Unit (`unit` suite, vitest beside the source): `camera/{camera,transform,block}.test.ts`, `input/{gestures,semantic,pick,record,page-css}.test.ts`, `overlay/anchors.test.ts`.
- Browser (`browser` suite, Playwright, `packages/engine/tests/browser/`): `camera.spec.ts`, `follow.spec.ts`, `semantic.spec.ts`, `pick.spec.ts`, `overlay.spec.ts`, `anchors.spec.ts`, `ghost.spec.ts`, and the zero-allocation pages `gc-input.spec.ts` and `gc-anchors.spec.ts` (`gc-test` skill, [0016](../decisions/0016-zero-gc-definition.md)). Reference-game flows: `games/reference/tests/browser/collect-flow.spec.ts`.
- Real-phone behaviour (gestures, anchoring on iOS Safari, pull-to-refresh) is only checked by the manual device checklist: `.claude/skills/device-check/SKILL.md`.
- Suites and build steps are registered in `scripts/suites.mjs`; run them with `pnpm test [suite] [-t pattern]`.

Related: [renderer](renderer.md) (GPU uniform, DrawList, drawables), [client-api](client-api.md) (`createClient`, `onUi`, `clock`), [sync-and-netcode](sync-and-netcode.md) (uplink, subscriptions), [threads-and-boundary](threads-and-boundary.md) (SAB blocks and rings).
