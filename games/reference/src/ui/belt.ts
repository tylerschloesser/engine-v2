// `createBeltUi` (M51b): the placed belt's popover, anchored above the tapped belt with
// `client.overlay.anchor`. Like the furnace panel it holds no state about which belt is open:
// `Ui.belt` (Rust, `RefClient.belt`) says, and the popover is hidden while it is `null`. A tap on a
// belt opens it, a tap elsewhere, a tool or `CLOSE_PANEL` closes it, and it goes when the belt does.
//
// Rotate dispatches `RotateBelt` (the popover stays; the sprite turns). Pick up dispatches
// `PickUpBelt` then emits `CLOSE_PANEL`. Every dispatch and emit happens inside a button's own click
// handler, never inside `onUi`.
//
// M53b, a spawner's panel: per lane (`[data-spawn-lane="0|1"]`, 0 the belt's left seen along its
// direction) one button per item (`[data-spawn-item="0".."5"]`, the `content::ItemId` wire ids, and
// `[data-spawn-item="off"]`) and one per rate (`[data-spawn-rate="0".."3"]`, `content::SPAWN_RATES`),
// each dispatching `SetSpawner`; buttons only, no text field (the `R` key has no focus guard). The
// lane's item and rate show as `.is-on` from `Ui.belt.spawn`; a rate needs an item, so the rate
// buttons are disabled while the lane is off and an item keeps the lane's rate (the saturation rate,
// the last, when the lane was off: one tap makes a lane run at full belt).
//
// DOM identity: root `.belt-popover` (`data-belt="x,y"`, `data-dir`, `data-kind`);
// `[data-belt-rotate]`, `[data-belt-pickup]`; `.belt-spawn` (hidden unless a spawner) with the lane
// rows above.
import type { ActionOutcome, Client } from 'engine'
import type { RefAction } from '../bindings/RefAction.js'
import type { RefReject } from '../bindings/RefReject.js'
import type { RefUi } from '../bindings/RefUi.js'
import { LOCAL } from './build.js'
import { el } from './dom.js'
import { ITEM_LABELS } from './inventory.js'

type AnchorHandle = ReturnType<Client['overlay']['anchor']>
type BeltState = NonNullable<RefUi['belt']>

export type BeltUi = {
  /** Wired to `client.onUi<RefUi>`. */
  onUi(ui: RefUi): void
  /** Wired to `client.onActionResult<RefReject>`. */
  onActionResult(seq: number, result: ActionOutcome<RefReject>): void
}

/** `content::SPAWN_RATES`' items a second per lane (`sim/src/content.rs`): change both together. */
const SPAWN_RATE_LABELS = ['1/s', '2/s', '4/s', '7.5/s'] as const

/** The rate an item tap gives a lane that was off: the saturation rate (`SPAWN_RATES`' last). */
const FIRST_RATE = SPAWN_RATE_LABELS.length - 1

/** `content::SPAWN_OFF`: `SetSpawner`'s "clear this lane" item. */
const SPAWN_OFF = 255

const STYLE_ID = 'reference-belt-styles'

function installBeltStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.belt-popover {',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 4px;',
    '  padding: 4px;',
    '  border: 1px solid #345;',
    '  border-radius: 6px;',
    '  background: rgba(10, 20, 30, 0.92);',
    '  white-space: nowrap;',
    '}',
    '.belt-popover[hidden] { display: none; }',
    '.belt-popover .belt-actions, .belt-popover .spawn-row { display: flex; gap: 4px; }',
    '.belt-popover .belt-spawn { display: flex; flex-direction: column; gap: 4px; }',
    '.belt-popover .spawn-lane { color: #9ab; font: 11px sans-serif; align-self: center; }',
    '.belt-popover button.is-on { background: #2a6; border-color: #5c8; }',
    '.belt-popover button:disabled { opacity: 0.4; cursor: default; }',
    '.belt-popover .belt-spawn[hidden] { display: none; }',
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
  const actions = el('div', 'belt-actions')
  actions.append(rotate, pickUp)

  // The spawner panel: per lane, the six items and Off, then the four rates.
  const spawn = el('div', 'belt-spawn')
  spawn.hidden = true
  const laneItems: [HTMLButtonElement[], HTMLButtonElement[]] = [[], []]
  const laneRates: [HTMLButtonElement[], HTMLButtonElement[]] = [[], []]
  for (const lane of [0, 1] as const) {
    const items = el('div', 'spawn-row')
    items.dataset.spawnLane = String(lane)
    const name = el('span', 'spawn-lane')
    name.textContent = lane === 0 ? 'Left' : 'Right'
    items.append(name)
    const itemButtons = laneItems[lane]
    ITEM_LABELS.forEach((label, id) => {
      const b = el('button', 'spawn-item')
      b.dataset.spawnItem = String(id)
      b.textContent = label
      b.addEventListener('click', () => {
        if (state === null) return
        const cur = state.spawn[lane]
        send({ SetSpawner: { at: state.at, lane, item: id, rate: cur?.rate ?? FIRST_RATE } }, b)
      })
      itemButtons.push(b)
      items.append(b)
    })
    const off = el('button', 'spawn-item')
    off.dataset.spawnItem = 'off'
    off.textContent = 'Off'
    off.addEventListener('click', () => {
      if (state !== null)
        send({ SetSpawner: { at: state.at, lane, item: SPAWN_OFF, rate: 0 } }, off)
    })
    itemButtons.push(off)
    items.append(off)
    const rates = el('div', 'spawn-row')
    rates.dataset.spawnLane = String(lane)
    const rateButtons = laneRates[lane]
    SPAWN_RATE_LABELS.forEach((label, rate) => {
      const b = el('button', 'spawn-rate')
      b.dataset.spawnRate = String(rate)
      b.textContent = label
      b.addEventListener('click', () => {
        const cur = state?.spawn[lane]
        if (state === null || cur == null) return
        send({ SetSpawner: { at: state.at, lane, item: cur.item, rate } }, b)
      })
      rateButtons.push(b)
      rates.append(b)
    })
    spawn.append(items, rates)
  }
  root.append(actions, spawn)

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
    spawn.hidden = b.kind !== 'Spawner'
    for (const lane of [0, 1] as const) {
      const cfg = b.spawn[lane]
      laneItems[lane].forEach((btn, i) => {
        const on = cfg === null ? i === ITEM_LABELS.length : cfg.item === i
        btn.classList.toggle('is-on', on)
      })
      laneRates[lane].forEach((btn, rate) => {
        btn.classList.toggle('is-on', cfg !== null && cfg.rate === rate)
        btn.disabled = cfg === null
      })
    }
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
