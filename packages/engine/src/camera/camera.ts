// Camera integration (docs/decisions/0019-camera-input-and-overlay.md §1, §3; docs/plan/
// 11-camera-and-input.md Scope): pan, pinch, wheel, WASD, inertia, `moveTo`, constraints (including
// bounds), the view-clamp/follow hooks and the device-pixel-at-rest snap, integrated once per rAF
// from the fixed input slots (`input/pointers.ts`, `input/keys.ts`, `input/wheel.ts`) into a plain
// `CameraState` -- no DOM, so it is unit-testable with `dt` and plain state (Planning decisions:
// "integration functions take `dt` and plain state, no DOM").
//
// Steps 1-3 (an earlier range of this same milestone) built pan/pinch/wheel/WASD/inertia and left
// `constraints` mutable in place as a forward-compatible hook (Deviations); step 6 (this range) adds
// `moveTo`, `setViewClamp`, `setFollow` (still a no-op store: centring on a follow target is M18's
// own Non-scope), the device-pixel-at-rest snap and an `onMotionEnd` hook `client.ts` uses for
// `localStorage` persistence. `client.camera.{setConstraints, moveTo, read}` and
// `client.camera.restored` are thin wrappers in `client.ts` over what this file exposes.

import type { KeyState } from '../input/keys.js'
import { KeyBit } from '../input/keys.js'
import type { GestureState, PointerSlot, PointerSlots, ScreenVelocity } from '../input/pointers.js'
import { pointerVelocity } from '../input/pointers.js'
import type { WheelState } from '../input/wheel.js'
import type { CameraState } from './state.js'
import {
  type CameraViewport,
  halfExtentTiles,
  pxPerTile,
  type ScreenPoint,
  screenToWorld,
} from './transform.js'

export type CameraInput = {
  pointers: PointerSlots
  keys: KeyState
  wheel: WheelState
}

/** A world-space axis-aligned bound on the camera centre (`client.camera.setConstraints`'s own
 * `bounds` field, Seams). Not the same thing as `setViewClamp`'s `maxTilesPerAxis` (a zoom-out
 * limit derived from world size), nor `render/viewport.ts`'s device-pixel `Viewport` -- world tiles,
 * matching `CameraState.centreX/Y`'s own units. */
export type Rect = { minX: number; minY: number; maxX: number; maxY: number }

export type CameraConstraints = { minTiles: number; maxTiles: number; bounds?: Rect }

/** 0019 §1: `client.camera.setConstraints` defaults. */
export const DEFAULT_MIN_TILES = 12
export const DEFAULT_MAX_TILES = 256
/** Planning decisions "Easing": `moveTo`'s own default when `opts.durationMs` is omitted. */
const DEFAULT_MOVE_TO_DURATION_MS = 400

/** 0019 §3: wheel notches ease to their target over ~100ms (99% there at a 22ms time constant). */
const WHEEL_TAU_MS = 22
/** 0019 §3: inertia decay time constant. */
const INERTIA_TAU_MS = 325
/** 0019 §3/Planning decisions: inertia (and, later, the snap/persistence range's own "motion ends")
 * stops below this CSS px/second. */
const INERTIA_STOP_PX_PER_S = 4
/** Planning decisions "Easing": WASD ramps up over 120ms and down over 80ms. */
const WASD_RAMP_UP_MS = 120
const WASD_RAMP_DOWN_MS = 80

function clampTiles(
  constraints: CameraConstraints,
  viewClampMaxTiles: number,
  value: number,
): number {
  const max = Math.min(constraints.maxTiles, viewClampMaxTiles)
  if (value < constraints.minTiles) return constraints.minTiles
  if (value > max) return max
  return value
}

function clampToBounds(state: CameraState, bounds: Rect | undefined): void {
  if (!bounds) return
  if (state.centreX < bounds.minX) state.centreX = bounds.minX
  else if (state.centreX > bounds.maxX) state.centreX = bounds.maxX
  if (state.centreY < bounds.minY) state.centreY = bounds.minY
  else if (state.centreY > bounds.maxY) state.centreY = bounds.maxY
}

/** Planning decisions "Easing": cubic ease-in-out, `t` in `[0, 1]`. */
function cubicEaseInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

export type MoveToOptions = { tiles?: number; durationMs?: number }

