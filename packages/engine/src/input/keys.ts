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

/** 0019 §4 focus rules: "ignored when the target is `input, textarea, select, [contenteditable]`,
 * when `isComposing`, or with Ctrl/Meta/Alt held" -- keeps a real text field, a modal's own
 * shortcut, or a browser accelerator (Ctrl+W, Cmd+Q, ...) from being read as a WASD pan. Exported
 * for `input.keyboard_focus_rules` to probe directly. */
export function shouldIgnoreKeyDown(e: {
  isComposing: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  target: EventTarget | null
}): boolean {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return true
  const target = e.target
  if (target instanceof HTMLElement) {
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (target.isContentEditable) return true
  }
  return false
}

/** `window`-level (0019 §4: "key listeners on `window`"), matched by `event.code` so layout doesn't
 * matter. `keydown` is filtered by `shouldIgnoreKeyDown`; `keyup` never is -- releasing a key must
 * always be able to clear a bit `keydown` already set, even if a modifier got pressed or focus moved
 * in between (otherwise a real user releasing D while also tapping Ctrl would leave `KeyBit.D` stuck
 * on forever). Returns a disposer. */
export function installKeyListeners(state: KeyState, target: Window = window): () => void {
  function onKeyDown(e: KeyboardEvent): void {
    if (shouldIgnoreKeyDown(e)) return
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
