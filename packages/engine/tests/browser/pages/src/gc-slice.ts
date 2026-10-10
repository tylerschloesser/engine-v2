// `gc-slice.html`'s script (M16, step 6, "the zero-GC window with
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
  predictStats,
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
    /** M26, Open gate failures item 3, gate round 1:
     * `ClientCore::predict_applied_ever`, read outside the measured zero-GC window (parks the
     * client worker itself -- `predictStats`'s own precondition -- so this is never called from
     * inside `drive()`). */
    __predictStats?: () => Promise<{ appliedEver: number }>
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

// Built once (`.claude/rules/hot-paths.md`): one `Paint` action's JSON, at the camera's own
// starting centre tile (M26, Open gate failures item
// 3, gate round 1) -- a tile the replica actually holds (subscribed, since it is inside the panned
// view from frame 0) rather than the original `(500, 500)`, "far from the panned view": a blind
// write to an unheld chunk always predicts `NotPredictable` (`.claude/rules/prediction.md`,
// `Predicting::set_tile`'s own doc comment: "A blind write outside the subscription sets
// `saw_unknown` too"), so the original position never actually exercised the predict path this
// milestone's own code added -- found live, not merely suspected (`predictStats`'s own assertion
// below fails at `(500, 500)`, reverted). The camera drifts at most `PAN_TILES_PER_SECOND *
// (FRAMES / 60)` tiles away from this tile over the whole run (600 frames, 0016's own `instrument.
// ts` -- 80 tiles at 8 tiles/s), comfortably inside the 0010 subscription hold radius (ring 3, ~96
// tiles beyond the visible rect), so this chunk stays held and predictable for the entire window,
// not just the first dispatch. `fx-puts`'s own `Puts::admit` never rejects a Paint this close to
// the origin either (`PAINT_BOUND` is 1,000,000), so every dispatch here is still `Confirmed`,
// matching `gc-connected-terrain.ts`'s own "no controls beyond object/burst" shape.
const PAINT_JSON_BYTES = new TextEncoder().encode(
  JSON.stringify({ Paint: { pos: { x: 0, y: 8 }, base: 1, resource: 2 } }),
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
window.__predictStats = async () => {
  await parkWorkers(client)
  return predictStats(client)
}

window.__pageReady = true
