// Semantic input recognition (docs/decisions/0019-camera-input-and-overlay.md §4; docs/plan/
// 11-camera-and-input.md Scope, Order of work step 4): tap/hover/longpress/drag* recognition, run
// once per rAF from the same fixed pointer slots `camera/camera.ts`'s integrator reads -- no DOM,
// so it is unit-testable with `dt` and plain state (Planning decisions: "integration functions take
// `dt` and plain state, no DOM", the same discipline `camera.ts` follows). `client.input.{on,
// setMode, suspend, resume}` is the public event-delivery surface (Seams, Provides); `recognize`
// is this range's own addition to that same object (Deviations: not itself a pinned Seam name, the
// production-wiring counterpart of `CameraIntegrator.integrate` -- a later range's real DOM wiring
// calls both from the same `onCamera` hook, `frame-loop.ts`).
//
// `pick_id` (docs/plan/18-picking-and-overlay.md Scope, step 2): filled from the optional `pick`
// constructor argument -- `input/pick.ts`'s `Picker.at(cssX, cssY)`, `createClient`'s own real one
// (`src/client.ts`) built over the same `DrawListSlot` the frame loop's `acquire` phase pulls. `emit`
// takes the computed `pickId` as a plain parameter (not a closure over `pick` inside `emit` itself):
// every call site already has the real CSS-pixel point (`slot.x/y`, `hover.x/y`) the tile/frac
// arguments were themselves derived from, so the pick scan runs at that same point, once, per event
// -- taps pick on the event; hover's own "at most once per rAF, only when the pointer or slot
// changed" throttle lives inside `Picker.at` itself (its own doc comment), not here.
//
// M11 step 6 (mandatory gaps #1/#2 of the delegation prompt): `input/pointers.ts`'s fixed slots now
// carry real button/modifier state and an idle-mouse hover position (`MouseHoverState`), threaded
// through to every emitted event and the ring record below instead of the hardcoded 0/false the 4-5
// range left in their place.
import type { CameraInput } from '../camera/camera.js'
import type { CameraState } from '../camera/state.js'
import { type CameraViewport, type TilePoint, tileUnderPoint } from '../camera/transform.js'
import { RingProducer } from '../sab/ring.js'
import { PointerKind, type PointerKindValue, type PointerSlot } from './pointers.js'
import {
  INPUT_RECORD_BYTES,
  InputKind,
  type InputKindValue,
  type InputRecordFields,
  writeInputRecord,
} from './record.js'

export { INPUT_RECORD_BYTES }

export type InputEventType = 'tap' | 'hover' | 'longpress' | 'dragstart' | 'drag' | 'dragend'
export type InputPointerType = 'mouse' | 'touch' | 'pen'

/** Seams, Provides: one reused instance per event type; a listener must copy what it keeps
 * (mutated in place before every dispatch, per event type). */
export type InputEventTs = {
  type: InputEventType
  worldX: number
  worldY: number
  tileX: number
  tileY: number
  pickId: number
  button: number
  shift: boolean
  ctrl: boolean
  alt: boolean
  meta: boolean
  pointerType: InputPointerType
}

/** 0019 §4: `'tool'` turns a one-pointer drag into `dragstart`/`drag`/`dragend`; a two-pointer
 * gesture keeps panning/zooming regardless of mode. Default `'camera'`. */
export type InputMode = 'camera' | 'tool'

export type InputCallback = (e: InputEventTs) => void

export interface InputController {
  /** Registers `cb` for `type`; returns a disposer. */
  on(type: InputEventType, cb: InputCallback): () => void
  setMode(mode: InputMode): void
  /** Stops recognition and ring writes entirely (0019 §4: "covers modal UI"). */
  suspend(): void
  resume(): void
  /** docs/plan/18-picking-and-overlay.md Scope (0024 §7c): the TypeScript-to-`ClientSide` channel
   * for client-local UI intent -- writes one `InputKind.Game` record into `inputRing` (`code` in
   * `pick_id`, `a`/`b` as `i32` in `tile`, all else zero), which surfaces in Rust's `FrameCx::
   * input()` in ring order and is never delivered to `on`. Returns `false` (nothing written, same
   * "drop and count, never block" convention every other emitted event already follows) when the
   * ring is full. M33 is the first consumer (construction mode). */
  emit(code: number, a?: number, b?: number): boolean
}

