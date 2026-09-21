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

### Notes for later briefs

- The 4-5 range (semantic events, `inputRing` producer): `RING_DEFAULTS.inputRing`'s slot size looks
  short by 8 bytes for the pinned 32-byte record (above) -- check before assuming `tryPush`/`commit`
  fits it as-is.
- The 6-8 range (`moveTo`, constraints, persistence, focus rules, GC scenario, device page):
  `CameraIntegrator.constraints` is mutable in place for `setConstraints` to write into directly;
  `device.ts`'s `onCamera` stand-in should be replaced with a real `createCameraIntegrator` wired to
  real `installPointerListeners`/`installKeyListeners`/`installWheelListeners` on the production
  canvas, using `transform.ts`'s formulas verbatim for `camTileX/Y`/`camFracX/Y`/`tilesPerPx`
  (splitting `CameraState.centreX/Y` into an integer tile part and an f32 fraction the same way
  `device.ts` already does with `Math.floor`, just fed by the real `tilesAcross`/`halfExtentTiles`
  this range computes instead of the stand-in's uniform formula).
- Focus rules and `input/page-css.ts` are unbuilt (above); the 6-8 range's brief already names both.
