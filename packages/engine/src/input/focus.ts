// Focus-loss reset (docs/decisions/0019-camera-input-and-overlay.md §4: "all key and pointer state
// is cleared on `blur`, `visibilitychange` and `pointercancel`"; docs/plan/11-camera-and-input.md,
// Order of work step 6, Non-scope of the 1-3 range: "Keyboard/pointer focus rules ... beyond
// `pointercancel`'s own slot release, which `pointers.ts` already does"). `pointercancel` already
// clears its own slot (`recordPointerUp`, `input/pointers.ts`); this file is the other two triggers,
// which are page-wide, not per-pointer, so they clear every fixed slot at once: both pointer slots,
// the gesture slot, the idle-mouse hover, the wheel accumulator and the key bitmask.
//
// A plain local type, not `camera/camera.ts`'s own `CameraInput` (which this file would otherwise
// need to import just for a type, the wrong direction for a leaf `input/*` module to depend on
// `camera/*`): the same three-field shape, structurally compatible either way.
import type { KeyState } from './keys.js'
import type { PointerSlots } from './pointers.js'
import type { WheelState } from './wheel.js'

export type FocusResetBundle = { pointers: PointerSlots; keys: KeyState; wheel: WheelState }

/** Clears every fixed input slot in place. Exported standalone so a test can assert the effect
 * without dispatching a real `blur`/`visibilitychange`. */
export function resetInputState(bundle: FocusResetBundle): void {
  bundle.keys.mask = 0
  for (const slot of bundle.pointers.slots) slot.active = false
  bundle.pointers.gesture.active = false
  bundle.pointers.mouseHover.valid = false
  bundle.wheel.hasPending = false
  bundle.wheel.pendingDeltaLog = 0
}

/** `window`'s `blur` (focus left the whole page/tab) and `document`'s `visibilitychange` (only
 * acted on when the page just became hidden -- becoming visible again needs no reset, the slots are
 * already clear). Returns a disposer. */
export function installBlurAndVisibilityReset(
  bundle: FocusResetBundle,
  win: Window = window,
  doc: Document = document,
): () => void {
  function onBlur(): void {
    resetInputState(bundle)
  }
  function onVisibilityChange(): void {
    if (doc.hidden) resetInputState(bundle)
  }
  win.addEventListener('blur', onBlur)
  doc.addEventListener('visibilitychange', onVisibilityChange)
  return () => {
    win.removeEventListener('blur', onBlur)
    doc.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
