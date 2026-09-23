// `gc-drawables.html`'s script (docs/plan/17-drawlist-and-sprites.md step 6, Tests added: "page id
// `drawables` through `zeroGcSuite` (fixture with a few hundred entities, panning, actions from
// pre-encoded bytes; isolates `main`, `client`, `sim`, `gen0`)"): `gc-slice.ts`'s own real,
// connected, panning + dispatched-action topology, over `fx-drawables` instead of `fx-puts`, with
// the drawables uber-quad renderer attached to terrain's own render pass (`attachDrawables`,
// Planning decisions "the production wrapper count stays five" -- one shared encoder/pass/command
// buffer covers both renderers every frame).
//
// Population (a few hundred entities, Tests added): `fx-drawables`'s own `genesis` stays fixed at
// its original three (`drawlist_fixture_hash_golden`'s own count depends on it, module doc comment
// there); this page instead dispatches `Action::Spawn` `POPULATE_COUNT` times, each admitted by a
// real sim tick, entirely *before* `installGcPage` -- one-time setup (0016 §2), exempt the same way
// `terrain`'s own 120-frame warm-up is. The camera's own half extent is wide enough (`POPULATE_HALF_
// EXTENT`) to subscribe every spawned entity's own chunk before the measured window narrows nothing:
// the *same* wide camera stays for the whole run, panning inside it, so every entity stays resident
// and visible in `extract()` throughout (`visible()`'s own margin, 0018 Provides) -- unlike `gc-
// terrain.ts`'s small cache, this page is not testing eviction, only a DrawList genuinely wide
// enough to matter for `render.drawCallsMax`/`instanceBytes`.
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import { initDevice } from '../../../../src/render/device.ts'
import {
  attachDrawables,
  createDrawablesRenderer,
  type DrawablesRenderer,
} from '../../../../src/render/drawables.ts'
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
  resumeWorkers,
  stepSimTickSync,
} from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import {
  drawCalls as drawablesDrawCalls,
  drawListDropped,
  instanceBytes,
  pipelineSwitches,
} from '../../../../src/test/render.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __netCounters?: (conn?: number) => Promise<NetCounters>
    __drawablesGcCounters?: () => {
      drawCalls: number
      pipelineSwitches: number
      instanceBytes: number
      drawListDropped: number
    }
    /** Test-only, outside `engine/test` (docs/plan/17-drawlist-and-sprites.md Tests added:
     * `drawlist.triple_newest_wins`, `counters.draws_equal_nonempty_layers`): every read goes
     * through `drawablesRenderer`'s own `TripleReader` (`acquire()`), never a second, independent
     * one over the same `drawList` SAB -- `sab/triple.ts`'s own `acquire()` mutates shared
     * triple-buffer state on every call, so two readers racing each other tear the "current front
     * slot" handoff (found by this page's own first draft, Deviations). `stepClientFrameOnly`
     * drives the client worker one real frame at a time with no `acquire()`/draw call, unlike
     * `drive()` -- the fine-grained control both tests need. */
    __drawablesTest?: {
      /** `resumeWorkers(client)` -- required before `stepClientFrameOnly`/`acquireAndDraw` below,
       * since `window.__pageReady` is set with every worker already *parked* (`window.__gc.run`'s
       * own `harness.resume()`/`harness.park()` bracketing is what every other production-topology
       * page's own test relies on for this; a spec driving this page's own extra hooks needs the
       * same bracketing, explicitly, since it never calls `window.__gc.run` itself). */
      resume(): Promise<void>
      /** `parkWorkers(client)` -- call after `resume()`-bracketed work, so the page is left ready
       * for the next `window.__gc.run()` (or the next spec) the same way `__pageReady` first found
       * it. */
      park(): Promise<void>
      /** `drawablesRenderer.acquire()` alone -- no draw. */
      acquire(): void
      /** `frame_seq` of the slot `acquire()`/`acquireAndDraw()` last read. */
      frameSeq(): number
      /** `record_count` of the slot `acquire()`/`acquireAndDraw()` last read. */
      recordCount(): number
      /** How many of the 8 `layer_count` entries of that same slot are non-zero. */
      nonEmptyLayerCount(): number
      /** `engine/test`'s `drawListDropped` counter, of that same slot. */
      drawListDropped(): number
      /** One real client-worker frame (`harness.stepFrame`) -- a real `extract`+`sort_into`
       * publish -- with no `acquire()`/draw call, unlike `drive()`. */
      stepClientFrameOnly(): void
      acquireAndDraw(): void
      drawCallsNow(): number
      /** Fix round 1: the distinct layers the population loop actually dispatched entities to
       * (`[0, 3, 7]`), tracked by the page's own population bookkeeping -- an independent ground
       * truth `counters.draws_equal_nonempty_layers` checks `drawCallsNow()`'s delta against,
       * never derived from `render/drawables.ts`'s own `computeLayerOffsets`/`layerCounts`. */
      populatedLayers(): number[]
    }
  }
}

