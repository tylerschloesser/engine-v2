// `world.html`'s script (docs/plan/23-persistence-opfs-and-lifecycle.md, Scope): a real
// `createClient()` single-player topology with persistence on (`host.persist`), fixture `puts` --
// `?world=<id>` (default `device`). Reuses M16's `slice.html` HUD/Paint precedent (a plain HUD
// element and a Paint button dispatching an action at a fixed world position -- no renderer: this
// page's own exit criteria (`hash`/`tick`/`durable`/`persisted`, the `WorldBusy` banner) need no
// GPU device at all, `createClient` itself never touches one, 0018 §1) plus this milestone's own
// additions: `hash` (`worldHash`, refreshed once a second), `durable`/`persisted` (from
// `client.onStorage`), and the `WorldBusy` banner when `client.ready` rejects with `'world-busy'`.
//
// Export/Import/Delete buttons (Scope, step 5): `#export-btn`, `#import-file`, `#import-worldid`,
// `#import-btn`, `#delete-btn` over `client.exportWorld`/`importWorld`/`deleteWorld`. Export both
// stashes the archive's bytes on `window.__lastExportedBytes` (a plain number array: `page.
// evaluate`'s own structured-clone boundary, `slice.ts`'s own `__probeTile` precedent, for browser
// tests) *and* triggers a real file download (`<a download>` + `URL.createObjectURL`, `M23-export-
// import`'s own "confirm the file arrives in Files"). Import reads its file from `#import-file` via
// `Blob.arrayBuffer()` (a real `<input type=file>`, driven in tests with Playwright's own
// `setInputFiles({ buffer })`, no on-disk file needed, and by hand on-device by picking the
// downloaded file) and its target id from `#import-worldid` (empty means "the archive's own id").
// `#world-op-status` shows the last op's outcome or error message, for both the device check and
// tests. `#world-canvas` is this page's own canvas (required by `ClientOptions.canvas`, never fed to
// WebGPU); `#hud`, `#paint-btn`, `#world-busy` already exist, matching `slice.html`'s own ids where
// they overlap.
import type { Action } from '../../../../fixtures/puts/bindings/Action.ts'
import type { Client, ClientOptions, StorageStatus } from '../../../../src/client.ts'
import {
  attachHostLifecycle,
  clientTestHandle,
  createClient,
  EngineStartError,
} from '../../../../src/client.ts'
import { CB_SIM_TICKS_RUN } from '../../../../src/sab/control.ts'
import {
  parkWorkers,
  persistenceCounters,
  worldHash as readWorldHash,
  resumeWorkers,
  simCounters,
} from '../../../../src/test/client.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __worldBusy?: () => boolean
    __readyErrorCode?: () => string | undefined
    __storageStatuses?: () => StorageStatus[]
    /** docs/plan/23-persistence-opfs-and-lifecycle.md step 5: `#export-btn`'s own stash (see the
     * file-level comment above); a test reads this instead of intercepting a real download. */
    __lastExportedBytes?: () => number[] | undefined
    /** Direct, button-independent hooks (Seams parity): a test drives most of `export_import_
     * roundtrip_browser` this way, and the buttons themselves the same way a human would, in the one
     * test that exists to prove the DOM controls work at all (`export_import_roundtrip_browser`
     * itself, or a dedicated one -- see that spec). */
    __exportWorld?: () => Promise<number[]>
    __importWorld?: (
      bytes: number[],
      opts?: { worldId?: string; overwrite?: boolean },
    ) => Promise<{ worldId: string }>
    __deleteWorld?: (worldId: string) => Promise<void>
    /** Deterministic hidden/visible control (headless Chromium's own `document.hidden` cannot be
     * forced from outside the page, `hidden-tab-upload.ts`'s own `__worldSetHidden` precedent):
     * `undefined` (the default) means "follow the real `document.hidden`"; a test overrides it. */
    __worldSetHidden?: (hidden: boolean | undefined) => void
    __dumpWorldStorage?: (worldId: string) => Promise<Record<string, number[]>>
    /** `export_works_after_load_failure`'s own corruption hook (`world-corrupt-worker.ts`). */
    __corruptWorldKey?: (worldId: string, key: string, bytes: number[]) => Promise<void>
    __worldHash?: () => Promise<string>
    __worldHashAndTick?: () => Promise<{ hash: string; tick: number }>
    /** A direct `Atomics.load` of `CB_SIM_TICKS_RUN` (no park/resume round trip): safe to call
     * while the sim worker is deliberately left parked for a hidden-boundary pause, unlike
     * `__worldHash`/`__worldHashAndTick` (`parkWorkers`/`resumeWorkers`, `test/client.ts`, would
     * wrongly resume a worker this page itself parked for a reason other than a generic test park --
     * `hidden_pauses_and_snapshots`'s own reason for using this hook instead while hidden). */
    __simTicksRun?: () => number
    __dispatchPaintAt?: (x: number, y: number) => number
    __hudText?: () => string
    __errors?: () => string[]
    /** Coordinator fix round 1: `PersistenceCounters` plus `OpfsStorage.snapshotDeferred`, for
     * `paced_session_lands_periodic_snapshots` alone (`PERSISTENCE_DEBUG_CALL`'s own doc comment --
     * step 6's `persistenceCounters()` is the real, public seam). Requires the sim worker parked. */
    __persistenceDebug?: () => Promise<{
      logBytes: number
      frames: number
      snapshots: number
      lastSnapshotBytes: number
      syncs: number
      snapshotDeferred: number
    }>
  }
}

