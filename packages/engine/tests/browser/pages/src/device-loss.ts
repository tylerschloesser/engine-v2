// `device-loss.html` (docs/plan/37b-device-loss.md): the real-client host for `device-loss.spec.ts`.
// `fx-terrain` (Gen + Client roles) behind a `GpuHost`, one `createFrameLoop` driving the production
// phase list over `gpu`, a manual clock and an offscreen `rgba8unorm` target (a pixel probe needs
// that format; a real canvas would need the preferred one). Every step is stepped, never real rAF:
// `step(dtMs)` is `stepFrame` (lockstep with the client worker) followed by one `loop.tick()`.
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import { createFrameLoop } from '../../../../src/frame-loop.ts'
import { createGpuHost, type GpuHost } from '../../../../src/render/gpu-host.ts'
import type { GpuResources } from '../../../../src/render/gpu-resources.ts'
import { createViewportController } from '../../../../src/render/viewport.ts'
import { CB_FRAME_REQ, W_ACK, WORKER_CLIENT, workerWord } from '../../../../src/sab/control.ts'
import { stepFrame as clientStepFrame } from '../../../../src/test/client.ts'
import { stats as genStats } from '../../../../src/test/gen.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import {
  attachGpuHost,
  loseDevice,
  readPixels,
  renderTo,
  untilRendererRecovered,
} from '../../../../src/test/render.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
  }
}

type Client = ReturnType<typeof createClient>
type FrameLoopT = ReturnType<typeof createFrameLoop>
type ProbeCamera = Parameters<GpuResources['renderer']['writeFrameUniform']>[0]

let client: Client | undefined
let host: GpuHost | undefined
let loop: FrameLoopT | undefined
let errorsSeen: string[] = []
let anchorEl: HTMLElement | undefined
let probeCamera: ProbeCamera | undefined
let targetOwner: GpuResources | null = null
let target: GPUTexture | undefined
let ticks = 0
let ticksWithoutDevice = 0

function requireClient(): Client {
  if (!client) throw new Error('__deviceLoss.init() must be called first')
  return client
}

function requireLoop(): FrameLoopT {
  if (!loop) throw new Error('__deviceLoss.init() must be called first')
  return loop
}

function requireHost(): GpuHost {
  if (!host) throw new Error('__deviceLoss.init() must be called first')
  return host
}

