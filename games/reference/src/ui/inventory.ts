// `createInventoryUi` (M20b Scope: "A plain inventory
// readout (six counts)."). No anchoring: a fixed DOM element, not tied to any tile.
import type { RefUi } from '../bindings/RefUi.js'
import { el } from './dom.js'

export type InventoryUi = {
  /** Called from the page's own `client.onUi` subscription, every `Ui` change. */
  onUi(ui: RefUi): void
}

/** Display labels in `content::ItemId` slot order: `Ui.inventory[i]` is the count of item `i`. */
export const ITEM_LABELS = ['Stone', 'Iron', 'Wood', 'Coal', 'Furnace', 'Ingot'] as const

const STYLE_ID = 'reference-inventory-styles'

/** One-time, idempotent `<style>` injection (`collect.ts`'s own precedent). */
function installInventoryStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.inventory {',
    '  position: fixed;',
    '  top: 8px;',
    '  left: 8px;',
    '  padding: 6px 10px;',
    '  background: rgba(10, 20, 30, 0.7);',
    '  color: #fff;',
    '  font: 12px sans-serif;',
    '  border-radius: 4px;',
    '  pointer-events: none;',
    '}',
  ].join('\n')
  doc.head.appendChild(style)
}

/** Appends one small readout element into `container` and returns the controller that keeps its
 * text in sync with `Ui.inventory`. */
export function createInventoryUi(container: HTMLElement, doc: Document = document): InventoryUi {
  installInventoryStyles(doc)
  const root = el('div', 'inventory')
  const rows: HTMLElement[] = []
  for (const label of ITEM_LABELS) {
    const row = el('div', 'inventory-row')
    row.textContent = `${label}: 0`
    root.appendChild(row)
    rows.push(row)
  }
  container.appendChild(root)

  function onUi(ui: RefUi): void {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row === undefined) continue
      row.textContent = `${ITEM_LABELS[i]}: ${ui.inventory[i]}`
    }
  }

  return { onUi }
}