const params = new URL(location.href).searchParams
const worldId = params.get('world') ?? 'device'
// `no_opfs_falls_back_durable_false`'s own deterministic switch (Deviations: not the brief's own
// suggested "OPFS stubbed out by an init script" -- measured that `navigator.storage.getDirectory`
// stubbed via `page.addInitScript` on the page's own `navigator` does not reach the sim worker's
// separate global scope's `navigator`, so `TestFlags.noOpfs` is the real mechanism instead).
const noOpfs = params.get('noOpfs') === '1'
// The snapshot-cadence override for the periodic-OPFS-snapshot behavioural test (coordinator fix
// round 1): `?snapshotEveryTicks=N` in place of 0005 Cadence's own 1,200.
const snapshotEveryTicksParam = params.get('snapshotEveryTicks')
const snapshotEveryTicks = snapshotEveryTicksParam ? Number(snapshotEveryTicksParam) : undefined

const hudEl = document.createElement('pre')
hudEl.id = 'hud'
document.body.appendChild(hudEl)

const canvas = document.createElement('canvas')
canvas.id = 'world-canvas'
document.body.appendChild(canvas)

const paintBtn = document.createElement('button')
paintBtn.id = 'paint-btn'
paintBtn.textContent = 'Paint'
document.body.appendChild(paintBtn)

const busyEl = document.createElement('div')
busyEl.id = 'world-busy'
busyEl.textContent = 'WorldBusy: another tab already has this world open'
busyEl.style.display = 'none'
document.body.appendChild(busyEl)

// docs/plan/23-persistence-opfs-and-lifecycle.md step 5, Scope: Export/Import/Delete controls.
const exportBtn = document.createElement('button')
exportBtn.id = 'export-btn'
exportBtn.textContent = 'Export'
document.body.appendChild(exportBtn)

const importFile = document.createElement('input')
importFile.id = 'import-file'
importFile.type = 'file'
document.body.appendChild(importFile)

const importWorldIdInput = document.createElement('input')
importWorldIdInput.id = 'import-worldid'
importWorldIdInput.type = 'text'
importWorldIdInput.placeholder = 'new world id (blank = archive’s own)'
document.body.appendChild(importWorldIdInput)

const importBtn = document.createElement('button')
importBtn.id = 'import-btn'
importBtn.textContent = 'Import'
document.body.appendChild(importBtn)

const deleteBtn = document.createElement('button')
deleteBtn.id = 'delete-btn'
deleteBtn.textContent = 'Delete'
document.body.appendChild(deleteBtn)

