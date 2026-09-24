// `anchors` zero-GC page (docs/plan/18-picking-and-overlay.md step 8, Tests added: "page id
// `anchors` through `zeroGcSuite`; strict pages unchanged"; Planning decisions "Overlay string
// constant"): a real, unconnected `fx-overlay` client (`gc-input.ts`'s own topology -- no dispatch/
// sim needed, `ClientSide::frame`/`extract` run every client-worker frame regardless of a net link),
// terrain + drawables rendering attached (`gc-drawables.ts`'s own shape: the same wrapper-object
// count its `main` budget was derived from), 50 static `client.overlay.anchor` anchors and 4
// `client.overlay.anchorSlot` anchors mounted once at setup (tracking `fx-overlay`'s own real,
// `DrawList::anchor`-published orbiting circles), and a continuously panning *and* zooming camera
// (0016 §2: "chunk-enter bursts are not exempt... panning is the normal state") -- `main`'s own
// budget is `drawables`' own strict number plus a separate "with anchors mounted" constant (0016 §2:
// "a separate line in the budgets file, asserted by its own test with a fixed anchor count"). Also
// exercises `client.input.emit` in the measured window (step 4-6 Deviations: "no zero-GC page covers
// it yet") -- `emit`'s own implementation is allocation-free by construction (`input/semantic.ts`),
// so folding one call per frame into this page's own clean measurement is what actually proves it.
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import { loadSpriteAtlas } from '../../../../src/render/atlas.ts'
import { initDevice } from '../../../../src/render/device.ts'
import {
  attachDrawables,
  createDrawablesRenderer,
  type DrawablesRenderer,
} from '../../../../src/render/drawables.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { createUploadDrain, DEFAULT_UPLOAD_BUDGET_BYTES } from '../../../../src/render/upload.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import { asHarness, parkWorkers } from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
  }
}

const assets = { tiles: '/terrain/tiles.json', sprites: '/drawables/sprites.json' }
const wasm = await fixtureWasm('overlay')
const clock = createManualClock()

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

// `gc-input.ts`'s own reasoning: a real CSS size so `client.overlay`'s own `worldToScreen` math (and
// `ClientOptions.overlay`'s default root, the canvas's own parent) reads a sane viewport, not the
// `{1, 1}` fallback -- never used as a real GPU canvas context (drawing goes to the offscreen
// `target` below), but it must be *attached* to the document for overlay anchors to have a parent.
const canvas = document.createElement('canvas')
canvas.style.width = '800px'
canvas.style.height = '600px'
canvas.style.position = 'fixed'
canvas.style.left = '-9999px'
document.body.appendChild(canvas)

const client = createClient({
  canvas,
  wasm,
  host: { kind: 'remote', url: 'ws://unused.invalid' },
  genWorkers: 1,
  assets,
  test: { clock, flags: { gcHook: true }, game: { seed: '0x1', params: null } },
})
await client.ready
const harness = asHarness(client)

const drawListSlot = clientTestHandle(client).drawListSlot
const drawablesRenderer: DrawablesRenderer = await createDrawablesRenderer(device.device, {
  colorFormat: 'rgba8unorm',
  drawListSlot,
  checkCompilation: device.checkCompilation,
})
attachDrawables(renderer, drawablesRenderer)
const spriteAtlas = await loadSpriteAtlas(device.device, assets.sprites, {
  checkCompilation: device.checkCompilation,
})
drawablesRenderer.setSpriteAtlas(spriteAtlas)

const { cameraState } = client
cameraState.centreX = 0
cameraState.centreY = 0
cameraState.tilesAcross = 24
cameraState.halfExtentTilesX = 60
cameraState.halfExtentTilesY = 60

// 50 static anchors, spread on a grid well inside the camera's own view (visibility toggling is not
// this page's own concern -- `overlay.offscreen_hidden_on_transition_only` already covers it -- so
// the exact spread only needs to be "plausible", not tuned to stay on screen every frame).
const STATIC_ANCHOR_COUNT = 50
const STATIC_COLS = 10
for (let i = 0; i < STATIC_ANCHOR_COUNT; i++) {
  const col = i % STATIC_COLS
  const row = Math.floor(i / STATIC_COLS)
  const el = document.createElement('div')
  el.textContent = String(i)
  client.overlay.anchor(el, (col - STATIC_COLS / 2) * 2, (row - 2) * 2)
}

// 4 slot anchors, tracking `fx-overlay`'s own real `DrawList::anchor`-published orbiting circles
// (`fixtures/overlay/src/lib.rs`'s own `ANCHOR_SLOT_COUNT`).
const SLOT_ANCHOR_COUNT = 4
for (let slot = 0; slot < SLOT_ANCHOR_COUNT; slot++) {
  const el = document.createElement('div')
  el.textContent = `slot ${slot}`
  client.overlay.anchorSlot(el, slot)
}

// Continuous pan *and* zoom (0016 §2, Planning decisions: "pans and zooms continuously for the
// window") -- a plain triangle wave for zoom (`tilesAcross` 20..28..20), deterministic and cheap
// (`.claude/rules/hot-paths.md`: no `Math.sin`/closures on this path).
const PAN_TILES_PER_SECOND = 6
const PAN_TILES_PER_FRAME = PAN_TILES_PER_SECOND / 60
const ZOOM_PERIOD_FRAMES = 120
const ZOOM_MIN_TILES = 20
const ZOOM_SPAN_TILES = 8

const uploadDrain = createUploadDrain(new RingConsumer(client.uploadRing), renderer, {
  sabWriteTextureOk: device.sabWriteTextureOk,
})
renderer.frameUniform.viewportPxW = 64
renderer.frameUniform.viewportPxH = 64
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

let frame = 0
let emitA = 0

function zoomFor(f: number): number {
  const t = f % ZOOM_PERIOD_FRAMES
  const half = ZOOM_PERIOD_FRAMES / 2
  const tri = t < half ? t / half : (ZOOM_PERIOD_FRAMES - t) / half
  return ZOOM_MIN_TILES + tri * ZOOM_SPAN_TILES
}

await parkWorkers(client)

installGcPage(harness, {
  adapter: device.adapterInfo,
  drive() {
    frame += 1
    cameraState.centreX += PAN_TILES_PER_FRAME
    cameraState.tilesAcross = zoomFor(frame)
    harness.stepFrame(1000 / 60)
    harness.stepTick() // `gc-gen.ts`'s own reasoning: a reliable per-frame wake for gen0's controls
    uploadDrain.drain(DEFAULT_UPLOAD_BUDGET_BYTES)
    client.pick.acquire() // the one real TripleReader.acquire() over drawList, this rAF
    drawablesRenderer.acquire()
    renderer.writeFrameUniform(renderer.frameUniform)
    renderer.draw(target)
    client.overlay.update()
    // docs/plan/18-picking-and-overlay.md steps 4-6 Deviations: no existing zero-GC page folds a
    // `client.input.emit` call into its own measured window -- this one, folded here, is that
    // coverage (`code`/`a`/`b` vary with `frame` only so the call is real work, not a constant).
    emitA = (emitA + 1) & 0xff
    client.input.emit(3, emitA, frame & 0xff)
  },
})

window.__pageReady = true
