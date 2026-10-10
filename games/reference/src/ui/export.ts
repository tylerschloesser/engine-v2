// "Export world" in the normal game UI (R4, Tyler 2026-10-10: always offered, as protection against
// Safari's 7-day storage eviction, as well as on the refused-start screen). A small fixed button
// built once; the download is the same path the `save-incompatible` screen uses (`exportWorldFile`
// in `status.ts`). Nothing here runs per frame: the click handler is the only code.

import { exportWorldFile, type WorldOps } from './status.js'

export type ExportUi = {
  /** Shows the button (called once the world has started; a refused start never gets one). */
  show(): void
  /** The button, for tests. */
  readonly button: HTMLButtonElement
}

export function createExportUi(
  container: HTMLElement,
  ops: Pick<WorldOps, 'worldId' | 'exportWorld'>,
  doc: Document = document,
): ExportUi {
  const button = doc.createElement('button')
  button.dataset.gameExport = ''
  button.textContent = 'Export world'
  button.hidden = true
  button.style.cssText =
    'position:fixed;right:8px;bottom:32px;z-index:5;padding:2px 8px;font:11px sans-serif;opacity:0.7'
  button.addEventListener('click', () => {
    button.disabled = true
    exportWorldFile(doc, ops)
      .then((size) => {
        button.dataset.state = 'exported'
        button.title = `Exported ${size} bytes.`
      })
      .catch((err: unknown) => {
        button.dataset.state = 'export-failed'
        button.title = `Export failed: ${String(err)}`
      })
      .finally(() => {
        button.disabled = false
      })
  })
  container.append(button)
  return {
    show() {
      button.hidden = false
    },
    button,
  }
}