const wasm = await fixtureWasm('drawables')
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

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'gc-drawables', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  test: { clock, flags: { gcHook: true } },
})
await pumpUntilLive(client)
// Every worker is still in its normal, *unparked* running state here (a production worker enters
// its blocking loop right after `ready`, but "blocking" means `Atomics.wait`-and-respond-to-wake,
// not parked -- parking is the separate, explicit `W_YIELD`/`W_PARKED` protocol `parkWorkers` below
// puts it into). `stepFrame`/`stepSimTickSync` need a worker in *this* state to ack a plain
// `Atomics.notify` wake at all (`asHarness.stepTick`'s own doc comment: "did not ack a step
// (resume() first?)" -- a *parked* worker only responds to a `{ type: 'resume' }` postMessage, per
// `resumeWorkers`'s own doc comment: "a parked worker is not blocked"). The population loop below
// therefore runs *before* parking, not after (a first draft parked here, matching `gc-slice.ts`'s
// own precedent line-for-line, and every population-loop `stepFrame` call hung forever -- `gc-
// slice.ts` never calls `stepFrame` this early itself, only registers `drive()` for a later `window.
// __gc.run()`, which itself calls `harness.resume()` first; that is the difference this milestone's
// own new setup-time population loop exposed).
const harness = asHarness(client)

// Now built once `render/drawables.js` is loaded (`.claude/rules/hot-paths.md`'s own "views/scratch
// built once at setup"): the drawList SAB comes off `clientTestHandle` (`ClientTestHandle.sabs`),
// not the public `Client` interface, which this milestone leaves untouched (Files touched lists
// `src/worker/client.ts`, not `src/client.ts`).
const drawListSab = clientTestHandle(client).sabs.drawList
const drawablesRenderer: DrawablesRenderer = await createDrawablesRenderer(device.device, {
  colorFormat: 'rgba8unorm',
  drawListSab,
  checkCompilation: device.checkCompilation,
})
attachDrawables(renderer, drawablesRenderer)

const { cameraState } = client
// Wide enough to keep every populated entity's own chunk subscribed (and inside `visible()`,
// margin included) for the whole run: `POPULATE_HALF_EXTENT` covers the full spawn grid below with
// slack, `ChunkDims::new(5)` (32-tile chunks, `Game::CHUNK_BITS`'s own default) puts the whole
// grid's chunk footprint well under the 128-chunk subscription cap (0010).
const POPULATE_HALF_EXTENT = 120
cameraState.centreX = 0
cameraState.centreY = 0
cameraState.tilesAcross = 24 // well under `SMALL_ZOOM_THRESHOLD` (32): irrelevant here since every
// populated entity is spawned with `small: false`, but keeping it realistic costs nothing.
cameraState.halfExtentTilesX = POPULATE_HALF_EXTENT
cameraState.halfExtentTilesY = POPULATE_HALF_EXTENT

// A few hundred entities (Tests added), spread across a grid well inside `POPULATE_HALF_EXTENT` so
// every one lands in a subscribed chunk from the very first tick. One-time setup (0016 §2): every
// dispatch/tick pair below runs *before* `installGcPage`, outside any measured window.
//
// Fix round 1 (docs/plan/17-drawlist-and-sprites.md, coordinator review): spread across three
// layers with a gap (0, 3, 7 -- layers 1/2/4/5/6 stay empty), not all on layer 0
// (`fx-drawables`' own genesis entities are, unchanged -- `layer` defaults to `0` on `Entity`).
// `counters.draws_equal_nonempty_layers` needs this to have more than one non-empty layer to prove
// anything; `POPULATE_LAYERS`, tracked here in the page's own population bookkeeping, is the
// independent ground truth that test reads (never derived from `computeLayerOffsets`/
// `layerCounts` on the render side, so a bug there cannot move both sides of that test's own
// comparison together).
const POPULATE_COUNT = 300
const GRID_COLS = 20
const GRID_SPACING = 4
const POPULATE_LAYERS = [0, 3, 7]
let seq = 1
for (let i = 0; i < POPULATE_COUNT; i++) {
  const gx = i % GRID_COLS
  const gy = Math.floor(i / GRID_COLS)
  const x = (gx - GRID_COLS / 2) * GRID_SPACING
  const y = (gy - Math.ceil(POPULATE_COUNT / GRID_COLS) / 2) * GRID_SPACING
  const layer = POPULATE_LAYERS[i % POPULATE_LAYERS.length]
  const bytes = new TextEncoder().encode(
    JSON.stringify({ Spawn: { at: { x, y }, small: false, layer } }),
  )
  dispatchRaw(client, seq, bytes)
  seq += 1
  harness.stepFrame(1000 / 60)
  stepSimTickSync(client, 1)
}
// Lets every spawned entity's own delta actually land in the replica (one more real host tick with
// nothing new to admit) before the measured window's own first `drive()` call reads `client.frame`.
harness.stepFrame(1000 / 60)
stepSimTickSync(client, 1)
harness.stepTick()

