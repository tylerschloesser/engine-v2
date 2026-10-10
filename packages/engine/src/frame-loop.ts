// The single rAF callback as a fixed, ordered phase list (docs/decisions/0018-renderer.md §1;
// M09 Scope): `camera` (no-op until M11) -> `writeCamera`
// (`Client.writeCameraAndWake`, Deviations) -> `upload` (`render/upload.ts`'s byte-budgeted drain)
// -> `render` (`renderer.writeFrameUniform` + `draw`) -> `overlay` (M18) -> `ui` (M16).
//
// M09b Scope/Seams (M09b): a viewport-apply step runs before
// every other phase (not a new named `FRAME_PHASES` entry -- Seams only pins the phase list's own
// name, not that it enumerates every internal step -- `renderer.onViewportChange(cb)` "called at
// most once per frame, before the `camera` phase" is satisfied by `tick()` calling
// `ViewportController.applyPending()` as its very first statement); `FrameLoop.pause()`/`resume()`
// (renamed from M09's own ad hoc `stop`/`start`, never a pinned Seam name there) drive the injected
// `Scheduler`'s rAF and are what 0018 §8's backgrounding rule actually calls; `createRealFrameLoop`
// is the wiring this milestone's own Scope names ("Wire `createFrameLoop` ... to a real canvas").
// Everything here is created once, at `createFrameLoop` time, and `tick()`'s own body is a fixed
// sequence of calls with no per-frame closures, arrays or descriptor objects (`.claude/rules/
// hot-paths.md`).
import type { Client, RenderOptions } from './client.js'
import { type Clock, createResyncingClock, type Scheduler } from './clock.js'
import type { GpuHost } from './render/gpu-host.js'
import type { TerrainRenderer, Viewport } from './render/terrain.js'
import { createUploadDrain, DEFAULT_UPLOAD_BUDGET_BYTES } from './render/upload.js'
import {
  configureCanvasContext,
  createViewportController,
  type ViewportController,
} from './render/viewport.js'
import { FLAG_REBASE } from './sab/control.js'
import { RingConsumer } from './sab/ring.js'

/** Named, in call order (Seams, Provides: "`FrameLoop` phases by name"). docs/plan/
 * 18-picking-and-overlay.md Scope, step 1: `acquire` is the new first phase -- takes the newest
 * DrawList slot once (`Client.pick.acquire()`, `render/drawlist-slot.ts`'s own `DrawListSlot`), so
 * `camera` (follow, a later step), picking, `overlay` and `render` all read the same slot for the
 * rest of this `tick()`. */
export const FRAME_PHASES = [
  'acquire',
  'camera',
  'writeCamera',
  'upload',
  'render',
  'overlay',
  'ui',
] as const
export type FramePhase = (typeof FRAME_PHASES)[number]

/** A fixed value (every test here before M09b) or a thunk re-evaluated every tick (M09b: a real
 * canvas's context hands out a *fresh* `GPUTexture` each frame via `getCurrentTexture()` -- a fixed
 * target cannot represent that). */
export type FrameTarget = GPUTexture | GPUTextureView | (() => GPUTexture | GPUTextureView)

