// The single rAF callback as a fixed, ordered phase list (docs/decisions/0018-renderer.md §1;
// docs/plan/09-renderer-terrain.md Scope): `camera` (no-op until M11) -> `writeCamera`
// (`Client.writeCameraAndWake`, Deviations) -> `upload` (`render/upload.ts`'s byte-budgeted drain)
// -> `render` (`renderer.writeFrameUniform` + `draw`) -> `overlay` (M18) -> `ui` (M16).
//
// docs/plan/09b-terrain-art-and-lifecycle.md Scope/Seams (M09b): a viewport-apply step runs before
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
import type { Clock, Scheduler } from './clock.js'
import type { TerrainRenderer } from './render/terrain.js'
import { createUploadDrain, DEFAULT_UPLOAD_BUDGET_BYTES } from './render/upload.js'
import {
  configureCanvasContext,
  createViewportController,
  type ViewportController,
} from './render/viewport.js'
import { FLAG_REBASE } from './sab/control.js'
import { RingConsumer } from './sab/ring.js'

/** Named, in call order (Seams, Provides: "`FrameLoop` phases by name"). */
export const FRAME_PHASES = ['camera', 'writeCamera', 'upload', 'render', 'overlay', 'ui'] as const
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
  /** M09b: applied once per frame, before every other phase (`applyPending()`, before `onCamera`).
   * Optional so a fakes-only unit test (no canvas to resize) can omit it. Production always supplies
   * one (`createRealFrameLoop`, below). */
  viewport?: ViewportController
  /** M11 fills this in for real (Non-scope): mutate `client.cameraState` from input/gestures
   * before this tick's `writeCamera` phase runs. Default no-op. */
  onCamera?(): void
  /** M18 (Non-scope): default no-op. */
  onOverlay?(): void
  /** M16 (Non-scope): default no-op. */
  onUi?(): void
  /** M09b step 6 (docs/plan/09b-terrain-art-and-lifecycle.md, Tests added:
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
   * stepFrame` already uses for the worker side, Non-scope). */
  tick(): FrameTickResult
}

const noop = (): void => {}
const noopPhase = (_phase: FramePhase): void => {}

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
  let handle = -1
  let running = false
  let everResumed = false

  function currentTarget(): GPUTexture | GPUTextureView {
    return typeof opts.target === 'function' ? opts.target() : opts.target
  }

  function tick(): FrameTickResult {
    opts.viewport?.applyPending() // M09b: before every other phase, at most once per frame
    onPhase('camera')
    onCamera() // camera (no-op until M11)
    opts.client.cameraState.frameTimeMs = opts.clock.now()
    onPhase('writeCamera')
    opts.client.writeCameraAndWake() // writeCamera: writeCameraBlock + CB_FRAME_REQ + wake
    onPhase('upload')
    const stats = drain.drain(budget) // upload
    onPhase('render')
    opts.renderer.writeFrameUniform(opts.renderer.frameUniform)
    opts.renderer.draw(currentTarget()) // render
    onPhase('overlay')
    onOverlay()
    onPhase('ui')
    onUi()
    return { uploadBytes: stats.bytes, uploadRecords: stats.records }
  }

  function frame(): void {
    if (!running) return
    tick()
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
  }
}

export type RealFrameLoopOptions = {
  client: Client
  renderer: TerrainRenderer
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
  /** M09b step 6: forwarded straight to `createFrameLoop` (see its own doc comment). */
  onPhase?(phase: FramePhase): void
}

export type RealFrameLoop = {
  loop: FrameLoop
  viewport: ViewportController
  ctx: GPUCanvasContext
  dispose(): void
}

/**
 * M09b (docs/plan/09b-terrain-art-and-lifecycle.md Scope: "Wire `frame-loop.ts`'s `createFrameLoop`
 * ... to a real canvas"): the one place a page assembles a real `Client`/`TerrainRenderer`/canvas
 * into a running `FrameLoop`. Configures the canvas's WebGPU context once, wires `ClientOptions.
 * render` into both the viewport controller and the frame uniform, and draws into
 * `ctx.getCurrentTexture()` every frame (a fresh texture each frame, unlike a fixed offscreen
 * target).
 */
export function createRealFrameLoop(opts: RealFrameLoopOptions): RealFrameLoop {
  const ctx = configureCanvasContext(opts.canvas, opts.renderer.device)
  opts.renderer.frameUniform.neighbourCutoffPx = opts.render?.neighbourCutoffPx ?? 0
  // `exactOptionalPropertyTypes`: an optional key set to `undefined` is not the same as an absent
  // key, so `render`/`doc` are added only when actually given, rather than built as one literal with
  // `opts.render`/`opts.doc` spliced straight in.
  const viewportOpts: Parameters<typeof createViewportController>[2] = {
    maxTextureDimension2D: opts.maxTextureDimension2D,
  }
  if (opts.render !== undefined) viewportOpts.render = opts.render
  if (opts.doc !== undefined) viewportOpts.doc = opts.doc
  const viewport = createViewportController(opts.canvas, opts.renderer, viewportOpts)
  const frameLoopOpts: FrameLoopOptions = {
    clock: opts.clock,
    scheduler: opts.scheduler,
    client: opts.client,
    renderer: opts.renderer,
    target: () => ctx.getCurrentTexture(),
    viewport,
  }
  if (opts.onCamera !== undefined) frameLoopOpts.onCamera = opts.onCamera
  if (opts.onPhase !== undefined) frameLoopOpts.onPhase = opts.onPhase
  const loop = createFrameLoop(frameLoopOpts)
  return {
    loop,
    viewport,
    ctx,
    dispose() {
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
