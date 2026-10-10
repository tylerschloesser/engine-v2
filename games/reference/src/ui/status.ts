// The one place engine events are handled (docs/plan/37-robustness-events.md; the audit is
// `packages/engine/src/engine-events.test.ts`). Framework-free plain text, one button where a button
// helps:
// - link state (M34, `client.onLink`): a small line, nothing while online; no retry button (the
//   engine redials by itself, 0013 Client policy). `resyncing` (`client.onResyncing`) is the same
//   line for a moment.
// - a refused start (M23 `world-busy`, M24b `save-incompatible`): a screen; Export and Delete on
//   `save-incompatible` only.
// - storage (`client.onStorage`, 0005): a notice when the world is not durable, and a storage line.
// - `rendererLost` (M37b): a banner with a Reload button; the sim keeps running and saving.
// - `onFatal` (M37): a screen with the engine's message and a Reload button; the world is untouched.
// - desync (`client.onDesync`, M31b): a counter in dev builds only.
// - `?linklog=1` (M38, `createLinkLog`): the on-page link log of `mp.html?linklog=1`, for a phone with
//   no console.
import type {
  DesyncReport,
  FatalEvent,
  LinkReason,
  LinkState,
  RendererLostReason,
  StorageStatus,
} from 'engine'
import { type Scheduler, systemScheduler } from 'engine/render'

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

/** One row of the `?linklog=1` view: the event, the link state, the close code (`-`: `onLink` does not
 * carry one) and the milliseconds since the page last became visible. */
export function linkLogRow(event: string, state: string, msSinceVisible: number): string {
  return `${event.padEnd(10)} ${state.padEnd(12)} code=- sinceVisible=${Math.round(msSinceVisible)}ms`
}

/**
 * The hosted build's link log (M38, `?linklog=1` only): `client.onLink` events and `visibilitychange`
 * timestamps from the public API, newest first, in a `<pre id="linklog">`. A step of M38-socket-resume
 * reads `visible` to the next `online` row.
 */
export function createLinkLog(
  container: HTMLElement,
  doc: Document = document,
  now: () => number = () => performance.now(),
): { onLink(e: { state: LinkState }): void; rows(): string[] } {
  const pre = doc.createElement('pre')
  pre.id = 'linklog'
  pre.style.cssText =
    'position:fixed;left:8px;top:8px;margin:0;max-width:95vw;max-height:60vh;overflow:auto;' +
    'padding:4px 8px;font:11px monospace;background:rgba(0,0,0,0.7);color:#cfc;z-index:40'
  container.append(pre)
  const rows: string[] = []
  let visibleAt = now()
  function push(event: string, state: string): void {
    rows.unshift(linkLogRow(event, state, now() - visibleAt))
    if (rows.length > 100) rows.pop()
    pre.textContent = rows.join('\n')
  }
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') visibleAt = now()
    push(doc.visibilityState, '-')
  })
  return { onLink: (e) => push('link', e.state), rows: () => rows }
}

/** How long the `resyncing` notice stays on the line (the engine gives no "resynced" event: the second
 * `Welcome` is applied within a few frames). */
export const RESYNC_NOTICE_MS = 1500

const RENDERER_LOST: Record<RendererLostReason, string> = {
  'repeated-loss': 'The graphics device was lost twice in a row and could not be restored.',
  'no-adapter': 'No graphics adapter is available any more.',
}

