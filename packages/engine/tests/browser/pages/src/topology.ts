// `topology.html`'s script (docs/plan/06b-workers-and-spawn.md, Tests added): builds a real
// `createClient()` and exposes a small debug API `workers.spec.ts`/`start.spec.ts` drive through
// `page.evaluate`, since a `Client`'s own shape (`ready`, `destroy`) is not itself serialisable
// across the CDP boundary Playwright's `page.evaluate` return value crosses.
import wasm from 'virtual:engine/wasm'
import {
  type Client,
  type ClientOptions,
  clientTestHandle,
  createClient,
} from '../../../../src/client.ts'
import { W_MEM_GROWS, W_MEM_PAGES, workerWord } from '../../../../src/sab/control.ts'
import { parkWorkers, resumeWorkers, setCamera, stepFrame } from '../../../../src/test/client.ts'

const DEFAULT_GAME = { seed: '0x1', entities: 4 }

type CreateOptions = {
  host?: ClientOptions['host']
  arenas?: ClientOptions['arenas']
  genWorkers?: number
  test?: ClientOptions['test']
  /** Pattern B (0017 §3): `start.worker_blocked_error` points this at a worker script served
   * without COEP (docs/plan/06b-workers-and-spawn.md, Tests added). */
  createWorker?: () => Worker
}

declare global {
  interface Window {
    __client?: Client
    __createClient?: (opts?: CreateOptions) => void
    __clientReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __clientWorkers?: () => Record<string, { memPages: number; memGrows: number }>
    __clientDestroy?: () => void
    /** Returns the `frame_time_ms` this step wrote into the camera block, so a spec can compare
     * it with what WASM saw as `t_ms` (`workers.camera_block_reaches_wasm`). */
    __setCameraAndStep?: (x: number, y: number, tilesAcross: number, dtMs: number) => number
    /** A blocked worker cannot receive CDP (0015 §2, "a blocked worker receives no events"): a
     * spec that reaches into a worker with `worker.evaluate()` parks first. */
    __park?: () => Promise<void>
    __resume?: () => Promise<void>
    __pageReady?: true
  }
}

window.__createClient = (opts = {}) => {
  const canvas = document.createElement('canvas')
  const host = opts.host ?? { kind: 'local', world: { game: DEFAULT_GAME } }
  // `flags` defaults to `{}`, not omitted: every worker this test page spawns is a test worker, so
  // its setup message should always carry `test` (orchestrator decision 1's gate on the setup
  // message's own `test` field -- always empty for a real game, always present here) and expose
  // `__engineWorkerKind`/`__engineInstance`/`__engineIsolateName` the way this file's own tests
  // (`workers.spec.ts`, `start.spec.ts`) already read them.
  const test: ClientOptions['test'] = {
    game: DEFAULT_GAME,
    ...opts.test,
    flags: opts.test?.flags ?? {},
  }
  const options: ClientOptions = { canvas, wasm, host, test }
  if (opts.arenas) options.arenas = opts.arenas
  if (opts.genWorkers !== undefined) options.genWorkers = opts.genWorkers
  if (opts.createWorker) options.createWorker = opts.createWorker
  window.__client = createClient(options)
  // Swallow here, synchronously with creation, so the browser never reports this as an unhandled
  // rejection; `__clientReady` (called later, from a separate `page.evaluate`) observes the same
  // promise's outcome independently (a promise may be `.then`/`.catch`-ed more than once).
  window.__client.ready.catch(() => {})
}

window.__clientReady = async () => {
  try {
    await window.__client?.ready
    return { ok: true }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { ok: false, code: err.code ?? '', message: err.message ?? String(e) }
  }
}

window.__clientWorkers = () => {
  if (!window.__client) return {}
  const h = clientTestHandle(window.__client)
  const out: Record<string, { memPages: number; memGrows: number }> = {}
  for (const w of h.workers) {
    out[`${w.kind}${w.index}`] = {
      memPages: Atomics.load(h.control.words, workerWord(w.index, W_MEM_PAGES)),
      memGrows: Atomics.load(h.control.words, workerWord(w.index, W_MEM_GROWS)),
    }
  }
  return out
}

window.__clientDestroy = () => window.__client?.destroy()

window.__park = () => (window.__client ? parkWorkers(window.__client) : Promise.resolve())
window.__resume = () => (window.__client ? resumeWorkers(window.__client) : Promise.resolve())

window.__setCameraAndStep = (x, y, tilesAcross, dtMs) => {
  if (!window.__client) throw new Error('__setCameraAndStep: no client')
  setCamera(window.__client, { x, y, tilesAcross })
  stepFrame(window.__client, dtMs)
  return clientTestHandle(window.__client).cameraState.frameTimeMs
}

window.__pageReady = true