export interface CameraIntegrator {
  /** Integrates `dtMs` of pan/pinch/wheel/WASD/inertia/`moveTo` into `state` in place, reading
   * whatever the fixed input slots currently hold, then snaps to a whole device pixel if (and only
   * if) nothing is moving this frame (0018 §3). Called once per rAF, from the frame loop's `camera`
   * phase, before `writeCamera` (`frame-loop.ts`'s own `onCamera` hook). Allocates nothing in steady
   * state: every scratch object below is created once, in `createCameraIntegrator`. */
  integrate(state: CameraState, viewport: CameraViewport, dtMs: number): void
  /** Mutable in place (Deviations: forward-compatible seam for `client.camera.setConstraints`).
   * Defaults to 0019 §1's own 12/256, no `bounds`. `setConstraints` (below) is the same thing as a
   * method, for a caller that would rather not reach into the object directly. */
  readonly constraints: CameraConstraints
  setConstraints(opts: { bounds?: Rect; minTiles?: number; maxTiles?: number }): void
  /** Eases `state` to `(x, y)` (world tiles) and, if `opts.tiles` is given, to that zoom, over
   * `opts.durationMs` (default 400ms, Planning decisions "Easing"; 0 or omitted-but-zero jumps
   * immediately). Cancelled by any pointer, wheel or key input already in progress the next time
   * `integrate` runs (0019 §1: "user input cancels it"). */
  moveTo(state: CameraState, x: number, y: number, opts?: MoveToOptions): void
  /** Internal (Seams): a host-driven zoom-out ceiling from the world's own size (`Welcome`, M15/
   * M28's own Non-scope -- this range only builds the setter). Narrower than `constraints.maxTiles`
   * only when it is itself the smaller number; never widens past `constraints.maxTiles`. */
  setViewClamp(maxTilesPerAxis: number): void
  /** Internal (Seams, M18): stored, not yet consumed -- "no-op until M18 supplies a target" (Scope).
   * `camera.ts` never reads `followX/Y/Valid` today; the follow-target centring itself is M18's own
   * Non-scope line, and a follow target disabling panning (0019 §1) is also unimplemented here. */
  setFollow(x: number, y: number, valid: boolean): void
}

