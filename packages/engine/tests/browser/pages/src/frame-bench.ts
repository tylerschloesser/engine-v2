// `frame-bench.html`: `bench.frame_worstcase`'s own page (docs/plan/17b-sprites-and-frame-budget.md
// steps 4-6, Planning decisions "Frame-time criterion lands here, not in M09"). A real, connected
// `fx-drawables` client (`host: { kind: 'local', connect: true }`, the same production topology
// `gc-drawables.ts` uses) at 0018 §6's own worst case -- 256x256 tiles, 65,536 drawables, maximum
// zoom-out -- driven by the *production* `systemClock`/`systemScheduler` (real `requestAnimationFrame`,
// `device.html`'s own precedent) so the benchmark measures real frame pacing, not a stepped
// approximation.
//
// **Reaching 65,536 replica entities without hitting `host::mod::SIM_TX_BYTES` (64 KiB per-tick
// frame budget, Non-scope here per the delegation prompt's "Known from cut 1"):** the grid is
// dispatched as many small `Action::SpawnMany` batches (128 entities each), not one giant action --
// each batch's own one-tick delta stays comfortably under that budget. One-time setup (0016 §2),
// entirely before the real rAF loop starts.
//
// **No `performance.now()` deltas computed in this file for the measurement itself** (the
// delegation prompt's own binding rule): this page only counts frames and, while `startMarking()`
// is armed, brackets the main-thread rAF callback with `performance.mark()` calls the Node-side test
// reads back as real trace-event timestamps (`frame-bench.spec.ts`) -- the same "a page script can
// always call `performance.mark` itself" precedent `tests/browser/gc/instrument.ts` documents for
// `main`. The client worker's own `frame()` call cannot be marked from inside this file (a
// production worker cannot call `performance.mark`, `.claude/rules/hot-paths.md`) -- the Node-side
// test brackets it instead, via a CDP-injected wrapper over `self.__engineInstance.call1` (exposed
// only because `test: { flags: {} }` below is truthy, the same escape hatch `workers.camera_
// block_reaches_wasm` already uses).
import { pxPerTile } from '../../../../src/camera/transform.ts'
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import type { Scheduler } from '../../../../src/clock.ts'
import { systemClock, systemScheduler } from '../../../../src/clock.ts'
import { createRealFrameLoop, type RealFrameLoop } from '../../../../src/frame-loop.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import { loadSpriteAtlas } from '../../../../src/render/atlas.ts'
import type { AdapterInfo, RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import {
  attachDrawables,
  createDrawablesRenderer,
  type DrawablesRenderer,
} from '../../../../src/render/drawables.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import {
  asHarness,
  dispatchRaw,
  parkWorkers,
  pumpUntilLive,
  resumeWorkers,
  stepSimTickSync,
} from '../../../../src/test/client.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __frameBench?: {
      adapterInfo: AdapterInfo
      recordCount: number
      errors(): string[]
      framesRendered(): number
      /** Arms per-frame `performance.mark` bracketing of the main-thread rAF callback
       * (`mf-s-<n>`/`mf-e-<n>`); resets the per-window counter to 0. */
      startMarking(): void
      stopMarking(): void
      /** `parkWorkers`/`resumeWorkers` (`src/test/client.ts`): a worker blocked in its normal
       * `Atomics.wait` loop never processes a CDP `Runtime.evaluate` (found empirically, this
       * milestone: the loop's own synchronous call stack never returns to the isolate's message
       * pump except through the park protocol's own `W_YIELD`/`W_PARKED` handshake, the same
       * "not blocked" property `resumeWorkers`'s own doc comment already names) -- the Node-side
       * test parks every worker once, right after setup and before the real rAF loop starts, so it
       * can reach the client worker to install its own `call1` wrapper (`frame-bench.spec.ts`),
       * then resumes before calling `start()`. */
      park(): Promise<void>
      resume(): Promise<void>
      /** Starts the real rAF loop (`real.loop.resume()`) -- not called automatically at the end of
       * this script's own top-level `await` chain, unlike every other real-client page here, so the
       * Node-side test can park/instrument the client worker first (above) with nothing yet
       * running for it to race against. */
      start(): void
    }
  }
}