export type FrameLoopOptions = {
  clock: Clock
  scheduler: Scheduler
  client: Client
  renderer: TerrainRenderer
  target: FrameTarget
  /** Default 0018 §3's 64 KiB. */
  uploadBudgetBytes?: number
  /** `RendererDevice.sabWriteTextureOk` (Planning decisions "`writeTexture` from a SAB view is
   * unverified"): forwarded to `render/upload.ts`'s own drain. Default `false` (the safe path). */
  sabWriteTextureOk?: boolean
  /** M37b (device loss): the host that owns the current `GpuResources`. When given, the loop
   * follows it: while it has no device the rAF callback integrates the camera and runs `acquire`/
   * `writeCamera`/`overlay`/`ui` but skips upload, encode and submit; when a rebuilt device arrives
   * the upload drain and the viewport controller are pointed at its renderer. Omitted (fakes-only
   * unit tests, hand-built pages), the loop owns `renderer` for good. */
  gpu?: GpuHost
  /** M09b: applied once per frame, before every other phase (`applyPending()`, before `onCamera`).
   * Optional so a fakes-only unit test (no canvas to resize) can omit it. Production always supplies
   * one (`createRealFrameLoop`, below). */
  viewport?: ViewportController
  /** M11 fills this in for real (Non-scope): mutate `client.cameraState` from input/gestures
   * before this tick's `writeCamera` phase runs. Default no-op. */
  onCamera?(): void
  /** M18: default no-op; a page wires this to `client.overlay.
   * update()` the same way `onCamera` wires `client.camera.tick(dtMs)` -- `frame-loop.ts` itself
   * only guarantees the phase ordering (`overlay` after `camera`/`render`), not the call. */
  onOverlay?(): void
  /** M29 Scope ("Reveal gate"): default omitted, which
   * always draws (the pre-existing behaviour of every page before this milestone, unchanged) -- a
   * page wires this to `client.revealed` (or any other predicate) to gate the `render` phase's
   * terrain draw on it (`TerrainRenderer.draw`'s own `{ reveal }` option), so a join over a slow
   * link shows the clear colour instead of a half-populated view (0013) until every visible chunk
   * has arrived. Called once per frame, the same already-bound-function-reference cost `onCamera`/
   * `onOverlay`/`onUi` already pay (`.claude/rules/hot-paths.md`: no allocation). */
  revealed?(): boolean
  /** M16 (Non-scope): default no-op. */
  onUi?(): void
  /** M09b step 6 (M09b, Tests added:
   * `frame-loop.production_runs_phases_in_order`): called with each of `FRAME_PHASES`, in order, at
   * the start of that phase's own work, every `tick()`. Purely observational (a diagnostic/test
   * hook, not a new phase: `FRAME_PHASES`' own six names are unchanged) -- default no-op, so
   * production pages that don't pass one pay one extra already-bound function-reference call per
   * phase per frame, no allocation (`.claude/rules/hot-paths.md`). `device.html` is the one real
   * page that supplies it, to prove the order end to end against a real `Client`/`TerrainRenderer`/
   * canvas instead of only the fakes `frame-loop.test.ts` uses. */
  onPhase?(phase: FramePhase): void
}

export type FrameTickResult = { uploadBytes: number; uploadRecords: number }

export type FrameLoop = {
  /** Starts the rAF loop through the injected `Scheduler`, or restarts it after `pause()` (Seams,
   * Provides: `FrameLoop.pause()/resume()`). A restart -- not the very first call -- also re-checks
   * the viewport's size and sets `CB_FLAGS.REBASE` (0018 §8: "on visible, reset the frame clock,
   * re-check size, and tell the client worker to re-base interpolation"; M30 consumes the flag, this
   * milestone only sets it). Idempotent while already running. */
  resume(): void
  /** Stops the rAF loop (0018 §8: "on hidden, stop rAF"). Idempotent. */
  pause(): void
  /** Runs exactly one iteration of the phase list, synchronously. Production only ever calls
   * `resume`/`pause`; `engine/test` and every browser test here drive frames with this instead of
   * racing `requestAnimationFrame` (the same "stepped, not real time" discipline `engine/test.
   * stepFrame` already uses for the worker side, Non-scope). `tMs`, when given, is used as
   * `cameraState.frameTimeMs` directly instead of reading the clock (Deviations, fix round 2): the
   * production path (`resume()`'s own `frame(tMs)`, below) always has one, straight from
   * `Scheduler.requestFrame`'s own callback argument -- a real `DOMHighResTimeStamp` under
   * `systemScheduler`, no `clock.now()` call at all. Omitted only by a direct manual `tick()` call
   * (`engine/test`, fakes-only unit tests): falls back to the resync clock in that case. */
  tick(tMs?: number): FrameTickResult
  /** Cumulative bytes the upload phase has drained (`UploadDrain.bytesTotal`): the bench HUD's
   * GPU-upload counter (M36), read per frame as a difference. A plain read, no allocation. */
  uploadBytes(): number
}

const noop = (): void => {}
/** What `tick()` returns while there is no device: nothing was uploaded. One shared object, never
 * mutated (`.claude/rules/hot-paths.md`). */
