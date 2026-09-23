// `input` zero-GC page (docs/plan/11-camera-and-input.md, step 7): the proof for the *whole*
// milestone's rAF path -- 600 frames of injected drag, pinch, wheel and WASD, with a `tap` every 30
// frames, against a real `createClient()` over `fx-terrain` (chunk streaming and the renderer both
// active, `gc-terrain.ts`'s own shape: a small cache forces continuous generate/upload/evict inside
// the measured window). `drive()` additionally calls `client.camera.tick(dtMs)` before `stepFrame`/
// `stepTick` -- the same `CameraIntegrator.integrate` + `input.recognize` pair `real-camera.ts`'s
// production wiring drives every rAF (`client.ts`), so this page is what actually measures that path
// under the strict per-frame budget (Notes for later briefs, the 4-5 range's own Deviations:
// "nothing in this range's own tests proves it under real allocation measurement").
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import { initDevice } from '../../../../src/render/device.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { createUploadDrain, DEFAULT_UPLOAD_BUDGET_BYTES } from '../../../../src/render/upload.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import { asHarness, parkWorkers } from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import {
  attachCameraInputTestHooks,
  injectKey,
  injectPointer,
  injectWheel,
} from '../../../../src/test/input.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    /** Budgets (Exit criteria): "`inputRing` `drops == 0`" -- read after a run, same `RingStats`
     * shape `src/test/client.ts`'s own `ringDrained` reads. */
    __gcInputRingDrops?: () => number
  }
}

const wasm = await fixtureWasm('terrain')
const clock = createManualClock()

const device = await initDevice()
const renderer = await createTerrainRenderer(device.device, {
  colorFormat: 'rgba8unorm',
  viewProbePasses: device.viewProbePasses,
  checkCompilation: device.checkCompilation,
})
const art = await loadTileArt(device.device, '/terrain/tiles.json', {
  checkCompilation: device.checkCompilation,
})
renderer.setTileArray(art.texture, art.gpuBytes)
renderer.writeVisualTable(art.visualTableBytes)
const target = device.device.createTexture({
  size: [64, 64],
  format: 'rgba8unorm',
  usage:
    GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
})

// A real CSS size (`gc-terrain.ts`'s own canvas is never appended to the document at all -- it
// never needs to be, since that page drives the camera with a hand-written formula rather than the
// real `CameraIntegrator`/`installPointerListeners`; this page's `client.camera.tick()` needs a real
// `getBoundingClientRect()` so `pxPerTile` is a sane number, not the `{1, 1}` fallback). Never used
// as a real GPU canvas context: drawing still goes to the offscreen `target` above, same as
// `gc-terrain.ts`.
const canvas = document.createElement('canvas')
canvas.style.width = '800px'
canvas.style.height = '600px'
canvas.style.position = 'fixed'
canvas.style.left = '-9999px' // never visible; only its layout box matters
document.body.appendChild(canvas)

// gc-terrain.ts's own reasoning: a small cache well under this page's own drift forces continuous
// eviction/upload throughout the run instead of filling once and going quiet.
const CLIENT_CACHE_CHUNKS = 8
const client = createClient({
  canvas,
  wasm,
  host: { kind: 'remote', url: 'ws://unused.invalid' },
  genWorkers: 1,
  assets: { tiles: '/terrain/tiles.json' },
  test: { clock, flags: { gcHook: true }, game: { clientCacheChunks: CLIENT_CACHE_CHUNKS } },
})
await client.ready
const harness = asHarness(client)
await parkWorkers(client)

// Injection targets the *same* internal bundle `client.camera.tick()` drives (Deviations of the
// M11 6-8 range: `ClientTestHandle.cameraBundle`), not a second, unrelated one.
attachCameraInputTestHooks(client, clientTestHandle(client).cameraBundle)

client.cameraState.centreX = 0
client.cameraState.centreY = 8
client.cameraState.tilesAcross = 16

