// Wheel accumulator (docs/decisions/0019-camera-input-and-overlay.md §3; docs/plan/
// 11-camera-and-input.md Planning decisions "Wheel constants"): a listener only accumulates a
// target log-zoom delta and remembers the cursor position; `camera/camera.ts` is what eases toward
// it, once per rAF. `Δlog(tiles) = deltaY x k`, `k = 0.002` per pixel (d3-zoom's own constants, per
// the brief -- 0019 fixes only the form), `x 25` for `deltaMode` line, `x 500` for page, `x 10` with
// `ctrlKey` (Chrome/Firefox trackpad pinch, which reports as `wheel` with `ctrlKey: true`). Positive
// `deltaY` (scrolling down/away) increases `Δlog`, so `tilesAcross` grows -- zooming out; negative
// `deltaY` zooms in.
export const WHEEL_K = 0.002
const DELTA_MODE_LINE_MULT = 25
const DELTA_MODE_PAGE_MULT = 500
const CTRL_MULT = 10

export class WheelState {
  /** Remaining log-zoom delta not yet eased in by `camera/camera.ts` (consumed there, not here). */
  pendingDeltaLog = 0
  /** Cursor position (canvas-relative CSS px) of the most recent wheel event: the pivot every
   * pending delta zooms about, "wheel zooms about the cursor" (0019 §3). */
  cssX = 0
  cssY = 0
  hasPending = false
}

export function recordWheel(
  state: WheelState,
  deltaY: number,
  deltaMode: number,
  cssX: number,
  cssY: number,
  ctrlKey: boolean,
): void {
  const modeMult =
    deltaMode === 1 ? DELTA_MODE_LINE_MULT : deltaMode === 2 ? DELTA_MODE_PAGE_MULT : 1
  const ctrlMult = ctrlKey ? CTRL_MULT : 1
  state.pendingDeltaLog += deltaY * WHEEL_K * modeMult * ctrlMult
  state.cssX = cssX
  state.cssY = cssY
  state.hasPending = true
}

/** Canvas-only, non-passive (0019 §3: "non-passive `wheel` ... listener on the canvas calling
 * `preventDefault()`" -- a `window`-level wheel listener is passive by default in Chrome, per that
 * same paragraph). `offsetX`/`offsetY`, not `getBoundingClientRect()`: see `input/pointers.ts`'s own
 * doc comment for why (no per-event `DOMRect` allocation on a path that runs during ordinary play).
 * Returns a disposer. */
export function installWheelListeners(state: WheelState, canvas: HTMLElement): () => void {
  function onWheel(e: WheelEvent): void {
    e.preventDefault()
    recordWheel(state, e.deltaY, e.deltaMode, e.offsetX, e.offsetY, e.ctrlKey)
  }
  canvas.addEventListener('wheel', onWheel, { passive: false })
  return () => canvas.removeEventListener('wheel', onWheel)
}
