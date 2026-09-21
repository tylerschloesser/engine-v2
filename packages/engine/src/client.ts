// Main-thread entrypoint (`engine`): `createClient`'s spawn path (docs/plan/06b-workers-and-spawn.md).
// Checks isolation, compiles the module once, creates the `SabSet`, spawns the worker set for the
// chosen topology, and posts each worker its `Module` (or `wasmUrl`), its SABs and its config.
import { CameraBlockView, writeCameraBlock } from './camera/block.js'
import type { CameraInput, CameraIntegrator, MoveToOptions, Rect } from './camera/camera.js'
import { createCameraIntegrator } from './camera/camera.js'
import { cameraStorageKey, restoreCameraState, saveCameraState } from './camera/persistence.js'
import { CameraState, copyCameraState } from './camera/state.js'
import type { CameraViewport, ScreenPoint } from './camera/transform.js'
import { screenToWorld, worldToScreen } from './camera/transform.js'
import type { Clock, Scheduler } from './clock.js'
import { systemClock, systemScheduler } from './clock.js'
import { installBlurAndVisibilityReset } from './input/focus.js'
import { installKeyListeners, KeyState } from './input/keys.js'
import { installPointerListeners, PointerSlots } from './input/pointers.js'
import { createSemanticRecognizer, type SemanticRecognizer } from './input/semantic.js'
import { installWheelListeners, WheelState } from './input/wheel.js'
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
import {
  buildSimInstanceConfig,
  type WorldConfig as ServerWorldConfig,
  seedToHexU64,
} from './sim-config.js'
import type { FromWorker, TestFlags, ToWorker, WorkerKind } from './worker/protocol.js'

export type { SupportFailure, SupportFailureCode, SupportReport } from './support.js'
export { checkSupport } from './support.js'

/**
 * The real shape (docs/plan/13-sim-host-tick-loop.md, Scope "`createClient` local host"): `server.
 * ts`'s own `WorldConfig` (0009), minus `buildHash` -- `createClient` fills that itself, from
 * `ClientOptions.wasm.buildHash`, the same build the worker set it spawns is instantiated from (a
 * caller would otherwise have to keep two copies of one hash in sync). `Params` defaults to
 * `unknown`, matching `server.ts`'s own default; `ClientOptions` itself stays non-generic (Seams:
 * no renamed Provides).
 */
