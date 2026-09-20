// Main-thread entrypoint (`engine`): `createClient`'s spawn path (docs/plan/06b-workers-and-spawn.md).
// Checks isolation, compiles the module once, creates the `SabSet`, spawns the worker set for the
// chosen topology, and posts each worker its `Module` (or `wasmUrl`), its SABs and its config.
import { CameraBlockView } from './camera/block.js'
import { CameraState } from './camera/state.js'
import type { Clock, Scheduler } from './clock.js'
import { systemClock, systemScheduler } from './clock.js'
import type { InstanceConfig } from './loader.js'
import {
  CB_LIFECYCLE,
  ControlBlock,
  Lifecycle,
  W_YIELD,
  WORKER_CLIENT,
  WORKER_GEN0,
  WORKER_GEN1,
  WORKER_HOST,
  workerWord,
} from './sab/control.js'
import { createSabSet, type SabSet, sabBytesTotal } from './sab/layout.js'
import type { FromWorker, TestFlags, ToWorker, WorkerKind } from './worker/protocol.js'

export type { SupportFailure, SupportFailureCode, SupportReport } from './support.js'
export { checkSupport } from './support.js'

/**
 * Provisional: the real shape belongs to M07's world model. Only `game` (forwarded verbatim, as
 * JSON, to the sim instance's config) is needed to route data through the spawn path this
 * milestone builds; a later milestone widens this without touching `ClientOptions`'s own shape.
 */
export type WorldConfig = { game?: unknown }

export interface ClientOptions {
  canvas: HTMLCanvasElement
  wasm: { url: string; buildHash: string }
  host: { kind: 'local'; world: WorldConfig } | { kind: 'remote'; url: string; joinKey?: string }
  /** Pattern B (0017 §3): the game constructs the worker itself. */
  createWorker?: () => Worker
  /** Bytes; defaults are 0015 §5's per-role arenas. */
  arenas?: { sim?: number; client?: number; gen?: number }
  /** Default per 0008: 2 when `navigator.hardwareConcurrency >= 8`, else 1. */
  genWorkers?: number
  /** Test-only escape hatch (Planning decisions: "`createClient` takes `{ clock, scheduler }`
   * through a test-only options field"); never set by a game. */
  test?: {
    clock?: Clock
    scheduler?: Scheduler
    /** Every worker's `game` config, overriding `host.world.game` (real `WorldConfig` plumbing is
     * M07's; tests need to reach a real fixture's config today). */
    game?: unknown
    flags?: TestFlags
  }
}

export interface Client {
  readonly ready: Promise<void>
  destroy(): void
}

export class EngineStartError extends Error {
  readonly code:
    | 'not-isolated'
    | 'worker-blocked'
    | 'compile-failed'
    | 'abi-mismatch'
    | 'arena-config'
    | 'worker-fatal'
  constructor(code: EngineStartError['code'], message: string) {
    super(message)
    this.name = 'EngineStartError'
    this.code = code
  }
}

// 0015 §5: default per-role arenas.
const MIB = 1024 * 1024
const DEFAULT_ARENA_BYTES = { sim: 96 * MIB, client: 48 * MIB, gen: 4 * MIB }
// 0015 §5: whole-tab target on the baseline phone, minus the fixed SAB and GPU shares (Planning
// decisions "Arena config check on main").
const TAB_TARGET_BYTES = 256 * MIB
const GPU_SHARE_BYTES = 20 * MIB

/** Bytes left for arenas once the fixed SAB and GPU shares are taken out of the whole-tab target
 * (0015 §5; Planning decisions "Arena config check on main"). Exported for `arena.sum_rule`. */
export function arenaBudgetBytes(): number {
  return TAB_TARGET_BYTES - sabBytesTotal() - GPU_SHARE_BYTES
}

/** Total arena bytes the chosen topology reserves: `client` + (`sim`, only when hosting locally)
 * + `gen` * `genWorkers`. Exported for `arena.sum_rule`. */
