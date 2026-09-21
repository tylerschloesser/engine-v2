// Fixed pointer slots (docs/decisions/0019-camera-input-and-overlay.md §3; docs/plan/
// 11-camera-and-input.md Scope: "listeners per 0019 §3-§4 that write into two fixed pointer slots
// ... nothing else happens in a listener"). At most two pointers are tracked at once (extra touches
// are silently ignored -- 0019 §3's own "at most two pointers"); macOS Safari's non-standard
// `gesturechange` writes into its own small `GestureState`, not a third pointer slot, since it never
// carries a `pointerId` at all. Every `record*` function below is the single source of truth both a
// real `PointerEvent`/`GestureEvent` listener and `engine/test`'s `injectPointer` call into (Seams,
// Provides): plain field writes and fixed-size ring pushes, no allocation (`.claude/rules/
// hot-paths.md` -- this runs on every real pointer event during a drag, which is normal play, 0016
// §2).
export const MAX_POINTERS = 2

/** Matches the eventual `inputRing` record's `pointer` byte (Seams, Provides) so `semantic.ts`
 * (M11 steps 4-5) can copy a slot's `kind` straight across without a second mapping. */
export const PointerKind = { Mouse: 0, Touch: 1, Pen: 2 } as const
export type PointerKindValue = (typeof PointerKind)[keyof typeof PointerKind]

export function pointerKindFromEventType(pointerType: string): PointerKindValue {
  if (pointerType === 'touch') return PointerKind.Touch
  if (pointerType === 'pen') return PointerKind.Pen
  return PointerKind.Mouse
}

/** Samples over the last ~80 ms (0019 §3 "a fixed ring of the last 80ms of samples"), used to
 * derive inertia velocity when a pointer lifts. 16 slots comfortably covers 80 ms even at a
 * 240 Hz touch digitizer (~19 samples); older samples are simply overwritten. */
const SAMPLE_CAPACITY = 16
const INERTIA_WINDOW_MS = 80

export class PointerSlot {
  active = false
  id = -1
  kind: PointerKindValue = PointerKind.Mouse
  x = 0
  y = 0
  /** M11 step 6 (mandatory gap #1, docs/plan/11-camera-and-input.md delegation prompt): captured
   * at `recordPointerDown` (a button/modifier state doesn't change mid-press for `button`; the
   * modifiers are refreshed on every `recordPointerMove` too, since a real drag can start or stop
   * holding Shift etc partway through). `button` matches `PointerEvent.button` (0 primary, 1
   * auxiliary, 2 secondary); always 0 for a touch/pen `pointerdown`, which never sets a nonzero
   * `button`. */
  button = 0
  shift = false
  ctrl = false
  alt = false
  meta = false
  readonly sampleX = new Float64Array(SAMPLE_CAPACITY)
  readonly sampleY = new Float64Array(SAMPLE_CAPACITY)
  readonly sampleT = new Float64Array(SAMPLE_CAPACITY)
  sampleCount = 0
  sampleNext = 0

  pushSample(x: number, y: number, tMs: number): void {
    const i = this.sampleNext
    this.sampleX[i] = x
    this.sampleY[i] = y
    this.sampleT[i] = tMs
    this.sampleNext = (i + 1) % SAMPLE_CAPACITY
    if (this.sampleCount < SAMPLE_CAPACITY) this.sampleCount++
  }
}

/** M11 step 6 (mandatory gap #2): a real desktop mouse fires `pointermove` continuously with no
 * button held, which never activates a `PointerSlot` (that only happens on a real `pointerdown`,
 * Deviations of the 4-5 range: "a genuinely idle hovering mouse ... produces no state at all
 * today"). A mouse-kind `pointermove` updates this every time, independent of `PointerSlot`
 * activation, so `semantic.ts`'s `recognize()` can fall back to it when no mouse slot is
 * press-active -- `camera.ts`'s own pan logic never reads this (only `PointerSlot.active` drives
 * `activeCount`), so an idle hover still cannot pan the camera. */
export class MouseHoverState {
  x = 0
  y = 0
  valid = false
  shift = false
  ctrl = false
  alt = false
  meta = false
}

/** macOS Safari trackpad pinch (0019 §3): `gesturechange.scale` is cumulative from `gesturestart`
 * (always 1 there), not a per-event delta -- `scale`/`x`/`y` are simply the latest reported values;
 * `camera/camera.ts` tracks how much of `scale` it has already applied. */