const NO_UPLOAD: FrameTickResult = { uploadBytes: 0, uploadRecords: 0 }
const noopPhase = (_phase: FramePhase): void => {}

// M15d: `opts.clock.now()` used to be read fresh every `tick()`
// -- a fractional double, boxed as a new `HeapNumber` on every read (the same defect class 0030
// fixed on the sim worker; measured on `test/client.ts`'s own `stepFrame`, which drives this same
// camera-block phase in every zero-GC page: ~11.96 B/frame, Deviations). Fix round 2 (Deviations,
// coordinator correction): the production rAF path never needs to read the clock at all --
// `Scheduler.requestFrame(cb: (tMs: number) => void)` already delivers a real timestamp to `frame`
// below, so `tick(tMs)` assigns it straight to `cameraState.frameTimeMs`, no call and no box,
// stronger than amortising one. Measured (Deviations) that assigning an already-in-hand double
// allocates nothing, on `device.html`'s real `createRealFrameLoop` (`systemClock`/
// `systemScheduler`, real `requestAnimationFrame`) -- the one production page this milestone did
// not have a zero-GC page to measure against otherwise. `RESYNC_FRAMES` (`createResyncingClock`,
// `clock.ts`) stays only as `tick()`'s own fallback for a caller with no `tMs` in hand (a direct
// manual `tick()` call -- `engine/test`, fakes-only unit tests); `FRAME_MS` is that fallback's own
// nominal per-call duration, never used on the real rAF path any more.
const RESYNC_FRAMES = 30
const FRAME_MS = 1000 / 60

export function createFrameLoop(opts: FrameLoopOptions): FrameLoop {
  const budget = opts.uploadBudgetBytes ?? DEFAULT_UPLOAD_BUDGET_BYTES
  const onCamera = opts.onCamera ?? noop
  const onOverlay = opts.onOverlay ?? noop
  const onUi = opts.onUi ?? noop
  const onPhase = opts.onPhase ?? noopPhase
  const consumer = new RingConsumer(opts.client.uploadRing)
  const drain = createUploadDrain(consumer, opts.renderer, {
    sabWriteTextureOk: opts.sabWriteTextureOk ?? false,
  })
  // M37b: `null` while the host has no device. `viewportRef` keeps the last renderer's `Viewport`
  // object so the camera block still gets a size during an outage.
  let renderer: TerrainRenderer | null = opts.renderer
  let viewportRef: Viewport = opts.renderer.viewport
  if (opts.gpu) {
    opts.gpu.onChange((next) => {
      if (next === null) {
        renderer = null
        return
      }
      opts.viewport?.setRenderer(next.renderer)
      drain.setRenderer(next.renderer, next.device.sabWriteTextureOk)
      renderer = next.renderer
      viewportRef = next.renderer.viewport
    })
  }
  const frameClock = createResyncingClock(opts.clock, RESYNC_FRAMES)
  let handle = -1
  let running = false
  let everResumed = false
  // M29 Scope ("Reveal gate"): one reused object,
  // mutated in place every frame (`.claude/rules/hot-paths.md`: no per-frame literal) -- `opts.
  // revealed` omitted keeps `reveal` permanently `true`, so `TerrainRenderer.draw`'s own default
  // ("no second argument" for every pre-existing caller) is what every page without this hook
  // still effectively gets.
  const drawOpts = { reveal: true }

  function currentTarget(): GPUTexture | GPUTextureView {
    return typeof opts.target === 'function' ? opts.target() : opts.target
  }

  function tick(tMs?: number): FrameTickResult {
    opts.viewport?.applyPending() // M09b: before every other phase, at most once per frame
    onPhase('acquire')
    opts.client.pick.acquire() // M18: the newest DrawList slot, once
    onPhase('camera')
    onCamera() // camera (no-op until M11)
    opts.client.cameraState.frameTimeMs = tMs ?? frameClock.next(FRAME_MS)
    // M17 ( steps 4-6): the real device-pixel viewport size,
    // straight off `renderer.viewport` (already refreshed this tick by `applyPending()`, above,
    // before the `camera` phase) -- plain number assignments, no allocation
    // (`.claude/rules/hot-paths.md`), the same pattern `frameTimeMs` just used on the line above.
    opts.client.cameraState.viewportPxW = viewportRef.widthPx
    opts.client.cameraState.viewportPxH = viewportRef.heightPx
    onPhase('writeCamera')
    opts.client.writeCameraAndWake() // writeCamera: writeCameraBlock + CB_FRAME_REQ + wake
    if (renderer === null) {
      // M37b: no device (0018 §8). The upload ring is not drained (the refill after the rebuild
      // takes it under the byte budget), nothing is encoded or submitted; the canvas keeps its last
      // presented frame. Overlay and UI keep running.
      onPhase('overlay')
      onOverlay()
      onPhase('ui')
      onUi()
      return NO_UPLOAD
    }
    onPhase('upload')
    const stats = drain.drain(budget) // upload
    onPhase('render')
    renderer.writeFrameUniform(renderer.frameUniform)
    drawOpts.reveal = opts.revealed ? opts.revealed() : true
    renderer.draw(currentTarget(), drawOpts) // render
    onPhase('overlay')
    onOverlay()
    onPhase('ui')
    onUi()
    return { uploadBytes: stats.bytes, uploadRecords: stats.records }
  }

  function frame(tMs: number): void {
    if (!running) return
    tick(tMs)
    handle = opts.scheduler.requestFrame(frame)
  }

  return {
    resume() {
      if (running) return
      if (everResumed) {
        // 0018 §8: not the very first `resume()` (an ordinary start, not a return from
        // backgrounding) -- that would fire a spurious rebase at startup.
        opts.viewport?.invalidate()
        opts.client.setFlags(FLAG_REBASE)
      }
      everResumed = true
      running = true
      handle = opts.scheduler.requestFrame(frame)
    },
    pause() {
      running = false
      opts.scheduler.cancelFrame(handle)
    },
    tick,
    uploadBytes: drain.bytesTotal,
  }
}