export function totalArenaBytes(
  arenas: { sim: number; client: number; gen: number },
  hostKind: 'local' | 'remote',
  genWorkers: number,
): number {
  return arenas.client + (hostKind === 'local' ? arenas.sim : 0) + arenas.gen * genWorkers
}

/** Throws `EngineStartError('arena-config', ...)` when the chosen topology's arenas sum past
 * `arenaBudgetBytes()`. Exported for `arena.sum_rule` (docs/plan/06b-workers-and-spawn.md, Tests
 * added): a pure check, callable without a DOM (`Worker`, `fetch`) or cross-origin isolation. */
export function checkArenaBudget(
  arenas: { sim: number; client: number; gen: number },
  hostKind: 'local' | 'remote',
  genWorkers: number,
): void {
  const budget = arenaBudgetBytes()
  const total = totalArenaBytes(arenas, hostKind, genWorkers)
  if (total > budget) {
    throw new EngineStartError(
      'arena-config',
      `arenas sum to ${total} bytes, over the ${budget} byte budget left by the whole-tab ` +
        `target minus SABs and GPU (0015 §5)`,
    )
  }
}

export type WorkerEntry = { kind: WorkerKind; index: number; worker: Worker }

/** `engine/test` only: everything the client test helpers (`parkWorkers`, `stepFrame`, `setCamera`,
 * `asHarness`, ...) need. Not part of the public `Client` shape (its Seams comment: "later
 * milestones add members"); reached only through `clientTestHandle`. */
export interface ClientTestHandle {
  readonly control: ControlBlock
  readonly sabs: SabSet
  readonly cameraState: CameraState
  readonly cameraWriter: CameraBlockView
  readonly clock: Clock
  readonly scheduler: Scheduler
  readonly workers: WorkerEntry[]
}

const handles = new WeakMap<Client, ClientTestHandle>()

export function clientTestHandle(client: Client): ClientTestHandle {
  const h = handles.get(client)
  if (!h) throw new Error('clientTestHandle: not a createClient() result')
  return h
}

function defaultGenWorkers(): number {
  return typeof navigator !== 'undefined' && navigator.hardwareConcurrency >= 8 ? 2 : 1
}

function spawnWorker(options: ClientOptions): Worker {
  return options.createWorker
    ? options.createWorker()
    : new Worker(new URL('./worker-auto.js', import.meta.url), { type: 'module' })
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Sends the setup message to `worker` and resolves once it replies `ready`, or rejects with an
 * `EngineStartError`: `worker-blocked` for a script the browser refused to even run (0015 §3,
 * "turn a pre-ready worker `error` into..."), `worker-fatal` for a trap or setup failure it
 * reported through the fixed protocol, unless the message names an ABI mismatch (`abi-mismatch`).
 */
function setupWorker(
  worker: Worker,
  kind: WorkerKind,
  index: number,
  sabs: SabSet,
  config: InstanceConfig,
  wasm: { module?: WebAssembly.Module; url?: string },
  test: TestFlags | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    worker.onerror = (e) => {
      if (settled) return
      settled = true
      reject(
        new EngineStartError(
          'worker-blocked',
          `worker script blocked: is COEP set on every path? (${e.message})`,
        ),
      )
    }
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      if (settled) return
      const m = ev.data
      if (m.type === 'ready') {
        settled = true
        resolve()
      } else if (m.type === 'fatal') {
        settled = true
        const code = m.message.includes('ABI mismatch') ? 'abi-mismatch' : 'worker-fatal'
        reject(new EngineStartError(code, m.message))
      }
    }
    const setup: ToWorker = {
      type: 'setup',
      kind,
      index,
      sabs,
      config,
      ...(wasm.module ? { module: wasm.module } : {}),
      ...(wasm.url ? { wasmUrl: wasm.url } : {}),
      ...(test ? { test } : {}),
    }
    worker.postMessage(setup)
  })
}

/** `createClient` is synchronous (PRE-PLAN §4); spawn itself is asynchronous, tracked by
 * `client.ready`. */
