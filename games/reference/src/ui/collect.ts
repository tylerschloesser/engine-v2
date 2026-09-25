// `createCollectUi` (docs/plan/20b-reference-player-and-collect-ui.md Scope): one `<button>` per
// `Ui.in_range` entry, anchored over its tile; a click dispatches `StartCollect`; while
// `Ui.collecting` names this button's own tile it fills over the collect duration and every other
// button disables; a button whose tile drops out of `in_range` while it is the collecting one gets
// `CancelCollect` sent once ("panning out of range cancels a collect", `docs/spec/
// reference-game.md`); a rejected `StartCollect` flashes its own button with the reject reason as a
// CSS class.
//
// DOM identity (Deviations, reused by later steps/milestones): a button carries `data-collect-tile
// = "x,y"` (`tileKey`, below) -- `[data-collect-tile="x,y"]` is the selector a test or another UI
// module uses to find one resource tile's own button.
import type { ActionOutcome, Client } from 'engine'
import type { RefAction } from '../bindings/RefAction.js'
import type { RefReject } from '../bindings/RefReject.js'
import type { RefUi } from '../bindings/RefUi.js'
import { diffKeyed, el } from './dom.js'

type InRangeEntry = RefUi['in_range'][number]
type AnchorHandle = ReturnType<Client['overlay']['anchor']>

/** The DOM identity a collect button carries for its own tile (module doc comment). */
export function tileKey(tile: { x: number; y: number }): string {
  return `${tile.x},${tile.y}`
}

type ButtonEntry = {
  button: HTMLButtonElement
  fill: HTMLSpanElement
  anchor: AnchorHandle
  /** Captured once, at creation (never re-assigned): `Ui`'s own invariant is that an entry's
   * `from`/`tile` are stable for as long as its key exists (Planning decisions "Where `from` comes
   * from" -- a change means the key itself changed, which recreates the button), so the click
   * handler below needs no "current entry" lookup at click time. */
  from: { x: number; y: number }
  tile: { x: number; y: number }
  /** Whether this button's own fill animation is currently running (`animationend` clears it, a
   * fresh collect on a *different* tile does not touch it). */
  filling: boolean
}

export type CollectUi = {
  /** Wired to `client.onUi<RefUi>`. */
  onUi(ui: RefUi): void
  /** Wired to `client.onActionResult<RefReject>`: only `StartCollect` outcomes this controller
   * itself dispatched are ever looked up (`pendingSeq`); anything else is silently ignored. */
  onActionResult(seq: number, result: ActionOutcome<RefReject>): void
}

const STYLE_ID = 'reference-collect-styles'

/** One-time, idempotent `<style>` injection (`installPageStyles`'s own precedent, `engine/render`):
 * not a hot path (Scope: the fill animation itself is "one CSS animation ... started once: zero
 * per-frame JS", 0019 §6). */
function installCollectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.collect-button {',
    '  position: relative;',
    '  overflow: hidden;',
    '  padding: 4px 10px;',
    '  border: 1px solid #345;',
    '  border-radius: 4px;',
    '  background: #123;',
    '  color: #fff;',
    '  font: 11px sans-serif;',
    '  cursor: pointer;',
    '  white-space: nowrap;',
    '}',
    '.collect-button:disabled { cursor: default; opacity: 0.55; }',
    '.collect-button .collect-fill {',
    '  position: absolute;',
    '  inset: 0;',
    '  background: rgba(255, 255, 255, 0.35);',
    '  transform: scaleX(0);',
    '  transform-origin: left center;',
    '  pointer-events: none;',
    '}',
    '.collect-button.is-filling .collect-fill {',
    '  animation: collect-fill-anim var(--collect-duration, 0ms) linear forwards;',
    '}',
    '@keyframes collect-fill-anim {',
    '  from { transform: scaleX(0); }',
    '  to { transform: scaleX(1); }',
    '}',
    '.collect-button .collect-label { position: relative; }',
    '.collect-button[class*="reject-"] { animation: collect-reject-flash 300ms ease-out; }',
    '@keyframes collect-reject-flash {',
    '  0% { background: #a33; }',
    '  100% { background: #123; }',
    '}',
  ].join('\n')
  doc.head.appendChild(style)
}