export type RealFrameLoopOptions = {
  client: Client
  renderer: TerrainRenderer
  /** M37b: the host the renderer came from; the loop follows it through a device loss (see
   * `FrameLoopOptions.gpu`) and reconfigures the canvas for each rebuilt device. */
  gpu?: GpuHost
  canvas: HTMLCanvasElement
  clock: Clock
  scheduler: Scheduler
  /** `ClientOptions.render`, threaded straight through (Seams, Provides): `scale`/`scaleCap` reach
   * the viewport controller, `neighbourCutoffPx` is written once into `renderer.frameUniform`
   * (`terrain.wgsl` already consumes the field; M09 defaulted it to 0, "always read neighbours"). */
  render?: RenderOptions
  /** Production passes `device.limits.maxTextureDimension2D` (0018 §7); a test passes a small
   * number directly so a clamp test never allocates a huge real texture. */
  maxTextureDimension2D: number
  doc?: Document
  /** M09b step 7 (`device.html`): the page's own scripted camera (Non-scope: "the device page uses
   * scripted motion via `autopan` until [M11]"), forwarded straight to `createFrameLoop`. */
  onCamera?(): void
  /** M18 step 8 (`device.html?anchors=50`): forwarded straight to
   * `createFrameLoop`, the first real page to need it (`FrameLoopOptions.onOverlay`'s own doc
   * comment: "a page's own concern", default no-op). */
  onOverlay?(): void
  /** M29 Scope ("Reveal gate"): forwarded straight to
   * `createFrameLoop` (see its own doc comment). */
  revealed?(): boolean
  /** M09b step 6: forwarded straight to `createFrameLoop` (see its own doc comment). */
  onPhase?(phase: FramePhase): void
  /** The canvas context's format and usage, applied on the first configure and on every rebuild.
   * Default: `getPreferredCanvasFormat()` and `RENDER_ATTACHMENT`. The terrain pipeline's colour
   * format (`GpuResourcesOptions.colorFormat`) must equal `format`. A page that probes the canvas
   * texture adds `COPY_SRC` to `usage`. */
  canvasConfig?: { format?: GPUTextureFormat; usage?: GPUTextureUsageFlags }
  /** Fix round 1 (M09b Deviations): forwarded straight to
   * `createViewportController`'s own `test.observeReal` -- see that option's own doc comment.
   * Never set by a production caller. */
  test?: { observeReal?: boolean }
}

