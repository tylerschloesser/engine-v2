// Link status (docs/plan/34-reference-multiplayer.md Scope): a small line fed by `client.onLink`.
// Nothing while the session is online; a short message when the link is down or was refused. No
// modal, no retry button (the engine redials by itself, 0013 Client policy). Framework-free.
import type { LinkReason, LinkState } from 'engine'

/** 0013 Client policy: an indicator appears after 1 s. `reconnecting` is already emitted after that
 * delay by the engine; the first `connecting` is delayed here. */
export const INDICATOR_DELAY_MS = 1000

const REJECTED: Record<LinkReason, string> = {
  BadKey: 'This invite link is not valid for the server.',
  Full: 'This world is full.',
  WorldMismatch: 'The server runs a different world.',
}

export function statusText(state: LinkState, reason?: LinkReason): string | null {
  switch (state) {
    case 'online':
      return null
    case 'connecting':
      return 'Connecting...'
    case 'reconnecting':
      return 'Connection lost, reconnecting...'
    case 'updating':
      return 'Updating...'
    case 'superseded':
      return 'This world is open in another tab.'
    case 'rejected':
      return reason ? REJECTED[reason] : 'The server refused the connection.'
  }
}

/** What a refused start looks like to the screen below: `EngineStartError`'s `code` and `message`. */
export type StartFailure = { code: string; message?: string }

/** The one line per start-failure code the game answers; `null` for codes it does not handle. */
export function startFailureText(code: string): string | null {
  switch (code) {
    case 'world-busy':
      return 'This world is already open in another tab. Close it there to play here.'
    case 'save-incompatible':
      return 'This saved world was made by a different version of the game and cannot be opened. Export it to keep a copy, or delete it.'
    default:
      return null
  }
}

/** The world operations the `SaveIncompatible` screen offers (`client.exportWorld`/`deleteWorld`). */
export type WorldOps = {
  worldId: string
  exportWorld(): Promise<Blob>
  deleteWorld(worldId: string): Promise<void>
  /** Called once a delete has finished (the page reloads onto a fresh world). */
  afterDelete?: () => void
}

export type StatusUi = {
  onLink(e: { state: LinkState; reason?: LinkReason }): void
  /**
   * The screen for a refused start (M23 `'world-busy'`, M24b `'save-incompatible'`): a message, and
   * for `save-incompatible` only Export and Delete (M23's default, Q9; nowhere else, R4's default).
   * Returns false for a failure this screen does not handle (the caller rethrows).
   */
  showStartFailure(failure: StartFailure, ops: WorldOps): boolean
}

export function createStatusUi(container: HTMLElement, doc: Document = document): StatusUi {
  const line = doc.createElement('div')
  line.className = 'link-status'
  line.hidden = true
  line.style.cssText =
    'position:fixed;left:8px;bottom:8px;padding:4px 8px;border-radius:4px;font:12px sans-serif;' +
    'background:rgba(0,0,0,0.6);color:#fff;pointer-events:none'
  container.append(line)
  let timer: ReturnType<typeof setTimeout> | undefined

  function show(text: string | null, state: LinkState): void {
    line.hidden = text === null
    line.textContent = text ?? ''
    line.dataset.state = state
  }

  function showStartFailure(failure: StartFailure, ops: WorldOps): boolean {
    const text = startFailureText(failure.code)
    if (text === null) return false
    const screen = doc.createElement('div')
    screen.className = 'start-failure'
    screen.dataset.code = failure.code
    screen.style.cssText =
      'position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:12px;padding:16px;background:#123;color:#fff;font:14px sans-serif;' +
      'text-align:center'
    const message = doc.createElement('p')
    message.className = 'start-failure-text'
    message.textContent = text
    screen.append(message)
    if (failure.code === 'save-incompatible') {
      const note = doc.createElement('p')
      note.className = 'start-failure-note'
      screen.append(note)
      const exportButton = doc.createElement('button')
      exportButton.dataset.exportWorld = ''
      exportButton.textContent = 'Export world'
      exportButton.addEventListener('click', () => {
        exportButton.disabled = true
        ops
          .exportWorld()
          .then((blob) => {
            const url = URL.createObjectURL(blob)
            const a = doc.createElement('a')
            a.href = url
            a.download = `${ops.worldId}.world`
            a.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
            note.textContent = `Exported ${blob.size} bytes.`
            note.dataset.state = 'exported'
          })
          .catch((err: unknown) => {
            note.textContent = `Export failed: ${String(err)}`
            note.dataset.state = 'export-failed'
          })
          .finally(() => {
            exportButton.disabled = false
          })
      })
      // Delete asks twice: the first press only arms the button.
      const deleteButton = doc.createElement('button')
      deleteButton.dataset.deleteWorld = ''
      deleteButton.textContent = 'Delete world'
      let armed = false
      deleteButton.addEventListener('click', () => {
        if (!armed) {
          armed = true
          deleteButton.textContent = 'Really delete? Press again'
          deleteButton.dataset.armed = ''
          return
        }
        deleteButton.disabled = true
        ops
          .deleteWorld(ops.worldId)
          .then(() => {
            note.textContent = 'Deleted.'
            note.dataset.state = 'deleted'
            ops.afterDelete?.()
          })
          .catch((err: unknown) => {
            note.textContent = `Delete failed: ${String(err)}`
            note.dataset.state = 'delete-failed'
            deleteButton.disabled = false
          })
      })
      screen.append(exportButton, deleteButton)
    }
    container.append(screen)
    return true
  }

  return {
    showStartFailure,
    onLink(e) {
      clearTimeout(timer)
      const text = statusText(e.state, e.reason)
      if (e.state === 'connecting') {
        show(null, e.state)
        timer = setTimeout(() => show(text, e.state), INDICATOR_DELAY_MS)
      } else {
        show(text, e.state)
      }
    },
  }
}
