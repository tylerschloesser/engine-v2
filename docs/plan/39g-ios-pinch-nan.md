# M39g: iOS pinch freezes the camera (gesture events)

Status: done (2026-10-05; device re-run of M11-gestures owed in round `m39-auto`) · After: 39f · Tyler-dependent: no (re-run of M11-gestures on his iPhone follows)

## Goal
Tyler's M39 auto round on the iPhone (2026-10-05, round `m39-auto`, item **M11-gestures**): "it asked me to zoom. And the zoom is fucked. Screen is green (as though it zoomed in super close to something). And now it's stuck green - like zoom doesn't work at all." When this is done a pinch on iOS Safari zooms once, about the fingers, and no input can leave the camera non-finite. The macOS trackpad pinch (device check M11-pinch-desktop-safari) zooms about the cursor.

## Diagnosis (orchestrator, from the code; not yet measured on the device)
- `installPointerListeners` (`packages/engine/src/input/pointers.ts`) reads `offsetX`/`offsetY` off `gesturestart`/`gesturechange`. WebKit's `GestureEvent` is a `UIEvent`, not a `MouseEvent`: it has `clientX`/`clientY`/`screenX`/`screenY`, `scale`, `rotation`, no `offsetX`/`offsetY` (verify against current WebKit IDL or MDN before relying on this). So `GestureState.x/y` become `undefined`.
- `applyGesture` → `applyZoomTo` (`camera/camera.ts`) then computes `screenToWorld(undefined)` → `NaN` centre. NaN is absorbing: every later pan and zoom keeps it, so the view is stuck until reload. `clampTiles` also passes `NaN` through.
- On iOS a two-finger pinch fires pointer events **and** `gesture*` events, so even with good coordinates the pinch would be applied twice (pointer path in `applyPointers`, gesture path in `applyGesture`).
- The existing test `camera.gesturechange_scale_zooms_about_cursor` calls `recordGestureChange` with clean numbers, so it cannot see either defect.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0019-camera-input-and-overlay.md` §3 (input: pinch is direct, gesture events are Safari's trackpad pinch, page never zooms)
Rules that apply: `.claude/rules/hot-paths.md` (listeners and `integrate` run per event/frame: no allocation in `gesturechange` or `integrate`).

## Scope
1. **Coordinates.** Gesture listeners derive canvas-relative x/y from `clientX`/`clientY` minus the canvas's client offset, without a per-`gesturechange` allocation (e.g. read `getBoundingClientRect()` once at `gesturestart` into numbers, not per change). Do not read `offsetX` from a gesture event.
2. **No double zoom on touch.** A `gesture*` scale change is not applied to the camera while any pointer slot is active (the touch pinch is the pointer path's job). Keep `gestureLastApplied` in step so a gesture that outlives its touches does not jump. `preventDefault()` stays on all three gesture events (the page must never zoom).
3. **Non-finite guard.** `recordGestureStart`/`recordGestureChange` ignore non-finite `scale`/`x`/`y` and `scale <= 0`; `applyZoomTo` returns without change on a non-finite target or point. Pick the smallest set of guards that makes a NaN camera unreachable from any input, and say which in Deviations.

## Non-scope
Inertia, tap thresholds, wheel maths, any renderer change, `device-walk` tooling.

## Files touched
`packages/engine/src/input/pointers.ts`, `packages/engine/src/camera/camera.ts`, their tests (`input/gestures.test.ts`, `camera/camera.test.ts`). Anything else: say why in Deviations.

## Seams
**Provides:** none new. **Consumes:** `installPointerListeners`, `recordGesture*`, `GestureState` (M11).

## Tests added
- `gestures.gesture_event_without_offset_records_finite_point`: fake canvas (the file's existing fake-DOM style), dispatch a `gesturestart`/`gesturechange` object carrying `scale`, `clientX`, `clientY` and **no** `offsetX`/`offsetY`; `GestureState.x/y` are finite and equal client minus canvas offset.
- `camera.touch_pinch_with_gesture_events_zooms_once`: two touch pointers spread to double their distance while `recordGestureChange(scale 2)` fires in the same frames; `tilesAcross` halves (not quarters) and the midpoint's world point stays put.
- `camera.non_finite_gesture_input_leaves_camera_finite`: `recordGestureChange` with `NaN`/`undefined` coordinates and scale; centre and `tilesAcross` stay finite and unchanged; a following valid pan still moves the camera.
Each test gets one inject-fail-revert (put the old code back, see it red, restore), with the red line pasted in the report.

## Exit criteria
- [x] The three tests exist and pass; each was seen red against the old behaviour.
- [x] `camera.gesturechange_scale_zooms_about_cursor` still passes (macOS trackpad pinch maths unchanged).
- [x] No allocation added in a gesture listener or `integrate` (say how you checked).
- [x] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t gesture` · `pnpm test unit -t camera` (targeted, foreground).

## Manual device checks
Re-run **M11-gestures** in round `m39-auto` (`pnpm device:walk --auto --round m39-auto`), and M11-pinch-desktop-safari later in the round.

## Deviations
- **GestureEvent shape not confirmed from primary sources.** MDN lists only `scale`/`rotation` (parent `UIEvent`, no `offsetX`); WebKit's implementation lives in private WebKitAdditions, so the IDL could not be read. Apple's legacy Safari reference (not reachable) is the source for `clientX`/`clientY`. The `offsetX` absence is consistent with every source; `clientX` presence is not machine-verified. Mitigation: a non-finite `clientX`/`clientY` falls back to the canvas centre, so a macOS pinch still zooms instead of being dropped.
- Listener (`input/pointers.ts`): `getBoundingClientRect()` read once per `gesturestart` into closure numbers (`gestureLeft/Top/W/H`); `gesturechange` allocates nothing (no new objects/closures per event).
- Guards: `recordGestureStart` drops non-finite x/y; `recordGestureChange` drops non-finite scale/x/y and `scale <= 0` (state is left as it was); `applyZoomTo` returns on a non-finite point or target (the one primitive pinch, wheel and gesture all pass through, so no input path reaches a NaN camera). Wheel/pointer coordinates are not separately guarded.
- `applyGesture(state, viewport, gesture, touching)`: while a pointer slot is active the scale change is not applied, `gestureLastApplied` still tracks it.
- Test names follow each file's `camera: ...`/`input gestures: ...` style with the brief's snake_case names; the existing test is `camera: gesturechange scale zooms about cursor` (passes).
- Inject-fail-revert (old `pointers.ts`+`camera.ts` restored, then new): `touch_pinch...` red `expected 12 to be close to 20` (also red with only camera.ts old); `non_finite...` red `expected -3.5 to be 10`; `gesture_event_without_offset...` red `expected undefined to be 100`.
- **Gate fix (orchestrator):** the implementer's `applyZoomTo` guard `Number.isFinite(screenX + screenY + newTilesAcrossRaw)` boxed a HeapNumber per zoom: `[gc] input clean` read 193.5-193.9 B/frame against its 190 budget (base passes under the same load). Three separate `Number.isFinite` calls instead: 180.4 B/frame (budget forced to 1 to read it, then restored), at the base level. The allocation criterion was a read-the-code claim; the gc page is what checked it.
