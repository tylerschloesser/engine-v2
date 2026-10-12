// `gc-belts.html`'s script (M49, docs/decisions/0078 A12): the zero-GC proof of the per-frame item
// drawing path, `gc-drawables.ts`'s topology over `fx-belts`. The world is the bench genesis's
// `SaturatedView { jam_pct: 0, period: 0 }` at scale 32 (four rows of 256 belt tiles, every lane
// packed and flowing into a sink); the camera sits still over the stream, 64 tiles of it in view
// (about 2,000 items, `fixtures/belts/src/client.rs` drawing each as a sprite through
// `transport::draw::draw_items`). `drive()` steps one sim tick and one 50 ms frame (the item clock
// moving with the follower's tick), drains uploads and draws terrain plus the drawables layers.
// Setup (the join, the forecasts' first lists) runs before `installGcPage`, outside every window.

import { clientTestHandle, createClient } from '../../../../src/client.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import { loadSpriteAtlas } from '../../../../src/render/atlas.ts'
import { initDevice } from '../../../../src/render/device.ts'
import { attachDrawables, createDrawablesRenderer } from '../../../../src/render/drawables.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { createUploadDrain, DEFAULT_UPLOAD_BUDGET_BYTES } from '../../../../src/render/upload.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import {
  asHarness,
  type DrawRecord,
  drawListRecords,
  parkWorkers,
  pumpUntilLive,
  stepSimTickSync,
} from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { setViewport } from '../../../../src/test/viewport.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    /** Records in the last published DrawList (the items drawn), read after setup. */
    __beltsItemsDrawn?: number
  }
}

const wasm = await fixtureWasm('belts')
const canvas = document.createElement('canvas')
const clock = createManualClock()
const assets = { tiles: '/terrain/tiles.json', sprites: '/drawables/sprites.json' }

const device = await initDevice()
const renderer = await createTerrainRenderer(device.device, {
  colorFormat: 'rgba8unorm',
  viewProbePasses: device.viewProbePasses,
  checkCompilation: device.checkCompilation,
})
const art = await loadTileArt(device.device, assets.tiles, {
  checkCompilation: device.checkCompilation,
})
renderer.setTileArray(art.texture, art.gpuBytes)
renderer.writeVisualTable(art.visualTableBytes)

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: {
      worldId: 'gc-belts',
      params: {
        seed: '7',
        worldgen: {
          bench: { seed: 7, scale: 32, regime: { SaturatedView: { jam_pct: 0, period: 0 } } },
        },
        maxLines: 4_096,
        maxItems: 16_384,
      },
    },
    connect: true,
  },
  genWorkers: 1,
  assets,
  test: { clock, flags: { gcHook: true } },
})
await pumpUntilLive(client)
const harness = asHarness(client)

const drawablesRenderer = await createDrawablesRenderer(device.device, {
  colorFormat: 'rgba8unorm',
  drawListSlot: clientTestHandle(client).drawListSlot,
  checkCompilation: device.checkCompilation,
})
attachDrawables(renderer, drawablesRenderer)
drawablesRenderer.setSpriteAtlas(
  await loadSpriteAtlas(device.device, assets.sprites, {
    checkCompilation: device.checkCompilation,
  }),
)

// The stream: rows 0..3, x 0..256; 64 tiles across at 20 px a tile (the fixture style draws nothing
// below 4).
const { cameraState } = client
cameraState.centreX = 128
cameraState.centreY = 2
cameraState.tilesAcross = 64
cameraState.halfExtentTilesX = 30
cameraState.halfExtentTilesY = 8
setViewport(client, 1280, 640)

/** One sim tick and one frame of the tick's length. */
const FRAME_MS = 50

// The join: chunk snapshots, every line's structure and first list (one-time setup, 0016 §2).
for (let i = 0; i < 40; i++) {
  harness.stepFrame(FRAME_MS)
  stepSimTickSync(client, 1)
}
harness.stepFrame(FRAME_MS)
harness.stepTick()

const records: DrawRecord[] = []
window.__beltsItemsDrawn = drawListRecords(client, records)

const uploadDrain = createUploadDrain(new RingConsumer(client.uploadRing), renderer, {
  sabWriteTextureOk: device.sabWriteTextureOk,
})
renderer.frameUniform.viewportPxW = 64
renderer.frameUniform.viewportPxH = 64
// Static uniforms: this page checks allocation, not pixels (`gc-drawables.ts`'s precedent).
drawablesRenderer.writeFrameUniform({
  camTileX: 0,
  camTileY: 0,
  camFracX: 0,
  camFracY: 0,
  windowOriginX: 0,
  windowOriginY: 0,
  cursorTileX: 0,
  cursorTileY: 0,
  viewportPxW: 64,
  viewportPxH: 64,
  tilesPerPx: 1 / 8,
  cursorValid: 0,
})
const target = device.device.createTexture({
  size: [64, 64],
  format: 'rgba8unorm',
  usage:
    GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
})

await parkWorkers(client)

installGcPage(harness, {
  adapter: device.adapterInfo,
  drive() {
    harness.stepFrame(FRAME_MS)
    stepSimTickSync(client, 1)
    harness.stepTick()
    uploadDrain.drain(DEFAULT_UPLOAD_BUDGET_BYTES)
    client.pick.acquire()
    drawablesRenderer.acquire()
    renderer.writeFrameUniform(renderer.frameUniform)
    renderer.draw(target)
  },
})

window.__pageReady = true