// 0018 §6: "Worst case 256x256 = 65,536 tiles, ... 65,536 drawables" -- exactly `DrawList::CAPACITY`
// (`render/drawables.ts`'s own `CAPACITY`), so this scene is the worst case, not an approximation of
// it. Far from `fx-drawables`' own three genesis entities (near true origin) so `entities()`'s
// `visible()` clip sees this grid alone -- no golden this fixture owns depends on genesis's own
// entities ever seeing a wide camera.
const GRID_SIDE = 256
const BASE_X = 20_000
const BASE_Y = 20_000
// Each dispatched batch's own one-tick delta (`Host::build_frame`) must stay well under
// `host::mod::SIM_TX_BYTES` (64 KiB) -- 128 new entities/tick is comfortably inside that with room
// to spare even at a generous per-entity encoding estimate; growing that constant is Non-scope here
// (`host::mod.rs`'s own "provisional... a real join-burst budget is 0010's pacing/backpressure").
const BATCH_COLS = 128

const wasm = await fixtureWasm('drawables')
const canvas = document.createElement('canvas')
document.body.appendChild(canvas)

const assets = { tiles: '/terrain/tiles.json', sprites: '/drawables/sprites.json' }

const device: RendererDevice = await initDevice()
const gpuApi = (navigator as unknown as { gpu: GPU }).gpu
const colorFormat = gpuApi.getPreferredCanvasFormat()

const renderer = await createTerrainRenderer(device.device, {
  colorFormat,
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
    world: { worldId: 'frame-bench', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  assets,
  // Exposes `self.__engineInstance` in every worker (`worker/client.ts setup()`'s own "debugging/
  // test convenience"), the CDP-side hook `frame-bench.spec.ts` wraps `call1` through -- no clock/
  // scheduler override, so `createRealFrameLoop` below still runs on the real, un-overridden
  // `systemClock`/`systemScheduler`.
  test: { flags: {} },
})
await pumpUntilLive(client)
const harness = asHarness(client)

const drawListSab = clientTestHandle(client).sabs.drawList
const drawablesRenderer: DrawablesRenderer = await createDrawablesRenderer(device.device, {
  colorFormat,
  drawListSab,
  checkCompilation: device.checkCompilation,
})
attachDrawables(renderer, drawablesRenderer)

const spriteAtlas = await loadSpriteAtlas(device.device, assets.sprites, {
  checkCompilation: device.checkCompilation,
})
drawablesRenderer.setSpriteAtlas(spriteAtlas)

// --- Worst-case population: 65,536 entities, `sprite: true` (exercises the atlas/data-texture reads
// under load too, Notes for cut 2: "cut 2's benchmark can spawn entities with `sprite: true`
// directly"), dispatched as `GRID_SIDE * (GRID_SIDE / BATCH_COLS)` small batches. One-time setup
// (0016 §2), entirely before `real.loop.resume()` below.
const cameraState = client.cameraState
cameraState.centreX = BASE_X + GRID_SIDE / 2
cameraState.centreY = BASE_Y + GRID_SIDE / 2
cameraState.tilesAcross = GRID_SIDE // 0018 §6's own "maximum zoom-out" figure (FrameView.zoom())
cameraState.halfExtentTilesX = GRID_SIDE / 2 + 2
cameraState.halfExtentTilesY = GRID_SIDE / 2 + 2

let seq = 1
for (let row = 0; row < GRID_SIDE; row++) {
  for (let colStart = 0; colStart < GRID_SIDE; colStart += BATCH_COLS) {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        SpawnMany: {
          origin: { x: BASE_X + colStart, y: BASE_Y + row },
          cols: BATCH_COLS,
          rows: 1,
          spacing: 1,
          layer: 0,
          sprite: true,
        },
      }),
    )
    dispatchRaw(client, seq, bytes)
    seq += 1
    harness.stepFrame(1000 / 60)
    stepSimTickSync(client, 1)
  }
}
// Lets the trailing batch's own delta actually land in the replica before the real rAF loop's first
// `frame()` reads it (`gc-drawables.ts`'s own precedent, same reasoning).
harness.stepFrame(1000 / 60)
stepSimTickSync(client, 1)
harness.stepTick()

