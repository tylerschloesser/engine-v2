// `gen.html`'s script (docs/plan/08b-gen-workers-and-queue.md, Tests added): the imperative debug
// API `gen.spec.ts` drives through `page.evaluate`, the same pattern `topology.ts` uses for
// `workers.spec.ts`/`start.spec.ts` (docs/plan/06b-workers-and-spawn.md) -- a `Client`'s own shape
// is not itself serialisable across the CDP boundary `page.evaluate`'s return value crosses. The
// first browser page over `fx-worldgen` rather than `fx-hash` (`fixtureWasm`, `packages/engine/
// CLAUDE.md`). `host: { kind: 'remote', ... }`: `fx-worldgen` has no `Sim` role (`fixtures/worldgen/
// CLAUDE.md`), so a `local` host (which always spawns a `sim` worker) would fail every test here;
// `net` never connects (M29) and has no WASM at all.
//
// Every global here is `__gen*`-prefixed, not the `__client`/`__createClient`/... names
// `topology.ts` already claims: `tests/browser/pages/tsconfig.json` type-checks every page script
// as one program, so two files augmenting the same `Window` property with a differently-shaped
// type is a compile error, not a per-file concern.
import { Status } from '../../../../src/abi.ts'
import {
  type Client,
  type ClientOptions,
  clientTestHandle,
  createClient,
  type WorkerEntry,
} from '../../../../src/client.ts'
import {
  W_MEM_GROWS,
  W_MEM_PAGES,
  W_PARKED,
  W_YIELD,
  workerWord,
} from '../../../../src/sab/control.ts'
import { RingConsumer, type RingStats } from '../../../../src/sab/ring.ts'
import { callParked, parkWorkers, resumeWorkers, stepFrame } from '../../../../src/test/client.ts'
import * as gen from '../../../../src/test/gen.ts'
import { isolateName } from '../../../../src/worker/protocol.ts'
import { fixtureWasm } from './fixture-wasm.ts'

const wasm = await fixtureWasm('worldgen')
const DEFAULT_SEED = '0x00c0ffee5eed1234'

type GenCreateOptions = {
  genWorkers?: number
  seed?: string
  /** `fixtures/worldgen`'s own test-only config knob (this milestone's Deviations): default 5
   * (edge 32); the oversize-fatal test sets 6 (edge 64) to exceed the browser topology's fixed
   * `genResult` slot. */
  chunkBits?: number
  arenas?: ClientOptions['arenas']
  test?: ClientOptions['test']
  createWorker?: () => Worker
}

type GenIsolateStat = { memPages: number; memGrows: number }
type GenRingStat = { drops: number; pushed: number; popped: number }

declare global {
  interface Window {
    __genClient?: Client
    __genCreateClient?: (opts?: GenCreateOptions) => void
    __genClientReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __genClientDestroy?: () => void
    __genPark?: () => Promise<void>
    __genResume?: () => Promise<void>
    __genSetView?: (opts: {
      x: number
      y: number
      halfExtentX: number
      halfExtentY: number
      velocityX?: number
      velocityY?: number
    }) => void
    __genStep?: (dtMs: number) => void
    __genStats?: () => Promise<gen.GenStats>
    __genIdle?: () => Promise<void>
    __genChunkHash?: (cx: number, cy: number) => Promise<string | null>
    __genIsolates?: () => Record<string, GenIsolateStat>
    __genRings?: () => Record<string, GenRingStat>
    /** Self-contained ordering probe (Deviations): keeps `gen0` parked except during a bounded
     * resume/park burst per cycle, sequenced with the client's own park/resume so nothing runs in
     * the background between cycles -- avoids a race between this page's own polling and the real
     * worker threads. Returns the 1-based cycle index each of three known chunks first shows
     * cached, or -1 if never (within `cycles`). */
    __genProbeOrder?: () => Promise<{
      ring0At: number
      ring1At: number
      ring2At: number
      cycles: number
    }>
    __pageReady?: true
  }
}

function requireClient(): Client {
  const c = window.__genClient
  if (!c) throw new Error('gen.ts: no client (call __genCreateClient first)')
  return c
}

window.__genCreateClient = (opts = {}) => {
  const canvas = document.createElement('canvas')
  const genWorkers = opts.genWorkers ?? 1
  const game: Record<string, unknown> = {
    seed: opts.seed ?? DEFAULT_SEED,
    params: {},
    genWorkers,
  }
  if (opts.chunkBits !== undefined) game.chunkBits = opts.chunkBits
  const test: ClientOptions['test'] = {
    game,
    ...opts.test,
    flags: opts.test?.flags ?? {},
  }
  const options: ClientOptions = {
    canvas,
    wasm,
    host: { kind: 'remote', url: 'ws://unused.invalid' },
    genWorkers,
    test,
  }
  if (opts.arenas) options.arenas = opts.arenas
  if (opts.createWorker) options.createWorker = opts.createWorker
  window.__genClient = createClient(options)
  // Swallow here, synchronously with creation (same reasoning as `topology.ts`): `__genClientReady`
  // observes the same promise's outcome independently later.
  window.__genClient.ready.catch(() => {})
}

window.__genClientReady = async () => {
  try {
    await window.__genClient?.ready
    return { ok: true }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { ok: false, code: err.code ?? '', message: err.message ?? String(e) }
  }
}

window.__genClientDestroy = () => window.__genClient?.destroy()

window.__genPark = () => (window.__genClient ? parkWorkers(window.__genClient) : Promise.resolve())
window.__genResume = () =>
  window.__genClient ? resumeWorkers(window.__genClient) : Promise.resolve()

