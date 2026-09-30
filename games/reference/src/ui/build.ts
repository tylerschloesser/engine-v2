// `createBuildUi` (docs/plan/33-reference-furnace.md Scope): the Build button (shown while the
// player holds a furnace item), construction mode, and the two placement flows.
//
// Construction mode is client-local: `client.input.emit(LOCAL.PLACE_MODE, on)` tells `RefClient`
// (which then emits the ghost); nothing is logged and `client.input.setMode` is not used, so drags
// keep panning (0019 section 4). Mouse: a `tap` while placing dispatches `PlaceFurnace` at the
// tapped tile. Touch: a `tap` moves the engine's cursor tile (the ghost follows it) and shows a
// Confirm button anchored just below the ghost; Confirm dispatches. Mouse or touch is the tap's
// `pointerType`. A rejection flashes the control that sent the action with the reason as a CSS
// class (`reject-<reason>`), like a collect button.
//
// DOM identity: `.build-button` (`data-build`), `.build-confirm` (`data-build-confirm="x,y"`).
import type { ActionOutcome, Client } from 'engine'
import type { RefAction } from '../bindings/RefAction.js'
import type { RefReject } from '../bindings/RefReject.js'
import type { RefUi } from '../bindings/RefUi.js'
import { el } from './dom.js'

/** `content::local` (`sim/src/content.rs`): change both together. */
export const LOCAL = { PLACE_MODE: 1, CLOSE_PANEL: 2 } as const

type AnchorHandle = ReturnType<Client['overlay']['anchor']>

export type BuildUi = {
  /** Wired to `client.onUi<RefUi>`. */
  onUi(ui: RefUi): void
  /** Wired to `client.onActionResult<RefReject>`. */
  onActionResult(seq: number, result: ActionOutcome<RefReject>): void
}

const STYLE_ID = 'reference-build-styles'

function installBuildStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.build-button, .build-confirm {',
    '  padding: 4px 10px;',
    '  border: 1px solid #345;',
    '  border-radius: 4px;',
    '  background: #123;',
    '  color: #fff;',
    '  font: 11px sans-serif;',
    '  cursor: pointer;',
    '  white-space: nowrap;',
    '}',
    '.build-button { position: fixed; left: 8px; bottom: 8px; z-index: 5; }',
    '.build-button.is-on { background: #264; }',
    '.build-confirm { background: #264; }',
    '.build-button[hidden], .build-confirm[hidden] { display: none; }',
    '.build-button[class*="reject-"], .build-confirm[class*="reject-"] {',
    '  animation: build-reject-flash 300ms ease-out;',
    '}',
    '@keyframes build-reject-flash {',
    '  0% { background: #a33; }',
    '  100% { background: #123; }',
    '}',
  ].join('\n')
  doc.head.appendChild(style)
}

export function createBuildUi(client: Client, doc: Document = document): BuildUi {
  installBuildStyles(doc)

  const button = el('button', 'build-button')
  button.dataset.build = ''
  button.textContent = 'Build'
  button.hidden = true
  doc.body.appendChild(button)

  const confirm = el('button', 'build-confirm')
  confirm.textContent = 'Confirm'
  confirm.hidden = true
  // Anchored once, hidden until a touch tap; `set` moves it to each tapped tile.
  const anchor: AnchorHandle = client.overlay.anchor(confirm, 0, 0, { align: 'top' })

  let placing = false
  let canBuild = false
  /** The tile a touch tap chose; `null` until one does, and again after leaving construction mode. */
  let touchTile: { x: number; y: number } | null = null
  /** `seq -> the control that sent it`, for the rejection flash. */
  const pending = new Map<number, HTMLElement>()

  function setPlacing(on: boolean): void {
    if (on === placing) return
    placing = on
    client.input.emit(LOCAL.PLACE_MODE, on ? 1 : 0)
    if (!on) hideConfirm()
    render()
  }

  function hideConfirm(): void {
    touchTile = null
    confirm.hidden = true
  }

  function render(): void {
    button.hidden = !(canBuild || placing)
    button.classList.toggle('is-on', placing)
    button.textContent = placing ? 'Cancel' : 'Build'
  }

  function place(origin: { x: number; y: number }, from: HTMLElement): void {
    const action: RefAction = { PlaceFurnace: { origin: { x: origin.x, y: origin.y } } }
    pending.set(client.dispatch(action), from)
  }

  button.addEventListener('click', () => setPlacing(!placing))
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setPlacing(false)
  })
  confirm.addEventListener('click', () => {
    if (touchTile === null) return
    place(touchTile, confirm)
  })

  client.input.on('tap', (e) => {
    if (!placing) return
    if (e.pointerType === 'touch') {
      // The engine has already moved its cursor tile here (the ghost follows); the Confirm button
      // sits at the bottom edge of the 2x2 ghost, centred on it.
      touchTile = { x: e.tileX, y: e.tileY }
      anchor.set(e.tileX + 1, e.tileY + 2)
      confirm.dataset.buildConfirm = `${e.tileX},${e.tileY}`
      confirm.hidden = false
    } else {
      place({ x: e.tileX, y: e.tileY }, button)
    }
  })

  function onUi(ui: RefUi): void {
    canBuild = ui.can_build
    // The last furnace was placed: `RefClient` has already ended construction mode itself, so
    // follow it without emitting (an emit from a `Ui` callback lands between frames).
    if (placing && !canBuild && !ui.placing) {
      placing = false
      hideConfirm()
    }
    render()
  }

  function onActionResult(seq: number, result: ActionOutcome<RefReject>): void {
    if (result === 'NotPredictable') return
    const from = pending.get(seq)
    if (from === undefined) return
    pending.delete(seq)
    if (result === 'Confirmed' || result === 'Lost') return
    const reason = 'Game' in result.Rejected ? result.Rejected.Game : result.Rejected.Engine
    const cls = `reject-${String(reason).toLowerCase()}`
    from.classList.remove(cls)
    void from.offsetWidth
    from.classList.add(cls)
    from.addEventListener('animationend', () => from.classList.remove(cls), { once: true })
  }

  return { onUi, onActionResult }
}
