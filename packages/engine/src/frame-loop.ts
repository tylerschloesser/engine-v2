// The single rAF callback as a fixed, ordered phase list (docs/decisions/0018-renderer.md §1;
// docs/plan/09-renderer-terrain.md Scope): `camera` (no-op until M11) -> `writeCamera`
// (`Client.writeCameraAndWake`, Deviations) -> `upload` (`render/upload.ts`'s byte-budgeted drain)
// -> `render` (`renderer.writeFrameUniform` + `draw`) -> `overlay` (M18) -> `ui` (M16).
//
// docs/plan/09b-terrain-art-and-lifecycle.md Scope/Seams (M09b step 4): a viewport-apply step runs
// before every other phase (not a new named `FRAME_PHASES` entry -- Seams only pins the phase
// list's own name, not that it enumerates every internal step -- `renderer.onViewportChange(cb)`
// "called at most once per frame, before the `camera` phase" is satisfied by `tick()` calling
// `ViewportController.applyPending()` as its very first statement); `FrameLoop.pause()`/`resume()`
// (renamed from M09's own ad hoc `stop`/`start`, never a pinned Seam name there) drive the injected
// `Scheduler`'s rAF and are what 0018 §8's backgrounding rule actually calls. Step 5 (a later commit
// in this same milestone) adds `createRealFrameLoop`, the wiring of all this to a real canvas.
// Everything here is created once, at `createFrameLoop` time, and `tick()`'s own body is a fixed
// sequence of calls with no per-frame closures, arrays or descriptor objects (`.claude/rules/
// hot-paths.md`).
import type { Client } from './client.js'
import type { Clock, Scheduler } from './clock.js'
import type { TerrainRenderer } from './render/terrain.js'
import { createUploadDrain, DEFAULT_UPLOAD_BUDGET_BYTES } from './render/upload.js'
import type { ViewportController } from './render/viewport.js'
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

export function createFrameLoop(opts: FrameLoopOptions): FrameLoop {
  const budget = opts.uploadBudgetBytes ?? DEFAULT_UPLOAD_BUDGET_BYTES
  const onCamera = opts.onCamera ?? noop
  const onOverlay = opts.onOverlay ?? noop
  const onUi = opts.onUi ?? noop
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
    onCamera() // camera (no-op until M11)
    opts.client.cameraState.frameTimeMs = opts.clock.now()
    opts.client.writeCameraAndWake() // writeCamera: writeCameraBlock + CB_FRAME_REQ + wake
    const stats = drain.drain(budget) // upload
    opts.renderer.writeFrameUniform(opts.renderer.frameUniform)
    opts.renderer.draw(currentTarget()) // render
    onOverlay()
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