export class GestureState {
  active = false
  scale = 1
  x = 0
  y = 0
}

export class PointerSlots {
  readonly slots: readonly [PointerSlot, PointerSlot] = [new PointerSlot(), new PointerSlot()]
  readonly gesture = new GestureState()
  readonly mouseHover = new MouseHoverState()
}

function findSlot(state: PointerSlots, id: number): PointerSlot | undefined {
  for (const s of state.slots) if (s.active && s.id === id) return s
  return undefined
}

function freeSlot(state: PointerSlots): PointerSlot | undefined {
  for (const s of state.slots) if (!s.active) return s
  return undefined
}

export function recordPointerDown(
  state: PointerSlots,
  id: number,
  x: number,
  y: number,
  tMs: number,
  kind: PointerKindValue = PointerKind.Mouse,
  button = 0,
  shift = false,
  ctrl = false,
  alt = false,
  meta = false,
): void {
  if (findSlot(state, id)) return // already tracked (duplicate down, ignore)
  const slot = freeSlot(state)
  if (!slot) return // 0019 §3: at most two pointers tracked, extra touches are ignored
  slot.active = true
  slot.id = id
  slot.kind = kind
  slot.x = x
  slot.y = y
  slot.button = button
  slot.shift = shift
  slot.ctrl = ctrl
  slot.alt = alt
  slot.meta = meta
  slot.sampleCount = 0
  slot.sampleNext = 0
  slot.pushSample(x, y, tMs)
}

export function recordPointerMove(
  state: PointerSlots,
  id: number,
  x: number,
  y: number,
  tMs: number,
  shift = false,
  ctrl = false,
  alt = false,
  meta = false,
): void {
  const slot = findSlot(state, id)
  if (!slot) return
  slot.x = x
  slot.y = y
  slot.shift = shift
  slot.ctrl = ctrl
  slot.alt = alt
  slot.meta = meta
  slot.pushSample(x, y, tMs)
}

/** M11 step 6: written by every mouse-kind `pointermove` regardless of whether a `PointerSlot` is
 * press-active (mandatory gap #2 above); a real listener also calls this from `onMove` alongside
 * `recordPointerMove`. */
export function recordMouseHover(
  state: PointerSlots,
  x: number,
  y: number,
  shift = false,
  ctrl = false,
  alt = false,
  meta = false,
): void {
  const hover = state.mouseHover
  hover.x = x
  hover.y = y
  hover.valid = true
  hover.shift = shift
  hover.ctrl = ctrl
  hover.alt = alt
  hover.meta = meta
}

/** Shared by `pointerup` and `pointercancel`: both end a pointer's involvement the same way. The
 * slot's own ring is left as-is (not reset) so the *next* camera integration pass -- which sees this
 * transition to `active: false` -- can still read it to derive an inertia velocity; the ring is only
 * cleared again on that slot's *next* `recordPointerDown`. */
export function recordPointerUp(
  state: PointerSlots,
  id: number,
  x: number,
  y: number,
  tMs: number,
): void {
  const slot = findSlot(state, id)
  if (!slot) return
  slot.x = x
  slot.y = y
  slot.pushSample(x, y, tMs)
  slot.active = false
}

export function recordGestureStart(state: PointerSlots, x: number, y: number): void {
  state.gesture.active = true
  state.gesture.scale = 1
  state.gesture.x = x
  state.gesture.y = y
}

export function recordGestureChange(
  state: PointerSlots,
  scale: number,
  x: number,
  y: number,
): void {
  state.gesture.active = true
  state.gesture.scale = scale
  state.gesture.x = x
  state.gesture.y = y
}

export function recordGestureEnd(state: PointerSlots): void {
  state.gesture.active = false
}

export type ScreenVelocity = { x: number; y: number }

/** Velocity in CSS px/second (screen space), from the oldest sample within `INERTIA_WINDOW_MS` of
 * the newest one, to the newest. Returns `false` (leaving `out` untouched) when fewer than two
 * samples fall inside that window -- too short a history to derive a velocity from. */