export function createClient(options: ClientOptions): Client {
  // Checked first, synchronously, before anything below touches `SharedArrayBuffer`
  // (`createSabSet`): on a page the browser never made cross-origin isolated, the global does not
  // exist at all, so `new SharedArrayBuffer(...)` throws a bare `ReferenceError` synchronously out
  // of `createClient` itself instead of the readable, awaitable `EngineStartError` `client.ready` is
  // meant to reject with (0015 §3; docs/plan/06b-workers-and-spawn.md, Tests added
  // `start.not_isolated_error`, Deviations).
  if (!globalThis.crossOriginIsolated) {
    const err = new EngineStartError(
      'not-isolated',
      'crossOriginIsolated is false: see checkSupport() for what to fix',
    )
    const ready = Promise.reject(err)
    ready.catch(() => {}) // see `start()`'s own `.ready.catch()` comment below
    return { ready, destroy() {} }
  }

  const genWorkers = options.genWorkers ?? defaultGenWorkers()
  const arenas = {
    sim: options.arenas?.sim ?? DEFAULT_ARENA_BYTES.sim,
    client: options.arenas?.client ?? DEFAULT_ARENA_BYTES.client,
    gen: options.arenas?.gen ?? DEFAULT_ARENA_BYTES.gen,
  }
  const clock = options.test?.clock ?? systemClock
  const scheduler = options.test?.scheduler ?? systemScheduler

  const sabs = createSabSet(options.host.kind === 'local' ? 'sim' : 'net', genWorkers)
  const control = new ControlBlock(sabs.control)
  const cameraState = new CameraState()
  const cameraWriter = new CameraBlockView(sabs.cameraBlock)
  const workers: WorkerEntry[] = []

  function destroy(): void {
    Atomics.store(control.words, CB_LIFECYCLE, Lifecycle.Stopping)
    for (const w of workers) {
      Atomics.store(control.words, workerWord(w.index, W_YIELD), 1)
      control.wake(w.index)
    }
    for (const w of workers) w.worker.terminate()
  }

  async function start(): Promise<void> {
    checkArenaBudget(arenas, options.host.kind, genWorkers)

    const postModule = options.test?.flags?.postModule !== false
    let module: WebAssembly.Module | undefined
    if (postModule) {
      try {
        module = await WebAssembly.compileStreaming(fetch(options.wasm.url))
      } catch (e) {
        throw new EngineStartError(
          'compile-failed',
          `compiling ${options.wasm.url}: ${errorMessage(e)}`,
        )
      }
    }

    const game =
      options.test?.game ??
      (options.host.kind === 'local' ? options.host.world.game : undefined) ??
      null

    type Spawn = { kind: WorkerKind; index: number; arenaBytes: number }
    const spawns: Spawn[] = [{ kind: 'client', index: WORKER_CLIENT, arenaBytes: arenas.client }]
    spawns.push(
      options.host.kind === 'local'
        ? { kind: 'sim', index: WORKER_HOST, arenaBytes: arenas.sim }
        : { kind: 'net', index: WORKER_HOST, arenaBytes: 0 },
    )
    const genIndices = [WORKER_GEN0, WORKER_GEN1]
    for (let i = 0; i < genWorkers; i++) {
      spawns.push({ kind: 'gen', index: genIndices[i] as number, arenaBytes: arenas.gen })
    }

    const waits = spawns.map(({ kind, index, arenaBytes }) => {
      const worker = spawnWorker(options)
      workers.push({ kind, index, worker })
      const config: InstanceConfig = { arenaBytes, game }
      const wasm: { module?: WebAssembly.Module; url?: string } = {}
      if (kind !== 'net') {
        if (module) wasm.module = module
        else wasm.url = options.wasm.url
      }
      return setupWorker(worker, kind, index, sabs, config, wasm, options.test?.flags)
    })
    await Promise.all(waits)
  }

  const ready = start()
  const client: Client = { ready, destroy }
  handles.set(client, { control, sabs, cameraState, cameraWriter, clock, scheduler, workers })
  return client
}