const worldOpStatusEl = document.createElement('div')
worldOpStatusEl.id = 'world-op-status'
document.body.appendChild(worldOpStatusEl)

// A controllable `document.hidden`-shaped object (`attachHostLifecycle`'s own `doc` parameter,
// `frame-loop.ts`'s `attachVisibilityHandling`/`hidden-tab-upload.ts`'s own `FakeDoc` precedent):
// by default it forwards the real `document`'s own `visibilitychange` (so backgrounding a real tab
// on Tyler's own device check works unmodified), but `__worldSetHidden` can override `hidden` and fire
// the same listeners deterministically, for a spec that cannot force real `document.hidden` from
// outside headless Chromium.
const visibilityListeners: Array<() => void> = []
let hiddenOverride: boolean | undefined
document.addEventListener('visibilitychange', () => {
  if (hiddenOverride === undefined) for (const cb of visibilityListeners) cb()
})
const controllableDoc = {
  get hidden(): boolean {
    return hiddenOverride ?? document.hidden
  },
  addEventListener(_type: 'visibilitychange', cb: () => void): void {
    visibilityListeners.push(cb)
  },
  removeEventListener(_type: 'visibilitychange', cb: () => void): void {
    const i = visibilityListeners.indexOf(cb)
    if (i >= 0) visibilityListeners.splice(i, 1)
  },
}
window.__worldSetHidden = (hidden) => {
  hiddenOverride = hidden
  for (const cb of visibilityListeners) cb()
}

window.__dumpWorldStorage = (id) =>
  new Promise((resolve) => {
    const worker = new Worker(new URL('./world-dump-worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (ev: MessageEvent<{ entries: Record<string, number[]> }>) => {
      worker.terminate()
      resolve(ev.data.entries)
    }
    worker.postMessage({ worldId: id })
  })

// docs/plan/23-persistence-opfs-and-lifecycle.md step 5: `export_works_after_load_failure`'s own
// setup hook (`world-corrupt-worker.ts`'s own doc comment has why this is safe between page loads).
window.__corruptWorldKey = (worldId, key, bytes) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./world-corrupt-worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (ev: MessageEvent<{ done: true; error?: string }>) => {
      worker.terminate()
      if (ev.data.error) reject(new Error(ev.data.error))
      else resolve()
    }
    worker.postMessage({ worldId, key, bytes })
  })

const wasm = await fixtureWasm('puts')

const clientOptions: ClientOptions = {
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId, params: { seed: '1', worldgen: null } },
    connect: true,
    persist: true,
  },
  // Enables the parked test-call channel `worldHash`/`simCounters` need (`worker.ts`'s own
  // `testEnabled` gate reads `message.test`, not `options.test` itself) and real-time sim pacing
  // (`worker/sim.ts`'s `!message.test || message.test.pace === true` gate) -- `slice.ts`'s own
  // `connected-paced.ts` combination, verbatim.
  test: {
    flags: {
      pace: true,
      ...(noOpfs ? { noOpfs: true } : {}),
      ...(snapshotEveryTicks !== undefined ? { snapshotEveryTicks } : {}),
    },
  },
}

const storageStatuses: StorageStatus[] = []
window.__storageStatuses = () => storageStatuses

let worldBusy = false
// docs/plan/23-persistence-opfs-and-lifecycle.md step 5 (Deviations, `'load-failed'`): distinct from
// `worldBusy` -- the sim worker stays alive and `client.exportWorld()`/`deleteWorld()` still work
// (`export_works_after_load_failure`), but nothing else here should touch a world that never loaded
// (paint, hash reads, `attachHostLifecycle`'s pause/resume), so every gate below reads `unusable`.
let loadFailed = false
let readyErrorCode: string | undefined

const client: Client = createClient(clientOptions)
client.onStorage((status) => {
  storageStatuses.push(status)
})