export type WorldConfig<Params = unknown> = Omit<ServerWorldConfig<Params>, 'buildHash'>

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
  /** docs/plan/11-camera-and-input.md Seams (Provides): the `localStorage` persistence suffix (a
   * game passes its world id, so each world keeps its own camera). `camera/persistence.ts`'s
   * `cameraStorageKey` turns this into the actual key; omitted means `'default'`. */
  cameraKey?: string
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
  /** docs/plan/11-camera-and-input.md Seams (Provides): `camera.{setConstraints, moveTo, read,
   * worldToScreen, screenToWorld}` with 0019's signatures, plus `camera.restored: boolean` and,
   * internal (Seams: "Internal"), `setViewClamp`/`setFollow`. `tick(dtMs)` is this range's own
   * addition (Deviations: not itself a pinned Seam name, mirroring `input.recognize`'s own
   * precedent): runs one rAF's worth of `CameraIntegrator.integrate` then `input.recognize`, both
   * over the real pointer/key/wheel listeners this same `createClient` call installed on
   * `options.canvas`/`window` -- a page's own `onCamera` hook (`frame-loop.ts`) calls this once per
   * rAF instead of reaching into a separately-built integrator/bundle. */
  readonly camera: {
    setConstraints(opts: { bounds?: Rect; minTiles?: number; maxTiles?: number }): void
    moveTo(x: number, y: number, opts?: MoveToOptions): void
    read(out: CameraState): void
    worldToScreen(x: number, y: number, out: ScreenPoint): void
    screenToWorld(px: number, py: number, out: ScreenPoint): void
    readonly restored: boolean
    setViewClamp(maxTilesPerAxis: number): void
    setFollow(x: number, y: number, valid: boolean): void
    tick(dtMs: number): void
  }
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
  /** docs/plan/11-camera-and-input.md, step 6 (Deviations): the *same* `PointerSlots`/`KeyState`/
   * `WheelState` the client's own real listeners write into and `camera.tick()` reads from --
   * exposed so a test/dev page can pair it with `engine/test.attachCameraInputTestHooks` (the
   * existing, pinned `injectPointer`/`injectWheel`/`injectKey` seam) instead of driving a second,
   * unrelated bundle no real listener or `camera.tick()` call ever reads. */
  readonly cameraBundle: CameraInput
  readonly cameraIntegrator: CameraIntegrator
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
      camera: {
        setConstraints(): void {
          throw err
        },
        moveTo(): void {
          throw err
        },
        read(): void {
          throw err
        },
        worldToScreen(): void {
          throw err
        },
        screenToWorld(): void {
          throw err
        },
        restored: false,
        setViewClamp(): void {
          throw err
        },
        setFollow(): void {
          throw err
        },
        tick(): void {
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

  // docs/plan/11-camera-and-input.md, step 6 (Deviations: "engine-owned camera", 0019 §1): the one
  // real `PointerSlots`/`KeyState`/`WheelState` bundle this client's own real DOM listeners write
  // into and `camera.tick()`/`input.recognize` both read from every rAF. Built here (not per-page)
  // so `client.camera.{setConstraints, moveTo}` always affects the one camera actually driven by
  // real gestures, whether or not a page ever calls `camera.tick()` at all (a headless spectator
  // client still gets a working `moveTo`/`read`).
  const cameraBundle: CameraInput = {
    pointers: new PointerSlots(),
    keys: new KeyState(),
    wheel: new WheelState(),
  }
  const cameraStorageKeyValue = cameraStorageKey(options.cameraKey)
  const cameraRestored = restoreCameraState(cameraStorageKeyValue, cameraState)
  const cameraIntegrator = createCameraIntegrator(cameraBundle, {
    onMotionEnd: (s) => saveCameraState(cameraStorageKeyValue, s),
  })

  // CSS-pixel viewport (`camera/transform.ts`'s own space, distinct from `render/viewport.ts`'s
  // device-pixel one): read once at init and refreshed only on an actual resize
  // (`ResizeObserver`), never per frame -- `getBoundingClientRect()` allocates a `DOMRect`, and
  // `camera.tick()` runs on the strict per-rAF path this milestone's own zero-GC page proves
  // (`.claude/rules/hot-paths.md`; 0016 §2 exempts a real resize as a rare discontinuity).
  const cameraViewport: CameraViewport = { widthPx: 1, heightPx: 1 }
  function refreshCameraViewport(): void {
    const rect = options.canvas.getBoundingClientRect()
    if (rect.width > 0) cameraViewport.widthPx = rect.width
    if (rect.height > 0) cameraViewport.heightPx = rect.height
  }
  refreshCameraViewport()
  let cameraResizeObserver: ResizeObserver | undefined
  if (typeof ResizeObserver !== 'undefined') {
    cameraResizeObserver = new ResizeObserver(refreshCameraViewport)
    cameraResizeObserver.observe(options.canvas)
  }

  // Real DOM wiring (0019 §3-§4): pointer capture + gestures and wheel on the canvas, keys (with
  // focus rules) and the blur/visibilitychange full-state reset on `window`/`document` -- the exact
  // listener set the exit criterion's own source scan expects, and nowhere else. `typeof window`
  // guards a non-browser embedding (none exists today; `createClient` is main-thread-only, Files
  // touched) rather than assuming one.
  const cameraInputDisposers: Array<() => void> = []
  if (typeof window !== 'undefined') {
    cameraInputDisposers.push(installPointerListeners(cameraBundle.pointers, options.canvas))
    cameraInputDisposers.push(installWheelListeners(cameraBundle.wheel, options.canvas))
    cameraInputDisposers.push(installKeyListeners(cameraBundle.keys, window))
    cameraInputDisposers.push(installBlurAndVisibilityReset(cameraBundle, window, document))
  }

  const camera: Client['camera'] = {
    setConstraints(opts) {
      cameraIntegrator.setConstraints(opts)
    },
    moveTo(x, y, opts) {
      cameraIntegrator.moveTo(cameraState, x, y, opts)
    },
    read(out) {
      copyCameraState(cameraState, out)
    },
    worldToScreen(x, y, out) {
      worldToScreen(cameraState, cameraViewport, x, y, out)
    },
    screenToWorld(px, py, out) {
      screenToWorld(cameraState, cameraViewport, px, py, out)
    },
    restored: cameraRestored,
    setViewClamp(maxTilesPerAxis) {
      cameraIntegrator.setViewClamp(maxTilesPerAxis)
    },
    setFollow(x, y, valid) {
      cameraIntegrator.setFollow(x, y, valid)
    },
    tick(dtMs) {
      cameraIntegrator.integrate(cameraState, cameraViewport, dtMs)
      input.recognize(cameraBundle, cameraState, cameraViewport, dtMs)
    },
  }

  function destroy(): void {
    Atomics.store(control.words, CB_LIFECYCLE, Lifecycle.Stopping)
    for (const w of workers) {
      Atomics.store(control.words, workerWord(w.index, W_YIELD), 1)
      control.wake(w.index)
    }
    for (const w of workers) w.worker.terminate()
    for (const dispose of cameraInputDisposers) dispose()
    cameraResizeObserver?.disconnect()
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

    // The real `WorldConfig`, `buildHash` filled from `options.wasm.buildHash` (this milestone's
    // own "the engine fills `buildHash`" rule): only present for a local host.
    const worldConfig: ServerWorldConfig | undefined =
      options.host.kind === 'local'
        ? { ...options.host.world, buildHash: options.wasm.buildHash }
        : undefined

    // `options.test.game` is the documented escape hatch for *every* worker (its own doc comment:
    // "overriding `host.world.game`"), so it still wins over a real `WorldConfig` when set. Absent
    // that, each role gets its own config shape converted from the one real `WorldConfig`
    // (Planning decisions: "the client and gen workers take them from `host.world.params`" until
    // M28 delivers seed/params in `Welcome`) -- `sim`'s own shape (`SimConfig`, `host::mod.rs`) is
    // `buildSimInstanceConfig`'s (already built, steps 1-3); `gen`/`client`'s own shape
    // (`TerrainConfig`, `game_instance.rs`) needs only `seed`/`params`, the rest defaulted, so it
    // is built inline here rather than through a second named export nothing else calls yet.
    const simGame =
      options.test?.game ?? (worldConfig ? buildSimInstanceConfig(worldConfig).game : null)
    const game =
      options.test?.game ??
      (worldConfig
        ? { seed: seedToHexU64(worldConfig.params.seed), params: worldConfig.params.worldgen }
        : null)

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
      const config: InstanceConfig = { arenaBytes, game: kind === 'sim' ? simGame : game }
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
    camera,
    destroy,
  }
  handles.set(client, {
    control,
    sabs,
    cameraState,
    cameraWriter,
    clock,
    scheduler,
    workers,
    cameraBundle,
    cameraIntegrator,
  })
  return client
}