// ~8 tiles/second (`gc-terrain.ts`'s own rate): panning inside the wide, already-subscribed view
// above, so the measured window exercises real camera motion (0016 §2: "chunk-enter bursts are not
// exempt") without ever unsubscribing a populated entity's own chunk.
const PAN_TILES_PER_SECOND = 8
const PAN_TILES_PER_FRAME = PAN_TILES_PER_SECOND / 60
cameraState.velocityX = PAN_TILES_PER_SECOND

const uploadDrain = createUploadDrain(new RingConsumer(client.uploadRing), renderer, {
  sabWriteTextureOk: device.sabWriteTextureOk,
})
renderer.frameUniform.viewportPxW = 64
renderer.frameUniform.viewportPxH = 64
// Static: this page never checks pixel correctness, only allocation/counters (`gc-terrain.ts`'s own
// precedent -- none of that page's clean-run siblings track `camTileX`/`camFracX` from the live
// camera either). A non-zero `tilesPerPx` avoids a division by zero in `uberquad.wgsl`'s own vertex
// shader.
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

// Reused every frame (`.claude/rules/hot-paths.md`), like production's own offscreen/canvas target
// would be -- this page never reads it back, only draws into it.
const target = device.device.createTexture({
  size: [64, 64],
  format: 'rgba8unorm',
  usage:
    GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
})

// One `Spawn` dispatched every `DISPATCH_EVERY_FRAMES` frames *inside* the measured window too
// (`gc-slice.ts`'s own reasoning: proving the result path's own cost is real, not accidentally
// never exercised), spawned far outside `POPULATE_HALF_EXTENT` so it never enters `visible()` and
// never perturbs the rendered/counted DrawList.
const EXTRA_SPAWN_JSON_BYTES = new TextEncoder().encode(
  JSON.stringify({ Spawn: { at: { x: 1_000_000, y: 1_000_000 }, small: false, layer: 0 } }),
)
const DISPATCH_EVERY_FRAMES = 30
let frame = 0

// A production worker enters its blocking loop right after `ready` and has stayed in that normal,
// unparked state through the whole population loop above (comment there has the full reasoning);
// park it *now*, once setup is otherwise finished, so CDP can reach it the instant the test attaches
// (packages/engine/CLAUDE.md, `gc-topology.ts`'s own precedent) -- `window.__gc.run` (`gc-page.ts`)
// itself calls `harness.resume()` before ever stepping a frame, so a parked worker here is exactly
// what every other production-topology gc page's own `__pageReady` state already is.
await parkWorkers(client)

installGcPage(harness, {
  adapter: device.adapterInfo,
  drive() {
    frame += 1
    cameraState.centreX += PAN_TILES_PER_FRAME
    harness.stepFrame(1000 / 60)
    stepSimTickSync(client, 1)
    harness.stepTick()
    uploadDrain.drain(DEFAULT_UPLOAD_BUDGET_BYTES)
    drawablesRenderer.acquire()
    renderer.writeFrameUniform(renderer.frameUniform)
    renderer.draw(target) // one shared pass: terrain's triangle, then attachDrawables' own layers.
    if (frame % DISPATCH_EVERY_FRAMES === 0) {
      dispatchRaw(client, seq, EXTRA_SPAWN_JSON_BYTES)
      seq += 1
    }
  },
})

window.__netCounters = () => netCounters(client)
window.__drawablesGcCounters = () => ({
  drawCalls: drawablesDrawCalls(drawablesRenderer),
  pipelineSwitches: pipelineSwitches(drawablesRenderer),
  instanceBytes: instanceBytes(drawablesRenderer),
  drawListDropped: drawListDropped(drawablesRenderer),
})

// `window.__drawablesTest` reads exclusively through `drawablesRenderer`'s own `TripleReader`
// (`acquire()`/`frameSeq()`/`recordCount()`/`nonEmptyLayerCount()`, `render/drawables.ts`) -- never
// a second, independent `TripleReader` over the same `drawList` SAB (`sab/triple.ts`'s own
// `acquire()` mutates shared triple-buffer state on every call, so two readers racing each other
// tear the "current front slot" handoff; found by this page's own first draft, Deviations).
window.__drawablesTest = {
  resume() {
    return resumeWorkers(client)
  },
  park() {
    return parkWorkers(client)
  },
  acquire() {
    drawablesRenderer.acquire()
  },
  frameSeq() {
    return drawablesRenderer.frameSeq()
  },
  recordCount() {
    return drawablesRenderer.recordCount()
  },
  nonEmptyLayerCount() {
    return drawablesRenderer.nonEmptyLayerCount()
  },
  drawListDropped() {
    return drawListDropped(drawablesRenderer)
  },
  stepClientFrameOnly() {
    harness.stepFrame(1000 / 60)
  },
  acquireAndDraw() {
    drawablesRenderer.acquire()
    renderer.writeFrameUniform(renderer.frameUniform)
    renderer.draw(target)
  },
  drawCallsNow() {
    return drawablesDrawCalls(drawablesRenderer)
  },
  populatedLayers() {
    return POPULATE_LAYERS
  },
}

window.__pageReady = true
