// `engine/test`: engine-level input injection (docs/decisions/0019-camera-input-and-overlay.md,
// Consequences; docs/decisions/0020-testing-strategy.md §8; docs/plan/11-camera-and-input.md Seams,
// Provides). `injectPointer`/`injectWheel`/`injectKey` write into the exact same fixed slots a real
// `PointerEvent`/`WheelEvent`/`KeyboardEvent` listener would (`input/pointers.ts`, `input/keys.ts`,
// `input/wheel.ts`'s own `record*` functions), so a test drives gestures with no real DOM dispatch
// and no per-event browser allocation (0016 Consequences: "engine-level input injection that does
// not allocate"). Never imported by production code.
import type { Client } from '../client.js'
import type { KeyState } from '../input/keys.js'
import { recordKey } from '../input/keys.js'
import type { PointerKindValue, PointerSlots } from '../input/pointers.js'
import {
  PointerKind,
  recordPointerDown,
  recordPointerMove,
  recordPointerUp,
} from '../input/pointers.js'
import type { WheelState } from '../input/wheel.js'
import { recordWheel } from '../input/wheel.js'

export type CameraInputBundle = { pointers: PointerSlots; keys: KeyState; wheel: WheelState }

const bundles = new WeakMap<Client, CameraInputBundle>()

/** Pairs `client` with the fixed input-state objects a page's own listener wiring created (the
 * same "attach once, look up by client" shape `test/render.ts`'s `attachRenderer` and
 * `test/viewport.ts`'s `attachViewportTestHooks` already use), so the injectors below need no
 * extra argument. */
export function attachCameraInputTestHooks(client: Client, bundle: CameraInputBundle): void {
  bundles.set(client, bundle)
}

function bundleOf(client: Client): CameraInputBundle {
  const b = bundles.get(client)
  if (!b)
    throw new Error(
      'injectPointer/injectWheel/injectKey: call attachCameraInputTestHooks(client, ...) first',
    )
  return b
}

export type PointerPhase = 'down' | 'move' | 'up' | 'cancel'
export type PointerKindName = 'mouse' | 'touch' | 'pen'

const KIND_BY_NAME: Readonly<Record<PointerKindName, PointerKindValue>> = {
  mouse: PointerKind.Mouse,
  touch: PointerKind.Touch,
  pen: PointerKind.Pen,
}

/** Writes into the same two fixed pointer slots (or, on a real gesture, the same gesture state)
 * `input/pointers.ts`'s `installPointerListeners` writes (Seams, Provides). `'cancel'` behaves
 * exactly like `'up'` (`input/pointers.ts`'s own `recordPointerUp`, shared by both). */
export function injectPointer(
  client: Client,
  phase: PointerPhase,
  id: number,
  cssX: number,
  cssY: number,
  tMs: number,
  pointerType: PointerKindName = 'mouse',
): void {
  const { pointers } = bundleOf(client)
  if (phase === 'down') recordPointerDown(pointers, id, cssX, cssY, tMs, KIND_BY_NAME[pointerType])
  else if (phase === 'move') recordPointerMove(pointers, id, cssX, cssY, tMs)
  else recordPointerUp(pointers, id, cssX, cssY, tMs) // 'up' | 'cancel'
}

/** `deltaMode` is always 0 (pixel): a test asks for a pixel delta directly rather than picking a
 * `deltaMode` to reach one. */
export function injectWheel(
  client: Client,
  deltaY: number,
  cssX: number,
  cssY: number,
  ctrlKey = false,
): void {
  recordWheel(bundleOf(client).wheel, deltaY, 0, cssX, cssY, ctrlKey)
}

export function injectKey(client: Client, code: string, down: boolean): void {
  recordKey(bundleOf(client).keys, code, down)
}
