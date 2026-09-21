// Key bitmask (docs/decisions/0019-camera-input-and-overlay.md §3: "WASD uses `event.code`");
// docs/plan/11-camera-and-input.md Scope: "a key bitmask ... nothing else happens in a listener".
// Focus rules (ignore `input`/`textarea`/`select`/`[contenteditable]`, `isComposing`, Ctrl/Meta/Alt
// held; clear on `blur`) are 0019 §4's own paragraph but this milestone's step 6 (Non-scope: "focus
// rules"): `installKeyListeners` here is the plain `window` keydown/keyup recorder step 6 will wrap.
export const KeyBit = { W: 1 << 0, A: 1 << 1, S: 1 << 2, D: 1 << 3 } as const

const CODE_BIT: Readonly<Record<string, number>> = {
  KeyW: KeyBit.W,
  KeyA: KeyBit.A,
  KeyS: KeyBit.S,
  KeyD: KeyBit.D,
}

export class KeyState {
  mask = 0
}

export function recordKey(state: KeyState, code: string, down: boolean): void {
  const bit = CODE_BIT[code]
  if (bit === undefined) return
  state.mask = down ? state.mask | bit : state.mask & ~bit
}

/** `window`-level (0019 §4: "key listeners on `window`"), matched by `event.code` so layout doesn't
 * matter. Returns a disposer. */
export function installKeyListeners(state: KeyState, target: Window = window): () => void {
  function onKeyDown(e: KeyboardEvent): void {
    recordKey(state, e.code, true)
  }
  function onKeyUp(e: KeyboardEvent): void {
    recordKey(state, e.code, false)
  }
  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  return () => {
    target.removeEventListener('keydown', onKeyDown)
    target.removeEventListener('keyup', onKeyUp)
  }
}
