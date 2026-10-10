// `createFurnaceUi` (M33b Scope): the furnace panel,
// anchored above the open furnace with `client.overlay.anchor`. It holds no state about which
// furnace is open: `Ui.furnace` (Rust, `RefClient.open`) says, and the panel is hidden while it is
// `null`. Closing emits `LOCAL.CLOSE_PANEL`; picking an empty furnace up dispatches `FurnacePickUp`
// and the panel goes away when the furnace does (`RefClient::frame` notices it is gone).
//
// Every dispatch and emit happens inside a button's own click handler, never inside `onUi` (a
// record written from a `Ui` callback lands between frames).
//
// Deposit buttons: +1, +5, all, per item, enabled from `Ui.inventory`. Take all is enabled while the
// furnace holds ingots. Pick up is enabled only when all five counts are zero. The smelt progress
// is one CSS animation restarted whenever `smelt_done_at` changes, timed on the authoritative clock.
//
// DOM identity: root `.furnace-panel` (`data-furnace="x,y"`); `[data-deposit="iron|coal|wood"]`
// with `data-amount="1|5|all"`; `[data-furnace-take]`, `[data-furnace-pickup]`,
// `[data-furnace-close]`; counts in `[data-count="iron_in|coal|wood|burn_left|ingots_out"]`;
// `.furnace-progress` (`.is-smelting` while a smelt runs).
import type { ActionOutcome, Client } from 'engine'
import type { RefAction } from '../bindings/RefAction.js'
import type { RefReject } from '../bindings/RefReject.js'
import type { RefUi } from '../bindings/RefUi.js'
import { LOCAL } from './build.js'
import { el } from './dom.js'

type AnchorHandle = ReturnType<Client['overlay']['anchor']>
type FurnaceState = NonNullable<RefUi['furnace']>

export type FurnaceUi = {
  /** Wired to `client.onUi<RefUi>`. */
  onUi(ui: RefUi): void
  /** Wired to `client.onActionResult<RefReject>`. */
  onActionResult(seq: number, result: ActionOutcome<RefReject>): void
}

/** `content::SMELT` in seconds (`sim/src/content.rs`): change both together. */
const SMELT_SECS = 5

/** Wire ids of the depositable items (`content::ItemId`) and their `Ui.inventory` slots (the same). */
const DEPOSIT_ITEMS = [
  { key: 'iron', label: 'Iron', id: 1 },
  { key: 'coal', label: 'Coal', id: 3 },
  { key: 'wood', label: 'Wood', id: 2 },
] as const

const COUNTS = [
  { key: 'iron_in', label: 'Iron' },
  { key: 'coal', label: 'Coal' },
  { key: 'wood', label: 'Wood' },
  { key: 'burn_left', label: 'Burning' },
  { key: 'ingots_out', label: 'Ingots' },
] as const

const STYLE_ID = 'reference-furnace-styles'

function installFurnaceStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.furnace-panel {',
    '  padding: 8px;',
    '  border: 1px solid #345;',
    '  border-radius: 6px;',
    '  background: rgba(10, 20, 30, 0.92);',
    '  color: #fff;',
    '  font: 11px sans-serif;',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 4px;',
    '  white-space: nowrap;',
    '}',
    '.furnace-panel[hidden] { display: none; }',
    '.furnace-panel button {',
    '  padding: 2px 6px;',
    '  border: 1px solid #345;',
    '  border-radius: 3px;',
    '  background: #123;',
    '  color: #fff;',
    '  font: 11px sans-serif;',
    '  cursor: pointer;',
    '}',
    '.furnace-panel button:disabled { cursor: default; opacity: 0.45; }',
    '.furnace-panel .furnace-row { display: flex; gap: 4px; align-items: center; }',
    '.furnace-panel .furnace-row .furnace-label { min-width: 48px; }',
    '.furnace-panel .furnace-counts { display: flex; gap: 8px; }',
    '.furnace-progress {',
    '  position: relative;',
    '  height: 6px;',
    '  background: #234;',
    '  overflow: hidden;',
    '}',
    '.furnace-progress .furnace-progress-fill {',
    '  position: absolute;',
    '  inset: 0;',
    '  background: #f90;',
    '  transform: scaleX(0);',
    '  transform-origin: left center;',
    '}',
    '.furnace-progress.is-smelting .furnace-progress-fill {',
    '  animation: furnace-fill-anim var(--furnace-duration, 0ms) linear forwards;',
    '  animation-delay: var(--furnace-delay, 0ms);',
    '}',
    '@keyframes furnace-fill-anim {',
    '  from { transform: scaleX(0); }',
    '  to { transform: scaleX(1); }',
    '}',
    '.furnace-panel button[class*="reject-"] { animation: furnace-reject-flash 300ms ease-out; }',
    '@keyframes furnace-reject-flash {',
    '  0% { background: #a33; }',
    '  100% { background: #123; }',
    '}',
  ].join('\n')
  doc.head.appendChild(style)
}

