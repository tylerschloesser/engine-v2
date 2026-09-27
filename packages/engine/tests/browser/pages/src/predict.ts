// `predict.html`: a real, connected `createClient()` local topology over `fx-predict`
// (docs/plan/26-prediction-rendering-and-clocks.md steps 4-6, `prediction-no-flicker`) -- the
// manual clock/renderer/GPU-readback wiring is `connected-terrain.ts`'s own (`overlay_tile_
// reaches_screen`'s precedent): no `createRealFrameLoop`/viewport at all, since this page's own
// tests drive everything through explicit `__predictAdvance`/`__predictRenderAndRead` calls, never a real
// `requestAnimationFrame` -- there is no background render loop to race a probe's own
// `writeFrameUniform` between two `page.evaluate` calls the way M16 found on a *real* frame loop.
import type { Client } from '../../../../src/client.ts'
import { createClient } from '../../../../src/client.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import type { RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import type { FrameUniformValues, TerrainRenderer } from '../../../../src/render/terrain.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { createUploadDrain, type UploadDrain } from '../../../../src/render/upload.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import { pumpUntilLive, resumeWorkers, stepFrame, stepTick } from '../../../../src/test/client.ts'
import { createManualClock, type ManualClock } from '../../../../src/test/manual-clock.ts'
import { readPixels, renderTo } from '../../../../src/test/render.ts'
import { fixtureWasm } from './fixture-wasm.ts'

/** `Client.clock()`'s own return shape (`client.ts`'s `ClockSnapshot`), copied here rather than
 * imported: this page's own `window.__predictClock` re-exposes it verbatim to the spec file. */
type ClockSnapshot = {
  authoritative: number
  predicted: number
  ticksPerSecond: number
  tickFraction: number
}

declare global {
  interface Window {
    __pageReady?: true
    __predictInit?: () => Promise<{ adapterInfo: unknown }>
    /** `fx_predict::Action::Paint { tile, base }` (docs/plan/26-...md step 3): JSON-encodes and
     * dispatches through the real, production `Client.dispatch` -- never a test backdoor. */
    __predictDispatchPaint?: (x: number, y: number, base: number) => number
    /** Moves the client's own camera *state* (never sent until the next `__predictAdvance`'s own
     * `stepFrame`, `connected-terrain.ts`'s own precedent), so the host's subscription covers the
     * anchor tile a test probes. */
    __predictSetCamera?: (x: number, y: number, tilesAcross: number) => void
    /** One `resumeWorkers` + `stepFrame` + `stepTick(n)` + a full upload-ring drain, the same
     * shape `connected-terrain.ts`'s own `__predictAdvance` uses (its own doc comment has the "drain to
     * empty, deterministically" reasoning) -- no camera parameters here, since every probe in this
     * page's own tests writes the frame uniform directly (`__predictWriteFrameUniform`), never through
     * `client.cameraState`. */
    __predictAdvance?: (ticks: number) => Promise<void>
    __predictWriteFrameUniform?: (v: FrameUniformValues) => void
    __predictRenderAndRead?: (
      width: number,
      height: number,
    ) => Promise<{ width: number; height: number; data: number[] }>
    __predictClock?: () => ClockSnapshot
    __predictErrors?: () => string[]
  }
}

let device: RendererDevice | undefined
let renderer: TerrainRenderer | undefined
let client: Client | undefined
let clock: ManualClock | undefined
let bgUploadDrain: UploadDrain | undefined

window.__predictInit = async () => {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)

  device = await initDevice()
  renderer = await createTerrainRenderer(device.device, {
    colorFormat: 'rgba8unorm',
    viewProbePasses: device.viewProbePasses,
    checkCompilation: device.checkCompilation,
  })
  const art = await loadTileArt(device.device, '/terrain/tiles.json', {
    checkCompilation: device.checkCompilation,
  })
  renderer.setTileArray(art.texture, art.gpuBytes)
  renderer.writeVisualTable(art.visualTableBytes)

  const wasm = await fixtureWasm('predict')
  clock = createManualClock()

  client = createClient({
    canvas,
    wasm,
    host: {
      kind: 'local',
      world: { worldId: 'predict-no-flicker-test', params: { seed: '1', worldgen: null } },
      connect: true,
    },
    genWorkers: 1,
    test: { clock, flags: {} },
  })
  await pumpUntilLive(client)

  const uploadConsumer = new RingConsumer(client.uploadRing)
  bgUploadDrain = createUploadDrain(uploadConsumer, renderer)
  setInterval(() => {
    for (;;) {
      const { records } = (bgUploadDrain as UploadDrain).drain(64)
      if (records === 0) break
    }
  }, 16)

  return { adapterInfo: device.adapterInfo }
}

window.__predictDispatchPaint = (x, y, base) =>
  (client as Client).dispatch({ Paint: { tile: { x, y }, base } })

window.__predictSetCamera = (x, y, tilesAcross) => {
  const c = client as Client
  c.cameraState.centreX = x
  c.cameraState.centreY = y
  c.cameraState.tilesAcross = tilesAcross
}

window.__predictAdvance = async (ticks) => {
  const c = client as Client
  await resumeWorkers(c)
  stepFrame(c, 2000)
  await stepTick(c, ticks)
  const drain = bgUploadDrain as UploadDrain
  for (;;) {
    const { records } = drain.drain(1_000_000)
    if (records === 0) break
  }
}

window.__predictWriteFrameUniform = (v) => {
  ;(renderer as TerrainRenderer).writeFrameUniform(v)
}
window.__predictRenderAndRead = async (width, height) => {
  const target = renderTo(renderer as TerrainRenderer, { width, height })
  const pixels = await readPixels(target)
  return { width: pixels.width, height: pixels.height, data: Array.from(pixels.data) }
}

window.__predictClock = () => (client as Client).clock()

window.__predictErrors = () => (device ? device.errors() : [])

window.__pageReady = true
