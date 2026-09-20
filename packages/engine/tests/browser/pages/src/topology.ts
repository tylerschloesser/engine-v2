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
}

declare global {
  interface Window {
    __client?: Client
    __createClient?: (opts?: CreateOptions) => void
    __clientReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __clientWorkers?: () => Record<string, { memPages: number; memGrows: number }>
    __clientDestroy?: () => void
    __setCameraAndStep?: (x: number, y: number, tilesAcross: number, dtMs: number) => void
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
  const test: ClientOptions['test'] = { game: DEFAULT_GAME, ...opts.test }
  const options: ClientOptions = { canvas, wasm, host, test }
  if (opts.arenas) options.arenas = opts.arenas
  if (opts.genWorkers !== undefined) options.genWorkers = opts.genWorkers
  window.__client = createClient(options)
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
}

window.__pageReady = true