export type RealFrameLoop = {
  loop: FrameLoop
  viewport: ViewportController
  /** The canvas context configured for the current device (replaced after a device rebuild). */
  readonly ctx: GPUCanvasContext
  dispose(): void
}

/**
 * M09b (Scope: "Wire `frame-loop.ts`'s `createFrameLoop`
 * ... to a real canvas"): the one place a page assembles a real `Client`/`TerrainRenderer`/canvas
 * into a running `FrameLoop`. Configures the canvas's WebGPU context once, wires `ClientOptions.
 * render` into both the viewport controller and the frame uniform, and draws into
 * `ctx.getCurrentTexture()` every frame (a fresh texture each frame, unlike a fixed offscreen
 * target).
 */
export function createRealFrameLoop(opts: RealFrameLoopOptions): RealFrameLoop {
  let ctx = configureCanvasContext(opts.canvas, opts.renderer.device, opts.canvasConfig)
  const neighbourCutoffPx = opts.render?.neighbourCutoffPx ?? 0
  opts.renderer.frameUniform.neighbourCutoffPx = neighbourCutoffPx
  // `exactOptionalPropertyTypes`: an optional key set to `undefined` is not the same as an absent
  // key, so `render`/`doc` are added only when actually given, rather than built as one literal with
  // `opts.render`/`opts.doc` spliced straight in.
  const viewportOpts: Parameters<typeof createViewportController>[2] = {
    maxTextureDimension2D: opts.maxTextureDimension2D,
  }
  if (opts.render !== undefined) viewportOpts.render = opts.render
  if (opts.doc !== undefined) viewportOpts.doc = opts.doc
  if (opts.test !== undefined) viewportOpts.test = opts.test
  const viewport = createViewportController(opts.canvas, opts.renderer, viewportOpts)
  const frameLoopOpts: FrameLoopOptions = {
    clock: opts.clock,
    scheduler: opts.scheduler,
    client: opts.client,
    renderer: opts.renderer,
    target: () => ctx.getCurrentTexture(),
    viewport,
  }
  if (opts.gpu !== undefined) frameLoopOpts.gpu = opts.gpu
  if (opts.onCamera !== undefined) frameLoopOpts.onCamera = opts.onCamera
  if (opts.onOverlay !== undefined) frameLoopOpts.onOverlay = opts.onOverlay
  if (opts.revealed !== undefined) frameLoopOpts.revealed = opts.revealed
  if (opts.onPhase !== undefined) frameLoopOpts.onPhase = opts.onPhase
  // Registered before the loop's own subscription (`createFrameLoop`), so by the time the loop
  // swaps in the rebuilt renderer the canvas is already configured for the new device.
  const unsubscribe = opts.gpu?.onChange((next) => {
    if (next === null) return
    ctx = configureCanvasContext(opts.canvas, next.device.device, opts.canvasConfig)
    next.renderer.frameUniform.neighbourCutoffPx = neighbourCutoffPx
  })
  const loop = createFrameLoop(frameLoopOpts)
  return {
    loop,
    viewport,
    get ctx() {
      return ctx
    },
    dispose() {
      unsubscribe?.()
      loop.pause()
      viewport.dispose()
    },
  }
}

/** 0018 §8 backgrounding, wired to the real `document`: `hidden` -> `pause()`, `visible` ->
 * `resume()` (which is what actually re-checks size and sets `CB_FLAGS.REBASE`, above). Returns a
 * disposer. Not used by this milestone's own tests (`engine/test.setVisibility` drives `pause`/
 * `resume` directly -- headless Chromium's `document.hidden` cannot be forced from outside the page
 * in a way this harness can reach); wired into a real page by whichever one first owns `document`
 * (`device.html`, M09b step 7). */
export function attachVisibilityHandling(loop: FrameLoop, doc: Document = document): () => void {
  function onVisibilityChange(): void {
    if (doc.hidden) loop.pause()
    else loop.resume()
  }
  doc.addEventListener('visibilitychange', onVisibilityChange)
  return () => doc.removeEventListener('visibilitychange', onVisibilityChange)
}
