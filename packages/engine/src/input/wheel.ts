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
/** M39aj (docs/decisions/0061-wheel-zoom-bounded-accumulator.md, amending 0019 §3): the outstanding
 * accumulator saturates here, so one burst of events (a momentum flick, a trackpad pinch) queues at
 * most one doubling or halving. The whole default range is only ln(256/12) = 3.06. */
export const WHEEL_MAX_PENDING_LOG = Math.LN2

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
  const next = state.pendingDeltaLog + deltaY * WHEEL_K * modeMult * ctrlMult
  state.pendingDeltaLog =
    next > WHEEL_MAX_PENDING_LOG
      ? WHEEL_MAX_PENDING_LOG
      : next < -WHEEL_MAX_PENDING_LOG
        ? -WHEEL_MAX_PENDING_LOG
        : next
  state.cssX = cssX
  state.cssY = cssY
  state.hasPending = true
}

/** An element (or an ancestor below the listener root) carrying this attribute keeps its own wheel
 * scroll: the listener neither zooms nor calls `preventDefault` (docs/decisions/0061 §3). */
export const WHEEL_OWN_ATTRIBUTE = 'data-wheel-own'

/** Non-passive (0019 §3: "non-passive `wheel` ... listener ... calling `preventDefault()`" -- a
 * `window`-level wheel listener is passive by default in Chrome, per that same paragraph). Listens on
 * `root` (default: the canvas's parent, the overlay's default root), so events over the canvas and
 * over every anchored overlay element bubble into it (docs/decisions/0061 §2; before M39aj the
 * listener sat on the canvas and a `pointer-events: auto` overlay element swallowed the wheel).
 *
 * Cursor position: an event aimed at the canvas uses `offsetX`/`offsetY` (see `input/pointers.ts`'s
 * doc comment: no per-event `DOMRect`); an event aimed at an overlay element uses
 * `clientX/clientY` minus a canvas rect cached on resize, window resize and scroll. Returns a
 * disposer. */
export function installWheelListeners(
  state: WheelState,
  canvas: HTMLElement,
  root: HTMLElement = canvas.parentElement ?? canvas,
): () => void {
  let rectLeft = 0
  let rectTop = 0
  function refreshRect(): void {
    const r = canvas.getBoundingClientRect()
    rectLeft = r.left
    rectTop = r.top
  }
  refreshRect()
  function onWheel(e: WheelEvent): void {
    const target = e.target
    if (target === canvas) {
      e.preventDefault()
      recordWheel(state, e.deltaY, e.deltaMode, e.offsetX, e.offsetY, e.ctrlKey)
      return
    }
    let el = target as Element | null
    while (el && el !== root) {
      if (el.hasAttribute(WHEEL_OWN_ATTRIBUTE)) return
      el = el.parentElement
    }
    e.preventDefault()
    recordWheel(state, e.deltaY, e.deltaMode, e.clientX - rectLeft, e.clientY - rectTop, e.ctrlKey)
  }
  root.addEventListener('wheel', onWheel, { passive: false })
  let observer: ResizeObserver | undefined
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(refreshRect)
    observer.observe(canvas)
  }
  const win = typeof window !== 'undefined' ? window : undefined
  win?.addEventListener('resize', refreshRect)
  win?.addEventListener('scroll', refreshRect, { passive: true, capture: true })
  return () => {
    root.removeEventListener('wheel', onWheel)
    observer?.disconnect()
    win?.removeEventListener('resize', refreshRect)
    win?.removeEventListener('scroll', refreshRect, { capture: true })
  }
}