const uploadDrain = createUploadDrain(new RingConsumer(client.uploadRing), renderer, {
  sabWriteTextureOk: device.sabWriteTextureOk,
})
renderer.frameUniform.viewportPxW = 64
renderer.frameUniform.viewportPxH = 64

// One 30-frame cycle, repeated for the whole 600-frame window: a one-pointer drag (consistently
// rightward, so world position actually drifts across chunk boundaries over many cycles, not just
// jitters in place), a two-pointer pinch about a fixed midpoint (zoom only, no net pan -- so it
// exercises the zoom/inertia-cancel code paths without fighting the drag's own drift), a few wheel
// notches, a WASD hold/release, then a tap (down one cycle, up the next) timed to land after both
// pointer slots are free again. `f` is 1-based, matching `installGcPage`'s own `drive(frame)`.
// Every injected pointer is `'touch'`, not `injectPointer`'s own default `'mouse'` (semantic.spec.
// ts's own precedent, "input: events reach wasm": mouse also emits `hover` -- 0019 §4 "mouse only"
// -- on every tile the drag/pinch crosses, which would make this scenario's own `inputRing`/
// `client.input` traffic depend on that separate feature instead of the "a tap every 30 frames" the
// brief's own Tests added line asks for). Camera mode (never `setMode('tool')`) is the default, so
// the drag/pinch themselves emit no semantic events at all -- only the tap does.
const CYCLE_FRAMES = 30
const FRAME_MS = 1000 / 60
let tMs = 0

function drive(f: number): void {
  const c = ((f - 1) % CYCLE_FRAMES) + 1
  tMs += FRAME_MS

  if (c === 1) {
    injectPointer(client, 'down', 1, 100, 150, tMs, 'touch')
  } else if (c >= 2 && c <= 6) {
    injectPointer(client, 'move', 1, 100 + (c - 1) * 30, 150, tMs, 'touch')
  } else if (c === 7) {
    injectPointer(client, 'up', 1, 100 + 5 * 30, 150, tMs, 'touch')
  } else if (c === 8) {
    injectPointer(client, 'down', 1, 340, 150, tMs, 'touch')
    injectPointer(client, 'down', 2, 460, 150, tMs, 'touch')
  } else if (c >= 9 && c <= 13) {
    const spread = 60 + (c - 8) * 15 // pinch outward, midpoint fixed at x=400
    injectPointer(client, 'move', 1, 400 - spread, 150, tMs, 'touch')
    injectPointer(client, 'move', 2, 400 + spread, 150, tMs, 'touch')
  } else if (c === 14) {
    injectPointer(client, 'up', 1, 400 - 135, 150, tMs, 'touch')
    injectPointer(client, 'up', 2, 400 + 135, 150, tMs, 'touch')
  } else if (c >= 15 && c <= 19) {
    injectWheel(client, c % 2 === 0 ? -80 : 60, 400, 300)
  } else if (c === 20) {
    injectKey(client, 'KeyD', true)
  } else if (c === 25) {
    injectKey(client, 'KeyD', false)
  } else if (c === 26) {
    injectPointer(client, 'down', 1, 700, 400, tMs, 'touch')
  } else if (c === 27) {
    injectPointer(client, 'up', 1, 700, 400, tMs, 'touch')
  }

  client.camera.tick(FRAME_MS)
  harness.stepFrame(FRAME_MS)
  harness.stepTick() // gc-gen.ts's own reasoning: a reliable per-frame wake for gen0's own controls
  uploadDrain.drain(DEFAULT_UPLOAD_BUDGET_BYTES)
  renderer.writeFrameUniform(renderer.frameUniform)
  renderer.draw(target)
}

installGcPage(harness, {
  adapter: device.adapterInfo,
  drive,
})

window.__gcInputRingDrops = () => {
  const stats = { drops: 0, pushed: 0, popped: 0 }
  new RingConsumer(clientTestHandle(client).sabs.inputRing).stats(stats)
  return stats.drops
}

window.__pageReady = true