export function createCollectUi(client: Client, doc: Document = document): CollectUi {
  installCollectStyles(doc)

  const buttons = new Map<string, ButtonEntry>()
  /** `seq -> tile key`, so a later `onActionResult` can find the button a still-pending
   * `StartCollect` belongs to (Scope: "a rejected `StartCollect` flashes the button"). */
  const pendingSeq = new Map<number, string>()
  /** The tile key `CancelCollect` was already sent for, so pan-out only ever sends it once per
   * collect (cleared once `Ui.collecting` itself clears or names a different tile). */
  let cancelSentFor: string | null = null

  function dispatchStart(entry: ButtonEntry): void {
    const action: RefAction = {
      StartCollect: {
        tile: { x: entry.tile.x, y: entry.tile.y },
        from: { x: entry.from.x, y: entry.from.y },
      },
    }
    const seq = client.dispatch(action)
    pendingSeq.set(seq, tileKey(entry.tile))
  }

  function create(entry: InRangeEntry): ButtonEntry {
    const button = el('button', 'collect-button')
    button.dataset.collectTile = tileKey(entry.tile)
    const fill = el('span', 'collect-fill')
    const label = el('span', 'collect-label')
    label.textContent = 'Collect'
    button.appendChild(fill)
    button.appendChild(label)
    const anchor = client.overlay.anchor(button, entry.tile.x + 0.5, entry.tile.y + 0.5)
    const be: ButtonEntry = {
      button,
      fill,
      anchor,
      from: { x: entry.from.x, y: entry.from.y },
      tile: { x: entry.tile.x, y: entry.tile.y },
      filling: false,
    }
    button.addEventListener('click', () => {
      if (button.disabled) return
      dispatchStart(be)
    })
    return be
  }

  function remove(entry: ButtonEntry): void {
    entry.anchor.remove()
    entry.button.remove()
  }

  function startFilling(entry: ButtonEntry, durationMs: number): void {
    entry.button.style.setProperty('--collect-duration', `${Math.max(0, durationMs)}ms`)
    entry.button.classList.remove('is-filling')
    // Force a reflow so re-adding the class restarts the CSS animation even for the same tile
    // (a rare back-to-back collect on one tile) -- the same "restart a CSS animation" idiom used
    // for the reject flash below.
    void entry.button.offsetWidth
    entry.button.classList.add('is-filling')
    entry.filling = true
  }

  function stopFilling(entry: ButtonEntry): void {
    if (!entry.filling) return
    entry.button.classList.remove('is-filling')
    entry.filling = false
  }

  function onUi(ui: RefUi): void {
    diffKeyed(buttons, ui.in_range, (e) => tileKey(e.tile), { create, remove })

    const collectingKey = ui.collecting ? tileKey(ui.collecting.tile) : null

    for (const [key, entry] of buttons) {
      if (collectingKey !== null && key === collectingKey) {
        entry.button.disabled = true
        if (!entry.filling && ui.collecting) {
          const clock = client.clock()
          const remainingTicks = ui.collecting.done_at - clock.predicted
          const durationMs = (remainingTicks / Math.max(1, clock.ticksPerSecond)) * 1000
          startFilling(entry, durationMs)
        }
      } else {
        entry.button.disabled = collectingKey !== null
        stopFilling(entry)
      }
    }

    // "Panning out of range cancels a collect" (Requirements/Scope): `ui.collecting`'s own tile is
    // no longer among `ui.in_range` -- send `CancelCollect` exactly once per such episode.
    if (collectingKey !== null && !buttons.has(collectingKey)) {
      if (cancelSentFor !== collectingKey) {
        const action: RefAction = 'CancelCollect'
        client.dispatch(action)
        cancelSentFor = collectingKey
      }
    } else {
      cancelSentFor = null
    }
  }

  function onActionResult(seq: number, result: ActionOutcome<RefReject>): void {
    const key = pendingSeq.get(seq)
    if (key === undefined) return
    pendingSeq.delete(seq)
    if (result === 'Confirmed') return
    const entry = buttons.get(key)
    if (entry === undefined) return
    const reason = 'Game' in result.Rejected ? result.Rejected.Game : result.Rejected.Engine
    const cls = `reject-${String(reason).toLowerCase()}`
    entry.button.classList.remove(cls)
    void entry.button.offsetWidth
    entry.button.classList.add(cls)
    entry.button.addEventListener('animationend', () => entry.button.classList.remove(cls), {
      once: true,
    })
  }

  return { onUi, onActionResult }
}
