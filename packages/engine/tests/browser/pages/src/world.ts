// `world.html`'s script (docs/plan/23-persistence-opfs-and-lifecycle.md, Scope): a real
// `createClient()` single-player topology with persistence on (`host.persist`), fixture `puts` --
// `?world=<id>` (default `device`). Reuses M16's `slice.html` HUD/Paint precedent (a plain HUD
// element and a Paint button dispatching an action at a fixed world position -- no renderer: this
// page's own exit criteria (`hash`/`tick`/`durable`/`persisted`, the `WorldBusy` banner) need no
// GPU device at all, `createClient` itself never touches one, 0018 §1) plus this milestone's own
// additions: `hash` (`worldHash`, refreshed once a second), `durable`/`persisted` (from
// `client.onStorage`), and the `WorldBusy` banner when `client.ready` rejects with `'world-busy'`.
//
// Export/Import/Delete buttons (Scope) are step 5's own scope -- omitted here, not stubbed. DOM ids
// for step 5 to attach to: `#export-btn`, `#import-file`, `#import-worldid`, `#import-btn`,
// `#delete-btn` (none exist yet; step 5 creates them). `#world-canvas` is this page's own canvas
// (required by `ClientOptions.canvas`, never fed to WebGPU); `#hud`, `#paint-btn`, `#world-busy`
// already exist, matching `slice.html`'s own ids where they overlap.
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
    /** Deterministic hidden/visible control (headless Chromium's own `document.hidden` cannot be
     * forced from outside the page, `hidden-tab-upload.ts`'s own `__worldSetHidden` precedent):
     * `undefined` (the default) means "follow the real `document.hidden`"; a test overrides it. */
    __worldSetHidden?: (hidden: boolean | undefined) => void
    __dumpWorldStorage?: (worldId: string) => Promise<Record<string, number[]>>
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
  }
}

const params = new URL(location.href).searchParams
const worldId = params.get('world') ?? 'device'
// `no_opfs_falls_back_durable_false`'s own deterministic switch (Deviations: not the brief's own
// suggested "OPFS stubbed out by an init script" -- measured that `navigator.storage.getDirectory`
// stubbed via `page.addInitScript` on the page's own `navigator` does not reach the sim worker's
// separate global scope's `navigator`, so `TestFlags.noOpfs` is the real mechanism instead).
const noOpfs = params.get('noOpfs') === '1'

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
  test: { flags: { pace: true, ...(noOpfs ? { noOpfs: true } : {}) } },
}

const storageStatuses: StorageStatus[] = []
window.__storageStatuses = () => storageStatuses

let worldBusy = false
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
  } else {
    throw e
  }
}

window.__worldBusy = () => worldBusy
window.__readyErrorCode = () => readyErrorCode

if (!worldBusy) {
  attachHostLifecycle(client, controllableDoc)
}

function paintAt(x: number, y: number): number {
  const action: Action = { Paint: { pos: { x, y }, base: 1, resource: 2 } }
  return client.dispatch(action)
}
window.__dispatchPaintAt = paintAt
paintBtn.addEventListener('click', () => {
  if (!worldBusy) {
    paintAt(0, 0)
    void refreshHash()
  }
})

// `hash`/`tick`/`durable`/`persisted` (Scope): `worldHash`/`simCounters` need the sim worker
// parked, so both test hooks and the periodic HUD refresh below go through `parkWorkers`/
// `resumeWorkers` (`slice.ts`'s own `__worldHash` precedent) -- gated on `!worldBusy` (no sim
// worker ever came up) and, for the periodic refresh only, on `!controllableDoc.hidden` (a world
// this page itself paused for the hidden boundary must not be woken back up by an unrelated HUD
// poll; Deviations records this as a known, deliberately narrow race window rather than a fully
// serialized guarantee).
async function readHashAndTick(): Promise<{ hash: string; tick: number }> {
  await parkWorkers(client)
  const h = await readWorldHash(client)
  const counters = await simCounters(client)
  await resumeWorkers(client)
  return { hash: h, tick: counters.ticksRun }
}
window.__worldHash = async () => {
  if (worldBusy) throw new Error('world.ts: __worldHash called on a busy world')
  return (await readHashAndTick()).hash
}
window.__worldHashAndTick = async () => {
  if (worldBusy) throw new Error('world.ts: __worldHashAndTick called on a busy world')
  return readHashAndTick()
}
window.__simTicksRun = () => {
  if (worldBusy) return 0
  return Atomics.load(clientTestHandle(client).control.words, CB_SIM_TICKS_RUN)
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
  if (worldBusy || controllableDoc.hidden) return
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
