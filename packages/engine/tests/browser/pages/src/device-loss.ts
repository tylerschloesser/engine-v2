// `device-loss.html` (docs/plan/37b-device-loss.md): the real-client host for `device-loss.spec.ts`.
// `fx-terrain` (Gen + Client roles) behind a `GpuHost`, one `createFrameLoop` driving the production
// phase list over `gpu`, a manual clock and an offscreen `rgba8unorm` target (a pixel probe needs
// that format; a real canvas would need the preferred one). Every step is stepped, never real rAF:
// `step(dtMs)` is `stepFrame` (lockstep with the client worker) followed by one `loop.tick()`.
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import {
  createFrameLoop,
  createRealFrameLoop,
  type RealFrameLoop,
} from '../../../../src/frame-loop.ts'
import { createGpuHost, type GpuHost } from '../../../../src/render/gpu-host.ts'
import type { GpuResources } from '../../../../src/render/gpu-resources.ts'
import { createViewportController } from '../../../../src/render/viewport.ts'
import { CB_FRAME_REQ, W_ACK, WORKER_CLIENT, workerWord } from '../../../../src/sab/control.ts'
import { stepFrame as clientStepFrame } from '../../../../src/test/client.ts'
import { stats as genStats } from '../../../../src/test/gen.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import {
  attachGpuHost,
  failNextAdapter,
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
type FrameLoopT = RealFrameLoop['loop']
type ProbeCamera = Parameters<GpuResources['renderer']['writeFrameUniform']>[0]

let client: Client | undefined
let host: GpuHost | undefined
let loop: FrameLoopT | undefined
let errorsSeen: string[] = []
let anchorEl: HTMLElement | undefined
let probeCamera: ProbeCamera | undefined
let real: RealFrameLoop | undefined
let ticks = 0
let ticksWithoutDevice = 0
let useCanvas = true
let canvasFormat: 'rgba8unorm' | 'bgra8unorm' = 'rgba8unorm'
let manualClock: ReturnType<typeof createManualClock> | undefined
const lostEvents: string[] = []
let adapterRequests = 0

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
    manualClock = clock
    // The canvas's preferred format: a non-preferred one costs the browser an extra internal copy
    // that fails on SwiftShader (M37b step 4). `renderTo`/`readPixels` follow the host's format.
    // SwiftShader cannot present a WebGPU canvas here: configuring one makes the browser's own
    // compositor copy fail with an `uncapturederror` and then loses the device ("A valid external
    // Instance reference no longer exists"), with no device loss of ours involved. On a fallback
    // adapter the page draws into an offscreen target instead and the canvas-path proof is skipped
    // (named local-only notice in the spec); every other check runs on both.
    const probe = await navigator.gpu.requestAdapter()
    useCanvas = probe?.info.isFallbackAdapter !== true
    canvasFormat = useCanvas
      ? (navigator.gpu.getPreferredCanvasFormat() as 'rgba8unorm' | 'bgra8unorm')
      : 'rgba8unorm'
    // Counts every `requestAdapter` the page makes (a rebuild attempt is exactly one).
    const gpuApi = navigator.gpu
    const realRequest = gpuApi.requestAdapter.bind(gpuApi)
    gpuApi.requestAdapter = (o) => {
      adapterRequests += 1
      return realRequest(o)
    }
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
    c.onRendererLost((e) => {
      lostEvents.push(e.reason)
    })
    adapterRequests = 0
    host = await createGpuHost({
      colorFormat: canvasFormat,
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
    const probeFrame = (): void => {
      const r = gpu.current
      if (r && probeCamera) r.renderer.writeFrameUniform(probeCamera)
    }
    if (useCanvas) {
      // A real canvas in the preferred format (a non-preferred one costs the browser an extra
      // internal copy) with `COPY_SRC` so the page can read the presented texture back; reconfigured
      // by `createRealFrameLoop` for each rebuilt device.
      real = createRealFrameLoop({
        clock,
        scheduler: clock,
        client: c,
        renderer: first.renderer,
        gpu,
        canvas,
        maxTextureDimension2D: first.device.device.limits.maxTextureDimension2D,
        canvasConfig: {
          format: canvasFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        },
        test: { observeReal: false },
        onCamera: probeFrame,
        onOverlay: () => c.overlay.update(),
      })
      real.viewport.forceSize(opts?.cssSize ?? 256, opts?.cssSize ?? 256, 1)
      loop = real.loop
    } else {
      const viewport = createViewportController(canvas, first.renderer, {
        maxTextureDimension2D: first.device.device.limits.maxTextureDimension2D,
        test: { observeReal: false },
      })
      viewport.forceSize(opts?.cssSize ?? 256, opts?.cssSize ?? 256, 1)
      let targetOwner: GpuResources | null = null
      let target: GPUTexture | undefined
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
    }
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

  /** One production `tick()` drawing into the canvas's own current texture, read back in the same
   * task (the presented texture is only valid until the task ends). Rows are the canvas's
   * `width` x `height` (the viewport controller sizes it). */
  async canvasRead() {
    if (!real) return null
    const r = requireLoop()
    r.tick()
    const gpu = requireHost().current as GpuResources
    const canvasTexture = (real as RealFrameLoop).ctx.getCurrentTexture()
    const pixels = await readPixels({
      device: gpu.device.device,
      texture: canvasTexture,
      width: canvasTexture.width,
      height: canvasTexture.height,
      format: canvasFormat,
    })
    return {
      width: pixels.width,
      height: pixels.height,
      data: Array.from(pixels.data.slice(0, 64 * 4)),
    }
  },

  setDrawablesEnabled(on) {
    ;(requireHost().current as GpuResources).drawables?.setEnabled(on)
  },

  drawablesEnabled() {
    return (requireHost().current as GpuResources).drawables?.isEnabled() ?? null
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

  failNextAdapter() {
    failNextAdapter(requireClient())
  },

  /** Moves the injected manual clock (the repeated-loss window reads it). */
  advanceClock(ms) {
    ;(manualClock as ReturnType<typeof createManualClock>).advance(ms)
  },

  /** The `reason` of every `client.onRendererLost` event so far. */
  rendererLostEvents() {
    return lostEvents.slice()
  },

  adapterRequests() {
    return adapterRequests
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
