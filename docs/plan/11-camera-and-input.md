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
- `camera/camera.ts`: integration (`camera` phase of the frame loop), constraints, view clamp, `moveTo`, follow-target hook (no-op until M18 supplies a target), snap to device pixels at rest, `localStorage` save/restore.
- `camera/transform.ts`: `worldToScreen`, `screenToWorld`, tile under a point; pure functions shared with M18 picking.
- `input/pointers.ts`, `input/keys.ts`, `input/wheel.ts`: listeners per 0019 §3–§4 that write into two fixed pointer slots, a key bitmask and a wheel accumulator; nothing else happens in a listener.
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
- TS, on `Client`: `camera.{setConstraints, moveTo, read, worldToScreen, screenToWorld}` and `input.{on, setMode, suspend, resume}` with 0019's signatures. Types: `CameraState` (M06, now `read`'s out-parameter), `InputEventTs { type, worldX, worldY, tileX, tileY, pickId, button, shift, ctrl, alt, meta, pointerType }` (one reused instance per event type; listeners must copy what they keep).
- Internal: `camera.setViewClamp(maxTilesPerAxis)`, `camera.setFollow(x, y, valid)` (M18), `camera.cursorTile` (M17 uniform, M18 picking), `transform.ts` functions.
- `inputRing` record (32 bytes, little-endian): `0 kind u8` (1 tap, 2 hover, 3 longpress, 4 dragstart, 5 drag, 6 dragend), `1 button u8`, `2 modifiers u8` (bit 0 shift, 1 ctrl, 2 alt, 3 meta), `3 pointer u8` (0 mouse, 1 touch, 2 pen), `4 seq u32`, `8 tile i32×2`, `16 frac f32×2` (position inside the tile, so world position is exact over ±2^23), `24 pick_id u32`, `28 time_ms u32` (wrapping).
- Rust: `#[repr(C)] InputEvent` mirroring the record with `world_pos()`; `InputQueue` (fixed 64; on overflow the oldest `hover` or `drag` is dropped before any other kind; cleared at the end of each `frame`); ABI `on_input(len: u32) -> status` (added by M02's rule) decodes whole records from `RegionId::Rx`.
- `engine/test`: `injectPointer(client, phase: 'down' | 'move' | 'up' | 'cancel', id, cssX, cssY, tMs, pointerType?)`, `injectWheel(client, deltaY, cssX, cssY, ctrlKey?)`, `injectKey(client, code, down)`; they write the same fixed slots the DOM listeners write and allocate nothing.

**Consumes** M06: `CameraState`, `writeCameraBlock`, `inputRing`, control block. M06b: `stepFrame`, client worker body. M09: `FrameLoop` `camera` phase, `renderer.viewport`, `renderer.frameUniform`; M09b: `renderer.onViewportChange`, `device.html` (if M09b is not done, read the viewport each frame and create the page here). M03: `pnpm device:serve --tunnel`. M04: `installGcPage`, `zeroGcSuite`, `budgets.json`.

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
- `unit` suite: `camera.pan_keeps_world_point`, `camera.pinch_about_midpoint`, `camera.wheel_about_cursor`, `camera.zoom_clamps_and_constraints`, `camera.inertia_decay_time_based` (same end state at 30, 60 and 120 Hz steps within 1e-6), `camera.moveto_cancelled_by_input`, `camera.precision_at_2pow23`, `transform.roundtrip`, `semantic.tap_vs_drag_thresholds`, `semantic.longpress`, `semantic.hover_only_on_change`, `input.record_layout_golden`.
- Rust native: `input.decode_record_golden`, `input.queue_overflow_drops_hover_first`.
- Browser (Chromium): `input.dom_path_pan_and_tap` (real `PointerEvent`s via Playwright mouse: the one DOM-path test), `input.keyboard_focus_rules` (typing in an `<input>` does not move the camera; `blur` clears keys), `input.widget_blocks_canvas` (`pointer-events: auto` element above the canvas), `input.suspend_resume`, `camera.block_reaches_worker_each_frame`, `camera.persisted_and_restored`, `input.events_reach_wasm` (test export returns `InputQueue` length and last tile).
- Zero-GC: page id `input` through `zeroGcSuite` (600 frames of injected drag, pinch, wheel and WASD with a `tap` every 30 frames; chunk streaming and the renderer active; isolates `main`, `client`, `gen0`).

## Exit criteria
- [ ] All tests above pass by name; page `input` within its `gc.pages.input` budgets on every isolate, `inputRing` `drops == 0`.
- [ ] Source scan: no `getCoalescedEvents`, no listener outside the canvas except the `window` key, `blur` and `visibilitychange` listeners of 0019 §4.
- [ ] Device-check items below are written into `docs/plan/device-checks.md`.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test unit -t camera` · `pnpm test unit -t semantic` · `pnpm test rust -t input` · `pnpm test browser -t input` · `pnpm test browser -t camera` · `pnpm test` · `pnpm lint`.

## Budgets
- Allocation per isolate (0016): page `input`. DOM-dispatched event objects are the browser's and are not in the window (injection bypasses them, 0016 Consequences).
- Frame time, main share (0018 §9): not asserted here; first asserted in M17b.
- Bandwidth up while panning (0010): M15's counter, fed by this camera block.

## Context artifacts
`packages/engine/CLAUDE.md`: "listeners record, rAF integrates"; how to inject input in tests. `hot-paths.md` globs already cover `src/input/**` and `src/camera/**`.

## Manual device checks
`docs/plan/device-checks.md`, on the iPhone (and the Android phone if Q5 says one exists), `device.html` from `pnpm device:serve --tunnel`:
- **M11-boot.** Open the URL. Pass: HUD shows isolated, adapter and "workers ready (posted Module)". Fail with a worker error → reopen with `?module=url`; if that passes, plan edit: default to the URL path on Safari (0017 §4 fallback).
- **M11-gestures.** One-finger pan for 10 s, flick, pinch to both zoom limits, tap a tile, pull down from the top edge, double-tap, rotate the phone. Pass: the world point stays under the finger; flick glides and stops; HUD shows the tapped tile; the page never scrolls, zooms or refreshes; after rotation the view keeps its centre. Fail → the named knob (inertia constant, thresholds, page CSS helper) and a plan edit.
- **M11-memory** (`?probe=memory`; closes 0015's on-device ceilings). The page (1) grows a scratch `WebAssembly.Memory` in 64 MiB steps to 1 GiB and reports the largest success; (2) runs the default topology (sim + client + gen arenas of 0015 §5) beside the WebGPU context with `autopan` for 2 min; (3) repeats (2) with `&touch=1`, which writes every arena page. Record all three results. Pass: (2) and (3) survive without a reload. Fail → re-run with `&sim=64&client=32` (MiB); if that survives, plan edit lowering the mobile defaults through a superseding ADR for 0015 §5; if (1) < 256 MiB, record the ceiling there too.

## Deviations
(filled in during Phase 3)
