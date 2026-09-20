// The single rAF callback as a fixed, ordered phase list (docs/decisions/0018-renderer.md §1;
// docs/plan/09-renderer-terrain.md Scope): `camera` (no-op until M11) -> `writeCamera`
// (`Client.writeCameraAndWake`, Deviations) -> `upload` (`render/upload.ts`'s byte-budgeted drain)
// -> `render` (`renderer.writeFrameUniform` + `draw`) -> `overlay` (M18) -> `ui` (M16). Non-scope
// of this milestone: real camera integration (M11: `onCamera` is a no-op by default, a caller
// mutates `client.cameraState` before a tick the same way `engine/test.setCamera` does today) and
// the canvas lifecycle (M09b: `target` is whatever offscreen or canvas texture the caller already
// owns). Everything here is created once, at `createFrameLoop` time, and `tick()`'s own body is a
// fixed sequence of calls with no per-frame closures, arrays or descriptor objects (`.claude/
// rules/hot-paths.md`).
import type { Client } from './client.js'
import type { Clock, Scheduler } from './clock.js'
import type { TerrainRenderer } from './render/terrain.js'
import { createUploadDrain, DEFAULT_UPLOAD_BUDGET_BYTES } from './render/upload.js'
import { RingConsumer } from './sab/ring.js'

/** Named, in call order (Seams, Provides: "`FrameLoop` phases by name"). */
export const FRAME_PHASES = ['camera', 'writeCamera', 'upload', 'render', 'overlay', 'ui'] as const
export type FramePhase = (typeof FRAME_PHASES)[number]

export type FrameLoopOptions = {
  clock: Clock
  scheduler: Scheduler
  client: Client
  renderer: TerrainRenderer
  /** Whatever the caller already owns: an offscreen probe target in every test here (M09b wires a
   * real canvas). */
  target: GPUTexture | GPUTextureView
  /** Default 0018 §3's 64 KiB. */
  uploadBudgetBytes?: number
  /** `RendererDevice.sabWriteTextureOk` (Planning decisions "`writeTexture` from a SAB view is
   * unverified"): forwarded to `render/upload.ts`'s own drain. Default `false` (the safe path). */
  sabWriteTextureOk?: boolean
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
  start(): void
  stop(): void
  /** Runs exactly one iteration of the phase list, synchronously. Production only ever calls
   * `start`/`stop`; `engine/test` and every browser test here drive frames with this instead of
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

  function tick(): FrameTickResult {
    onCamera() // camera (no-op until M11)
    opts.client.cameraState.frameTimeMs = opts.clock.now()
    opts.client.writeCameraAndWake() // writeCamera: writeCameraBlock + CB_FRAME_REQ + wake
    const stats = drain.drain(budget) // upload
    opts.renderer.writeFrameUniform(opts.renderer.frameUniform)
    opts.renderer.draw(opts.target) // render
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
    start() {
      if (running) return
      running = true
      handle = opts.scheduler.requestFrame(frame)
    },
    stop() {
      running = false
      opts.scheduler.cancelFrame(handle)
    },
    tick,
  }
}
