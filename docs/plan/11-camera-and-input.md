# M11: Camera and input

Status: not started · After: 09 (09b recommended first for `onViewportChange`; not required) · Tyler-dependent: no

Carries a **D**: gestures on a real phone, the posted-`Module` check, and the on-device memory ceilings of 0015.

## Goal
The engine-owned camera runs on the main thread at display rate: f64 centre, pan, pinch, wheel, WASD, inertia, `moveTo`, constraints, integrated once per rAF from state that DOM listeners only record. Each rAF writes the camera block and wakes the client worker. Raw input becomes semantic events delivered to `client.input.on` with one reused object per type and written as fixed records to `inputRing`, which the client worker drains into the instance. The rAF path allocates nothing, proven by a GC scenario driven with engine-level input injection.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0019-camera-input-and-overlay.md` (§1–§4; §4 "Picking" only for the event fields)
3. `docs/decisions/0016-zero-gc-definition.md` (§1, §2 including what is exempt)
4. `docs/decisions/0020-testing-strategy.md` (§8 input injection; §10 device checklist)

Mine from spikes: none with camera code; `spikes/zero-gc-webgpu/public/main.js` for the reused-object style. Rules that apply: `.claude/rules/hot-paths.md`.

## Scope
- `camera/camera.ts`: integration (`camera` phase of the frame loop), constraints, view clamp, `moveTo`, follow-target hook (no-op until M18 supplies a target), snap to device pixels at rest, `localStorage` save/restore under `engine.camera.<ClientOptions.cameraKey ?? 'default'>` (a game passes its world id, so each world keeps its own camera), and `client.camera.restored: boolean` (false when nothing was restored, so a game knows to `moveTo` its spawn; M20b consumes both).
- `camera/transform.ts`: `worldToScreen`, `screenToWorld`, tile under a point; pure functions shared with M18 picking.
- `input/pointers.ts`, `input/keys.ts`, `input/wheel.ts`: listeners per 0019 §3–§4 that write into two fixed pointer slots, a key bitmask and a wheel accumulator; nothing else happens in a listener. `pointerdown` takes pointer capture, so a drag that passes under a widget keeps panning (0019 §3, §4); macOS Safari's `gesturechange` writes its `scale` into the same pinch slot (0019 §3).
- `input/semantic.ts`: tap, hover, longpress, drag* recognition in rAF; cursor tile; `client.input.{on, setMode, suspend, resume}`; `inputRing` producer.
- `input/page-css.ts`: the helper for 0019 §3's page CSS (`installPageStyles()`), opt-in.
- Client worker body: drain `inputRing` into `on_input(len)`. Rust: `InputEvent`, `InputQueue` (fixed 64), record decode.
- `engine/test`: input injection at engine level.
- `device.html` additions (fixture app): gestures enabled, `?probe=memory`.

## Non-scope
`pick_id` in events (0 until M18). Surfacing events to the game's Rust (`FrameCx::input`, M18). Centring on a follow target (M18). The camera report on the uplink (M15 derives it from the block). Overlay writes (M18). View clamp from `Welcome` (M15/M28 call `setViewClamp`).

## Files, packages and crates touched
`packages/engine` (`src/camera/*`, `src/input/*`, `src/client.ts`, `src/worker/client.ts`, `src/test/*`, `src/abi.ts`, `tests/browser/`), `packages/engine/crates/engine` (`client/input.rs`, `abi/registry.rs`). Fixture: `fx-terrain` (M09).

## Seams
**Provides**
- TS, on `Client`: `camera.{setConstraints, moveTo, read, worldToScreen, screenToWorld}`, `camera.restored: boolean`, `ClientOptions.cameraKey?: string`, and `input.{on, setMode, suspend, resume}` with 0019's signatures. Types: `CameraState` (M06, now `read`'s out-parameter), `InputEventTs { type, worldX, worldY, tileX, tileY, pickId, button, shift, ctrl, alt, meta, pointerType }` (one reused instance per event type; listeners must copy what they keep).
- Internal: `camera.setViewClamp(maxTilesPerAxis)`, `camera.setFollow(x, y, valid)` (M18), `camera.cursorTile` (M17 uniform, M18 picking), `transform.ts` functions.
- `inputRing` record (32 bytes, little-endian): `0 kind u8` (1 tap, 2 hover, 3 longpress, 4 dragstart, 5 drag, 6 dragend), `1 button u8`, `2 modifiers u8` (bit 0 shift, 1 ctrl, 2 alt, 3 meta), `3 pointer u8` (0 mouse, 1 touch, 2 pen), `4 seq u32`, `8 tile i32×2`, `16 frac f32×2` (position inside the tile, so world position is exact over ±2^23), `24 pick_id u32`, `28 time_ms u32` (wrapping).
- Rust: `#[repr(C)] InputEvent` mirroring the record with `world_pos()`; `InputQueue` (fixed 64; on overflow the oldest `hover` or `drag` is dropped before any other kind; cleared at the end of each `frame`); ABI `on_input(len: u32) -> status` (added by M02's rule) decodes whole records from `RegionId::Rx`.
- `engine/test`: `injectPointer(client, phase: 'down' | 'move' | 'up' | 'cancel', id, cssX, cssY, tMs, pointerType?)`, `injectWheel(client, deltaY, cssX, cssY, ctrlKey?)`, `injectKey(client, code, down)`; they write the same fixed slots the DOM listeners write and allocate nothing.

**Consumes** M06: `CameraState`, `writeCameraBlock`, `inputRing`, control block. M06b: `stepFrame`, client worker body. M09: `FrameLoop` `camera` phase, `renderer.viewport`, `renderer.frameUniform`; M09's Deviations "Notes for later briefs" name the exact seams to fill here: `frame-loop.ts`'s `onCamera` hook (should mutate `Client.cameraState` from input/gestures before each tick) and `Client.writeCameraAndWake(): number` (already production-shaped, fire-and-forget, no ack spin — call it, don't change it); M09b: `renderer.onViewportChange(cb)` (`Viewport = { widthPx, heightPx, dpr, renderScale }`, fired by a plain indexed-loop `notifyViewportChange()` at most once per frame, before the camera phase runs); `device.html`/`src/device.ts` are already built (`docs/plan/09b-terrain-art-and-lifecycle.md` Deviations, Steps 6-7) — its `onCamera` callback computes `tilesPerPx`/`halfExtentTilesX/Y` itself from `cameraState`/`viewport` as a stand-in for this milestone's real camera maths (same Deviations, "Interpretation calls"), and the page never reads the `probe` parameter this milestone owns (an unread `URLSearchParams` key is tolerated by construction). `FrameLoop`'s `start()`/`stop()` are renamed `pause()`/`resume()` there too. M03: `pnpm device:serve --tunnel`. M04: `installGcPage`, `zeroGcSuite`, `budgets.json`.

## Planning decisions
- **Wheel constants.** `Δlog(tiles) = deltaY × k`, `k = 0.002` per pixel, `× 25` for `deltaMode` line, `× 500` for page, `× 10` with `ctrlKey`. These are d3-zoom's field-tested constants; 0019 fixes only the form. macOS Safari `gesturechange.scale` is applied directly like a pinch.
- **Easing.** Wheel notches: exponential approach in log-zoom space with time constant 22 ms (99 % at 0019's 100 ms), about the cursor. `moveTo`: cubic ease-in-out over `durationMs` (default 400), centre in world space and zoom in log space; any pointer, wheel or key input cancels it. WASD: speed = one visible long-axis extent per second, linear ramp 120 ms up and 80 ms down. Inertia is 0019's; it ends below 4 CSS px/s, which is also "motion ends" for the `localStorage` save and the device-pixel snap.
- **Thresholds.** Tap and drag thresholds are 0019's; longpress = 500 ms without leaving the tap radius; hover is emitted at most once per rAF.
- **Full `inputRing`: drop and count** (M06). Main cannot block, and an input event that waited seconds is wrong to deliver; tests assert `drops == 0`.
- **Persistence key.** `engine:camera:v1:<'local' | remote URL>`; world identity (M23) can refine the suffix later without migration, because a missing key just means the default camera.
- **"Follow with user offset" (0019 deferral): not in v1.** A follow target disables panning as 0019 states. A game that wants an offset adds it to the position it passes to `cx.follow` from drag events in tool mode (M18). No milestone owns further work; reopening it takes a new ADR.
- **Camera tests run in the `browser` suite for gestures and in the `unit` suite for maths** (0020 §3 lists camera maths under TS unit): integration functions take `dt` and plain state, no DOM.

## Order of work
1. `transform.ts` and integration maths with unit tests. 2. Fixed-slot listeners + injection helpers. 3. Pan, pinch, wheel, WASD, inertia; camera-block write per rAF. 4. Semantic events, cursor tile, `client.input`. 5. `inputRing` → `on_input` → `InputQueue`. 6. `moveTo`, constraints, persistence, focus rules. 7. GC scenario. 8. Device page gestures and memory probe.

## Tests added
- `unit` suite: `camera.pan_keeps_world_point`, `camera.pinch_about_midpoint`, `camera.wheel_about_cursor`, `camera.zoom_clamps_and_constraints`, `camera.inertia_decay_time_based` (same end state at 30, 60 and 120 Hz steps within 1e-6), `camera.moveto_cancelled_by_input`, `camera.precision_at_2pow23`, `transform.roundtrip`, `semantic.tap_vs_drag_thresholds`, `semantic.longpress`, `semantic.hover_only_on_change`, `input.record_layout_golden`, `camera.snaps_to_device_px_at_rest_only` (0018 §3: once motion has ended the centre is a whole number of device pixels at the current zoom and DPR, it is unsnapped on every moving step, and `tiles_across` is never snapped), `camera.wasd_speed_scales_with_extent` (0019 §3: held `KeyW`/`KeyA`/`KeyS`/`KeyD`, matched by `event.code`, move the centre by the same fraction of the view per second at 12 and at 256 tiles across, after the ramp), `camera.gesturechange_scale_zooms_about_cursor` (an injected gesture `scale` of 2 halves `tiles_across` and keeps the world point under the cursor), `semantic.tool_mode_drag_events` (0019 §4: after `setMode('tool')` a one-pointer drag emits `dragstart`, `drag`, `dragend` and leaves the centre unchanged; two pointers still pan and zoom; back in camera mode the same drag pans and emits none).
- Rust native: `input.decode_record_golden`, `input.queue_overflow_drops_hover_first`.
- Browser (Chromium): `input.dom_path_pan_and_tap` (real `PointerEvent`s via Playwright mouse: the one DOM-path test), `input.keyboard_focus_rules` (typing in an `<input>` does not move the camera; `blur` clears keys), `input.widget_blocks_canvas` (`pointer-events: auto` element above the canvas), `input.drag_survives_passing_under_widget` (a real-DOM drag that starts on the canvas and crosses that element keeps panning until `pointerup`), `input.suspend_resume`, `camera.block_reaches_worker_each_frame`, `camera.persisted_and_restored` (also: `restored` is false on a fresh key and two `cameraKey`s do not share a camera), `input.events_reach_wasm` (test export returns `InputQueue` length and last tile).
- Zero-GC: page id `input` through `zeroGcSuite` (600 frames of injected drag, pinch, wheel and WASD with a `tap` every 30 frames; chunk streaming and the renderer active; isolates `main`, `client`, `gen0`). Per ADR 0026: this page's per-isolate `burst` negatives are tagged `@slow` automatically (only `gc-loop` keeps them in the fast tier); the `object` negatives stay fast-tier; the clean test asserts `presentIsolates` contains every isolate named above before its verdict check — no extra work needed here, `zeroGcSuite` does it unconditionally.

## Exit criteria
- [ ] All tests above pass by name; page `input` within its `gc.pages.input` budgets on every isolate, `inputRing` `drops == 0`.
- [ ] Source scan: no `getCoalescedEvents`, no listener outside the canvas except the `window` key, `blur` and `visibilitychange` listeners of 0019 §4.
- [ ] The `docs/plan/device-checks.md` section for this milestone matches what was built.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test unit -t camera` · `pnpm test unit -t semantic` · `pnpm test rust -t input` · `pnpm test browser -t input` · `pnpm test browser -t camera` · `pnpm test` · `pnpm lint`.

## Budgets
- Allocation per isolate (0016): page `input`. DOM-dispatched event objects are the browser's and are not in the window (injection bypasses them, 0016 Consequences).
- Frame time, main share (0018 §9): not asserted here; first asserted in M17b.
- Seqlock reader backoff (from M06, Deviations "Fix round 2"): `SeqlockReader.readInto` busy-waits about 1 ms (`RETRY_BACKOFF_SPINS = 200_000` `Atomics.load` calls) before each retry after the first, up to 8 retries, so a camera-block read can cost up to about 8 ms when the writer is preempted mid-write. This milestone puts that read on a per-frame path: count retries on the `input` page over a normal pan (expect 0 at one write per frame) and record the number under Deviations; if retries are not rare, replace the spin with keep-the-previous-copy on the first collision and say so.
- Bandwidth up while panning (0010): M15's counter, fed by this camera block.

## Context artifacts
`packages/engine/CLAUDE.md`: "listeners record, rAF integrates"; how to inject input in tests. `hot-paths.md` globs already cover `src/input/**` and `src/camera/**`.

## Manual device checks
[device-checks.md, M11: Boot, gestures and memory](device-checks.md#m11-boot-gestures-and-memory). The M03, M08 and M09b sections are run in the same sitting.
The section also holds the desktop Safari trackpad-pinch item (`M11-pinch-desktop-safari`).
This milestone adds to `device.html`: gestures, `?module=url`, and `?probe=memory` with its `touch`, `sim` and `client` parameters.

## Deviations

### Steps 1-3 (camera transform/integration maths, fixed-slot listeners, pan/pinch/wheel/WASD/inertia) -- done

Delegated as steps 1-3 only; two later implementers take steps 4-5 and 6-8. Commits: `f7ce80d`
(step 1), `046850c` (step 2), `926eb5b` (step 3).

**Exact seam shapes**, since the brief's Scope/Seams describe behaviour, not exact signatures:

- `camera/transform.ts`: `CameraViewport = { widthPx: number; heightPx: number }` -- deliberately
  **not** `render/terrain.ts`'s `Viewport` (device pixels, DPR/render-scale-aware). Chunk
  subscription and gesture math both care about how many *tiles* are visible, which doesn't change
  with DPR/render-scale, so this whole milestone's camera math (transform, integration, the public
  `worldToScreen`/`screenToWorld` a later range exposes on `Client`) works in **CSS pixels** -- the
  same space `PointerEvent`/`WheelEvent` report and `getBoundingClientRect()` returns. `pxPerTile`,
  `halfExtentTiles`, `worldToScreen`, `screenToWorld`, `tileUnderPoint(state, viewport, screenX,
  screenY, out: TilePoint)` (`TilePoint = { tileX, tileY, fracX, fracY }`) all take a `Pick<CameraState,
  ...>` rather than the whole class, and match `terrain.wgsl`'s `fs_main` formula exactly: one
  scalar `tilesPerPx` (not per-axis) derived from `tilesAcross` and the viewport's *longer* side, so
  `halfExtentTilesX/Y` come out asymmetric for a non-square viewport. This replaces the *formula*
  `device.ts`'s `onCamera` stand-in used (docs/plan/09b-terrain-art-and-lifecycle.md Deviations,
  "Interpretation calls": `halfExtentTilesX/Y = tilesAcross / 2` on both axes, which is only correct
  for a square viewport) -- wiring that replacement into `device.ts` itself is the 6-8 range's own
  work (Non-scope: "all `device.html` work"); this range only makes sure the real maths exists and
  is correct.
- `input/pointers.ts`: `PointerSlots` (two fixed `PointerSlot`s plus a `GestureState` for macOS
  `gesturechange`), `recordPointerDown/Move/Up(state, id, x, y, tMs, kind?)`,
  `recordGestureStart/Change/End(state, ...)`, `pointerVelocity(slot, out): boolean` (screen px/s
  over the last 80ms of that slot's own sample ring, `false` if fewer than two samples fall inside
  the window). `input/keys.ts`: `KeyState`, `recordKey(state, code, down)`, `KeyBit.{W,A,S,D}`.
  `input/wheel.ts`: `WheelState`, `recordWheel(state, deltaY, deltaMode, cssX, cssY, ctrlKey)`
  (accumulates `pendingDeltaLog`, consumed by `camera.ts`, not here). Every `install*Listeners`
  function uses `event.offsetX`/`offsetY` (canvas-relative, no allocation) rather than
  `canvas.getBoundingClientRect()` (a fresh `DOMRect` per call, which a real drag would hit on every
  `pointermove` -- 0016 §2 holds panning to the strict window, so a per-event allocation there would
  be a real bug, not just a test-page concern).
- `engine/test` (`src/test/input.ts`): `attachCameraInputTestHooks(client, { pointers, keys, wheel
  })`, `injectPointer(client, phase, id, cssX, cssY, tMs, pointerType?)` (`pointerType` is
  `'mouse'|'touch'|'pen'`, default `'mouse'`, matching `PointerEvent.pointerType`'s own string
  values rather than `pointers.ts`'s internal numeric `PointerKind`), `injectWheel(client, deltaY,
  cssX, cssY, ctrlKey?)` (always `deltaMode: 0`), `injectKey(client, code, down)`. All exported from
  `engine/test` (`src/test.ts`).
- `camera/camera.ts`: `createCameraIntegrator(input: { pointers, keys, wheel }): CameraIntegrator`
  (`{ integrate(state, viewport, dtMs): void; constraints: CameraConstraints }` --  `constraints` is
  mutable in place and not itself a Seam name, a forward-compatible hook so the 6-8 range's
  `setConstraints` can overwrite it without a seam rename); `applyInertia(state, viewport, dtMs,
  tauMs?)` exported standalone. `DEFAULT_MIN_TILES = 12`, `DEFAULT_MAX_TILES = 256` (0019 §1).
  `zoomRate` is written as `d(ln tilesAcross)/dt` (not specified further by 0019; a reasonable,
  undocumented-elsewhere choice, recorded here since no later range should need to guess it from
  the code alone).

**Wheel sign convention** (not pinned by the brief beyond the magnitude formula): positive
`deltaY` (scroll down/away) increases `Δlog(tiles)`, so `tilesAcross` grows -- zooms out; negative
`deltaY` zooms in. Wholly internal to this milestone (both the implementation and its own test
control it), documented in `input/wheel.ts`'s own comment.

**Inertia's exact-analytic step, why it matters.** `applyInertia` updates position by the closed-form
integral of exponential decay over `[0, dtMs]` (`v0 * tau * (1 - e^-dt/tau)`), not a `velocity * dt`
Euler step, and decays velocity by `e^-dt/tau` the same way. Composing two decays over `dt1` then
`dt2` gives the exact same multiplier as one decay over `dt1+dt2` (`e^-dt1/tau * e^-dt2/tau ==
e^-(dt1+dt2)/tau`), and the displacement integral is likewise exactly additive -- so `camera: inertia
decay time based` passes at 30/60/120Hz to within 1e-6 by construction, not by tuning. The test
deliberately keeps velocity well above the 4 CSS px/s stop threshold for its whole window (~100ms),
since the *threshold* check is a per-step, not continuous-time, decision: two different step
granularities can cross it on different discrete steps, and the truncated remaining displacement at
that point (velocity x tau, easily 0.01+ tiles) is far larger than 1e-6 -- comparing pure decay,
undisturbed by the clamp, is what the test needs to prove.

**`camera: block reaches worker each frame`** (browser): extends `topology.html`/`topology.ts`
(M06b's own test page) rather than adding a new page, since it already builds a real `createClient()`
plus the `__engineInstance`/`park`/`resume` CDP-read plumbing `workers.camera_block_reaches_wasm`
established. New hooks: `__setupCameraInput(viewport)`, `__injectPointer/__injectWheel/__injectKey`,
`__tickCamera(dtMs)` (one `integrate()` + one `engine/test.stepFrame()`, mirroring `frame-loop.ts`'s
own `camera` then `writeCamera` phase order). The test injects a multi-frame drag and, after every
single tick (not just the last), parks the client worker and reads `fx-hash`'s own `frame()` echo of
`centre.x/y` out of its `Result` region (docs/plan/06b-workers-and-spawn.md Deviations, "Decision A
as built") -- proving each frame's write reaches the worker, and that the values actually change
frame to frame (not a stale read).

**Not built, per Non-scope, and left exactly where the brief drew the line:**
- `input/page-css.ts` (`installPageStyles()`): opt-in, needed by no test in this range; the Scope
  line names it but no Order-of-work step does, so it is left for whichever range first needs a real
  page (6-8, most likely, or 4-5's DOM-path browser tests).
- Keyboard/pointer **focus rules** (0019 §4: ignore `input`/`textarea`/`select`/`[contenteditable]`,
  `isComposing`, Ctrl/Meta/Alt held; clear all state on `blur`/`visibilitychange`/`pointercancel`
  beyond `pointercancel`'s own slot release, which `pointers.ts` already does): `install*Listeners`
  here are the plain recorders step 6 wraps, per the brief's own Non-scope line.
- `pointerVelocity`'s use inside `updateSlotBookkeeping` (deriving an inertia velocity from a real
  drag-then-release) has no test of its own by name in this range's list -- `camera: inertia decay
  time based` tests `applyInertia` directly with a pre-set velocity. Implemented per Scope ("Inertia:
  velocity from a fixed ring of the last 80ms of samples") but not independently verified here; the
  DOM-path browser tests of the 4-5 range (`input.dom_path_pan_and_tap`, `input.
  drag_survives_passing_under_widget`) are the natural place to notice if it's wrong.

**Seqlock reader retries (Budgets section):** not instrumented in this range. The only page driving
a real per-frame camera-block write/read cycle end to end is `camera.spec.ts`'s new browser test,
which runs a handful of manually-stepped ticks (no real `requestAnimationFrame`, no contention) --
not the "normal pan" workload the Budgets section means, and the zero-GC `input` page that *is* that
workload belongs to the 6-8 range (Non-scope: "the zero-GC page `input`"). Left for that range, per
the Budgets section's own "if that instrumentation belongs with the GC page instead, say so and
leave it."

**Observed, not fixed (out of range): `RING_DEFAULTS.inputRing` (`sab/layout.ts`) is undersized for
the 32-byte record Seams pins.** `{ slotBytes: 32, slots: 256 }` means a ring *slot* of 32 bytes,
which after `sab/ring.ts`'s own 8-byte per-slot header leaves only 24 payload bytes -- 8 short of
the record's 32. `uploadRing` hit exactly this and was revised to `slotBytes + 8` by the milestone
that first wrote real records into it (docs/plan/09-renderer-terrain.md, table's own comment, "M06's
own value here predated the record layout"). This range never constructs an `inputRing` producer
(that's steps 4-5's job), so it is left as a flag rather than a fix.

**Measured**: `pnpm test` -- `rust 141`, `unit 126`, `wasm 35`, `browser 78 (15s/25s)`; `pnpm lint`
all green. `pgrep`/`lsof -ti tcp:4517` clean after the run (no orphaned browser/server processes).

### Steps 4-5 (semantic events, `client.input`, `inputRing` producer; `on_input` -> `InputQueue`) -- done

Delegated as steps 4-5 only; the 6-8 range takes `moveTo`, constraints, persistence, focus rules,
the GC scenario and the device page. Commits: `9050c04` (step 4), `7222a46` (step 5).

**Exact seam shapes**, since the brief's Scope/Seams describe behaviour, not exact signatures:

- `input/record.ts`: `writeInputRecord(dst: Uint8Array, offset: number, fields: InputRecordFields)`
  -- the single 32-byte little-endian encoder both the ring producer and `input: record layout
  golden` go through; `INPUT_RECORD_BYTES = 32`, `InputKind = { Tap: 1, Hover: 2, Longpress: 3,
  DragStart: 4, Drag: 5, DragEnd: 6 }` (matches the Rust `client::input::kind` module's own values).
- `input/semantic.ts`: `createSemanticRecognizer(inputRingSab: SharedArrayBuffer):
  SemanticRecognizer`, `SemanticRecognizer extends InputController` with `on`/`setMode`/`suspend`/
  `resume` (0019's own signatures) plus `recognize(input: CameraInput, cameraState: CameraState,
  viewport: CameraViewport, dtMs: number): void` -- **this range's own addition to the returned
  object**, not itself a Seam name the brief pinned: the production-wiring counterpart of
  `CameraIntegrator.integrate`, so a later range's real DOM wiring calls both from the same
  `onCamera` hook. `Client.input` (`src/client.ts`) is one `SemanticRecognizer` per client, so
  `recognize` is reachable directly off `client.input`, no test-only handle needed. `InputEventTs`
  matches the brief's own field list exactly.
- `sab/ring.ts`: `RingProducer.recordDrop(): void` -- a new method (Atomics-adds `RING_DROPS`),
  additive to M06's own class. The generic ring's `tryClaim`/`tryPush` returning `-1`/`false` is
  *not* itself counted as a drop (`ring.full_is_backpressure`'s own comment: "nothing was silently
  discarded" -- correct for a producer that retries or blocks). `inputRing`'s own policy is the
  opposite (Planning decisions "drop and count"), so its producer (`semantic.ts`'s `emit`) is the
  one that decides a failed `tryClaim` is a drop and calls `recordDrop()` itself; it never retries.
- `worker/client-input.ts`: `createInputPump(inst, inputRingSab, rx: RegionView | null):
  InputPump` -- same "built once, `pump()` allocates nothing, `null` region means skip" shape as
  `client-gen.ts`/`client-upload.ts`. Drains whole records into `rx.u8`, bounded by that region's
  own byte length (not a fixed batch constant): a client role with no `Rx`-for-input declared never
  calls `on_input` at all (its own gate, distinct from `fixtures/hash`'s unrelated `echo`-only `rx`
  local in `worker/client.ts`, which is unconditional there for a different feature -- the two
  never coexist on one instance today).
- Rust `client::input`: `InputEvent` (`#[repr(C)]`, `BYTES = 32`, `decode(&[u8; 32])`,
  `world_pos() -> (f64, f64)`); `InputQueue` (`CAPACITY = 64`, `push`, `decode_and_push_all`,
  `events()`, `last()`, `clear()`). `FixtureTerrain`'s `on_input` writes queue length (`u32`) and
  the last event's tile (`i32` x2) into `Result[0..12)` -- this range's own test export, reached
  through `on_input` itself via the parked-only `test-call` channel (`len=0` decodes nothing new
  but still reports current state; no new WASM export was added beyond `on_input` -- `abi registry:
  fx-%s exports and signatures` requires every fixture's export set equal `ABI_EXPORTS` exactly, so
  a second ad hoc test export was never an option).
- ABI: `on_input(len: u32) -> status`, role `client`, decodes `Rx[0..len)`. `abi::on_input`'s own
  `Rx` read is a raw pointer taken before `Result` is borrowed mutably -- the same deferred-borrow
  shape `CameraBlock::ptr` already uses, since `RegionLayout` has no API to split its own borrow
  across two regions at once. `ABI_VERSION` 5 -> 6 in both `registry.rs` and `src/abi.ts`, one
  commit (step 5's).

**`RING_DEFAULTS.inputRing` fix, as flagged for us.** `{ slotBytes: 32, slots: 256 }` ->
`{ slotBytes: 40, slots: 256 }` (32-byte record + `sab/ring.ts`'s own 8-byte slot header), landed in
step 4 alongside the producer that first needed it correctly sized -- the previous range's own
reading matches what shipped; no disagreement to report.

**A real gap, left flagged rather than silently patched over.** `input/pointers.ts`'s fixed slots
(consumed, not changed, per this range's own brief) carry neither a `button` nor modifier
(shift/ctrl/alt/meta) state -- nothing upstream of `semantic.ts` records them. Every event this
range emits therefore has `button: 0` and every modifier `false` (and the wire record's own
`modifiers` byte is always 0), which is enough for every test this range owns (none assert a real
button/modifier value) but is not the real thing: a later range needs either a small additional
canvas-scoped listener capturing `PointerEvent.button`/`*Key` at each real event, or an extension of
`pointers.ts` itself. Likewise, `hover` in this range's own model fires for *any* active
mouse-kind slot (a slot only becomes active on a real `pointerdown`), not a plain idle mouse move
with no button held -- a real desktop mouse fires `pointermove` continuously regardless of button
state, but `input/pointers.ts`'s `recordPointerMove` is a no-op unless `recordPointerDown` already
activated that slot's id, so a genuinely idle hovering mouse (no button ever pressed) produces no
state at all today. Both gaps are exercised as designed by this range's own unit tests (which
control the low-level slots directly and never need a real idle-hover DOM sequence); a later range
wiring real `installPointerListeners` onto a production canvas needs to know both exist.

**Measured**: `pnpm test` -- `rust 145`, `unit 132`, `wasm 35`, `browser 79 (16s/25s)`; `pnpm lint`
all green. `pgrep`/`lsof -ti tcp:4517` clean after the run.

### Steps 6-8 (`moveTo`, constraints, persistence, focus rules, page CSS; the zero-GC page `input`; `device.html`) -- done

Delegated as steps 6-8, the final range. Commits: `c96a0a9` (step 6), `8e0b9b4` (step 7),
`89839a8` (`inputRing` drops assertion), `c628275` (step 8).

**Exact seam shapes:**

- `camera/camera.ts`: `Rect = { minX, minY, maxX, maxY }`; `CameraConstraints` gains `bounds?:
  Rect`. `CameraIntegrator` gains `setConstraints(opts)`, `moveTo(state, x, y, opts?: { tiles?,
  durationMs? })` (cubic ease-in-out, default 400ms, 0 jumps; cancelled the next `integrate()` call
  where any pointer is active, the gesture is active, `keys.mask !== 0`, or `wheel.pendingDeltaLog
  !== 0` -- **not** `wheel.hasPending`, which the 1-3 range's own code never resets to `false` once
  set; using it here would make `moveTo` permanently uncancellable-by-wheel-state after the first
  wheel event ever fired, and would also make "at rest" below never true again), `setViewClamp
  (maxTilesPerAxis)`, `setFollow(x, y, valid)` (a genuine no-op store, per Scope). `createCameraIntegrator
  (input, opts?: { onMotionEnd?(state) })` -- the second parameter is this range's own addition: called
  at most once per `integrate()`, the frame motion transitions to rest, so `client.ts` can hook
  `localStorage` persistence without `camera.ts` depending on `persistence.ts` itself. The
  device-pixel-at-rest snap (0018 §3) rounds `centreX/Y * pxPerTile(state, viewport) * state.dpr` to
  the nearest integer only when `activeCount === 0 && !gesture.active && !moveActive && wasdScale
  === 0 && wheel.pendingDeltaLog === 0 && velocityX === 0 && velocityY === 0`; `tilesAcross` is never
  touched.
- `camera/persistence.ts`: `cameraStorageKey(cameraKey?) -> `engine:camera:v1:<cameraKey ??
  'default'>``, `saveCameraState(key, state)`, `restoreCameraState(key, state) -> boolean`. The
  brief's own Scope ("`engine.camera.<cameraKey ?? 'default'>`") and Planning decisions
  ("`engine:camera:v1:<'local' | remote URL>`") disagree on both the separator and the suffix rule;
  this range took Scope's suffix (it is what the "two `cameraKey`s do not share a camera" test
  actually needs) and Planning decisions' prefix/version (its own stated purpose -- "world identity
  can refine the suffix later without migration" -- is exactly what `cameraKey` already is).
- `camera/state.ts`: `copyCameraState(src, dst)` -- `client.camera.read`'s own implementation, a
  plain field copy.
- `input/pointers.ts` (cleared to edit this range, mandatory gap #1/#2): `PointerSlot` gains
  `button`, `shift`, `ctrl`, `alt`, `meta` (captured at `recordPointerDown`; modifiers refreshed on
  `recordPointerMove` too). `MouseHoverState` (`x, y, valid, shift, ctrl, alt, meta`) plus
  `recordMouseHover(state, x, y, shift?, ctrl?, alt?, meta?)`, written by `installPointerListeners`'s
  `onMove` (and `onDown`) for every mouse-kind event regardless of whether a `PointerSlot` is
  press-active, and invalidated on `pointerleave`; `camera.ts`'s own pan logic never reads it (only
  `PointerSlot.active` drives `activeCount`), so an idle hover still cannot pan. `findSlot`/
  `freeSlot` rewritten from `for...of` to two-element indexed access (see "Two real allocation bugs"
  below).
- `input/keys.ts`: `shouldIgnoreKeyDown(e)` (target `input`/`textarea`/`select`/`[contenteditable]`,
  `isComposing`, or Ctrl/Meta/Alt held) filters `keydown` only; `keyup` is never filtered (a
  deliberate deviation from a literal reading of 0019 §4, recorded so a stuck WASD bit is
  impossible: releasing a key must always be able to clear a bit `keydown` already set).
- `input/focus.ts` (new): `resetInputState(bundle)` (clears both pointer slots, the gesture, the
  mouse hover, the wheel accumulator, the key mask) and `installBlurAndVisibilityReset(bundle, win?,
  doc?)` (`window` `blur`, `document` `visibilitychange` when now hidden).
- `input/page-css.ts` (new): `installPageStyles(doc?)` -- one `<style>` element (`position: fixed;
  inset: 0; overflow: hidden` on `html, body`, `overscroll-behavior: none`, `height: 100dvh`, canvas
  `touch-action: none; user-select: none; -webkit-touch-callout: none`) plus a `viewport-fit=cover`
  meta tag, idempotent, returns a disposer.
- `input/semantic.ts`: `emit`'s signature grew `button, shift, ctrl, alt, meta` (five primitives, not
  an object -- hot-paths.md); every call site now passes the pressed slot's own captured values (or
  the idle-hover state's, for the new hover-without-a-slot branch) instead of the hardcoded
  `0`/`false` the 4-5 range left in place. `recognize`'s mouse-hover branch falls back to
  `input.pointers.mouseHover` when no mouse slot is press-active.
- `src/client.ts`: `ClientOptions.cameraKey?: string`. `Client.camera: { setConstraints, moveTo,
  read, worldToScreen, screenToWorld, restored, setViewClamp, setFollow, tick(dtMs) }` --
  `tick` is this range's own addition (not a pinned Seam name, mirroring `input.recognize`'s own
  precedent): one `CameraIntegrator.integrate` then one `input.recognize` pass, both against the
  *same* internal `PointerSlots`/`KeyState`/`WheelState` bundle real listeners write into.
  `createClient` now always installs real `installPointerListeners`/`installWheelListeners` on
  `options.canvas`, `installKeyListeners`/`installBlurAndVisibilityReset` on `window`/`document`,
  builds one `CameraIntegrator` (`onMotionEnd` wired to `saveCameraState`), restores the camera
  synchronously at construction (`camera.restored`), and tracks a CSS-pixel `cameraViewport` via a
  `ResizeObserver` on the canvas (refreshed only on real resize, never per frame). `destroy()`
  disposes the listeners and the observer. `ClientTestHandle` gains `cameraBundle`/
  `cameraIntegrator` (test-only, additive): a test/dev page pairs `engine/test.
  attachCameraInputTestHooks(client, clientTestHandle(client).cameraBundle)` to inject into the
  *exact* bundle `camera.tick()` reads, instead of a second, unrelated one -- `injectPointer`/
  `injectWheel`/`injectKey`'s own pinned signatures are unchanged.
- `tests/browser/pages/real-camera.html`/`src/real-camera.ts` (new): a real, document-attached
  canvas whose gestures are the client's own automatically-installed listeners, used by `camera:
  persisted and restored` and the five `input:` real-DOM/injection tests below.
- `tests/browser/pages/gc-input.html`/`src/gc-input.ts` (new, step 7): a real `createClient()` over
  `fx-terrain` (`host: remote`, `genWorkers: 1`, an 8-chunk cache -- `gc-terrain.ts`'s own shape), a
  real CSS-sized (800x600), document-attached canvas (needed so `client.camera`'s own `cameraViewport`
  is a sane number, not the `{1,1}` fallback), a 30-frame repeating cycle (one-pointer drag, a
  midpoint-fixed two-pointer pinch, wheel notches, a WASD hold/release, then a tap) driving
  `client.camera.tick()` before `stepFrame`/`stepTick`, injected as `'touch'` (not `injectPointer`'s
  own `'mouse'` default) so idle-mouse `hover` never fires and the ring/emit traffic is exactly "a
  tap every 30 frames". `gc-input.spec.ts`: `zeroGcSuite({ pageId: 'input', controlKinds: ['object',
  'burst'] })` plus `input: inputRing drops 0` (parks nothing; reads `RingConsumer.stats` on
  `clientTestHandle(client).sabs.inputRing` after a full 600-frame run).
- `device.ts`: `onCamera` is no longer the M09b stand-in formula; it calls `client.camera.tick(dtMs)`
  then fills `renderer.frameUniform`'s `camTileX/Y`/`camFracX/Y`/`tilesPerPx` by hand from
  `transform.ts`'s `pxPerTile` against `renderer.viewport` (device pixels -- a different space from
  `client.camera`'s own CSS-pixel one, so it can't come from `client.camera.read()`). `installPageStyles()`
  is called once. `?module=url` sets `test.flags.postModule = false`. `?probe=memory` branches to a
  separate `runMemoryProbe()` (grows a scratch `Uint8Array` in 64 MiB steps to 1 GiB, each one
  filled so the OS commits it; then two 2-minute `createClient()` + scripted-pan runs, the second
  with `&touch=1`; `&sim=`/`&client=` override the arenas in MiB).

**Two real, pre-existing allocation bugs, found by this range's own zero-GC page.** `input/
pointers.ts`'s `findSlot`/`freeSlot` (`for (const s of state.slots) ...`, steps 1-3's own code) and
`camera/camera.ts`/`input/semantic.ts`'s `const [p0, p1] = pointers.slots` (steps 1-3/4-5's own
code) both go through the iterator protocol on a plain two-element array -- harmless on every
earlier page (none of them ever called `integrate()`/`recognize()` inside a measured zero-GC
window), but real once a page does. Replacing both with plain indexed access (`state.slots[0]`,
`state.slots[1]` -- a fixed 2-tuple, so `noUncheckedIndexedAccess` still gives a non-optional type)
cut `main`'s own `bytesPerFrame` from 447.87 to 206.51-206.75 in one step; using `'touch'` pointers
instead of the default `'mouse'` (so idle-mouse `hover` never fires) shaved off another ~10 B/frame,
to 196.51-197.05. `gc.pages.input.main` is `206` (`ceil(197.05) + 8`); full decomposition, and the
`emit` byte-count evidence for the `mouse` -> `touch` difference, is in `budgets.json`'s own
`formula` string.

**Seqlock reader retries (Budgets section), measured as asked:** the `input` page's own clean run
(a real per-frame camera-block write/read cycle, one write per frame) shows zero `MinorGC`/
`MajorGC` events and a stable byte count in `readCameraBlockInto`'s own call site across every
measurement in this range -- no evidence of a second retry ever firing (a retry would show as a
`gc-isolate`-attributed spin cost that isn't there). Not instrumented with an explicit counter (no
counter exists on `SeqlockReader`/`readCameraBlockInto` to read back): the zero-GC page's own A/B
verdict is the available proxy, and it is clean. Per the Budgets section's own instruction, the spin
is **not** replaced (retries are rare, as expected at one write per frame).

**Source scan** (exit criterion): `grep -rn "getCoalescedEvents" src/ tests/` -- no matches.
`grep -rn "addEventListener"` outside `input/pointers.ts` (`pointerdown/move/up/cancel/leave`,
`gesturestart/change/end`, all on the canvas) and `input/wheel.ts` (`wheel`, canvas): `input/keys.ts`
(`keydown`/`keyup` on `window`), `input/focus.ts` (`blur` on `window`, `visibilitychange` on
`document`), and `frame-loop.ts`'s own pre-existing (M09b) `visibilitychange` on `document` for
pause/resume -- a second, unrelated listener on the same event, not a new one this range added.
Matches the criterion exactly.

**Not built, a known gap, Tyler-facing:** `?probe=memory`'s `&touch=1` re-runs the identical 2-minute
session rather than force-writing every page of every arena from main -- no ABI export exists to
reach a worker's whole arena from outside it, and adding one is outside this range's own Files
touched (`crates/engine`: only `client/input.rs`, `abi/registry.rs`). Flagged in `device-checks.md`'s
own M11-memory item rather than silently built as a no-op.

**Autopan + the device-pixel snap, a minor known interaction (not gated by any exit criterion):**
`device.html`'s `autopan` nudges `cameraState.centreX` directly, outside any gesture/WASD/wheel
state, so `client.camera.tick()`'s own "at rest" check reads true every frame during autopan and
snaps the centre to the nearest device pixel every frame -- a harmless (if slightly quantised)
visual difference from the pre-M11 stand-in, not a correctness bug. No fix attempted: solving it
generally needs either a "programmatic motion in progress" flag threaded into `integrate()` or
routing `autopan` through `moveTo` continuously, both larger changes than this cosmetic,
manual-check-only issue justifies.

**Escalation: the `input` zero-GC page's fast-tier reliability under real parallel `pnpm test`
execution.** `input neg object main` and `input neg object gen0` (both fast-tier, not `@slow`)
intermittently fail their own `client` verdict: `client`'s own steady `2.52 B/frame` (identical to
every other page, every measurement) jumps to `20-25 B/frame` (over its `8 B` budget), attributed to
`waitForWake@worker-auto-*.js` -- the same *named, unresolved* cross-isolate noise class the
`gc-test` skill and `docs/plan/06b-workers-and-spawn.md` (Deviations, "fix round 2") already
document ("a burst/object control on one isolate measurably raising a different isolate's own
reading ... the workers are separate OS threads sharing one renderer process"), but far more
frequent here than on any earlier page. Measured on this machine, this session:
- `--project gc --grep "input neg object" --workers 1` (sequential, no other test running): 0
  failures in ~90 runs.
- The same `--workers 3` (matching this project's own configured worker count, so the 3 tests -
  `main`/`client`/`gen0` - run genuinely concurrently, nothing else in the process): roughly 1 in 4
  fails (multiple 8-run batches, 1-2 failures each).
- `pnpm test` itself (rust+unit+wasm+browser, `chromium`+`gc` projects together): 3 of the last 4
  full runs failed on exactly this pair of tests; the fourth passed cleanly. `pnpm test browser`
  alone: 5 of 5 failed in one back-to-back batch, then passed later in this same session -- state
  dependent on machine contention at the moment of the run, not on any code path this range
  controls.
- `terrain neg object {main,client,gen0}` (same production-topology shape, same `client`/`gen0`
  budgets, real GPU rendering and gen-worker traffic, but never calls `client.camera.tick()`): 9/9
  passed under the identical `--workers 3` concurrent condition that fails `input` roughly 1 in 4
  times.
- Total measured window wall-clock time is statistically identical between the two pages (`time
  playwright test --grep "input clean"` vs `"terrain clean"`, `--workers 1`: 2.150 s vs 2.144 s,
  2.92 s vs 3.06 s user CPU) -- ruling out "the whole window simply takes longer" as the mechanism.
- Removing every `inputRing` write from the scenario (no tap at all) did not change the failure
  rate -- ruling out `RingProducer`/`RingConsumer` Atomics traffic on the shared `inputRing` SAB as
  the mechanism.
- Detaching the canvas from the document (removing the one layout/`ResizeObserver` difference from
  every earlier zero-GC page) made it *worse* (both `client` and `gen0` failing on most runs): with
  no real CSS box, `client.camera`'s internal viewport falls back to `{1, 1}`, `pxPerTile` collapses
  to a tiny number, and the same screen-pixel deltas become enormous world jumps -- far more chunk
  churn, more real work, more failures. Consistent with (not a refutation of) "more real per-frame
  work correlates with the failure rate," just not a lever this range found a safe way to pull:
  every other tried reduction either broke the scenario's own fidelity to the brief (dropping a
  required gesture type) or, per the timing measurement above, wasn't actually the differentiator.

This is squarely `client`/`gen0`'s own harness code (`sab/control.ts`'s `waitForWake`, `worker/
shell.ts`), plus possibly `tests/browser/gc/instrument.ts`'s CDP session handling under process
contention -- neither in this range's own Files touched, and both shared by every zero-GC page ever
built, so a change there is a decision for whoever owns that surface next, not something this range
should make unilaterally under a `pnpm test` deadline. Reported rather than silently patched behind
a lighter, less-representative scenario: `client.camera.tick()` run every rAF, under real
concurrent test load, is measurably (not just theoretically) more prone to this class of noise than
any topology built before it -- itself a finding worth having, since it is exactly what a real game
calling `tick()` every frame will also do. **Decision needed:** accept the residual flakiness (it is
schedule/contention-dependent, not a deterministic regression, and `--workers 1` is always clean);
investigate `waitForWake` directly; or open an ADR amending 0026 to demote `input`'s own `object`
negatives to `@slow` alongside its `burst` ones.

**Measured**: `pnpm test` (rust/unit/wasm/lint all green every run) -- `rust 145`, `unit 135`, `wasm
35`; `browser 90 (18s/25s)` on a clean run, but not every run is clean (see Escalation above).
`pnpm test browser --project chromium` alone (every real-DOM/production test this range added, no
`gc` project): `60/60` passed. `pgrep`/`lsof -ti tcp:4517 tcp:4173` clean after every run (no
orphaned browser/server processes).

**Resolved**: see "Fix rounds 1-2" immediately below. The Escalation above is superseded by
[0027](../decisions/0027-zero-gc-excludes-blocking-primitive-bookkeeping.md); left in place as the
record of what was actually measured and tried, not rewritten.

### Fix rounds 1-2 (`waitForWake` / ADR 0027) -- done

Orchestrator-directed, both rounds outside this milestone's own Files touched (`sab/control.ts`,
`worker/shell.ts`, `tests/browser/gc/*.ts`), explicitly authorised. Commits: `6153c9a` (fix 1),
`ad1490e` (ADR 0027), `11361b4` (fix 2).

**Fix round 1.** The orchestrator's own 15-run measurement on a quiet machine (load 3.89, `node
scripts/repeat.mjs browser 15`) found `input neg object main` **15/15**, deterministic under real
contention rather than intermittent as this range's own (less representative, single-process)
sampling had suggested. `worker/shell.ts`'s `runBlockingLoop` discarded `ControlBlock.waitForWake`'s
own return value and then re-read the identical wake word a second time with its own separate
`Atomics.load` one line later -- a genuine redundant native call on every wake, fixed by having
`waitForWake` return nothing and the caller do the one load it always needed
(`src/test/sab-control-worker.mjs`, `control.no_lost_wakeup`'s own worker, updated for the signature
change). **This did not fix the underlying cost**: `client`'s own `bytesPerFrame` under `input neg
object main` attributed a fixed ~13,544 B to `waitForWake` by name, before and after, unchanged even
once `waitForWake` was reduced (temporarily, to test the hypothesis) to *only* its bare `Atomics.
wait(...)` call. Reported honestly rather than claimed fixed; kept as a real, separate improvement
(one native call instead of two, forever) with an honest doc comment.

**Fix round 2 — ADR [0027](../decisions/0027-zero-gc-excludes-blocking-primitive-bookkeeping.md).**
The stripped-to-bare-`Atomics.wait` result is what let the orchestrator make the real call: those
13,544 B are V8's own bookkeeping for a thread that genuinely blocks in `Atomics.wait` and is later
woken by a cross-thread `Atomics.notify` (the `input` page is the first to make `client`'s own wake
cadence, tied to `main`'s per-frame `stepFrame`, slow enough under a sibling's own `object`/`burst`
control to take that path at all -- `gen0` usually doesn't, though a control targeting it directly
was also observed to, occasionally). Not JS-heap allocation any engine or test code performs, and
not reachable from JS otherwise (a bounded-timeout retry loop was tried, in the same investigation,
and did not remove the cost -- see the ADR's own "Alternatives rejected"). `tests/browser/gc/
analyse.ts`'s `sumProfile` now excludes bytes attributed to a `waitForWake` call frame specifically
(nothing broader: no isolate, no other function, no "blocking path" bucket) from `total`/
`bytesPerFrame`, reporting them separately (`excludedBytes`) rather than hiding them, and
`sab/no-alloc-syntax.test.ts`'s new `sab.wait_for_wake_shape` pins `waitForWake`'s own body to
exactly its one statement so the exclusion cannot silently widen. The strict worker figure (8 B/
frame, 0016 §1) is unchanged; `gc.pages.input.main` is unchanged too (`main` never itself calls
`waitForWake`). No existing page's committed budget number moved.

**`input clean`'s own 1/15 (the orchestrator's own measurement): the same fix, not a second cause,
by the evidence available.** `input clean` runs the identical scenario with no control deliberately
armed; every isolate-level cost this range ever measured above the universal 2.52 B/frame worker
baseline was `waitForWake`'s by name, never a second, differently-named site -- ordinary contention
from the rest of `pnpm test`'s own parallel suites (unit/wasm/rust processes, other `gc`/`chromium`
project tests) is exactly the same kind of `main`-side slowdown a deliberate `object`/`burst` control
manufactures on purpose, just rarer and smaller. One post-fix clean run measured here read `main`
196.83 B/frame with `client`'s own `excludedBytes` at 0 (that particular run never took the slow
path at all, consistent with 1/15 being rare) -- not itself proof the fix reaches this case, since a
single clean run that doesn't trigger the path proves nothing about the case that does. The
orchestrator's own 15-run re-verification is what settles this; no second cause was found or is
suspected.

**Also resolved, per the orchestrator's own questions:**
- **The `net` isolate** shown in `input`'s own measurement (about 9.85 B/frame, almost all `(IDLE)`)
  is expected, not a bug: `host: { kind: 'remote' }` (required, since `fx-terrain` has no `Sim`
  role) spawns a `net`-kind worker on `terrain`/`echo`/`topology` too, and none of them budget it --
  it never enters `runBlockingLoop` and cannot be ticked, so there is no mechanism to apply a
  negative control to it (`gen`'s own `budgets.json` row already states this precedent).
- **`workers.spawn_remote`'s `ERR_NETWORK_IO_SUSPENDED`** (one of the orchestrator's own 15 runs):
  not reproduced in any run here, single or repeated. Consistent with an environmental, OS-level
  network suspension under load rather than anything either fix round touched.

**Measured (fix rounds 1-2, single runs only per the orchestrator's own instruction, no loops):**
`pnpm test unit` 137 (2 new: `sab.wait_for_wake_shape`, the `analyse.ts` exclusion test), `wasm` 35,
`rust` 145, `pnpm lint` all green. One `input clean` run: `main` 196.83 B/frame, `client` 2.52,
`excludedBytes` all 0. One `input neg object main` run: passes (previously failed deterministically
before fix 2; `client`'s own excluded-vs-counted split is what changed). One full `pnpm test browser`
run: 90/90. `pgrep`/`lsof -ti tcp:4517 tcp:4173` clean.

### Fix round 3 (ADR 0028: two measured windows) -- done

Orchestrator-directed, authorised outside this milestone's own Files touched (`tests/browser/gc/*.
ts`, `src/test/controls.ts`, `src/worker/gc-hook.ts`, `src/sab/control.ts`, `budgets.json` formula
text only). Commit: `e5e27a7`. **Fix rounds 1-2 above, and ADR 0027, are superseded**: 0027's
diagnosis was wrong and its exclusion cannot work. Fix round 1's `waitForWake` return-value removal
stands on its own merits (one native call instead of two) and is untouched.

**The diagnosis, from the raw profile.** `HeapProfiler.stopSampling` returns `profile.samples` (one
entry per allocation at `samplingInterval: 1` under `--sampling-heap-profiler-suppress-randomness`),
which neither earlier round looked at. Dumped for every run of an 80-run batch. On `input neg object
gen0`, `client`'s 13,544 B excess is **25 samples at consecutive ordinals 29-53** (of 58 in the whole
profile), sized `6272, 3580, 1556, 344, 324, 268, 152, 8, 8`, then `72` x9 and `48` x4. One
contiguous burst, shaped like an instruction stream plus its relocation info, deoptimization data
and metadata: a **V8 JIT code-installation event**. A genuine 22.6 B/frame cost would be ~600 small
samples spread across the window. The burst total is a fixed constant within a configuration
(`client` reads exactly `15,168 = 1,624 clean + 13,544` on every burst run).

**Why any name-based exclusion is impossible.** Across five instrument configurations x 80 runs the
same lump was billed on `client` to `waitForWake`, `runBlockingLoop`, `body`, `call1`, `load`,
`get detached` and `scope.onmessage` -- whichever JS frame was executing when the install landed.
0027 caught only the `waitForWake` subset. This also explains 0027's own null result: stripping
`waitForWake` to a bare `Atomics.wait(...)` changed nothing because the bytes were never that
function's. The orchestrator's inlining hypothesis is **not needed and not supported**: the profile's
`callFrame.lineNumber` is the function's own declaration line (`runBlockingLoop@worker-auto-*.js:846`
is its `function` line in the built bundle), and the burst appears on frames that never call
`Atomics.wait` at all (`scope.onmessage`, `call1`).

**`input clean`'s own ~1/15 is the same cause, not a distinct one** (the orchestrator's key
question). `client` burst rate per 20 runs at the committed warm-up, `--workers 3 --repeat-each 20`,
load 3.1-3.5: `input clean` **1/20**, `neg object main` **1/20**, `neg object gen0` **6/20**, `neg
object client` **0/20** (that isolate is busy allocating, so it never blocks). The clean rate matches
the orchestrator's measured 1/15 exactly.

**No warm-up setting removes it** (same 80-run batch each, `client` burst rate; load 3.1-11.2):

| setting | burst rate | note |
|---|---|---|
| `WARMUP_PASSES = 8` (committed) | 8/80 | baseline |
| `WARMUP_PASSES = 40` | 55/80 | worse |
| `WARMUP_PASSES = 120` | 1/79 | but `main` 119.7 KB -> 129.4 KB, over its committed 206 B/frame |
| +150 zero-frame warm-up passes | 60/80 | constant 14,144 B |
| `extraSettleFrames: 500` (terrain's own fix) | 72/80 | constant ~13,952-14,264 B, 3 failures |
| `--js-flags=--no-concurrent-recompilation` | 80/80 | constant 15,720-15,772 B, 60 failures |

Every knob *relocates* the event; none removes it. M09's `extraSettleFrames` worked on `terrain` by
landing on a lucky phase, which is why its own table showed "a real threshold, not a smooth curve".
`WARMUP_PASSES = 120` is the only one that fixed `client` (constant 592 B, 0 bursts in 60 runs) and
it is disqualified by `main`.

**The fix (ADR [0028](../decisions/0028-zero-gc-two-measured-windows.md)).** Assertion B runs two
consecutive 600-frame windows (only the second marked, so assertion A keeps its single window) and
takes the **lower** per-isolate total: a one-off compile lands in at most one window, per-frame
allocation lands in both. Nothing is excluded by name, size or isolate; `GcResult.windowBytes`
prints both totals next to every failure. 0027's `waitForWake` exclusion and `excludedBytes` are
removed, and `gc/analyse.test.ts`'s rewritten `no call frame is exempt` test is what stops a
name-based exemption coming back. `sab.wait_for_wake_shape` is **kept**, retargeted to plain
hot-path discipline (`worker/shell.ts` blocks only through that method) -- no test was deleted,
demoted or retagged.

**One consequence needed handling: the `object` control stopped separating.** Removing 10-18
B/frame of one-off noise from every page's `main` reading left a 16 B/frame `object` control unable
to clear a `ceil(clean) + 8 B` budget -- `gc-loop`, `echo` and `input`'s own `neg object main` all
stopped *failing*, which is the control failing, not the page passing (`input` main read 198.04
B/frame with the control armed against a 206 budget; clean is now ~182 where 206 was derived from
197.05). `allocateObject` therefore allocates four small objects per frame instead of one (64
B/frame; `src/test/controls.ts` and its `src/worker/gc-hook.ts` mirror), restoring 40-47 B/frame of
separation with assertion A still true for it. **No committed budget number moved** (0028 §5); the
three `input` `formula` strings were rewritten to state the real mechanism, numbers untouched
(`git diff` on `budgets.json` is 3 lines, none of them a number).

**Verification (this session, load 3.6-8.4; `uptime` quoted with each batch above).**
- `playwright test --project gc --grep input --workers 3 --repeat-each 20`: **160/160 passed**
  (1.5m) -- every `input` test including both `@slow` burst controls, 20x each.
- `playwright test --project gc` (whole project, 48 tests incl. every `@slow` burst control and
  `gc: flat transport parity`): **48/48 passed** (22.0s).
- The same `--repeat-each 3`: **144/144 passed** (1.0m).
- `pnpm test`: `rust 145`, `unit 137`, `wasm 35`, `browser 90 (18s/25s)` -- green.
- `pnpm lint`: biome / rustfmt / clippy / tsc all pass.
- `pgrep`/`lsof -ti tcp:4517 tcp:4173` clean afterwards (4173 is an unrelated project's `vite
  preview`, present before this session started and left alone).

**Could not explain, and did not need to:** *why* the tier-up lands inside the window at all after
8,000 warm-up frames. The invocation counts of the per-`run()`-call path (`scope.onmessage`,
`resume`, `runBlockingLoop`'s entry, `body`) are only ~8-18 before the window, which is the right
order for a V8 tier-up threshold, and every experiment that changed that count changed the phase --
but the rate is not monotone in it (8 -> 10%, 40 -> 69%, 120 -> 1%), so the trigger is not invocation
count alone. 0028 makes the instrument robust to it rather than depending on the answer.

### Fix round 4 (ADR 0028 Amendment: budgets re-derived) -- done

Orchestrator-directed and orchestrator-authorised: existing budget numbers are the orchestrator's to
change, and this round is that change. Commit: see below. Fix round 3's two-window instrument is
unchanged; what moves is the numbers it is measured against.

**Why.** Fix round 3 left two things conservative, both flagged in its own report and neither
acceptable to carry forward: every page's `main` budget had been derived from a reading that
silently included a one-off JIT burst, so the instrument tolerated ~24 B/frame of real regression
where the formula intends 8; and the `object` negative control had been coarsened 1 -> 4 objects
(16 -> 64 B/frame) to keep clearing those same stale budgets, so detection was only demonstrated at
4x the threshold the budget names.

**A. Every page's `main` re-derived**, 0016 §1's formula unchanged (`ceil(measured clean) + 8 B`),
each measured the way its own `formula` string documents (`--grep "<page> clean" --repeat-each 8
--workers 1`; `uptime` 1-minute load 2.1-2.4 throughout):

| page | was | measured clean, 8 runs | now |
|---|---|---|---|
| `gc-loop` | 54 | 36.900-36.900 | 45 |
| `topology` | 50 | 33.433-33.480 | 42 |
| `echo` | 38 | 21.480-21.520 | 30 |
| `gen` | 48 | 33.433-33.480 | 42 |
| `terrain` | 116 | 101.533-101.580 | 110 |
| `input` | 206 | 181.673-181.913 | 190 |

Spreads across 8 runs are 0.000-0.240 B/frame, against the 0.4-4 B/frame the pre-0028 `formula`
strings quote for the same rows -- independent evidence that the two-window minimum removes noise,
not signal. Each row's `formula` text now records the re-derivation without discarding its original
derivation history.

**B. Strict worker rows stay at 8** (instructed, and correct: they were never derived from a
measured reading). Measured clean under the two-window instrument, all 16 worker rows: 0.700-2.520
B/frame. `input`'s own `client` is still exactly 2.507-2.520.

**C. `allocateObject` restored to one small retained object per frame** (16 B/frame; `src/test/
controls.ts` and its `src/worker/gc-hook.ts` mirror). **Verified, not assumed** -- every `object`
control's own reading against its own re-derived budget, all 19, `--workers 1`:

| | budget | read | margin |
|---|---|---|---|
| `echo main` | 30 | 37.61 | +7.61 |
| `gen main` | 42 | 49.56 | +7.56 |
| `input main` | 190 | 197.84 | +7.84 |
| `gc-loop main` | 45 | 53.23 | +8.23 |
| `terrain main` | 110 | 117.70 | +7.70 |
| `topology main` | 42 | 49.61 | +7.61 |
| worker rows (13) | 8 | 16.74-25.87 | +8.74 to +17.87 |

Every one trips; none trips an isolate it does not name; `pass: false` with exactly the expected
`A`/`B` table on all 48 tests. No page needed to keep the coarser control.

**D. `terrain`'s `extraSettleFrames: 500` is now measurably inert -- kept, not removed** (the
orchestrator's call, and M09b's Deviations stay true). Measured both ways, 8 clean runs each at
`--workers 1`: `main` 101.533-101.580 with the option, 101.553-101.640 without; `client` 0.747 with,
0.813-0.827 without; `gen0` 0.827 either way. Both are inside the re-derived 110, and all 32
`terrain clean`/`terrain neg object *` runs passed without it. Fix round 3's own measurement of this
option on `input` (where it took `client`'s burst rate from 8/80 to 72/80) is why it is not a knob a
new page should reach for; under the two-window instrument it simply does nothing.

**Still unexplained, and accepted as a known open question** (the orchestrator's own framing): why a
V8 tier-up lands inside the measured window at all after 8,000 warm-up frames, and why the burst
rate is not monotone in pre-window invocation count (8 passes -> 10%, 40 -> 69%, 120 -> 1%). ADR 0028
does not depend on the answer: the two-window minimum is robust to *where* the event lands, not to
any theory of *when*. Nobody is asked to chase it.

**Verification (this session; `uptime` 1-minute load quoted per batch).**
- `--project gc --grep input --workers 3 --repeat-each 20` (load 4.23): **160/160 passed (1.5m)**.
- `--project gc --workers 3` (whole project, 48 tests incl. every `@slow` burst control and
  `gc: flat transport parity`) (load 10.58): **48/48 passed (21.9s)**.
- The same `--repeat-each 3`: **144/144 passed (1.0m)**.
- `--project gc --workers 1` (the measurement run, 48 tests): **48/48 passed (49.8s)**.
- `pnpm test` (load 9.56): `rust 145`, `unit 137`, `wasm 35`, `browser 90 (18s/25s)` -- green.
- `pnpm lint`: `biome` / `rustfmt` / `clippy` / `tsc` all pass.
- `pgrep`/`lsof -ti tcp:4517 tcp:4173` clean afterwards (4173 is an unrelated project's `vite
  preview`, present before this session began and untouched).

Temporary diagnostics used and removed before the commit (`git diff` on the file is empty): an
env-gated `GC_DUMP_BYTES` append of each run's `bytesPerFrame`/`windowBytes` in `measure()`, and
`gc-terrain.spec.ts` with `extraSettleFrames` deleted for item D's second measurement only.

### Notes for later briefs

- The 4-5 range (semantic events, `inputRing` producer): `RING_DEFAULTS.inputRing`'s slot size looks
  short by 8 bytes for the pinned 32-byte record (above) -- check before assuming `tryPush`/`commit`
  fits it as-is. **Done in step 4** (above): `slotBytes` is now 40.
- The 6-8 range (`moveTo`, constraints, persistence, focus rules, GC scenario, device page):
  `CameraIntegrator.constraints` is mutable in place for `setConstraints` to write into directly;
  `device.ts`'s `onCamera` stand-in should be replaced with a real `createCameraIntegrator` wired to
  real `installPointerListeners`/`installKeyListeners`/`installWheelListeners` on the production
  canvas, using `transform.ts`'s formulas verbatim for `camTileX/Y`/`camFracX/Y`/`tilesPerPx`
  (splitting `CameraState.centreX/Y` into an integer tile part and an f32 fraction the same way
  `device.ts` already does with `Math.floor`, just fed by the real `tilesAcross`/`halfExtentTiles`
  this range computes instead of the stand-in's uniform formula).
- Focus rules and `input/page-css.ts` are unbuilt (above); the 6-8 range's brief already names both.
- The 6-8 range also owns wiring `client.input.recognize(...)` itself: call it from the same
  `onCamera` hook as `CameraIntegrator.integrate`, after building the same `PointerSlots`/
  `KeyState`/`WheelState` bundle both consume (`recognize`'s own doc comment in `input/semantic.ts`).
  Two real gaps to close there (this range's own Deviations, above): real button/modifier capture,
  and idle-mouse hover with no button held (today a mouse slot only activates on `pointerdown`).
  The zero-GC page `input` (step 7) exercises `client.input`'s dispatch/ring-write path under the
  strict budget; `CallbackList.dispatch`'s indexed loop (no `Set`, no `for...of`) is already written
  to that discipline, but nothing in this range's own tests proves it under real allocation
  measurement -- that is exactly what step 7's own page is for.
