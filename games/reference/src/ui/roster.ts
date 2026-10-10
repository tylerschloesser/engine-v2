// `createRosterUi` (M34 Scope): one dot per `Ui.roster` entry,
// in the player's colour, hollow (border only) while the player is offline. The page's own dot
// carries `data-me="true"` and a thicker outline. A fixed, non-anchored readout like `inventory.ts`.
//
// DOM contract (tests select on it): `.roster` holds one `.roster-dot` per entry, in roster order,
// each with `data-player="<id>"`, `data-online="true|false"`, `data-me="true|false"` and
// `data-colour="r,g,b"`; an offline dot also has the class `offline`, the own dot `me`.
import type { RefUi } from '../bindings/RefUi.js'
import type { UiRosterEntry } from '../bindings/UiRosterEntry.js'
import { diffKeyed, el } from './dom.js'

export type RosterUi = {
  /** Called from the page's own `client.onUi` subscription, every `Ui` change. */
  onUi(ui: RefUi): void
}

const STYLE_ID = 'reference-roster-styles'

function installRosterStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.roster {',
    '  position: fixed;',
    '  top: 8px;',
    '  right: 8px;',
    '  display: flex;',
    '  gap: 6px;',
    '  padding: 6px 8px;',
    '  background: rgba(10, 20, 30, 0.7);',
    '  border-radius: 4px;',
    '  pointer-events: none;',
    '}',
    '.roster-dot {',
    '  box-sizing: border-box;',
    '  width: 14px;',
    '  height: 14px;',
    '  border-radius: 50%;',
    '  border: 2px solid transparent;',
    '}',
    '.roster-dot.me { outline: 2px solid #fff; outline-offset: 1px; }',
    '.roster-dot.offline { background: transparent !important; }',
  ].join('\n')
  doc.head.appendChild(style)
}

/** Appends the roster strip into `container` and returns the controller that keeps it in sync. */
export function createRosterUi(container: HTMLElement, doc: Document = document): RosterUi {
  installRosterStyles(doc)
  const root = el('div', 'roster')
  container.appendChild(root)
  const live = new Map<string, HTMLElement>()

  function paint(dot: HTMLElement, entry: UiRosterEntry): void {
    const rgb = `${entry.colour[0]},${entry.colour[1]},${entry.colour[2]}`
    if (dot.dataset.colour !== rgb) {
      dot.dataset.colour = rgb
      dot.style.background = `rgb(${rgb})`
      dot.style.borderColor = `rgb(${rgb})`
    }
    const online = String(entry.online)
    if (dot.dataset.online !== online) {
      dot.dataset.online = online
      dot.classList.toggle('offline', !entry.online)
    }
    const me = String(entry.me)
    if (dot.dataset.me !== me) {
      dot.dataset.me = me
      dot.classList.toggle('me', entry.me)
    }
  }

  function onUi(ui: RefUi): void {
    diffKeyed(live, ui.roster, (e) => String(e.id), {
      create(entry) {
        const dot = el('span', 'roster-dot')
        dot.dataset.player = String(entry.id)
        root.appendChild(dot)
        return dot
      },
      update: paint,
      remove(dot) {
        dot.remove()
      },
    })
  }

  return { onUi }
}