try {
  await client.ready
} catch (e) {
  readyErrorCode = e instanceof EngineStartError ? e.code : 'unknown'
  if (e instanceof EngineStartError && e.code === 'world-busy') {
    worldBusy = true
    busyEl.style.display = 'block'
  } else if (e instanceof EngineStartError && e.code === 'load-failed') {
    loadFailed = true
    setWorldOpStatus(`load-failed: ${e.message}`)
  } else {
    throw e
  }
}

const unusable = worldBusy || loadFailed
window.__worldBusy = () => worldBusy
window.__readyErrorCode = () => readyErrorCode

if (!unusable) {
  attachHostLifecycle(client, controllableDoc)
}

// docs/plan/23-persistence-opfs-and-lifecycle.md step 5: Export/Import/Delete, both as the real
// button wiring (Scope) and as direct test hooks (Seams parity, file-level comment above).
let lastExportedBytes: number[] | undefined
window.__lastExportedBytes = () => lastExportedBytes

let lastExportedBlob: Blob | undefined

async function doExport(): Promise<number[]> {
  const blob = await client.exportWorld()
  lastExportedBlob = blob
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
  lastExportedBytes = bytes
  return bytes
}
window.__exportWorld = doExport

/** Device check `M23-export-import` ("confirm the file arrives in Files"): a real download, not
 * just the test-hook stash above -- an anchor with `download` set, clicked once and discarded, the
 * ordinary way to save a `Blob` without a File System Access API prompt (unsupported in Safari). */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function doImport(
  bytes: number[],
  opts?: { worldId?: string; overwrite?: boolean },
): Promise<{ worldId: string }> {
  return client.importWorld(new Uint8Array(bytes), opts)
}
window.__importWorld = doImport

window.__deleteWorld = (id) => client.deleteWorld(id)

function setWorldOpStatus(text: string): void {
  worldOpStatusEl.textContent = text
}

exportBtn.addEventListener('click', () => {
  void doExport()
    .then((bytes) => {
      setWorldOpStatus(`exported ${bytes.length} bytes`)
      if (lastExportedBlob) triggerDownload(lastExportedBlob, `${worldId}.world`)
    })
    .catch((e: unknown) => setWorldOpStatus(`export error: ${String(e)}`))
})

importBtn.addEventListener('click', () => {
  void (async () => {
    const file = importFile.files?.[0]
    if (!file) {
      setWorldOpStatus('import error: no file selected')
      return
    }
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
    const worldIdField = importWorldIdInput.value.trim()
    const opts = worldIdField.length > 0 ? { worldId: worldIdField } : undefined
    try {
      const result = await doImport(bytes, opts)
      setWorldOpStatus(`imported as ${result.worldId}`)
    } catch (e) {
      setWorldOpStatus(`import error: ${String(e)}`)
    }
  })()
})

deleteBtn.addEventListener('click', () => {
  void client
    .deleteWorld(worldId)
    .then(() => setWorldOpStatus(`deleted ${worldId}`))
    .catch((e: unknown) => setWorldOpStatus(`delete error: ${String(e)}`))
})

function paintAt(x: number, y: number): number {
  const action: Action = { Paint: { pos: { x, y }, base: 1, resource: 2 } }
  return client.dispatch(action)
}
window.__dispatchPaintAt = paintAt
paintBtn.addEventListener('click', () => {
  if (!unusable) {
    paintAt(0, 0)
    void refreshHash()
  }
})

