// `frame-loop.ts` unit coverage (docs/plan/09-renderer-terrain.md Scope, step 6): the ordered phase
// list and the `Scheduler` wiring, against fakes for `Client`/`TerrainRenderer`/`Scheduler` rather
// than a real GPU device or worker -- the real data path (residency, upload budget, one draw call)
// is proven by the browser suite's `terrain-readback.spec.ts` instead, since the lockstep
// determinism those tests need is `engine/test`'s own concern, not `frame-loop.ts`'s (Deviations
// "Steps 5-7": production's `writeCameraAndWake` is fire-and-forget, not the lockstep a lockstep
// test needs, so no browser test here drives a real `createFrameLoop`).
import { expect, test } from 'vitest'
import { CameraState } from './camera/state.js'
import type { Client } from './client.js'
import { createFrameLoop, FRAME_PHASES } from './frame-loop.js'
import { createSemanticRecognizer } from './input/semantic.js'
import type { TerrainRenderer } from './render/terrain.js'
import { FLAG_REBASE } from './sab/control.js'
import { createRing } from './sab/ring.js'

function fakeClient(): Client & { wakeCount: number; flagsSet: number } {
  const cameraState = new CameraState()
  const uploadRing = createRing(4120, 4)
  // `input` is unused by anything `frame-loop.ts` itself exercises (M11, Non-scope: wiring a real
  // recognizer is a later range's job); a real recognizer over a throwaway ring is simpler than a
  // hand-written stub of `SemanticRecognizer`'s own five methods.
  const input = createSemanticRecognizer(createRing(40, 4))
  return {
    ready: Promise.resolve(),
    cameraState,
    uploadRing,
    input,
    // M11 step 6: `Client.camera` is likewise unused by anything `frame-loop.ts` itself exercises
    // (this file's own fakes never call `onCamera`'s real production wiring), so a throwaway stub
    // is enough here too.
    camera: {
      setConstraints() {},
      moveTo() {},
      read() {},
      worldToScreen() {},
      screenToWorld() {},
      restored: false,
      setViewClamp() {},
      setFollow() {},
      tick() {},
    },
    wakeCount: 0,
    flagsSet: 0,
    // Unused by anything `frame-loop.ts` itself exercises (docs/plan/16-action-round-trip.md is a
    // main-thread/worker/ring feature this file's fakes never touch): throwaway stubs, same
    // precedent as `camera`/`input` above.
    dispatch(): number {
      throw new Error('fakeClient: dispatch not implemented')
    },
    onActionResult(): () => void {
      return () => {}
    },
    writeCameraAndWake(): number {
      this.wakeCount += 1
      return this.wakeCount
    },
    setFlags(mask: number): void {
      this.flagsSet |= mask
    },
    destroy() {},
  }
}

function fakeRenderer(): TerrainRenderer & { drawCallTargets: unknown[] } {
  const drawCallTargets: unknown[] = []
  return {
    device: {} as GPUDevice,
    writeFrameUniform() {},
    writeVisualTable() {},
    writePageChunk() {},
    writePageChunkBytes() {},
    writePageTexel() {},
    writeIndir() {},
    setTileArray() {},
    draw(target) {
      drawCallTargets.push(target)
    },
    drawCalls: () => drawCallTargets.length,
    pageSlotsUsed: () => 0,
    frameUniform: {
      camTileX: 0,
      camTileY: 0,
      camFracX: 0,
      camFracY: 0,
      viewportPxW: 0,
      viewportPxH: 0,
      tilesPerPx: 1,
      seed: 0,
      cursorTileX: 0,
      cursorTileY: 0,
      cursorValid: 0,
      neighbourCutoffPx: 0,
    },
    viewport: { widthPx: 0, heightPx: 0, dpr: 1, renderScale: 1 },
    onViewportChange() {},
    notifyViewportChange() {},
    drawCallTargets,
  }
}

/** A fake `ViewportController` (docs/plan/09b-terrain-art-and-lifecycle.md): tracks calls instead of
 * touching a real canvas/`ResizeObserver`, so `resume()`'s "re-check size" (`invalidate()`) is
 * provable against fakes alone, no browser needed. */
function fakeViewport(): {
  applyPending(): boolean
  invalidate(): void
  forceSize(): void
  dispose(): void
  invalidateCount: number
} {
  return {
    invalidateCount: 0,
    applyPending() {
      return false
    },
    invalidate() {
      this.invalidateCount += 1
    },
    forceSize() {},
    dispose() {},
  }
}

test('frame-loop.phases_named_in_order', () => {
  expect(FRAME_PHASES).toEqual(['camera', 'writeCamera', 'upload', 'render', 'overlay', 'ui'])
})

