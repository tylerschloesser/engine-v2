// `terrain` zero-GC page (docs/plan/09-renderer-terrain.md, step 7; `gc-test` skill "Production-
// topology pages"): a real `createClient()` over `fx-terrain`, `host: { kind: 'remote', ... }` (no
// `Sim` role), plus a real device/renderer, driven by a scripted pan so chunks are generated,
// converted, uploaded and evicted inside the measured window (0016 §2: "chunk-enter bursts are not
// exempt"). `drive()` bundles the camera pan, `harness.stepFrame`/`stepTick` (gc-gen.ts's own
// reasoning: `stepTick` gives `gen0` a reliable per-frame wake for the negative controls), one
// budgeted upload drain and one draw -- the first zero-GC page with a real WebGPU adapter, so
// `installGcPage`'s `adapter` option is this milestone's own addition.
import { createClient } from '../../../../src/client.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import { initDevice } from '../../../../src/render/device.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { createUploadDrain, DEFAULT_UPLOAD_BUDGET_BYTES } from '../../../../src/render/upload.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import { asHarness, parkWorkers } from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { stats as genStats } from '../../../../src/test/gen.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

// `window.__terrainGcCounters`'s type comes from `../support/gc-terrain-window.d.ts` (shared with
// the spec file), the same split `terrain.ts` already uses for `window.__terrain`.

declare global {
  interface Window {
    __pageReady?: true
  }
}

const wasm = await fixtureWasm('terrain')
const canvas = document.createElement('canvas')
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
renderer.setTileArray(art.texture)
renderer.writeVisualTable(art.visualTableBytes)
// Reused every frame (`.claude/rules/hot-paths.md`), like production's own offscreen/canvas target
// would be -- this page never reads it back, only draws into it.
const target = device.device.createTexture({
  size: [64, 64],
  format: 'rgba8unorm',
  usage:
    GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
})

// Open gate failures item 3, gate round 1: `fx-terrain`'s own default cache (1,024 chunks) never
// fills over this page's ~35-chunk pan, so `CacheEvent::Evicted`/`INDIR` none/slot reuse never ran
// inside the measured window. A small cache (well under the ~35 chunks the pan below touches, and
// under the instantaneous ring-1+lookahead footprint at half-extent 24) forces continuous eviction
// throughout the run instead -- also exercising item 4's own slot-reuse-ordering fix on every
// clean/negative-control run of this page.
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
// A production worker enters its blocking loop right after `ready`: park before `__pageReady`
// (packages/engine/CLAUDE.md, gc-gen.ts's own precedent) so CDP can reach it the instant the test
// attaches.
const harness = asHarness(client)
await parkWorkers(client)

const { cameraState } = client
cameraState.centreX = 0
cameraState.centreY = 8
cameraState.halfExtentTilesX = 24
cameraState.halfExtentTilesY = 24
// ~8 tiles/second (gc-gen.ts's own rate): crosses the chunk (0,0)/(1,0) boundary well inside the
// measured window, so residency both grows (new chunks entering view) and shrinks (old ones
// leaving the cache's own retention window) across the run.
const PAN_TILES_PER_SECOND = 8
const PAN_TILES_PER_FRAME = PAN_TILES_PER_SECOND / 60
cameraState.velocityX = PAN_TILES_PER_SECOND

const uploadDrain = createUploadDrain(new RingConsumer(client.uploadRing), renderer, {
  sabWriteTextureOk: device.sabWriteTextureOk,
})
renderer.frameUniform.viewportPxW = 64
renderer.frameUniform.viewportPxH = 64

installGcPage(harness, {
  adapter: device.adapterInfo,
  drive() {
    cameraState.centreX += PAN_TILES_PER_FRAME
    harness.stepFrame(1000 / 60)
    harness.stepTick()
    uploadDrain.drain(DEFAULT_UPLOAD_BUDGET_BYTES)
    renderer.writeFrameUniform(renderer.frameUniform)
    renderer.draw(target)
  },
})

window.__terrainGcCounters = async () => {
  const s = await genStats(client)
  return {
    generated: s.delivered,
    uploadedChunks: uploadDrain.chunkRecordsTotal(),
    evicted: uploadDrain.evictedTotal(),
  }
}

window.__pageReady = true
