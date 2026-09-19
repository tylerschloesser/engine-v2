# 0019: Camera, input, picking, and overlay anchoring

Status: Accepted (2026-09-19). Amended by [0024](0024-planning-amendments.md) §7.

## Context

Requirements: [`../spec/client.md`](../spec/client.md) (user-driven, engine-owned camera with game constraints, programmatic moves and a follow target; WASD/scroll and drag/pinch; a game-owned DOM overlay that needs transforms, picking, and low-GC observation) and [`../spec/reference-game.md`](../spec/reference-game.md) (collect buttons pinned to resources, a 2×2 ghost, tap-then-confirm placement on touch). The camera never mutates the world ([0001](0001-camera-and-presence.md)), so it has no round trip and can run at display rate next to the only thread that receives input. The renderer is on that thread ([0018](0018-renderer.md)); no WASM runs there ([0015](0015-threads-memory-and-topology.md)). Safari caps rAF at 60 Hz and drops to 30 Hz in Low Power Mode, so all motion is time-based.

## Decision

**1. Camera ownership.** The camera is main-thread TypeScript state owned by the engine: centre (f64 tiles), zoom (tiles across the long axis), velocity, zoom rate, viewport. It is integrated once per rAF from input, then used, in that same callback, for the GPU uniform, the overlay write (5), and one write of the **camera block**: a fixed seqlock-guarded SAB record `{seq, centre: f64×2, velocity: f32×2, tiles_across: f32, zoom_rate: f32, half_extent_tiles: f32×2, dpr: f32, frame_time_ms: f64, cursor_tile: i32×2, cursor_valid: u32}`. Nothing is posted: the client worker reads the block (`FrameCx`/`FrameView` in [0003](0003-game-facing-api.md); the reference game's spring), which also derives the camera report from it when it assembles the uplink ([0015](0015-threads-memory-and-topology.md)). The camera is saved to `localStorage` when motion ends and on `visibilitychange`, and restored at start ([0001](0001-camera-and-presence.md)).

Game controls (members of the `client` object returned by `createClient`, [0017](0017-packaging-and-build.md), alongside `dispatch`/`onUi`/`clock` of [0003](0003-game-facing-api.md); all clamped to the host's view clamp, which arrives in `Welcome`):

```ts
client.camera.setConstraints({ bounds?: Rect, minTiles?: number, maxTiles?: number }): void  // defaults 12 and 256
client.camera.moveTo(x: number, y: number, opts?: { tiles?: number; durationMs?: number }): void  // 0 = jump; eased otherwise; user input cancels it
client.camera.read(out: CameraState): void                  // fills a caller-owned object
client.camera.worldToScreen(x, y, out): void;  client.camera.screenToWorld(px, py, out): void
```

**Follow target:** the game's client Rust calls `cx.follow(Some(pos))` in `ClientSide::frame`; the engine puts it in the frame header and the main thread centres on it in the frame that draws that DrawList. While a target is set, pan input is ignored and zoom still works; `None` returns control. No "WASD moves a sim player" mode (Requirements).

**2. Reporting to the host.** Format, rate, clamps, rings and look-ahead are owned by [0010](0010-rates-and-subscriptions.md); semantics by [0001](0001-camera-and-presence.md). This ADR adds only: the report is derived from the camera block, never from a main-thread message, and reporting stops while the tab is hidden (subscriptions stay as last reported).

**3. Gestures.** Pointer Events on the canvas only; `setPointerCapture` on `pointerdown`; at most two pointers tracked in fixed slots; `getCoalescedEvents()` is never called (it allocates arrays of events and a camera needs only the latest position).
- One-pointer drag pans (the world point under the finger stays under it). Two pointers pan by midpoint delta and zoom by distance ratio **about the midpoint**. Wheel zooms **about the cursor**: `tiles *= exp(deltaY × k)`, `deltaMode` normalized, larger `k` with `ctrlKey` (Chrome/Firefox trackpad pinch); notches ease to the target over 100 ms; pinch is direct. macOS Safari trackpad pinch arrives only as `gesturechange.scale`.
- Inertia: velocity from a fixed ring of the last 80 ms of samples (event timestamps); exponential decay, time constant 325 ms; cancelled by any `pointerdown`. WASD uses `event.code`, speed proportional to the visible extent, with a short ramp.
- Browser gestures: canvas CSS `touch-action: none; user-select: none; -webkit-touch-callout: none`; non-passive `wheel`, `gesturestart`, `gesturechange` listeners **on the canvas** calling `preventDefault()` (window-level wheel listeners are passive by default in Chrome). The engine documents and offers a helper for the page CSS that prevents pull-to-refresh structurally: a `position: fixed; inset: 0; overflow: hidden` root, `overscroll-behavior: none` on `html, body`, `height: 100dvh`, `viewport-fit=cover`. iOS edge-swipe navigation cannot be blocked from script; installing as a PWA avoids it.

**4. Engine/game input split.** The engine turns raw input into semantic world events; the game turns those into actions.
- **Events:** `tap` (moved < 8 CSS px and < 300 ms; world pos, tile, `pick_id`, button, modifiers), `hover` (mouse only; emitted only when tile or `pick_id` changes), `longpress`, and, after `client.input.setMode('tool')`, `dragstart/drag/dragend` for one-pointer drags (two-finger pan/zoom still works). Each is written as a fixed-size record to a SAB ring the game's client Rust drains, and delivered to `client.input.on(type, cb)` with one reused event object.
- **Picking:** tiles by arithmetic from the camera. Entities by scanning the newest published DrawList slot front to back (layers high to low, reverse within a layer) for a record with `pick_id != 0`, without `ANCHOR_CURSOR_TILE`, whose shape contains the point. Synchronous, allocation-free, and exactly what is on screen including interpolation. Taps pick on the event; hover picks at most once per rAF, when the pointer or the slot changed.
- **Cursor tile and ghost:** the engine keeps a cursor tile (mouse: tile under the pointer; touch: tile of the last tap), publishes it in the camera block and as a shader uniform. The game emits the ghost in `extract` with `ANCHOR_CURSOR_TILE`, so it tracks the pointer with no added latency while its validity colour (from the shared `can_place` rule, 0003) arrives a frame later. **Touch flow:** tap sets the cursor tile and emits `tap`; the ghost appears there; the game shows a DOM confirm button anchored to that tile; confirm dispatches the action. Drags still pan, because a tap is defined by the thresholds above.
- **Input over DOM UI:** the overlay root is a sibling above the canvas with `pointer-events: none`; game widgets set `pointer-events: auto`. The browser's hit testing keeps widget events off the canvas, and the engine listens nowhere else for pointers. Pointer capture keeps a world drag alive when it passes under a widget.
- **Keyboard focus:** key listeners on `window`; ignored when the target is `input, textarea, select, [contenteditable]`, when `isComposing`, or with Ctrl/Meta/Alt held; all key and pointer state is cleared on `blur`, `visibilitychange` and `pointercancel`. `client.input.suspend()/resume()` covers modal UI.

**5. Overlay anchoring.**

```ts
const a = client.overlay.anchor(el, worldX, worldY, { align?: 'center' | 'top' | 'bottom' });  a.set(x, y);  a.remove();
const b = client.overlay.anchorSlot(el, slot);   // follows a moving position the game's Rust publishes with out.anchor(slot, pos); 64 slots
```

The engine owns one **anchor layer** element. Each anchor stores its offset from a floating origin tile once, in custom properties `--wx/--wy`, under a static rule: `transform: translate(calc(var(--z) * var(--wx) * 1px), calc(var(--z) * var(--wy) * 1px)) translate(-50%, -100%)`. Per frame the engine writes **at most two properties on one element**: the layer's `transform: translate(tx, ty)` if the camera moved and `--z` (CSS px per tile) if zoom changed, in the same rAF callback and from the same camera values as the GPU submit, so canvas and DOM present together. Cost: panning is compositor-only for any anchor count; zooming is one style recalc over N anchors, no layout; nothing is scaled, so text stays crisp; an idle camera writes nothing; a moving one allocates 1–2 short strings per frame. Translation is rounded to device pixels only at rest. Slot anchors read the frame header's anchor table through a long-lived `Float32Array` and rewrite `--wx/--wy` only for slots whose value changed. The origin is re-based (all `--wx/--wy` rewritten) when the camera is more than 50,000 CSS px from it. Anchors leaving the viewport plus a margin get `visibility: hidden`, toggled on transitions only. Budget: tens of anchors; anything in the hundreds is an in-canvas drawable (0018).

**6. Observing game state.** Owned by [0003](0003-game-facing-api.md) (`onUi`, `clock()`, `onActionResult`). The collect-button fill is a CSS animation started once with the known duration: zero per-frame JS.

## Alternatives rejected

- **Camera in a worker, or as sim/replicated state:** input and DOM are on main; any hop adds latency and makes anchors swim; the second contradicts 0001. **Camera follows a sim player by default:** not required; the follow hook allows it later.
- **Posting camera messages to workers, or reporting every frame/event:** per-message garbage (16 B per `MessageEvent` plus the payload, measured) and no benefit over a shared block read at ≤ 10 Hz.
- **Touch + Mouse Events, or a gesture library:** two code paths, or a runtime dependency ([0017](0017-packaging-and-build.md)).
- **Forwarding raw DOM events to the game:** every game re-implements tap/drag discrimination and DOM exclusion.
- **GPU id-buffer picking:** `mapAsync` readback is asynchronous and allocates. **Picking by a query into the worker:** a thread hop per pointer event and an answer that can disagree with the frame on screen; games may still query `WorldRead` in Rust for semantics.
- **Hit-testing DOM rectangles in engine code to exclude UI:** the browser already does it.
- **Per-anchor `left/top`:** layout per frame. **Reading layout (`getBoundingClientRect`) per frame:** forced reflow. **Scaling the anchor layer:** blurry text and scaled buttons. **Per-anchor `translate()` writes (MapLibre):** N strings and N style writes per frame; kept only as the fallback below.
- **Drawing UI widgets in the canvas:** the engine renders no widgets (`overview.md`).

## Consequences

- Camera feel, gestures and picking are TypeScript, part of the accepted exception in `overview.md`; they are tested in a browser, not natively ([0020](0020-testing-strategy.md)).
- Picking sees only what `extract` emitted with a `pick_id`; an entity the game chose not to draw cannot be picked.
- Overlay writes allocate short strings while the camera moves, and one pair per moving slot anchor; [0016](0016-zero-gc-definition.md) budgets this as a separate line (with no anchors mounted the engine writes no styles). CSS Typed OM would remove it but is absent in Firefox.
- A follow target disables panning entirely; "follow with user offset" needs a later decision.
- **Deferred to Phase 2/3 manual device checks: anchoring on iOS Safari** (50 anchors during pan and pinch: zero swim against the canvas, crisp text, style-recalc cost), combined with the fill-rate check in 0018, because real phones cannot be automated in this phase. Fallback if the custom-property mechanism misbehaves: per-anchor `translate()` writes from the same rAF callback.
- Deferred to Phase 2: exact input-ring record layout, easing curves and wheel constants, and the `FrameCx` shape (0003), because they are tuning or implementation details.

## Sources

- [`../research/client.md`](../research/client.md) 1.2, 1.6, 1.7, 2.6, 3.6–3.9, 4; [`../../spikes/zero-gc-webgpu/RESULT.md`](../../spikes/zero-gc-webgpu/RESULT.md) (`MessageEvent` cost; SAB lockstep with zero allocation on both sides).
- Gestures: https://danburzo.ro/dom-gestures/ · https://kenneth.io/post/detecting-multi-touch-trackpad-gestures-in-javascript · MDN browser-compat-data (`touch-action`, `overscroll-behavior`, `getCoalescedEvents`): https://github.com/mdn/browser-compat-data
- rAF throttling on iOS: https://motion.dev/magazine/when-browsers-throttle-requestanimationframe
- Anchoring prior art: https://github.com/maplibre/maplibre-gl-js/blob/main/src/ui/marker.ts · https://github.com/maplibre/maplibre-gl-js/discussions/6494 · https://wiki.whatwg.org/wiki/OffscreenCanvas · https://www.figma.com/blog/figma-rendering-powered-by-webgpu/