// `hash`/`tick`/`durable`/`persisted` (Scope): `worldHash`/`simCounters` need the sim worker
// parked, so both test hooks and the periodic HUD refresh below go through `parkWorkers`/
// `resumeWorkers` (`slice.ts`'s own `__worldHash` precedent) -- gated on `!worldBusy` (no sim
// worker ever came up) and, for the periodic refresh only, on `!controllableDoc.hidden` (a world
// this page itself paused for the hidden boundary must not be woken back up by an unrelated HUD
// poll). Step 5 fix round: `parkWorkers`/`resumeWorkers` touch the exact same `W_YIELD`/`W_PARKED`
// words `client.ts`'s own `hostWorkerLock` (`attachHostLifecycle`, `exportWorld`/`importWorld`/
// `deleteWorld`) already serializes against each other -- this function was the one caller left
// outside that lock (steps 3-4's own "known, deliberately narrow race window" note, before step 5
// added a second, real, non-test caller of the same words). Found live: `resumeWorkers`'s own
// `{type:'resume'}` re-entering `runBlockingLoop` synchronously, immediately followed by an
// unguarded `exportWorld()` that (wrongly) believed the worker was still parked and never set
// `W_YIELD` itself, leaves the worker ticking forever with the queued `export-world` message
// undelivered -- a true hang, not a timing flake (`export_import_roundtrip_browser`, ~15-20% of
// runs). Wrapping this function's own body in the same lock closes it for every caller here too.
async function readHashAndTick(): Promise<{ hash: string; tick: number }> {
  return clientTestHandle(client).hostWorkerLock(async () => {
    await parkWorkers(client)
    const h = await readWorldHash(client)
    const counters = await simCounters(client)
    await resumeWorkers(client)
    return { hash: h, tick: counters.ticksRun }
  })
}
window.__worldHash = async () => {
  if (unusable) throw new Error('world.ts: __worldHash called on a busy/load-failed world')
  return (await readHashAndTick()).hash
}
window.__worldHashAndTick = async () => {
  if (unusable) throw new Error('world.ts: __worldHashAndTick called on a busy/load-failed world')
  return readHashAndTick()
}
window.__simTicksRun = () => {
  if (unusable) return 0
  return Atomics.load(clientTestHandle(client).control.words, CB_SIM_TICKS_RUN)
}
window.__persistenceDebug = async () => {
  if (unusable) throw new Error('world.ts: __persistenceDebug called on a busy/load-failed world')
  return clientTestHandle(client).hostWorkerLock(async () => {
    await parkWorkers(client)
    const counters = await persistenceCounters(client)
    await resumeWorkers(client)
    return counters
  })
}

// `hash`/`tick` refresh on discrete events only (page load, a Paint dispatch), never a periodic
// timer (Deviations): `parkWorkers`/`resumeWorkers` (`test/client.ts`) touch the sim worker through
// the *generic* shell yield protocol (`{ type: 'resume' }`), the same underlying `W_YIELD`/
// `W_PARKED` words `attachHostLifecycle`'s own `sim-pause`/`sim-resume` protocol uses -- a periodic
// refresh racing a hidden-boundary pause could send a bare `{ type: 'resume' }` to a worker this
// page just deliberately parked (found by `hidden_pauses_and_snapshots` failing with a genuine OPFS
// access-handle conflict: two overlapping `Persistence`/`SimHost` operations on the same instance).
// A discrete, human- or test-triggered refresh has no such steady-state overlap; `refreshHash` still
// guards on `!controllableDoc.hidden` so a stray call during a pause is a no-op rather than a
// conflicting resume.
let lastHash = '(pending)'
let lastTick = 0
async function refreshHash(): Promise<void> {
  if (unusable || controllableDoc.hidden) return
  try {
    const r = await readHashAndTick()
    lastHash = r.hash
    lastTick = r.tick
  } catch {
    // Never surfaces as a console error (`openPage`'s own rule); the next trigger retries.
  }
}
void refreshHash()

function latestStatus(): StorageStatus | undefined {
  return storageStatuses.at(-1)
}

function hudText(): string {
  const status = latestStatus()
  return [
    'world.html',
    `world: ${worldId}`,
    `worldBusy: ${worldBusy}`,
    `loadFailed: ${loadFailed}`,
    `hash: ${lastHash}`,
    `tick: ${lastTick}`,
    `durable: ${status ? status.durable : '(pending)'}`,
    `persisted: ${status ? status.persisted : '(pending)'}`,
    `usage: ${status ? status.usage : '(pending)'}`,
    `quota: ${status ? status.quota : '(pending)'}`,
  ].join('\n')
}
function renderHud(): void {
  hudEl.textContent = hudText()
}
setInterval(renderHud, 200)
renderHud()
window.__hudText = hudText
window.__errors = () => []

window.__pageReady = true
