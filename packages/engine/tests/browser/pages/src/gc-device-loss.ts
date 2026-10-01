// `gc-device-loss.html`'s script (docs/plan/37b-device-loss.md step 5, Tests added: `device loss then
// zero-GC window @slow`): `gc-connected-terrain.ts`'s page (a real local connected `fx-puts` client
// panning under a real renderer) with the renderer owned by a `GpuHost`. `window.__lossThenGc.
// loseAndRecover()` loses the device, steps frames through the outage, waits for the rebuild and
// steps through the refill; the spec calls it once (after `allowDeviceLoss`) and only then measures
// the standard M04 window, so the window sees the *rebuilt* device generation on main and the client
// worker after `RENDERER_RESET` was answered (0016 §2: the loss itself is outside the window).
import { createClient } from '../../../../src/client.ts'
import { createGpuHost } from '../../../../src/render/gpu-host.ts'
import type { GpuResources } from '../../../../src/render/gpu-resources.ts'
import { createUploadDrain, DEFAULT_UPLOAD_BUDGET_BYTES } from '../../../../src/render/upload.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import {
  asHarness,
  parkWorkers,
  pumpUntilLive,
  stepSimTickSync,
} from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { attachGpuHost, loseDevice, untilRendererRecovered } from '../../../../src/test/render.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __lossThenGc?: { loseAndRecover(): Promise<{ generation: number; outageFrames: number }> }
  }
}

const wasm = await fixtureWasm('puts')
const canvas = document.createElement('canvas')
const clock = createManualClock()

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'gc-device-loss', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  test: { clock, flags: { gcHook: true } },
})
const gpu = await createGpuHost({
  colorFormat: 'rgba8unorm',
  tilesUrl: '/terrain/tiles.json',
  client,
  clock,
})
attachGpuHost(client, gpu)
await pumpUntilLive(client)
const harness = asHarness(client)
await parkWorkers(client)

const { cameraState } = client
cameraState.centreX = 0
cameraState.centreY = 8
cameraState.tilesAcross = 32
cameraState.halfExtentTilesX = 24
cameraState.halfExtentTilesY = 24
const PAN_TILES_PER_SECOND = 8
const PAN_TILES_PER_FRAME = PAN_TILES_PER_SECOND / 60
cameraState.velocityX = PAN_TILES_PER_SECOND

const first = gpu.current as GpuResources
const uploadDrain = createUploadDrain(new RingConsumer(client.uploadRing), first.renderer, {
  sabWriteTextureOk: first.device.sabWriteTextureOk,
})

function makeTarget(r: GpuResources): GPUTexture {
  return r.device.device.createTexture({
    size: [64, 64],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.TEXTURE_BINDING,
  })
}
// Reused every frame (`.claude/rules/hot-paths.md`); one per device generation.
let target: GPUTexture | null = makeTarget(first)
let renderer: GpuResources['renderer'] | null = first.renderer
first.renderer.frameUniform.viewportPxW = 64
first.renderer.frameUniform.viewportPxH = 64
gpu.onChange((r) => {
  if (!r) {
    target = null
    renderer = null
    return
  }
  uploadDrain.setRenderer(r.renderer, r.device.sabWriteTextureOk)
  r.renderer.frameUniform.viewportPxW = 64
  r.renderer.frameUniform.viewportPxH = 64
  target = makeTarget(r)
  renderer = r.renderer
})

installGcPage(harness, {
  adapter: first.device.adapterInfo,
  drive() {
    cameraState.centreX += PAN_TILES_PER_FRAME
    harness.stepFrame(1000 / 60)
    stepSimTickSync(client, 1)
    harness.stepTick()
    if (renderer === null || target === null) return
    uploadDrain.drain(DEFAULT_UPLOAD_BUDGET_BYTES)
    renderer.writeFrameUniform(renderer.frameUniform)
    renderer.draw(target)
  },
})

window.__lossThenGc = {
  async loseAndRecover() {
    await harness.resume()
    await loseDevice(client)
    let outageFrames = 0
    // The outage: frames keep stepping (camera, sim, worker) with no device.
    for (let i = 0; i < 4; i++) {
      harness.stepFrame(1000 / 60)
      stepSimTickSync(client, 1)
      harness.stepTick()
      outageFrames += 1
    }
    const generation = await untilRendererRecovered(client)
    // Refill: the worker answers `RENDERER_RESET` at its next wake, the drain paces the upload.
    for (let i = 0; i < 240; i++) {
      cameraState.centreX += PAN_TILES_PER_FRAME
      harness.stepFrame(1000 / 60)
      stepSimTickSync(client, 1)
      harness.stepTick()
      const r = renderer
      if (r !== null && target !== null) {
        uploadDrain.drain(DEFAULT_UPLOAD_BUDGET_BYTES)
        r.writeFrameUniform(r.frameUniform)
        r.draw(target)
      }
    }
    await harness.park()
    return { generation, outageFrames }
  },
}

window.__pageReady = true