window.__genSetView = (opts) => {
  const { cameraState } = clientTestHandle(requireClient())
  cameraState.centreX = opts.x
  cameraState.centreY = opts.y
  cameraState.halfExtentTilesX = opts.halfExtentX
  cameraState.halfExtentTilesY = opts.halfExtentY
  cameraState.velocityX = opts.velocityX ?? 0
  cameraState.velocityY = opts.velocityY ?? 0
}

window.__genStep = (dtMs) => {
  stepFrame(requireClient(), dtMs)
}

window.__genStats = () => gen.stats(requireClient())
window.__genIdle = () => gen.idle(requireClient())
window.__genChunkHash = (cx, cy) => gen.chunkHash(requireClient(), cx, cy)

window.__genIsolates = () => {
  const h = clientTestHandle(requireClient())
  const out: Record<string, GenIsolateStat> = {}
  for (const w of h.workers) {
    out[isolateName(w.kind, w.index)] = {
      memPages: Atomics.load(h.control.words, workerWord(w.index, W_MEM_PAGES)),
      memGrows: Atomics.load(h.control.words, workerWord(w.index, W_MEM_GROWS)),
    }
  }
  return out
}

window.__genRings = () => {
  const h = clientTestHandle(requireClient())
  const out: Record<string, GenRingStat> = {}
  const scratch: RingStats = { drops: 0, pushed: 0, popped: 0 }
  for (let i = 0; i < h.sabs.genRequest.length; i++) {
    new RingConsumer(h.sabs.genRequest[i] as SharedArrayBuffer).stats(scratch)
    out[`genRequest${i}`] = { ...scratch }
    new RingConsumer(h.sabs.genResult[i] as SharedArrayBuffer).stats(scratch)
    out[`genResult${i}`] = { ...scratch }
  }
  return out
}

function findWorker(client: Client, isolate: string): WorkerEntry {
  const h = clientTestHandle(client)
  for (const w of h.workers) {
    if (isolateName(w.kind, w.index) === isolate) return w
  }
  throw new Error(`gen.ts: no worker named '${isolate}'`)
}

function pollUntil(predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      setTimeout(tick, 0)
    }
    tick()
  })
}

/** Single-worker park/resume (the exported `parkWorkers`/`resumeWorkers` always act on every
 * spawned worker): `__genProbeOrder`'s own choreography needs to hold `gen0` parked while the
 * client keeps running, which those cannot express. */
async function parkOne(client: Client, isolate: string): Promise<void> {
  const h = clientTestHandle(client)
  const w = findWorker(client, isolate)
  Atomics.store(h.control.words, workerWord(w.index, W_YIELD), 1)
  h.control.wake(w.index)
  await pollUntil(() => Atomics.load(h.control.words, workerWord(w.index, W_PARKED)) === 1)
}

async function resumeOne(client: Client, isolate: string): Promise<void> {
  const h = clientTestHandle(client)
  const w = findWorker(client, isolate)
  Atomics.store(h.control.words, workerWord(w.index, W_YIELD), 0)
  w.worker.postMessage({ type: 'resume' })
  await pollUntil(() => Atomics.load(h.control.words, workerWord(w.index, W_PARKED)) === 0)
}

window.__genProbeOrder = async () => {
  const client = requireClient()

  // `visible_rect((32,32),(16,16),dims(5)) = ChunkRect{(0,0)-(1,1)}` (a 2x2 visible rect, >= the
  // in-flight cap of 2 per worker, so the first dispatch batch is pure ring 0 -- crates/engine/src/
  // gen_queue.rs's own `MAX_IN_FLIGHT_PER_WORKER`). `(2,0)` is inside `visible.expanded(1)` =
  // `{(-1,-1)-(2,2)}` (ring 1) but not `visible` itself; `(3,0)` is inside `visible.expanded(2)` =
  // `{(-2,-2)-(3,3)}` (ring 2) but not `expanded(1)`.
  await parkOne(client, 'gen0')
  const { cameraState } = clientTestHandle(client)
  cameraState.centreX = 32
  cameraState.centreY = 32
  cameraState.halfExtentTilesX = 16
  cameraState.halfExtentTilesY = 16
  cameraState.velocityX = 0
  cameraState.velocityY = 0
  stepFrame(client, 16)
  await parkOne(client, 'client')

  async function cached(cx: number, cy: number): Promise<boolean> {
    const { value } = await callParked(client, 'client', 'client_chunk_hash', [cx, cy], 8)
    return value !== Status.NotCached
  }

  let ring0At = -1
  let ring1At = -1
  let ring2At = -1
  const CYCLES = 24
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    // One bounded burst per worker per cycle: entry-drain (docs/plan/
    // 08b-gen-workers-and-queue.md, orchestrator decision 2) processes exactly what is already
    // queued, then the loop re-parks before anything new can arrive -- deterministic, since nothing
    // runs in the background between cycles (both workers are parked at rest the rest of the time).
    await resumeOne(client, 'gen0')
    await parkOne(client, 'gen0')
    await resumeOne(client, 'client')
    await parkOne(client, 'client')
    if (ring0At < 0 && (await cached(0, 0))) ring0At = cycle
    if (ring1At < 0 && (await cached(2, 0))) ring1At = cycle
    if (ring2At < 0 && (await cached(3, 0))) ring2At = cycle
    if (ring0At >= 0 && ring1At >= 0 && ring2At >= 0) break
  }
  await resumeOne(client, 'client')
  await resumeOne(client, 'gen0')
  return { ring0At, ring1At, ring2At, cycles: CYCLES }
}

window.__pageReady = true