export function createCameraIntegrator(
  input: CameraInput,
  opts?: {
    /** Called at most once per `integrate()`, the frame the camera transitions from moving to at
     * rest (0019 §1: "saved to `localStorage` when motion ends"). `client.ts` wires this to
     * `camera/persistence.ts`'s `saveCameraState`. */
    onMotionEnd?(state: CameraState): void
  },
): CameraIntegrator {
  const constraints: CameraConstraints = {
    minTiles: DEFAULT_MIN_TILES,
    maxTiles: DEFAULT_MAX_TILES,
  }
  let viewClampMaxTiles = Number.POSITIVE_INFINITY
  // Non-scope (M18): stored, never consumed -- "no-op until M18 supplies a target" (Scope). A
  // single object, not three separate `let`s, so `setFollow` writing it doesn't need a
  // `noUnusedVariables`-dodging read of its own.
  const follow = { x: 0, y: 0, valid: false }
  let wasAtRest = false

  let moveActive = false
  let moveStartX = 0
  let moveStartY = 0
  let moveStartLogZoom = 0
  let moveTargetX = 0
  let moveTargetY = 0
  let moveTargetLogZoom = 0
  let moveElapsedMs = 0
  let moveDurationMs = 0

  // Per-slot bookkeeping (index 0/1, matching `PointerSlots.slots`): the position/engagement state
  // as of the *last* integration call, so this frame's pan/zoom is a delta against it. Typed arrays
  // created once, mutated every call (`.claude/rules/hot-paths.md`).
  const wasActive = new Uint8Array(2)
  const lastX = new Float64Array(2)
  const lastY = new Float64Array(2)
  let hadTwo = false
  let lastMidX = 0
  let lastMidY = 0
  let lastDist = 0
  let wasGesture = false
  let gestureLastApplied = 1
  let wasdScale = 0
  let prevTilesAcross = Number.NaN

  const worldScratch: ScreenPoint = { x: 0, y: 0 }
  const halfScratch: ScreenPoint = { x: 0, y: 0 }
  const velScratch: ScreenVelocity = { x: 0, y: 0 }

  /** Recomputes `state.centreX/Y` so the world point under `(screenX, screenY)` is unchanged,
   * after clamping `newTilesAcrossRaw` to `constraints` and writing it to `state.tilesAcross`. The
   * one zoom primitive every gesture (pinch, wheel, macOS `gesturechange`) goes through, so
   * `zoom_clamps_and_constraints` holds regardless of which input produced the zoom. */
  function applyZoomTo(
    state: CameraState,
    viewport: CameraViewport,
    screenX: number,
    screenY: number,
    newTilesAcrossRaw: number,
  ): void {
    const clamped = clampTiles(constraints, viewClampMaxTiles, newTilesAcrossRaw)
    if (clamped === state.tilesAcross) return
    screenToWorld(state, viewport, screenX, screenY, worldScratch)
    state.tilesAcross = clamped
    const ppt = pxPerTile(state, viewport)
    state.centreX = worldScratch.x - (screenX - viewport.widthPx / 2) / ppt
    state.centreY = worldScratch.y - (screenY - viewport.heightPx / 2) / ppt
  }

  /** On release (`active` just went `false`), derives an inertia velocity from the slot's own
   * sample ring; otherwise (still active) just refreshes `lastX/Y` for next frame's delta. */
  function updateSlotBookkeeping(
    i: number,
    slot: PointerSlot,
    state: CameraState,
    viewport: CameraViewport,
  ): void {
    if (slot.active) {
      lastX[i] = slot.x
      lastY[i] = slot.y
      wasActive[i] = 1
      return
    }
    if (wasActive[i] === 1) {
      if (pointerVelocity(slot, velScratch)) {
        const ppt = pxPerTile(state, viewport)
        state.velocityX = velScratch.x / ppt
        state.velocityY = velScratch.y / ppt
      } else {
        state.velocityX = 0
        state.velocityY = 0
      }
    }
    wasActive[i] = 0
  }

  function applyGesture(state: CameraState, viewport: CameraViewport, gesture: GestureState): void {
    if (gesture.active) {
      if (wasGesture && gesture.scale !== gestureLastApplied && gestureLastApplied !== 0) {
        const incremental = gesture.scale / gestureLastApplied
        // 0019 §3: "pinch is direct" (not eased like a wheel notch).
        applyZoomTo(state, viewport, gesture.x, gesture.y, state.tilesAcross / incremental)
      }
      gestureLastApplied = gesture.scale
    } else {
      gestureLastApplied = 1
    }
    wasGesture = gesture.active
  }

  function applyPointers(
    state: CameraState,
    viewport: CameraViewport,
    pointers: PointerSlots,
  ): number {
    const [p0, p1] = pointers.slots
    const activeCount = (p0.active ? 1 : 0) + (p1.active ? 1 : 0)
    if (activeCount === 2) {
      const midX = (p0.x + p1.x) / 2
      const midY = (p0.y + p1.y) / 2
      const dist = Math.hypot(p0.x - p1.x, p0.y - p1.y)
      if (hadTwo) {
        const ppt = pxPerTile(state, viewport)
        state.centreX -= (midX - lastMidX) / ppt
        state.centreY -= (midY - lastMidY) / ppt
        if (lastDist > 0 && dist !== lastDist) {
          const factor = dist / lastDist
          applyZoomTo(state, viewport, midX, midY, state.tilesAcross / factor)
        }
      }
      lastMidX = midX
      lastMidY = midY
      lastDist = dist
      hadTwo = true
    } else {
      hadTwo = false
      if (activeCount === 1) {
        const i = p0.active ? 0 : 1
        const slot = p0.active ? p0 : p1
        if (wasActive[i] === 1) {
          const ppt = pxPerTile(state, viewport)
          state.centreX -= (slot.x - (lastX[i] as number)) / ppt
          state.centreY -= (slot.y - (lastY[i] as number)) / ppt
        }
      }
    }
    updateSlotBookkeeping(0, p0, state, viewport)
    updateSlotBookkeeping(1, p1, state, viewport)
    return activeCount
  }

  function applyWasd(state: CameraState, keys: KeyState, dtMs: number): void {
    const mask = keys.mask
    const dirX = (mask & KeyBit.D ? 1 : 0) - (mask & KeyBit.A ? 1 : 0)
    const dirY = (mask & KeyBit.S ? 1 : 0) - (mask & KeyBit.W ? 1 : 0)
    const engaged = dirX !== 0 || dirY !== 0
    const rampMs = engaged ? WASD_RAMP_UP_MS : WASD_RAMP_DOWN_MS
    const target = engaged ? 1 : 0
    const maxDelta = dtMs / rampMs
    if (wasdScale < target) wasdScale = Math.min(target, wasdScale + maxDelta)
    else if (wasdScale > target) wasdScale = Math.max(target, wasdScale - maxDelta)
    if (wasdScale <= 0) return
    const len = Math.hypot(dirX, dirY) || 1
    // Planning decisions "Easing": WASD speed is one visible long-axis extent (`tilesAcross`) per
    // second, so `distance / tilesAcross` is the same fraction of the view at any zoom level
    // (`camera: wasd speed scales with extent`).
    const dist = state.tilesAcross * wasdScale * (dtMs / 1000)
    state.centreX += (dirX / len) * dist
    state.centreY += (dirY / len) * dist
  }

  function applyWheelEasing(
    state: CameraState,
    viewport: CameraViewport,
    wheel: WheelState,
    dtMs: number,
  ): void {
    if (!wheel.hasPending || wheel.pendingDeltaLog === 0) return
    const tauSec = WHEEL_TAU_MS / 1000
    const dtSec = dtMs / 1000
    const appliedFrac = tauSec > 0 ? 1 - Math.exp(-dtSec / tauSec) : 1
    const appliedThisFrame = wheel.pendingDeltaLog * appliedFrac
    wheel.pendingDeltaLog -= appliedThisFrame
    if (Math.abs(wheel.pendingDeltaLog) < 1e-9) wheel.pendingDeltaLog = 0
    applyZoomTo(
      state,
      viewport,
      wheel.cssX,
      wheel.cssY,
      state.tilesAcross * Math.exp(appliedThisFrame),
    )
  }

  /** 0019 §1: "any pointer, wheel or key input cancels it" -- checked once, at the very start of
   * `integrate`, before this frame's own gesture/WASD/wheel logic runs (so a real gesture that
   * cancels `moveTo` this same frame also gets to move the camera this same frame, not the next
   * one). `wheel.pendingDeltaLog`, not `wheel.hasPending` (the latter is never reset back to
   * `false` once a wheel event has ever occurred -- `applyWheelEasing`'s own early-return already
   * relies on `pendingDeltaLog === 0` for the same reason). */
  function hasLiveInput(pointers: PointerSlots, keys: KeyState, wheel: WheelState): boolean {
    const [p0, p1] = pointers.slots
    return (
      p0.active ||
      p1.active ||
      pointers.gesture.active ||
      keys.mask !== 0 ||
      wheel.pendingDeltaLog !== 0
    )
  }

  function applyMoveTo(state: CameraState, dtMs: number): void {
    if (!moveActive) return
    moveElapsedMs += dtMs
    const t = moveDurationMs > 0 ? Math.min(1, moveElapsedMs / moveDurationMs) : 1
    const eased = cubicEaseInOut(t)
    state.centreX = moveStartX + (moveTargetX - moveStartX) * eased
    state.centreY = moveStartY + (moveTargetY - moveStartY) * eased
    state.tilesAcross = Math.exp(moveStartLogZoom + (moveTargetLogZoom - moveStartLogZoom) * eased)
    if (t >= 1) moveActive = false
  }

  function moveTo(state: CameraState, x: number, y: number, moveOpts?: MoveToOptions): void {
    const durationMs = moveOpts?.durationMs ?? DEFAULT_MOVE_TO_DURATION_MS
    const targetTiles = clampTiles(
      constraints,
      viewClampMaxTiles,
      moveOpts?.tiles ?? state.tilesAcross,
    )
    state.velocityX = 0
    state.velocityY = 0
    if (durationMs <= 0) {
      // 0019 §1: "0 = jump".
      state.centreX = x
      state.centreY = y
      state.tilesAcross = targetTiles
      moveActive = false
      return
    }
    moveActive = true
    moveStartX = state.centreX
    moveStartY = state.centreY
    moveStartLogZoom = Math.log(state.tilesAcross)
    moveTargetX = x
    moveTargetY = y
    moveTargetLogZoom = Math.log(targetTiles)
    moveElapsedMs = 0
    moveDurationMs = durationMs
  }

  function setConstraints(setOpts: { bounds?: Rect; minTiles?: number; maxTiles?: number }): void {
    if (setOpts.minTiles !== undefined) constraints.minTiles = setOpts.minTiles
    if (setOpts.maxTiles !== undefined) constraints.maxTiles = setOpts.maxTiles
    if (setOpts.bounds !== undefined) constraints.bounds = setOpts.bounds
  }

  function setViewClamp(maxTilesPerAxis: number): void {
    viewClampMaxTiles = maxTilesPerAxis
  }

  function setFollow(x: number, y: number, valid: boolean): void {
    follow.x = x
    follow.y = y
    follow.valid = valid
  }

  function integrate(state: CameraState, viewport: CameraViewport, dtMs: number): void {
    if (Number.isNaN(prevTilesAcross)) prevTilesAcross = state.tilesAcross
    const dtSec = dtMs / 1000
    const pointers = input.pointers
    const [p0, p1] = pointers.slots
    const gesture = pointers.gesture

    if (moveActive && hasLiveInput(pointers, input.keys, input.wheel)) moveActive = false

    // 0019 §3: "cancelled by any `pointerdown`" -- also true of a fresh pinch/gesture engaging.
    const justEngaged =
      (p0.active && wasActive[0] === 0) ||
      (p1.active && wasActive[1] === 0) ||
      (gesture.active && !wasGesture)
    if (justEngaged) {
      state.velocityX = 0
      state.velocityY = 0
    }

    applyGesture(state, viewport, gesture)
    const activeCount = applyPointers(state, viewport, pointers)

    if (activeCount === 0 && !gesture.active) {
      applyInertia(state, viewport, dtMs)
    }

    applyWasd(state, input.keys, dtMs)
    applyWheelEasing(state, viewport, input.wheel, dtMs)
    applyMoveTo(state, dtMs)
    clampToBounds(state, constraints.bounds)

    // 0018 §3: "the camera snaps to device pixels at rest" -- once *everything* above left the
    // camera untouched this frame (no active gesture, no WASD ramp in progress, no wheel easing
    // left to apply, no `moveTo` in flight, and inertia already decayed velocity to exactly 0).
    // `tilesAcross` is never part of this (0018 §3: "no zoom snapping").
    const atRest =
      activeCount === 0 &&
      !gesture.active &&
      !moveActive &&
      wasdScale === 0 &&
      input.wheel.pendingDeltaLog === 0 &&
      state.velocityX === 0 &&
      state.velocityY === 0
    if (atRest) {
      const devicePerTile = pxPerTile(state, viewport) * state.dpr
      if (devicePerTile > 0) {
        state.centreX = Math.round(state.centreX * devicePerTile) / devicePerTile
        state.centreY = Math.round(state.centreY * devicePerTile) / devicePerTile
      }
      if (!wasAtRest) opts?.onMotionEnd?.(state)
    }
    wasAtRest = atRest

    halfExtentTiles(state, viewport, halfScratch)
    state.halfExtentTilesX = halfScratch.x
    state.halfExtentTilesY = halfScratch.y

    state.zoomRate =
      dtSec > 0 && prevTilesAcross > 0
        ? (Math.log(state.tilesAcross) - Math.log(prevTilesAcross)) / dtSec
        : 0
    prevTilesAcross = state.tilesAcross
  }

  return { integrate, constraints, setConstraints, moveTo, setViewClamp, setFollow }
}