export function createFurnaceUi(client: Client, doc: Document = document): FurnaceUi {
  installFurnaceStyles(doc)

  const root = el('div', 'furnace-panel')
  root.hidden = true
  // Anchored once; `set` follows the open furnace (a different tile after a reopen).
  const anchor: AnchorHandle = client.overlay.anchor(root, 0, 0)

  const title = el('div', 'furnace-title')
  title.textContent = 'Furnace'
  const close = el('button', 'furnace-close')
  close.dataset.furnaceClose = ''
  close.textContent = 'Close'
  const head = el('div', 'furnace-row')
  head.append(title, close)

  const counts = el('div', 'furnace-counts')
  const countEls = new Map<string, HTMLSpanElement>()
  for (const c of COUNTS) {
    const span = el('span', 'furnace-count')
    span.dataset.count = c.key
    countEls.set(c.key, span)
    counts.appendChild(span)
  }

  const progress = el('div', 'furnace-progress')
  const fill = el('div', 'furnace-progress-fill')
  progress.appendChild(fill)

  const deposits = new Map<string, HTMLButtonElement>()
  const depositRows = DEPOSIT_ITEMS.map((item) => {
    const row = el('div', 'furnace-row')
    const label = el('span', 'furnace-label')
    label.textContent = item.label
    row.appendChild(label)
    for (const amount of ['1', '5', 'all'] as const) {
      const b = el('button', 'furnace-deposit')
      b.dataset.deposit = item.key
      b.dataset.amount = amount
      b.textContent = amount === 'all' ? 'all' : `+${amount}`
      deposits.set(`${item.key}:${amount}`, b)
      row.appendChild(b)
    }
    return row
  })

  const take = el('button', 'furnace-take')
  take.dataset.furnaceTake = ''
  take.textContent = 'Take all'
  const pickUp = el('button', 'furnace-pickup')
  pickUp.dataset.furnacePickup = ''
  pickUp.textContent = 'Pick up'
  const footer = el('div', 'furnace-row')
  footer.append(take, pickUp)

  root.append(head, counts, progress, ...depositRows, footer)

  let state: FurnaceState | null = null
  let inventory: readonly number[] = []
  /** `seq -> the button that sent it`, for the rejection flash. */
  const pending = new Map<number, HTMLElement>()

  function send(action: RefAction, from: HTMLElement): void {
    pending.set(client.dispatch(action), from)
  }

  for (const item of DEPOSIT_ITEMS) {
    for (const amount of ['1', '5', 'all'] as const) {
      deposits.get(`${item.key}:${amount}`)?.addEventListener('click', (e) => {
        if (state === null) return
        const held = inventory[item.id] ?? 0
        const count = amount === 'all' ? held : Number(amount)
        if (count < 1 || count > held) return
        send(
          { FurnaceDeposit: { at: state.at, item: item.id, count } },
          e.currentTarget as HTMLElement,
        )
      })
    }
  }
  take.addEventListener('click', () => {
    if (state !== null) send({ FurnaceTake: { at: state.at } }, take)
  })
  pickUp.addEventListener('click', () => {
    if (state !== null) send({ FurnacePickUp: { at: state.at } }, pickUp)
  })
  close.addEventListener('click', () => client.input.emit(LOCAL.CLOSE_PANEL, 0))

  /** The `smelt_done_at` the running animation was started for (`null`: none running). */
  let animatedFor: number | null = null

  function startProgress(doneAt: number): void {
    const c = client.clock()
    const tps = Math.max(1, c.ticksPerSecond)
    const remainingMs = Math.max(0, ((doneAt - c.authoritative) / tps) * 1000)
    const totalMs = SMELT_SECS * 1000
    progress.style.setProperty('--furnace-duration', `${totalMs}ms`)
    progress.style.setProperty('--furnace-delay', `${remainingMs - totalMs}ms`)
    progress.classList.remove('is-smelting')
    void progress.offsetWidth // restart the animation for a back-to-back smelt
    progress.classList.add('is-smelting')
  }

  function onUi(ui: RefUi): void {
    inventory = ui.inventory
    const f = ui.furnace
    state = f
    if (f === null) {
      root.hidden = true
      delete root.dataset.furnace
      progress.classList.remove('is-smelting')
      animatedFor = null
      return
    }
    root.hidden = false
    root.dataset.furnace = `${f.at.x},${f.at.y}`
    anchor.set(f.at.x + 1, f.at.y - 0.3)
    for (const c of COUNTS) {
      const span = countEls.get(c.key)
      if (span) span.textContent = `${c.label} ${f[c.key]}`
      if (span) span.dataset.value = String(f[c.key])
    }
    if (f.smelt_done_at === null) {
      progress.classList.remove('is-smelting')
      animatedFor = null
    } else if (animatedFor !== f.smelt_done_at) {
      animatedFor = f.smelt_done_at
      startProgress(f.smelt_done_at)
    }
    for (const item of DEPOSIT_ITEMS) {
      const held = inventory[item.id] ?? 0
      for (const amount of ['1', '5', 'all'] as const) {
        const b = deposits.get(`${item.key}:${amount}`)
        if (b) b.disabled = amount === 'all' ? held < 1 : held < Number(amount)
      }
    }
    take.disabled = f.ingots_out === 0
    pickUp.disabled = !(
      f.iron_in === 0 &&
      f.coal === 0 &&
      f.wood === 0 &&
      f.burn_left === 0 &&
      f.ingots_out === 0
    )
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