/** `1536` -> `1.5 KB`. */
export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`
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

/**
 * Exports the world and starts a browser download of `<worldId>.world`; resolves with its size.
 * The one export path: the refused-start screen below and the game UI's always-on control
 * (`ui/export.ts`) both call it.
 */
export async function exportWorldFile(
  doc: Document,
  ops: Pick<WorldOps, 'worldId' | 'exportWorld'>,
): Promise<number> {
  const blob = await ops.exportWorld()
  const url = URL.createObjectURL(blob)
  const a = doc.createElement('a')
  a.href = url
  a.download = `${ops.worldId}.world`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return blob.size
}

export type StatusOptions = {
  /** Times the `resyncing` notice; the page's injected `Scheduler` under test. */
  scheduler?: Scheduler
  /** What the Reload buttons do (`location.reload()`). */
  reload?: () => void
  /** Dev builds: the desync counter. */
  dev?: boolean
}

export type StatusUi = {
  onLink(e: { state: LinkState; reason?: LinkReason }): void
  /** `client.onResyncing`: "Resyncing..." for `RESYNC_NOTICE_MS`, then the link line again. */
  onResyncing(): void
  /** `client.onStorage`: the not-durable notice and the storage line. */
  onStorage(status: StorageStatus): void
  /** `client.onRendererLost`: the Reload banner. */
  onRendererLost(e: { reason: RendererLostReason }): void
  /** `client.onFatal`: the fatal screen. */
  onFatal(e: FatalEvent): void
  /** `client.onDesync`: counts, and shows the counter in a dev build. */
  onDesync(r: DesyncReport): void
  /**
   * The screen for a refused start (M23 `'world-busy'`, M24b `'save-incompatible'`): a message, and
   * for `save-incompatible` only Export and Delete (M23's default, Q9); the game UI also offers Export at all times (R4, `ui/export.ts`).
   * Returns false for a failure this screen does not handle (the caller rethrows).
   */
  showStartFailure(failure: StartFailure, ops: WorldOps): boolean
}

export function createStatusUi(
  container: HTMLElement,
  doc: Document = document,
  opts: StatusOptions = {},
): StatusUi {
  const scheduler = opts.scheduler ?? systemScheduler
  const reload = opts.reload ?? (() => location.reload())
  const line = doc.createElement('div')
  line.className = 'link-status'
  line.hidden = true
  line.style.cssText =
    'position:fixed;left:8px;bottom:8px;padding:4px 8px;border-radius:4px;font:12px sans-serif;' +
    'background:rgba(0,0,0,0.6);color:#fff;pointer-events:none'
  container.append(line)
  let timer: ReturnType<typeof setTimeout> | undefined
  let linkText: string | null = null
  let linkState: LinkState = 'online'
  let resyncTimer: number | undefined

  function show(text: string | null, state: string): void {
    line.hidden = text === null
    line.textContent = text ?? ''
    line.dataset.state = state
  }

  function button(label: string, attr: string, onClick: () => void): HTMLButtonElement {
    const b = doc.createElement('button')
    b.dataset[attr] = ''
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  const banner = (className: string, css: string): HTMLDivElement => {
    const el = doc.createElement('div')
    el.className = className
    el.hidden = true
    el.style.cssText = css
    container.append(el)
    return el
  }
  const BANNER =
    'position:fixed;left:50%;transform:translateX(-50%);padding:6px 10px;border-radius:4px;' +
    'font:12px sans-serif;background:#612;color:#fff;z-index:10'
  const durableNotice = banner('durable-notice', `${BANNER};top:8px`)
  const storageLine = banner(
    'storage-line',
    'position:fixed;right:8px;bottom:8px;font:11px sans-serif;color:#fff;opacity:0.7;' +
      'pointer-events:none',
  )
  const rendererBanner = banner('renderer-lost', `${BANNER};top:40px`)
  const desyncCounter = banner(
    'desync-counter',
    'position:fixed;right:8px;top:8px;font:11px monospace;color:#fc8;pointer-events:none',
  )
  let desyncCount = 0

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
        exportWorldFile(doc, ops)
          .then((size) => {
            note.textContent = `Exported ${size} bytes.`
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

  function showFatal(e: FatalEvent): void {
    const screen = doc.createElement('div')
    screen.className = 'engine-fatal'
    screen.dataset.tick = String(e.tick)
    screen.style.cssText =
      'position:fixed;inset:0;z-index:30;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:12px;padding:16px;background:#312;color:#fff;font:14px sans-serif;' +
      'text-align:center'
    const text = doc.createElement('p')
    text.className = 'engine-fatal-text'
    text.textContent =
      'The game stopped because the world cannot continue. Nothing was changed on disk: reload to try again.'
    const message = doc.createElement('pre')
    message.className = 'engine-fatal-message'
    message.style.cssText = 'max-width:90vw;white-space:pre-wrap;font:12px monospace'
    message.textContent = `${e.message} (tick ${e.tick})`
    screen.append(text, message, button('Reload', 'reload', reload))
    container.append(screen)
  }

  return {
    showStartFailure,
    onLink(e) {
      clearTimeout(timer)
      linkState = e.state
      linkText = statusText(e.state, e.reason)
      if (resyncTimer !== undefined) return // the resync notice ends on its own and restores this
      if (e.state === 'connecting') {
        show(null, e.state)
        timer = setTimeout(() => show(linkText, e.state), INDICATOR_DELAY_MS)
      } else {
        show(linkText, e.state)
      }
    },
    onResyncing() {
      if (resyncTimer !== undefined) scheduler.clearTimer(resyncTimer)
      show('Resyncing with the host...', 'resyncing')
      resyncTimer = scheduler.setTimer(() => {
        resyncTimer = undefined
        show(linkText, linkState)
      }, RESYNC_NOTICE_MS)
    },
    onStorage(status) {
      durableNotice.hidden = status.durable
      if (!status.durable) {
        durableNotice.textContent =
          'This browser cannot save your world: progress is lost when the tab closes.'
      }
      storageLine.hidden = false
      storageLine.dataset.durable = String(status.durable)
      storageLine.dataset.persisted = String(status.persisted)
      storageLine.textContent =
        `Storage: ${formatBytes(status.usage)} of ${formatBytes(status.quota)} used` +
        (status.durable && !status.persisted ? ' (the browser may clear it)' : '')
    },
    onRendererLost(e) {
      rendererBanner.hidden = false
      rendererBanner.dataset.reason = e.reason
      rendererBanner.replaceChildren(
        doc.createTextNode(`${RENDERER_LOST[e.reason]} Reload to restore the picture. `),
        button('Reload', 'reload', reload),
      )
    },
    onFatal: showFatal,
    onDesync(r) {
      desyncCount++
      if (!opts.dev) return
      desyncCounter.hidden = false
      desyncCounter.dataset.count = String(desyncCount)
      desyncCounter.textContent =
        `desyncs: ${desyncCount} (last: ${r.scope}` +
        `${r.scope === 'chunk' ? ` ${r.cx},${r.cy}` : ''} at tick ${r.tick})`
    },
  }
}
