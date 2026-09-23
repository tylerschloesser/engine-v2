// `gc-slice.html`'s script (docs/plan/16-action-round-trip.md, step 6, "the zero-GC window with
// actions"): `gc-connected-terrain.ts`'s own real connected+rendered+panning topology, plus one
// `dispatchRaw` call every `DISPATCH_EVERY_FRAMES` frames inside the *measured* window -- `engine/
// test.dispatchRaw` (0016 §2) takes pre-encoded `Uint8Array` bytes precisely so JSON encoding
// (`JSON.stringify`, a real allocation) never runs inside a zero-GC window; `PAINT_JSON_BYTES`
// below is built once, outside `drive()`, the same "views/scratch built once at setup" discipline
// `.claude/rules/hot-paths.md` requires everywhere else on this page.
//
// A dispatched action's own *result* (`onActionResult`, drained every real rAF frame by `client.ts`
// itself, `client.dispatch`'s own Deviations: "not zero-GC ... a later cut owns making it
// allocation-free") allocates: `JSON.parse`ing a `{"seq":n,"result":"Confirmed"}` record costs real
// bytes, folded into `main`'s own budget (`budgets.json`'s "the exit criterion's own 'zero-GC
// window with dispatchRaw' -- step 6 -- is where that gets budgeted", steps 1-5's own Deviations).
// `main` is still `class: "strict"` -- measured, not assumed (Deviations: a first draft tried
// `"budgeted"` pre-emptively before measuring `"strict"` at all): the ~1,296 B/600 frames this adds
// is real allocation too small to cross V8's young-generation scavenge threshold, so assertion A
// (zero GC events) still holds, the same as `connected-terrain`'s own larger per-frame allocation
// with no dispatched actions at all. `client`/`sim`/`gen0` also stay `"strict"`: the *sending* side
// (`dispatchRaw`'s own `RingProducer.tryPush`, `on_action`'s outbox push, `poll_uplink`'s
// immediate flush) and the *admit*/`apply` path are all proven zero-allocation already
// (`no_alloc_connection.rs`'s `host_admit_path_allocates_zero_bytes_per_action`, this milestone's
// own Deviations) -- only `main`'s own JSON *parse* of the result costs anything.
import { createClient } from '../../../../src/client.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import { initDevice } from '../../../../src/render/device.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { createUploadDrain, DEFAULT_UPLOAD_BUDGET_BYTES } from '../../../../src/render/upload.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import {
  asHarness,
  dispatchRaw,
  type NetCounters,
  netCounters,
  parkWorkers,
  pumpUntilLive,
  stepSimTickSync,
} from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __netCounters?: (conn?: number) => Promise<NetCounters>
  }
}

const wasm = await fixtureWasm('puts')
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
renderer.setTileArray(art.texture, art.gpuBytes)
renderer.writeVisualTable(art.visualTableBytes)

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'gc-slice', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  test: { clock, flags: { gcHook: true } },
})
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

const uploadDrain = createUploadDrain(new RingConsumer(client.uploadRing), renderer, {
  sabWriteTextureOk: device.sabWriteTextureOk,
})
renderer.frameUniform.viewportPxW = 64
renderer.frameUniform.viewportPxH = 64

// Reused every frame (`.claude/rules/hot-paths.md`), like production's own offscreen/canvas target
// would be -- this page never reads it back, only draws into it.
const target = device.device.createTexture({
  size: [64, 64],
  format: 'rgba8unorm',
  usage:
    GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
})

// Built once (`.claude/rules/hot-paths.md`): one `Paint` action's JSON, at a tile far from the
// panned view (`fx-puts`'s own `Puts::admit` never rejects a Paint this close to the origin --
// `PAINT_BOUND` is 1,000,000 -- so every dispatch here is `Confirmed`, matching `gc-connected-
// terrain.ts`'s own "no controls beyond object/burst" shape: nothing here needs a `Rejected` path).
const PAINT_JSON_BYTES = new TextEncoder().encode(
  JSON.stringify({ Paint: { pos: { x: 500, y: 500 }, base: 1, resource: 2 } }),
)
// Every 30 frames (0.5 s at 60 Hz): frequent enough that several results land inside a 600-frame
// measured window (proving the result path's own cost is real, not accidentally never exercised --
// this repo's own recurring "a test that cannot fail" trap), far under the outbox/action-ring
// capacity (32, `client::core::OUTBOX_CAPACITY`) even summed over the whole window.
const DISPATCH_EVERY_FRAMES = 30
let frame = 0
let seq = 1

installGcPage(harness, {
  adapter: device.adapterInfo,
  drive() {
    frame += 1
    cameraState.centreX += PAN_TILES_PER_FRAME
    harness.stepFrame(1000 / 60)
    stepSimTickSync(client, 1)
    harness.stepTick()
    uploadDrain.drain(DEFAULT_UPLOAD_BUDGET_BYTES)
    renderer.writeFrameUniform(renderer.frameUniform)
    renderer.draw(target)
    if (frame % DISPATCH_EVERY_FRAMES === 0) {
      dispatchRaw(client, seq, PAINT_JSON_BYTES)
      seq += 1
    }
  },
})

window.__netCounters = () => netCounters(client)

window.__pageReady = true