/** `input/pick.ts`'s own `Picker` shape, narrowed to what `emit` needs -- avoids a direct import
 * dependency from `input/semantic.ts` on `render/drawlist-slot.ts` for a type-only reason. */
export type PickSource = { at(cssX: number, cssY: number): number }

export interface SemanticRecognizer extends InputController {
  /** Runs once per rAF (Deviations: this range's own seam, not itself pinned by name).
   * Allocates nothing in steady state: every scratch object below is created once, in
   * `createSemanticRecognizer` (`.claude/rules/hot-paths.md`). */
  recognize(
    input: CameraInput,
    cameraState: CameraState,
    viewport: CameraViewport,
    dtMs: number,
  ): void
}

/** 0019 §4: "moved < 8 CSS px and < 300 ms" is a tap. */
const TAP_RADIUS_PX = 8
const TAP_MAX_MS = 300
/** Planning decisions "Thresholds": "longpress = 500ms without leaving the tap radius". */
const LONGPRESS_MS = 500

function pointerTypeName(kind: PointerKindValue): InputPointerType {
  if (kind === PointerKind.Touch) return 'touch'
  if (kind === PointerKind.Pen) return 'pen'
  return 'mouse'
}

const KIND_BY_TYPE: Record<InputEventType, InputKindValue> = {
  tap: InputKind.Tap,
  hover: InputKind.Hover,
  longpress: InputKind.Longpress,
  dragstart: InputKind.DragStart,
  drag: InputKind.Drag,
  dragend: InputKind.DragEnd,
}

/** A plain array plus indexed dispatch, not a `Set` (`.claude/rules/hot-paths.md`: `for...of` over
 * a `Set` allocates a fresh iterator every call, and `dispatch` runs on the semantic-recognition
 * path, once per emitted event -- a `tap` every 30 frames of the zero-GC page's own scenario,
 * Tests added). Registration (`add`) is setup-shaped (called once per game listener, not per
 * frame) and may allocate; `dispatch`'s own indexed loop does not. */
class CallbackList {
  private readonly cbs: InputCallback[] = []
  add(cb: InputCallback): () => void {
    this.cbs.push(cb)
    return () => {
      const i = this.cbs.indexOf(cb)
      if (i >= 0) this.cbs.splice(i, 1)
    }
  }
  dispatch(e: InputEventTs): void {
    for (let i = 0; i < this.cbs.length; i++) (this.cbs[i] as InputCallback)(e)
  }
}

function makeEvent(type: InputEventType): InputEventTs {
  return {
    type,
    worldX: 0,
    worldY: 0,
    tileX: 0,
    tileY: 0,
    pickId: 0,
    button: 0,
    shift: false,
    ctrl: false,
    alt: false,
    meta: false,
    pointerType: 'mouse',
  }
}

/** Builds the semantic recognizer + `client.input` API over `inputRingSab` (`SabSet.inputRing`,
 * `sab/layout.ts`). One instance per `Client` (`createClient`, `src/client.ts`). `pick` is optional
 * (omitted by a unit test that never needs a real pick_id): every event's `pickId` is `0` without
 * one, the same value this always had before docs/plan/18-picking-and-overlay.md. */
