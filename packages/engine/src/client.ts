// Main-thread entrypoint (`engine`): `createClient`'s spawn path (docs/plan/06b-workers-and-spawn.md).
// Checks isolation, compiles the module once, creates the `SabSet`, spawns the worker set for the
// chosen topology, and posts each worker its `Module` (or `wasmUrl`), its SABs and its config.
import { CameraBlockView, writeCameraBlock } from './camera/block.js'
import { CameraState } from './camera/state.js'
import type { Clock, Scheduler } from './clock.js'
import { systemClock, systemScheduler } from './clock.js'
import { createSemanticRecognizer, type SemanticRecognizer } from './input/semantic.js'
import type { InstanceConfig } from './loader.js'
import {
  CB_FLAGS,
  CB_FRAME_REQ,
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
import { createSabSet, MAX_GEN_WORKERS, type SabSet, sabBytesTotal } from './sab/layout.js'
import type { FromWorker, TestFlags, ToWorker, WorkerKind } from './worker/protocol.js'

export type { SupportFailure, SupportFailureCode, SupportReport } from './support.js'
export { checkSupport } from './support.js'

/**
 * Provisional: the real shape belongs to M07's world model. Only `game` (forwarded verbatim, as
 * JSON, to the sim instance's config) is needed to route data through the spawn path this
 * milestone builds; a later milestone widens this without touching `ClientOptions`'s own shape.
 */
export type WorldConfig = { game?: unknown }

/** docs/plan/09b-terrain-art-and-lifecycle.md, Seams (Provides): `ClientOptions.render`'s exact
 * shape. Defaults (per that brief's own Seams line): `scale` per 0018 §8 (`render/viewport.ts`'s
 * `computeRenderScale`, undefined here means "derive from DPR"), `scaleCap` none (undefined means
 * the derivation's own built-in 2x cap, not a narrower one), `neighbourCutoffPx` 0 ("always read
 * neighbours", already `terrain.wgsl`'s and `FrameUniformValues`'s own default since M09). Not read
 * by `createClient` itself (rendering never touches a WASM instance, 0018 §1) -- kept here so one
 * `ClientOptions` object is also what a caller hands `frame-loop.ts`'s `createRealFrameLoop`, the
 * same pattern `assets` already uses for `render/art.ts`'s `loadTileArt`. */
export type RenderOptions = { scale?: number; scaleCap?: number; neighbourCutoffPx?: number }

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
  /** docs/plan/09-renderer-terrain.md, Seams (Provides): URL of `tiles.json` (M17b adds
   * `sprites`). Not read by `createClient` itself -- rendering is main-thread-only and owns no
   * WASM instance (0018 §1) -- kept here so a caller's one `ClientOptions` object is also what it
   * hands `render/art.ts`'s `loadTileArt`, instead of a second, separately-threaded asset config. */
  assets?: { tiles: string }
  /** docs/plan/09b-terrain-art-and-lifecycle.md, Seams (Provides). See `RenderOptions`'s own doc
   * comment for defaults and why `createClient` doesn't read this itself. */
  render?: RenderOptions
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
  /** docs/plan/09-renderer-terrain.md, Non-scope ("here the camera is set by `engine/test.
   * setCamera` or a fixed `CameraState`"): a plain mutable object, later milestones add members to
   * the public `Client` shape (this comment's own precedent) as production features need direct
   * access instead of the test-only `clientTestHandle`. Mutate its fields directly, then call
   * `writeCameraAndWake()`; M11 is the real camera integration that will drive this every frame. */
  readonly cameraState: CameraState
  /** The SAB the client worker's `client::Uploader` stages upload-ring records into
   * (`worker/client-upload.ts`); `render/upload.ts`'s own `RingConsumer` drains it every frame
   * under a byte budget (0018 §3). Exposed directly, not gated behind `clientTestHandle`: draining
   * it is a production concern of any renderer built around a `createClient()` result, not a test
   * concern. */
  readonly uploadRing: SharedArrayBuffer
  /** Writes the whole camera block from `cameraState`, bumps `CB_FRAME_REQ` and wakes the client
   * worker (docs/plan/09-renderer-terrain.md Scope: `frame-loop.ts`'s "writeCameraBlock +
   * CB_FRAME_REQ + wake" phase calls this directly). Returns the new `CB_FRAME_REQ` value (`engine/
   * test`'s `stepFrame` uses it to spin on the worker's own ack; production code ignores it). */
  writeCameraAndWake(): number
  /** Sets bits of `mask` in the global `CB_FLAGS` word (`sab/control.ts`) without clearing any
   * other bit already set there. docs/plan/09b-terrain-art-and-lifecycle.md Scope/Seams:
   * `frame-loop.ts`'s `resume()` calls this with `FLAG_REBASE` on a real return-from-background
   * ("on visible ... tell the client worker to re-base interpolation"); M30 is the one that clears
   * and consumes the flag, not this milestone. */
  setFlags(mask: number): void
  /** docs/plan/11-camera-and-input.md Seams (Provides): `client.input.{on, setMode, suspend,
   * resume}` with 0019's signatures, plus `recognize(...)` (Deviations: this range's own addition,
   * the production-wiring seam a later range calls once per rAF -- mirroring `CameraIntegrator.
   * integrate`, from the same externally-owned `pointers`/`keys`/`wheel` bundle -- rather than a
   * pinned Seam name). */
  readonly input: SemanticRecognizer
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

/** 0008 §2: 1 worker by default, 2 when `hardwareConcurrency >= 8`. `requested` (`ClientOptions.
 * genWorkers`) overrides the default when given, clamped to `[1, MAX_GEN_WORKERS]` --
 * `createSabSet`'s own worst-case sizing (`sab/layout.ts`), which the whole-tab arena and SAB
 * budgets (0015 §5) already assume. A pure function (docs/plan/08b-gen-workers-and-queue.md,
 * Seams) so `genWorkerCount rule` can drive it without `navigator`. */
export function genWorkerCount(hardwareConcurrency: number, requested?: number): number {
  if (requested !== undefined) return Math.min(Math.max(requested, 1), MAX_GEN_WORKERS)
  return hardwareConcurrency >= 8 ? 2 : 1
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
    // No `SharedArrayBuffer` exists on this path (that global is exactly what being isolated
    // provides), so `uploadRing`/`writeCameraAndWake` cannot be real: any caller reaching them
    // without first awaiting the already-rejected `ready` gets the same error repeated.
    return {
      ready,
      cameraState: new CameraState(),
      get uploadRing(): SharedArrayBuffer {
        throw err
      },
      writeCameraAndWake(): number {
        throw err
      },
      setFlags(): void {
        throw err
      },
      input: {
        on(): () => void {
          throw err
        },
        setMode(): void {
          throw err
        },
        suspend(): void {
          throw err
        },
        resume(): void {
          throw err
        },
        recognize(): void {
          throw err
        },
      },
      destroy() {},
    }
  }

  const genWorkers = genWorkerCount(
    typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 1,
    options.genWorkers,
  )
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
  const input = createSemanticRecognizer(sabs.inputRing)
  const workers: WorkerEntry[] = []

  function destroy(): void {
    Atomics.store(control.words, CB_LIFECYCLE, Lifecycle.Stopping)
    for (const w of workers) {
      Atomics.store(control.words, workerWord(w.index, W_YIELD), 1)
      control.wake(w.index)
    }
    for (const w of workers) w.worker.terminate()
  }

  /** docs/plan/09-renderer-terrain.md Scope: "writeCameraBlock + CB_FRAME_REQ + wake" as one
   * seam (`Client.writeCameraAndWake`, Deviations). No spin/wait here (production never blocks
   * main, 0015 §2): `engine/test`'s `stepFrame` is the one that spins on the returned value. */
  function writeCameraAndWake(): number {
    writeCameraBlock(cameraWriter, cameraState)
    const req = (Atomics.add(control.words, CB_FRAME_REQ, 1) + 1) >>> 0
    control.wake(WORKER_CLIENT)
    return req
  }

  /** docs/plan/09b-terrain-art-and-lifecycle.md Scope: "set `CB_FLAGS.REBASE`". `Atomics.or`, not a
   * load-then-store: another flag bit set by something else between the load and the store would
   * otherwise be clobbered. */
  function setFlags(mask: number): void {
    Atomics.or(control.words, CB_FLAGS, mask)
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
  const client: Client = {
    ready,
    cameraState,
    uploadRing: sabs.uploadRing,
    writeCameraAndWake,
    setFlags,
    input,
    destroy,
  }
  handles.set(client, { control, sabs, cameraState, cameraWriter, clock, scheduler, workers })
  return client
}
