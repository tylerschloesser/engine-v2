// `createBeltUi` (M51b): the placed belt's popover, anchored above the tapped belt with
// `client.overlay.anchor`. Like the furnace panel it holds no state about which belt is open:
// `Ui.belt` (Rust, `RefClient.belt`) says, and the popover is hidden while it is `null`. A tap on a
// belt opens it, a tap elsewhere, a tool or `CLOSE_PANEL` closes it, and it goes when the belt does.
//
// Rotate dispatches `RotateBelt` (the popover stays; the sprite turns). Pick up dispatches
// `PickUpBelt` then emits `CLOSE_PANEL`. Every dispatch and emit happens inside a button's own click
// handler, never inside `onUi`.
//
// DOM identity: root `.belt-popover` (`data-belt="x,y"`, `data-dir`, `data-kind`);
// `[data-belt-rotate]`, `[data-belt-pickup]`.
import type { ActionOutcome, Client } from 'engine'
import type { RefAction } from '../bindings/RefAction.js'
import type { RefReject } from '../bindings/RefReject.js'
import type { RefUi } from '../bindings/RefUi.js'
import { LOCAL } from './build.js'
import { el } from './dom.js'

type AnchorHandle = ReturnType<Client['overlay']['anchor']>
type BeltState = NonNullable<RefUi['belt']>

export type BeltUi = {
  /** Wired to `client.onUi<RefUi>`. */
  onUi(ui: RefUi): void
  /** Wired to `client.onActionResult<RefReject>`. */
  onActionResult(seq: number, result: ActionOutcome<RefReject>): void
}

const STYLE_ID = 'reference-belt-styles'

function installBeltStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.belt-popover {',
    '  display: flex;',
    '  gap: 4px;',
    '  padding: 4px;',
    '  border: 1px solid #345;',
    '  border-radius: 6px;',
    '  background: rgba(10, 20, 30, 0.92);',
    '  white-space: nowrap;',
    '}',
    '.belt-popover[hidden] { display: none; }',
    '.belt-popover button {',
    '  padding: 2px 6px;',
    '  border: 1px solid #345;',
    '  border-radius: 3px;',
    '  background: #123;',
    '  color: #fff;',
    '  font: 11px sans-serif;',
    '  cursor: pointer;',
    '}',
    '.belt-popover button[class*="reject-"] { animation: belt-reject-flash 300ms ease-out; }',
    '@keyframes belt-reject-flash {',
    '  0% { background: #a33; }',
    '  100% { background: #123; }',
    '}',
  ].join('\n')
  doc.head.appendChild(style)
}

export function createBeltUi(client: Client, doc: Document = document): BeltUi {
  installBeltStyles(doc)

  const root = el('div', 'belt-popover')
  root.hidden = true
  // Anchored once; `set` follows the open belt. The popover's bottom edge sits above the tile.
  const anchor: AnchorHandle = client.overlay.anchor(root, 0, 0)

  const rotate = el('button', 'belt-rotate')
  rotate.dataset.beltRotate = ''
  rotate.textContent = 'Rotate'
  const pickUp = el('button', 'belt-pickup')
  pickUp.dataset.beltPickup = ''
  pickUp.textContent = 'Pick up'
  root.append(rotate, pickUp)

  let state: BeltState | null = null
  /** `seq -> the button that sent it`, for the rejection flash. */
  const pending = new Map<number, HTMLElement>()

  function send(action: RefAction, from: HTMLElement): void {
    pending.set(client.dispatch(action), from)
  }

  rotate.addEventListener('click', () => {
    if (state !== null) send({ RotateBelt: { at: state.at } }, rotate)
  })
  pickUp.addEventListener('click', () => {
    if (state === null) return
    send({ PickUpBelt: { at: state.at } }, pickUp)
    client.input.emit(LOCAL.CLOSE_PANEL, 0)
  })

  function onUi(ui: RefUi): void {
    const b = ui.belt
    state = b
    if (b === null) {
      root.hidden = true
      delete root.dataset.belt
      return
    }
    root.hidden = false
    root.dataset.belt = `${b.at.x},${b.at.y}`
    root.dataset.dir = b.dir
    root.dataset.kind = b.kind
    anchor.set(b.at.x + 0.5, b.at.y - 0.2)
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