window.__deviceLoss = {
  async init(opts) {
    const wasm = await fixtureWasm('terrain')
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:256px;height:256px'
    document.body.appendChild(canvas)
    const clock = createManualClock()
    client = createClient({
      canvas,
      wasm,
      host: { kind: 'remote', url: 'ws://unused.invalid' },
      genWorkers: 1,
      assets: { tiles: '/terrain/tiles.json' },
      test: { clock, flags: { netNoDial: true } },
    })
    await client.ready
    const c = client
    host = await createGpuHost({
      colorFormat: 'rgba8unorm',
      tilesUrl: '/terrain/tiles.json',
      client: c,
      clock,
    })
    attachGpuHost(c, host)
    const gpu = host
    const first = gpu.current as GpuResources
    // Every device generation's probe errors, kept on the page (`uncapturederror` per device).
    const collect = (r: GpuResources | null): void => {
      if (r) errorsSeen.push(...r.device.errors())
    }
    errorsSeen = []
    gpu.onChange((r) => {
      collect(r)
    })
    const viewport = createViewportController(canvas, first.renderer, {
      maxTextureDimension2D: first.device.device.limits.maxTextureDimension2D,
      test: { observeReal: false },
    })
    viewport.forceSize(opts?.cssSize ?? 256, opts?.cssSize ?? 256, 1)
    const probeFrame = (): void => {
      const r = gpu.current
      if (r && probeCamera) r.renderer.writeFrameUniform(probeCamera)
    }
    loop = createFrameLoop({
      clock,
      scheduler: clock,
      client: c,
      renderer: first.renderer,
      gpu,
      viewport,
      target: () => {
        const r = gpu.current as GpuResources
        if (targetOwner !== r) {
          targetOwner = r
          target = r.device.device.createTexture({
            size: [64, 16],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          })
        }
        return target as GPUTexture
      },
      onCamera: probeFrame,
      onOverlay: () => c.overlay.update(),
    })
    return { adapterInfo: first.device.adapterInfo }
  },

  setCamera(x, y, tilesAcross) {
    const c = requireClient()
    c.cameraState.centreX = x
    c.cameraState.centreY = y
    c.cameraState.tilesAcross = tilesAcross
  },

  setHalfExtent(x, y) {
    const c = requireClient()
    c.cameraState.halfExtentTilesX = x
    c.cameraState.halfExtentTilesY = y
  },

  setProbeCamera(v) {
    probeCamera = {
      camTileX: v.camTileX,
      camTileY: v.camTileY,
      camFracX: v.camFracX,
      camFracY: v.camFracY,
      viewportPxW: v.viewportPxW,
      viewportPxH: v.viewportPxH,
      tilesPerPx: v.tilesPerPx,
      seed: 0,
      cursorTileX: 0,
      cursorTileY: 0,
      cursorValid: 0,
      neighbourCutoffPx: 0,
    }
  },

  /** Lockstep one frame with the worker, then one production `tick()` (budgeted upload drain,
   * draw while a device exists). */
  step(dtMs) {
    const c = requireClient()
    const gpu = requireHost()
    clientStepFrame(c, dtMs)
    ticks += 1
    if (gpu.current === null) ticksWithoutDevice += 1
    const r = requireLoop().tick()
    return { uploadBytes: r.uploadBytes, uploadRecords: r.uploadRecords }
  },

  /** Steps until nothing is generating or uploading for a streak of frames. */
  async idle() {
    const c = requireClient()
    const l = requireLoop()
    let quietStreak = 0
    for (let i = 0; i < 4000; i++) {
      clientStepFrame(c, 1000 / 60)
      const r = l.tick()
      const s = await genStats(c)
      const quiet = s.pending === 0 && s.inFlight === 0 && r.uploadRecords === 0
      quietStreak = quiet ? quietStreak + 1 : 0
      if (quietStreak >= 8) return
    }
    throw new Error('__deviceLoss.idle: never reached a quiet steady state')
  },

  async loseDevice() {
    await loseDevice(requireClient())
  },

  /** Resolves with the rebuild count once no rebuild is in flight. */
  async untilRecovered() {
    return untilRendererRecovered(requireClient())
  },

  hasDevice() {
    return requireHost().current !== null
  },

  async renderAndRead(width, height) {
    const c = requireClient()
    renderTo(c, { width, height })
    const pixels = await readPixels(c)
    return { width: pixels.width, height: pixels.height, data: Array.from(pixels.data) }
  },

  /** Cumulative bytes the frame loop's drain applied (`FrameLoop.uploadBytes`). */
  uploadBytesTotal() {
    return requireLoop().uploadBytes()
  },

  /** `W_ACK` of the client worker, `CB_FRAME_REQ`, and the camera block's seq word. */
  controlWords() {
    const h = clientTestHandle(requireClient())
    return {
      ack: Atomics.load(h.control.words, workerWord(WORKER_CLIENT, W_ACK)),
      req: Atomics.load(h.control.words, CB_FRAME_REQ),
      cameraSeq: Atomics.load(h.cameraWriter.seqWord(), 0),
    }
  },

  /** Anchors one element at world `(x, y)` (`client.overlay.anchor`) and returns nothing; the
   * loop's `overlay` phase keeps it positioned. */
  anchor(x, y) {
    const el = document.createElement('div')
    el.style.cssText = 'width:4px;height:4px;background:red'
    document.body.appendChild(el)
    requireClient().overlay.anchor(el, x, y)
    anchorEl = el
  },

  anchorRect() {
    const r = (anchorEl as HTMLElement).getBoundingClientRect()
    return { x: r.x, y: r.y }
  },

  counters() {
    return { ticks, ticksWithoutDevice, generation: requireHost().generation }
  },

  errors() {
    const gpu = requireHost()
    return [...errorsSeen, ...(gpu.current ? gpu.current.device.errors() : [])]
  },
}

window.__pageReady = true