export function createSemanticRecognizer(
  inputRingSab: SharedArrayBuffer,
  pick?: PickSource,
): SemanticRecognizer {
  const ring = new RingProducer(inputRingSab)
  let mode: InputMode = 'camera'
  let suspended = false
  let nextSeq = 0
  let clockMs = 0

  const callbacks: Record<InputEventType, CallbackList> = {
    tap: new CallbackList(),
    hover: new CallbackList(),
    longpress: new CallbackList(),
    dragstart: new CallbackList(),
    drag: new CallbackList(),
    dragend: new CallbackList(),
  }
  const events: Record<InputEventType, InputEventTs> = {
    tap: makeEvent('tap'),
    hover: makeEvent('hover'),
    longpress: makeEvent('longpress'),
    dragstart: makeEvent('dragstart'),
    drag: makeEvent('drag'),
    dragend: makeEvent('dragend'),
  }

  // docs/plan/18-picking-and-overlay.md step 8 (`gc-anchors.ts`, folding `client.input.emit` into a
  // measured window, found the defect): `writeInputRecord`'s own doc comment already says "pure,
  // allocation-free", but both callers below used to pass it a fresh object literal per call --
  // `.claude/rules/hot-paths.md`: "Preallocate scratch objects at init and mutate them". One
  // `InputRecordFields` scratch, shared by `emit`/`emitGame` (never both in the same call).
  const recordScratch: InputRecordFields = {
    kind: InputKind.Tap,
    button: 0,
    modifiers: 0,
    pointer: 0,
    seq: 0,
    tileX: 0,
    tileY: 0,
    fracX: 0,
    fracY: 0,
    pickId: 0,
    timeMs: 0,
  }

  // Per-slot bookkeeping (index 0/1, matching `PointerSlots.slots` -- the same convention `camera/
  // camera.ts`'s own integrator uses). Typed arrays created once, mutated every call.
  const wasActive = new Uint8Array(2)
  const downX = new Float64Array(2)
  const downY = new Float64Array(2)
  const heldMs = new Float64Array(2)
  const movedPastThreshold = new Uint8Array(2)
  const longpressFired = new Uint8Array(2)
  const dragging = new Uint8Array(2)

  let hoverTileX = Number.NaN
  let hoverTileY = Number.NaN

  const tileScratch: TilePoint = { tileX: 0, tileY: 0, fracX: 0, fracY: 0 }

  /** `pick_id` at a real CSS-pixel point, or `0` when no `pick` was given (module doc comment). */
  function pickIdAt(cssX: number, cssY: number): number {
    return pick ? pick.at(cssX, cssY) : 0
  }

  function emit(
    type: InputEventType,
    tileX: number,
    tileY: number,
    fracX: number,
    fracY: number,
    pickId: number,
    button: number,
    shift: boolean,
    ctrl: boolean,
    alt: boolean,
    meta: boolean,
    pointerKind: PointerKindValue,
  ): void {
    const e = events[type]
    e.worldX = tileX + fracX
    e.worldY = tileY + fracY
    e.tileX = tileX
    e.tileY = tileY
    e.pickId = pickId
    e.button = button
    e.shift = shift
    e.ctrl = ctrl
    e.alt = alt
    e.meta = meta
    e.pointerType = pointerTypeName(pointerKind)
    callbacks[type].dispatch(e)

    const seq = nextSeq
    nextSeq = (nextSeq + 1) >>> 0
    const idx = ring.tryClaim()
    if (idx < 0) {
      // Planning decisions "Full `inputRing`: drop and count" -- never a block, a retry or a grow.
      ring.recordDrop()
      return
    }
    const modifiers = (shift ? 1 : 0) | (ctrl ? 2 : 0) | (alt ? 4 : 0) | (meta ? 8 : 0)
    recordScratch.kind = KIND_BY_TYPE[type]
    recordScratch.button = button
    recordScratch.modifiers = modifiers
    recordScratch.pointer = pointerKind
    recordScratch.seq = seq
    recordScratch.tileX = tileX
    recordScratch.tileY = tileY
    recordScratch.fracX = fracX
    recordScratch.fracY = fracY
    recordScratch.pickId = pickId
    recordScratch.timeMs = clockMs >>> 0
    writeInputRecord(ring.slotView(idx), 0, recordScratch)
    ring.commit()
  }

  /** `client.input.emit`'s own implementation (`InputController.emit`'s doc comment): writes
   * straight into `inputRing`, no callback dispatch (kind 7 is never delivered to `client.input.on`
   * -- this function is the *only* producer of that kind, and it never calls `callbacks[..].
   * dispatch`). `seq` is always `0` ("all else zero", Scope) -- `nextSeq` is reserved for the
   * semantic-event stream `emit` (the module-private function above) advances. */
  function emitGame(code: number, a = 0, b = 0): boolean {
    const idx = ring.tryClaim()
    if (idx < 0) {
      ring.recordDrop()
      return false
    }
    recordScratch.kind = InputKind.Game
    recordScratch.button = 0
    recordScratch.modifiers = 0
    recordScratch.pointer = 0
    recordScratch.seq = 0
    recordScratch.tileX = a
    recordScratch.tileY = b
    recordScratch.fracX = 0
    recordScratch.fracY = 0
    recordScratch.pickId = code
    recordScratch.timeMs = 0
    writeInputRecord(ring.slotView(idx), 0, recordScratch)
    ring.commit()
    return true
  }

  function endDrag(
    i: number,
    slot: PointerSlot,
    cameraState: CameraState,
    viewport: CameraViewport,
  ): void {
    tileUnderPoint(cameraState, viewport, slot.x, slot.y, tileScratch)
    emit(
      'dragend',
      tileScratch.tileX,
      tileScratch.tileY,
      tileScratch.fracX,
      tileScratch.fracY,
      pickIdAt(slot.x, slot.y),
      slot.button,
      slot.shift,
      slot.ctrl,
      slot.alt,
      slot.meta,
      slot.kind,
    )
    dragging[i] = 0
  }

  function processSlot(
    i: number,
    slot: PointerSlot,
    cameraState: CameraState,
    viewport: CameraViewport,
    activeCount: number,
    dtMs: number,
  ): void {
    if (slot.active) {
      if (wasActive[i] === 0) {
        // Just engaged: reset this press's bookkeeping. The down frame itself never emits
        // anything (same convention as `camera.ts`'s own "the down frame itself never pans").
        downX[i] = slot.x
        downY[i] = slot.y
        heldMs[i] = 0
        movedPastThreshold[i] = 0
        longpressFired[i] = 0
        dragging[i] = 0
      } else {
        heldMs[i] = (heldMs[i] as number) + dtMs
        const dx = slot.x - (downX[i] as number)
        const dy = slot.y - (downY[i] as number)
        if (Math.hypot(dx, dy) >= TAP_RADIUS_PX) movedPastThreshold[i] = 1
      }

      if (mode === 'tool' && activeCount === 1 && movedPastThreshold[i] === 1) {
        tileUnderPoint(cameraState, viewport, slot.x, slot.y, tileScratch)
        if (dragging[i] === 0) {
          dragging[i] = 1
          emit(
            'dragstart',
            tileScratch.tileX,
            tileScratch.tileY,
            tileScratch.fracX,
            tileScratch.fracY,
            pickIdAt(slot.x, slot.y),
            slot.button,
            slot.shift,
            slot.ctrl,
            slot.alt,
            slot.meta,
            slot.kind,
          )
        } else {
          emit(
            'drag',
            tileScratch.tileX,
            tileScratch.tileY,
            tileScratch.fracX,
            tileScratch.fracY,
            pickIdAt(slot.x, slot.y),
            slot.button,
            slot.shift,
            slot.ctrl,
            slot.alt,
            slot.meta,
            slot.kind,
          )
        }
      } else if (dragging[i] === 1) {
        // No longer a valid one-pointer tool-mode drag (mode changed, or a second pointer
        // engaged): end it. Camera pan/zoom for a second pointer is `camera.ts`'s own concern.
        endDrag(i, slot, cameraState, viewport)
      }

      if (
        longpressFired[i] === 0 &&
        movedPastThreshold[i] === 0 &&
        dragging[i] === 0 &&
        activeCount === 1 &&
        (heldMs[i] as number) >= LONGPRESS_MS
      ) {
        longpressFired[i] = 1
        tileUnderPoint(cameraState, viewport, slot.x, slot.y, tileScratch)
        emit(
          'longpress',
          tileScratch.tileX,
          tileScratch.tileY,
          tileScratch.fracX,
          tileScratch.fracY,
          pickIdAt(slot.x, slot.y),
          slot.button,
          slot.shift,
          slot.ctrl,
          slot.alt,
          slot.meta,
          slot.kind,
        )
      }
    } else if (wasActive[i] === 1) {
      // Just released.
      if (dragging[i] === 1) {
        endDrag(i, slot, cameraState, viewport)
      } else if (
        movedPastThreshold[i] === 0 &&
        longpressFired[i] === 0 &&
        (heldMs[i] as number) < TAP_MAX_MS
      ) {
        tileUnderPoint(cameraState, viewport, slot.x, slot.y, tileScratch)
        // docs/plan/18-picking-and-overlay.md (0019 §4 "Cursor tile and ghost"): "touch: tile of the
        // last tap" -- a touch pointer has no hover, so a tap is the only way its cursor tile is
        // ever set. Applied for every pointer kind (mouse included): a mouse tap lands on the same
        // tile hover already published, so this is a no-op re-affirmation there, not a behaviour
        // change to the mouse path.
        cameraState.cursorTileX = tileScratch.tileX
        cameraState.cursorTileY = tileScratch.tileY
        cameraState.cursorValid = true
        emit(
          'tap',
          tileScratch.tileX,
          tileScratch.tileY,
          tileScratch.fracX,
          tileScratch.fracY,
          pickIdAt(slot.x, slot.y),
          slot.button,
          slot.shift,
          slot.ctrl,
          slot.alt,
          slot.meta,
          slot.kind,
        )
      }
    }
    wasActive[i] = slot.active ? 1 : 0
  }

  function recognize(
    input: CameraInput,
    cameraState: CameraState,
    viewport: CameraViewport,
    dtMs: number,
  ): void {
    clockMs += dtMs
    if (suspended) return
    // A fixed indexed pair, not array destructuring (`.claude/rules/hot-paths.md`: found by the
    // zero-GC `input` page, docs/plan/11-camera-and-input.md step 7 -- destructuring a plain
    // `Array` still goes through the iterator protocol on a path this milestone is the first to
    // drive hard inside a measured window).
    const p0 = input.pointers.slots[0]
    const p1 = input.pointers.slots[1]
    const activeCount = (p0.active ? 1 : 0) + (p1.active ? 1 : 0)

    // 0019 §4: "hover (mouse only)"; the engine keeps a cursor tile (mouse: tile under the
    // pointer; touch: tile of the last tap -- set by the `tap` emission above/below instead). A
    // press-active mouse slot (button held while moving) takes priority over the idle-hover
    // fallback (mandatory gap #2): both report the same tile in practice, but only the slot carries
    // the pressed button/modifiers for `hover`'s own event fields.
    let mouseSlot: PointerSlot | undefined
    if (p0.active && p0.kind === PointerKind.Mouse) mouseSlot = p0
    else if (p1.active && p1.kind === PointerKind.Mouse) mouseSlot = p1
    if (mouseSlot) {
      tileUnderPoint(cameraState, viewport, mouseSlot.x, mouseSlot.y, tileScratch)
      cameraState.cursorTileX = tileScratch.tileX
      cameraState.cursorTileY = tileScratch.tileY
      cameraState.cursorValid = true
      if (tileScratch.tileX !== hoverTileX || tileScratch.tileY !== hoverTileY) {
        hoverTileX = tileScratch.tileX
        hoverTileY = tileScratch.tileY
        emit(
          'hover',
          tileScratch.tileX,
          tileScratch.tileY,
          tileScratch.fracX,
          tileScratch.fracY,
          pickIdAt(mouseSlot.x, mouseSlot.y),
          mouseSlot.button,
          mouseSlot.shift,
          mouseSlot.ctrl,
          mouseSlot.alt,
          mouseSlot.meta,
          PointerKind.Mouse,
        )
      }
    } else {
      const hover = input.pointers.mouseHover
      if (hover.valid) {
        tileUnderPoint(cameraState, viewport, hover.x, hover.y, tileScratch)
        cameraState.cursorTileX = tileScratch.tileX
        cameraState.cursorTileY = tileScratch.tileY
        cameraState.cursorValid = true
        if (tileScratch.tileX !== hoverTileX || tileScratch.tileY !== hoverTileY) {
          hoverTileX = tileScratch.tileX
          hoverTileY = tileScratch.tileY
          emit(
            'hover',
            tileScratch.tileX,
            tileScratch.tileY,
            tileScratch.fracX,
            tileScratch.fracY,
            pickIdAt(hover.x, hover.y),
            0,
            hover.shift,
            hover.ctrl,
            hover.alt,
            hover.meta,
            PointerKind.Mouse,
          )
        }
      }
    }

    processSlot(0, p0, cameraState, viewport, activeCount, dtMs)
    processSlot(1, p1, cameraState, viewport, activeCount, dtMs)
  }

  return {
    on(type, cb) {
      return callbacks[type].add(cb)
    },
    setMode(m) {
      mode = m
    },
    suspend() {
      suspended = true
    },
    resume() {
      suspended = false
    },
    emit: emitGame,
    recognize,
  }
}