test('frame-loop.tick_calls_camera_write_upload_render_in_order', () => {
  const calls: string[] = []
  const client = fakeClient()
  const originalWake = client.writeCameraAndWake.bind(client)
  client.writeCameraAndWake = () => {
    calls.push('writeCamera')
    return originalWake()
  }
  const renderer = fakeRenderer()
  const originalDraw = renderer.draw.bind(renderer)
  renderer.draw = (t) => {
    calls.push('render')
    originalDraw(t)
  }
  const target = {} as GPUTexture
  const clock = { now: () => 0 }
  const scheduler = {
    setTimer: () => 0,
    clearTimer: () => {},
    requestFrame: () => 0,
    cancelFrame: () => {},
  }

  const loop = createFrameLoop({
    clock,
    scheduler,
    client,
    renderer,
    target,
    onCamera: () => calls.push('camera'),
    onOverlay: () => calls.push('overlay'),
    onUi: () => calls.push('ui'),
  })
  const result = loop.tick()

  expect(calls).toEqual(['camera', 'writeCamera', 'render', 'overlay', 'ui'])
  expect(result).toEqual({ uploadBytes: 0, uploadRecords: 0 })
  expect(renderer.drawCallTargets).toEqual([target])
  expect(client.wakeCount).toBe(1)
})

// M09b step 6 (docs/plan/09b-terrain-art-and-lifecycle.md, Tests added): `onPhase` (the seam
// `frame-loop.production_runs_phases_in_order`, a real-canvas browser test, drives against a real
// `Client`/`TerrainRenderer`) fires with each of `FRAME_PHASES`, in that order, once per `tick()` --
// proven here against fakes alone, the same split every other phase-order assertion in this file
// uses.
test('frame-loop.onPhase_called_with_each_FRAME_PHASE_in_order', () => {
  const seen: string[] = []
  const loop = createFrameLoop({
    clock: { now: () => 0 },
    scheduler: {
      setTimer: () => 0,
      clearTimer: () => {},
      requestFrame: () => 0,
      cancelFrame: () => {},
    },
    client: fakeClient(),
    renderer: fakeRenderer(),
    target: {} as GPUTexture,
    onPhase: (phase) => seen.push(phase),
  })
  loop.tick()
  expect(seen).toEqual(FRAME_PHASES)
})

test('frame-loop.onCamera_onOverlay_onUi_default_to_noop', () => {
  const client = fakeClient()
  const renderer = fakeRenderer()
  const loop = createFrameLoop({
    clock: { now: () => 0 },
    scheduler: {
      setTimer: () => 0,
      clearTimer: () => {},
      requestFrame: () => 0,
      cancelFrame: () => {},
    },
    client,
    renderer,
    target: {} as GPUTexture,
  })
  expect(() => loop.tick()).not.toThrow()
})

test('frame-loop.pause_resume_drive_the_injected_scheduler', () => {
  const requested: Array<(t: number) => void> = []
  let cancelled = 0
  const scheduler = {
    setTimer: () => 0,
    clearTimer: () => {},
    requestFrame: (cb: (t: number) => void) => {
      requested.push(cb)
      return requested.length
    },
    cancelFrame: () => {
      cancelled += 1
    },
  }
  const loop = createFrameLoop({
    clock: { now: () => 0 },
    scheduler,
    client: fakeClient(),
    renderer: fakeRenderer(),
    target: {} as GPUTexture,
  })
  loop.resume()
  expect(requested).toHaveLength(1)
  // Driving the scheduler's own callback re-requests the next frame (the rAF loop shape).
  ;(requested[0] as (t: number) => void)(0)
  expect(requested).toHaveLength(2)
  loop.pause()
  expect(cancelled).toBe(1)
  // A paused loop's own re-armed callback is a no-op (checked via `running`).
  ;(requested[1] as (t: number) => void)(0)
  expect(requested).toHaveLength(2)
})

// docs/plan/09b-terrain-art-and-lifecycle.md Scope/Seams: 0018 §8's backgrounding rule, against
// fakes -- no browser needed to prove `resume()` distinguishes its very first call (an ordinary
// start) from a restart after `pause()` (a real return from backgrounding).
test('frame-loop.resume_after_pause_rechecks_viewport_and_sets_rebase', () => {
  const scheduler = {
    setTimer: () => 0,
    clearTimer: () => {},
    requestFrame: () => 0,
    cancelFrame: () => {},
  }
  const client = fakeClient()
  const viewport = fakeViewport()
  const loop = createFrameLoop({
    clock: { now: () => 0 },
    scheduler,
    client,
    renderer: fakeRenderer(),
    target: {} as GPUTexture,
    viewport,
  })

  loop.resume() // the very first start: no rebase, no re-check
  expect(viewport.invalidateCount).toBe(0)
  expect(client.flagsSet).toBe(0)

  loop.pause()
  loop.resume() // a real return from backgrounding
  expect(viewport.invalidateCount).toBe(1)
  expect(client.flagsSet & FLAG_REBASE).toBe(FLAG_REBASE)

  loop.resume() // already running: idempotent, no second rebase
  expect(viewport.invalidateCount).toBe(1)
})
