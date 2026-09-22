// `gc-connected-terrain.html`'s script (docs/plan/15c-terrain-visibility-and-cache-invalidation.md,
// step 4, Tests added: "the zero-GC panning window (600 frames, sim + client isolates within
// budget, ring drops === 0)" -- M15b's own step 6, left unbuilt until this milestone's cache-
// invalidation fix (steps 1-2) made a real connected+rendered pan mean what it claims). A real
// `createClient()` **local, connected** topology over `fx-puts` (`host.connect: true`, unlike
// `gc-terrain.ts`'s `remote` host -- this page is the first zero-GC page to combine a real `sim`
// isolate, a real `RingConnection`, and a real renderer/pan in one), driven by a scripted pan the
// same shape `gc-terrain.ts` already uses (chunks enter/leave the client's own generation set and
// cache inside the measured window, 0016 §2: "chunk-enter bursts are not exempt").
//
// `drive()` differs from `gc-terrain.ts`'s in one way: `asHarness.stepTick()` never touches
// `CB_SIM_STEP_REQ` (`gc-sim.ts`'s own doc comment: real-time pacing never arms in test mode,
// `worker/sim.ts`'s `!message.test` gate), so it alone would never actually tick `sim` -- this page
// calls `stepSimTickSync(client, 1)` for a real, deterministic host tick every frame (`gc-sim.ts`'s
// own precedent), in addition to `harness.stepTick()` (kept for the same reason `gc-terrain.ts`
// keeps it: a reliable per-frame wake for `gen0`'s own negative controls, not a second real tick --
// `worker/sim.ts`'s `wokenBy === lastWokenBy` guard, ADR 0030, makes a redundant wake harmless).
// Every real host tick both admits the camera's own subscription and runs `fx-puts`'s tick rule
// (`Puts::tick`), so the panning window exercises the exact overlay-replace/evict/re-request path
// this milestone fixed -- with the camera actually moving, unlike `overlay_tile_reaches_screen`'s
// own held-still probe.
import { createClient } from '../../../../src/client.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import { initDevice } from '../../../../src/render/device.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { createUploadDrain, DEFAULT_UPLOAD_BUDGET_BYTES } from '../../../../src/render/upload.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import {
  asHarness,
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
    // Same signature as `connected.ts`/`connected-terrain.ts`'s own global `Window` augmentation
    // (a TS project-wide `declare global` must match exactly everywhere it appears); this page
    // only ever has connection 0, so `conn` is unused.
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

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'gc-connected-terrain', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  test: { clock, flags: { gcHook: true } },
})
// `pumpUntilLive` (docs/plan/16-action-round-trip.md, `engine/test`'s own doc comment has the
// full reasoning): this page's own ticks are test-driven (`drive()`, wired below, well after this
// point), and `client.ready` now needs a real first frame before it resolves, so a bare `await
// client.ready` here would deadlock against the very hook that would otherwise drive one.
await pumpUntilLive(client)
// A production worker enters its blocking loop right after `ready`: park before `__pageReady`
// (packages/engine/CLAUDE.md, `gc-topology.ts`'s own precedent) so CDP can reach it the instant the
// test attaches.
const harness = asHarness(client)
await parkWorkers(client)

const { cameraState } = client
cameraState.centreX = 0
cameraState.centreY = 8
cameraState.tilesAcross = 32
cameraState.halfExtentTilesX = 24
cameraState.halfExtentTilesY = 24
// ~8 tiles/second (`gc-terrain.ts`'s own rate): crosses a chunk boundary well inside the measured
// window, so residency both grows and shrinks across the run on both the client's own cache and
// the host's own subscription.
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
    stepSimTickSync(client, 1)
    harness.stepTick()
    uploadDrain.drain(DEFAULT_UPLOAD_BUDGET_BYTES)
    renderer.writeFrameUniform(renderer.frameUniform)
    renderer.draw(target)
  },
})

// `join_at_max_zoom_out_never_drops` (`connected.spec.ts`)'s own `counters.uplink/downlink.drops`
// shape, exposed here so this page's own spec can assert the ring connection drops nothing while
// panning for real inside a measured zero-GC window (Exit criteria: "ring drops === 0").
window.__netCounters = () => netCounters(client)

window.__pageReady = true
