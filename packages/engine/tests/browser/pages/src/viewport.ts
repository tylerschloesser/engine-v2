// `viewport.html`: the host for `viewport.spec.ts` (docs/plan/09b-terrain-art-and-lifecycle.md,
// steps 4-5). A real device, a real `TerrainRenderer` (no tile art loaded: these tests assert canvas
// size/DPR/render-scale/draw-call timing, never pixel content -- the shader's own correctness is
// `terrain-readback.spec.ts`'s job, unchanged by this milestone) and a real `createClient()` over
// `fx-terrain`, wired through `frame-loop.ts`'s `createRealFrameLoop` -- the first page to drive
// `createFrameLoop` against a real canvas (docs/plan/09-renderer-terrain.md Deviations, "Notes for
// later briefs": "M09b's resize observer is the first real writer of `viewport`").
import type { Client } from '../../../../src/client.ts'
import { createClient } from '../../../../src/client.ts'
import type { Scheduler } from '../../../../src/clock.ts'
import type { RealFrameLoop } from '../../../../src/frame-loop.ts'
import { createRealFrameLoop } from '../../../../src/frame-loop.ts'
import type { RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import type { TerrainRenderer } from '../../../../src/render/terrain.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { createManualClock, type ManualClock } from '../../../../src/test/manual-clock.ts'
import {
  attachViewportTestHooks,
  clearRebaseFlag as clearRebaseFlagHook,
  rebaseFlagSet as rebaseFlagSetHook,
  setViewport as setViewportHook,
  setVisibility as setVisibilityHook,
} from '../../../../src/test/viewport.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
  }
}

let device: RendererDevice | undefined
let renderer: TerrainRenderer | undefined
let client: Client | undefined
let real: RealFrameLoop | undefined
let canvasEl: HTMLCanvasElement | undefined
let clock: ManualClock | undefined
let requestFrameCalls = 0

function requireClient(): Client {
  if (!client) throw new Error('__viewport.init() must be called first')
  return client
}

window.__viewport = {
  async init(opts) {
    canvasEl = document.createElement('canvas')
    // 0 CSS px: nothing here relies on the real `ResizeObserver`'s own report (every test drives
    // size through `setViewport`/`forceSize` instead, which is what makes these tests deterministic
    // in a headless browser that cannot really resize a window or change display DPI) -- starting
    // at 0 just keeps the *real* observer's own, unused, initial report harmless either way.
    document.body.appendChild(canvasEl)

    device = await initDevice()
    const gpu = (navigator as unknown as { gpu: GPU }).gpu
    renderer = await createTerrainRenderer(device.device, {
      colorFormat: gpu.getPreferredCanvasFormat(),
      viewProbePasses: device.viewProbePasses,
      checkCompilation: device.checkCompilation,
    })

    const wasm = await fixtureWasm('terrain')
    clock = createManualClock()
    // `exactOptionalPropertyTypes`: `render` is added only when actually given, not set to
    // `undefined` (a real absence, not a value of `undefined`).
    const clientOpts: Parameters<typeof createClient>[0] = {
      canvas: canvasEl,
      wasm,
      host: { kind: 'remote', url: 'ws://unused.invalid' },
      genWorkers: 1,
      test: { clock, flags: {} },
    }
    if (opts?.render !== undefined) clientOpts.render = opts.render
    client = createClient(clientOpts)
    await client.ready

    requestFrameCalls = 0
    const mc = clock
    // 0020 §3: browser tests never use real `requestAnimationFrame` pacing -- this counts
    // `requestFrame` calls and still delegates to the manual clock's own queue, so `frame(dtMs)`
    // below can run whichever callback `resume()` most recently registered (`lifecycle: hidden
    // stops visible rebases` proves the *count* stops growing while paused, real `Scheduler` wiring
    // and all, without a real animation frame ever firing).
    const scheduler: Scheduler = {
      setTimer: (cb, ms) => mc.setTimer(cb, ms),
      clearTimer: (id) => mc.clearTimer(id),
      requestFrame: (cb) => {
        requestFrameCalls += 1
        return mc.requestFrame(cb)
      },
      cancelFrame: (id) => mc.cancelFrame(id),
    }

    const realOpts: Parameters<typeof createRealFrameLoop>[0] = {
      client,
      renderer,
      canvas: canvasEl,
      clock,
      scheduler,
      maxTextureDimension2D: opts?.maxTextureDimension2D ?? 8192,
    }
    if (opts?.render !== undefined) realOpts.render = opts.render
    real = createRealFrameLoop(realOpts)
    attachViewportTestHooks(client, { viewport: real.viewport, loop: real.loop })

    return { adapterInfo: device.adapterInfo }
  },

  setViewport(cssWidth, cssHeight, dpr) {
    setViewportHook(requireClient(), { cssWidth, cssHeight, dpr })
  },

  tick() {
    return (real as RealFrameLoop).loop.tick()
  },

  setViewportAndTick(cssWidth, cssHeight, dpr) {
    setViewportHook(requireClient(), { cssWidth, cssHeight, dpr })
    return (real as RealFrameLoop).loop.tick()
  },

  frame(dtMs) {
    ;(clock as ManualClock).frame(dtMs)
  },

  setVisibility(state) {
    setVisibilityHook(requireClient(), state)
  },

  rebaseFlagSet() {
    return rebaseFlagSetHook(requireClient())
  },

  clearRebaseFlag() {
    clearRebaseFlagHook(requireClient())
  },

  canvasSize() {
    const c = canvasEl as HTMLCanvasElement
    return { width: c.width, height: c.height }
  },

  viewport() {
    const v = (renderer as TerrainRenderer).viewport
    return { widthPx: v.widthPx, heightPx: v.heightPx, dpr: v.dpr, renderScale: v.renderScale }
  },

  drawCalls() {
    return (renderer as TerrainRenderer).drawCalls()
  },

  requestFrameCalls() {
    return requestFrameCalls
  },

  neighbourCutoffPx() {
    return (renderer as TerrainRenderer).frameUniform.neighbourCutoffPx
  },

  errors() {
    return device ? device.errors() : []
  },
}

window.__pageReady = true
