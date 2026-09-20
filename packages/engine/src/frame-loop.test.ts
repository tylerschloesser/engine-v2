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
import type { TerrainRenderer } from './render/terrain.js'
import { createRing } from './sab/ring.js'

function fakeClient(): Client & { wakeCount: number } {
  const cameraState = new CameraState()
  const uploadRing = createRing(4120, 4)
  return {
    ready: Promise.resolve(),
    cameraState,
    uploadRing,
    wakeCount: 0,
    writeCameraAndWake(): number {
      this.wakeCount += 1
      return this.wakeCount
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
    drawCallTargets,
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

test('frame-loop.start_stop_drive_the_injected_scheduler', () => {
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
  loop.start()
  expect(requested).toHaveLength(1)
  // Driving the scheduler's own callback re-requests the next frame (the rAF loop shape).
  ;(requested[0] as (t: number) => void)(0)
  expect(requested).toHaveLength(2)
  loop.stop()
  expect(cancelled).toBe(1)
  // A stopped loop's own re-armed callback is a no-op (checked via `running`).
  ;(requested[1] as (t: number) => void)(0)
  expect(requested).toHaveLength(2)
})