// --- Real rAF loop -------------------------------------------------------------------------------
let framesRendered = 0
let marking = false
let markSeq = 0

function onCamera(): void {
  // Static camera (no autopan): 0018 §9's own "worst-case *view*", not a panning scene -- a fixed
  // camera keeps the measured window's own cost attributable to the DrawList/render path alone, not
  // camera-integration/pan work `draw.screen_px_stroke_constant_under_zoom` and friends already
  // cover elsewhere.
  const v = renderer.viewport
  const ppt = pxPerTile(cameraState, v)
  const camTileX = Math.floor(cameraState.centreX)
  const camTileY = Math.floor(cameraState.centreY)
  const camFracX = cameraState.centreX - camTileX
  const camFracY = cameraState.centreY - camTileY
  const fu = renderer.frameUniform
  fu.camTileX = camTileX
  fu.camTileY = camTileY
  fu.camFracX = camFracX
  fu.camFracY = camFracY
  fu.viewportPxW = v.widthPx
  fu.viewportPxH = v.heightPx
  fu.tilesPerPx = 1 / ppt

  // `DrawList::snap_window_origin` floors to the nearest multiple of 64 (`client/drawlist.rs`):
  // mirrored here so the sprite/shape geometry lands roughly where the camera is pointed (this page
  // asserts no pixel, so exactness does not change the measured cost -- every instance's vertex/
  // fragment work runs regardless of its own screen position).
  const windowOriginX = (camTileX >> 6) << 6
  const windowOriginY = (camTileY >> 6) << 6
  drawablesRenderer.writeFrameUniform({
    camTileX,
    camTileY,
    camFracX,
    camFracY,
    windowOriginX,
    windowOriginY,
    cursorTileX: 0,
    cursorTileY: 0,
    viewportPxW: v.widthPx,
    viewportPxH: v.heightPx,
    tilesPerPx: 1 / ppt,
    cursorValid: 0,
  })
  drawablesRenderer.acquire()
}

// A thin wrapper around `systemScheduler`, `device.html`'s own `instrumentedScheduler` precedent:
// while `marking` is armed, brackets the whole rAF callback (camera + upload + render + drawables
// acquire) with a pair of uniquely-named `performance.mark`s so the Node-side test can read their
// real trace-event timestamps back (never a `performance.now()` delta computed here).
const instrumentedScheduler: Scheduler = {
  setTimer: (cb, ms) => systemScheduler.setTimer(cb, ms),
  clearTimer: (id) => systemScheduler.clearTimer(id),
  requestFrame: (cb) =>
    systemScheduler.requestFrame((tMs) => {
      if (marking) {
        const n = markSeq
        markSeq += 1
        performance.mark(`mf-s-${n}`)
        cb(tMs)
        performance.mark(`mf-e-${n}`)
      } else {
        cb(tMs)
      }
      framesRendered += 1
    }),
  cancelFrame: (id) => systemScheduler.cancelFrame(id),
}

const real: RealFrameLoop = createRealFrameLoop({
  client,
  renderer,
  canvas,
  clock: systemClock,
  scheduler: instrumentedScheduler,
  maxTextureDimension2D: device.device.limits.maxTextureDimension2D,
  onCamera,
})

window.__frameBench = {
  adapterInfo: device.adapterInfo,
  recordCount: GRID_SIDE * GRID_SIDE,
  errors(): string[] {
    return device.errors()
  },
  framesRendered(): number {
    return framesRendered
  },
  startMarking(): void {
    markSeq = 0
    marking = true
  },
  stopMarking(): void {
    marking = false
  },
  park(): Promise<void> {
    return parkWorkers(client)
  },
  resume(): Promise<void> {
    return resumeWorkers(client)
  },
  start(): void {
    real.loop.resume()
  },
}

window.__pageReady = true