/** Exported standalone (Deviations: kept independently callable, not only reachable through
 * `CameraIntegrator.integrate`) so `camera: inertia decay time based` can assert step-size
 * independence directly. `tauMs` defaults to 0019 §3's 325ms. The position update is the exact
 * analytic integral of exponential decay over `[0, dtMs]` (`v0 * tau * (1 - e^-dt/tau)`), not a
 * first-order Euler step -- chaining many small steps gives the *same* end state as one big step to
 * floating-point precision, which a `velocity * dt` Euler update would not (`camera:
 * inertia_decay_time_based`'s own "within 1e-6" bound at 30/60/120Hz). */
export function applyInertia(
  state: CameraState,
  viewport: CameraViewport,
  dtMs: number,
  tauMs: number = INERTIA_TAU_MS,
): void {
  if (state.velocityX === 0 && state.velocityY === 0) return
  const dtSec = dtMs / 1000
  const tauSec = tauMs / 1000
  const decay = Math.exp(-dtSec / tauSec)
  const disp = tauSec * (1 - decay)
  state.centreX += state.velocityX * disp
  state.centreY += state.velocityY * disp
  state.velocityX *= decay
  state.velocityY *= decay
  const ppt = pxPerTile(state, viewport)
  const speedPxPerS = Math.hypot(state.velocityX, state.velocityY) * ppt
  if (speedPxPerS < INERTIA_STOP_PX_PER_S) {
    state.velocityX = 0
    state.velocityY = 0
  }
}