export function pointerVelocity(slot: PointerSlot, out: ScreenVelocity): boolean {
  const n = slot.sampleCount
  if (n < 2) return false
  const newestIdx = (slot.sampleNext - 1 + SAMPLE_CAPACITY) % SAMPLE_CAPACITY
  const newestT = slot.sampleT[newestIdx] as number
  let oldestIdx = newestIdx
  for (let k = 1; k < n; k++) {
    const idx = (newestIdx - k + SAMPLE_CAPACITY) % SAMPLE_CAPACITY
    const t = slot.sampleT[idx] as number
    if (newestT - t > INERTIA_WINDOW_MS) break
    oldestIdx = idx
  }
  if (oldestIdx === newestIdx) return false
  const dtSec = (newestT - (slot.sampleT[oldestIdx] as number)) / 1000
  if (dtSec <= 0) return false
  out.x = ((slot.sampleX[newestIdx] as number) - (slot.sampleX[oldestIdx] as number)) / dtSec
  out.y = ((slot.sampleY[newestIdx] as number) - (slot.sampleY[oldestIdx] as number)) / dtSec
  return true
}

/** Canvas-only (0019 §3): `pointerdown` takes pointer capture so a drag that passes under a
 * `pointer-events: auto` widget keeps panning; `gesturestart`/`gesturechange`/`gestureend` are
 * Safari-only (harmless no-ops elsewhere) and call `preventDefault()` the same way the non-passive
 * `wheel` listener does (`input/wheel.ts`). Uses `offsetX`/`offsetY` (canvas-relative, provided by
 * the browser on every `MouseEvent`-derived event) rather than `getBoundingClientRect()`, which
 * would allocate a fresh `DOMRect` on every single pointer move during a real drag -- a per-event
 * allocation on a path that runs during ordinary play (0016 §2 "steady state ... including
 * panning"). Returns a disposer. */
export function installPointerListeners(state: PointerSlots, canvas: HTMLElement): () => void {
  function onDown(e: PointerEvent): void {
    canvas.setPointerCapture(e.pointerId)
    recordPointerDown(
      state,
      e.pointerId,
      e.offsetX,
      e.offsetY,
      e.timeStamp,
      pointerKindFromEventType(e.pointerType),
      e.button,
      e.shiftKey,
      e.ctrlKey,
      e.altKey,
      e.metaKey,
    )
    if (e.pointerType === 'mouse') {
      recordMouseHover(state, e.offsetX, e.offsetY, e.shiftKey, e.ctrlKey, e.altKey, e.metaKey)
    }
  }
  function onMove(e: PointerEvent): void {
    recordPointerMove(
      state,
      e.pointerId,
      e.offsetX,
      e.offsetY,
      e.timeStamp,
      e.shiftKey,
      e.ctrlKey,
      e.altKey,
      e.metaKey,
    )
    // Mandatory gap #2 (docs/plan/11-camera-and-input.md delegation prompt): a mouse fires
    // `pointermove` whether or not any button is held, so this is written on every one of them --
    // not only while a `PointerSlot` happens to be press-active for this same event.
    if (e.pointerType === 'mouse') {
      recordMouseHover(state, e.offsetX, e.offsetY, e.shiftKey, e.ctrlKey, e.altKey, e.metaKey)
    }
  }
  function onUp(e: PointerEvent): void {
    recordPointerUp(state, e.pointerId, e.offsetX, e.offsetY, e.timeStamp)
  }
  function onCancel(e: PointerEvent): void {
    recordPointerUp(state, e.pointerId, e.offsetX, e.offsetY, e.timeStamp)
  }
  function onLeave(e: PointerEvent): void {
    if (e.pointerType === 'mouse') state.mouseHover.valid = false
  }
  function onGestureStart(e: Event): void {
    e.preventDefault()
    const ge = e as unknown as { offsetX: number; offsetY: number }
    recordGestureStart(state, ge.offsetX, ge.offsetY)
  }
  function onGestureChange(e: Event): void {
    e.preventDefault()
    const ge = e as unknown as { scale: number; offsetX: number; offsetY: number }
    recordGestureChange(state, ge.scale, ge.offsetX, ge.offsetY)
  }
  function onGestureEnd(e: Event): void {
    e.preventDefault()
    recordGestureEnd(state)
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onCancel)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('gesturestart', onGestureStart, { passive: false })
  canvas.addEventListener('gesturechange', onGestureChange, { passive: false })
  canvas.addEventListener('gestureend', onGestureEnd, { passive: false })
  return () => {
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointercancel', onCancel)
    canvas.removeEventListener('pointerleave', onLeave)
    canvas.removeEventListener('gesturestart', onGestureStart)
    canvas.removeEventListener('gesturechange', onGestureChange)
    canvas.removeEventListener('gestureend', onGestureEnd)
  }
}
