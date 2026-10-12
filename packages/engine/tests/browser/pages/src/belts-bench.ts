// `belts-bench.html`: `bench.frame_belts`'s page (M50; `frame-bench-belts.spec.ts`). `frame-bench.ts`'s
// real-rAF pattern (a connected local client on the production `systemClock`/`systemScheduler`,
// `mf-s-<n>`/`mf-e-<n>` marks around the rAF callback while armed, `park`/`resume`/`start` for the
// spec's worker wrapper) over `fx-belts`' worst case for one viewport: the bench genesis's
// `SaturatedView { jam_pct: 0, period: 0 }` at scale 1 (144 rows of 256 belt tiles, 2,974 lines,
// 294,912 items, every lane packed and flowing; 0076's figures), at the full-scale caps
// (`BENCH_CAPS`, `tests/netcode/support.ts`) with the chunk pacing lifted as `beltsBenchWorld` does
// (the join settles in seconds, not minutes). The fixture's `extract` draws one belt sprite per belt
// tile in view, then the items (none below 20 px a tile: 64 tiles across this canvas or closer).
//
// The scene by query string, on a 1280 x 720 canvas centred on the stream (128, 72): `?zoom=max`
// (256 tiles across, 5 px a tile: every belt tile in view, no item) or `?zoom=<n>` tiles across
// (the spec's other scene is 64: 20 px a tile, the fixture's item cut, 2,829 belt tiles and their
// items; `profile-frame` may pass any n). A slow triangle-wave pan along x
// (12 tiles a second at 60 frames a second, a per-frame step as the reference bench's `steer()`),
// starting at the centre, held there by `holdPan()` until the spec calls `releasePan()`, so the
// join and the pinned record counts see the same camera.
//
// The join runs under the real loop after `start()`: the spec waits on `beltTiles()` (the acquired
// slot's layer-1 count: one belt sprite per tile of a held line in view, so it reaches the view's
// belt tiles once the view's lines are held) before it measures. Numbers only on the per-frame path.
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
  benchProbe,
  parkWorkers,
  pumpUntilLive,
  resumeWorkers,
} from '../../../../src/test/client.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __beltsBench?: {
      adapterInfo: AdapterInfo
      /** 256 (`?zoom=max`) or n (`?zoom=<n>`, 12..256). */
      tilesAcross: number
      errors(): string[]
      framesRendered(): number
      /** The acquired slot's `record_count` (`DrawablesRenderer.recordCount()`). */
      records(): number
      /** The smallest and largest `record_count` of the frames marked since `startMarking()`. */
      recordsMin(): number
      recordsMax(): number
      dropped(): number
      /** The largest `dropped` of the frames marked since `startMarking()`. */
      droppedMax(): number
      /** The acquired slot's layer-1 count: the fixture's belt sprites (`BELT_LAYER`). */
      beltTiles(): number
      /** The acquired slot's non-empty layers (`DrawablesRenderer.nonEmptyLayerCount()`). */
      layers(): number
      /** `engine_mem_grows` of the sim and client workers (`benchProbe`). */
      memGrows(): { sim: number; client: number }
      startMarking(): void
      stopMarking(): void
      holdPan(): void
      releasePan(): void
      park(): Promise<void>
      resume(): Promise<void>
      start(): void
    }
  }
}

/** The stream: 256 x 144 belt tiles from (0, 0) (`saturated_view_world`). */
const CENTRE_X = 128
const CENTRE_Y = 72
const CANVAS_W = 1280
const CANVAS_H = 720
/** The pan: 12 tiles a second at 60 frames a second (`games/reference/src/bench.ts` `steer()`). */
const PAN_TILES_PER_FRAME = 12 / 60
/** Half the pan's swing: at 256 across the view keeps at least 97 % of the stream, at 64 across it
 * never leaves it. */
const PAN_AMP_TILES = 8
/** The drawables header's `layer_count[8]` (`client/drawlist.rs`; `render/drawables.ts`). */
const OFF_LAYER_COUNT = 16
const BELT_LAYER = 1
/** `recordsMin` before the first marked frame. */
const RECORDS_NONE = 0x7fff_ffff

const zoomParam = new URLSearchParams(location.search).get('zoom') ?? 'max'
const tilesAcross = zoomParam === 'max' ? 256 : Number(zoomParam)
if (!Number.isInteger(tilesAcross) || tilesAcross < 12 || tilesAcross > 256) {
  throw new Error(`belts-bench: ?zoom is max or an integer 12..256 (got '${zoomParam}')`)
}

const wasm = await fixtureWasm('belts')
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

const LIFTED = 1_000_000_000
const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: {
      // One world id per scene: the spec opens the scenes one after another in one browser
      // context, and a distinct id keeps a scene from ever meeting the previous one's world lock.
      worldId: `belts-bench-${tilesAcross}`,
      params: {
        seed: '7',
        worldgen: {
          bench: { seed: 7, scale: 1, regime: { SaturatedView: { jam_pct: 0, period: 0 } } },
        },
        // `BENCH_CAPS`: the recommended line cap (8 index tiles a line; this world has 73,728 lane
        // tiles) and an item cap that never binds (294,912 items, over the 262,144 default).
        maxLines: 32_768,
        maxItems: 393_216,
      },
      bandwidth: {
        softCapBytesPerS: LIFTED,
        chunkRefillBytesPerS: LIFTED,
        chunkBurstBytes: LIFTED,
        hardCapBytesPerS: LIFTED,
      },
    },
    connect: true,
  },
  genWorkers: 1,
  assets,
  // `self.__engineInstance` in every worker: the spec's `frame()` wrapper (`frame-bench.ts`).
  // `pace`: the sim ticks in real time (a page with `test` otherwise steps every tick itself);
  // `noOpfs`: no persistence (nothing measured needs it, and no world outlives its scene).
  test: { flags: { pace: true, noOpfs: true } },
})
await pumpUntilLive(client)

const drawListSlot = clientTestHandle(client).drawListSlot
const drawablesRenderer: DrawablesRenderer = await createDrawablesRenderer(device.device, {
  colorFormat,
  drawListSlot,
  checkCompilation: device.checkCompilation,
})
// `render/client-drawables.ts`' shape: the drawables' frame uniform copied from the terrain's staged
// bytes with the acquired slot's window origin, no per-frame object literal (unlike `frame-bench.ts`).
drawablesRenderer.bindTerrainFrame(renderer.stagedFrameUniform)
attachDrawables(renderer, {
  ...drawablesRenderer,
  encodeInto(pass) {
    drawablesRenderer.writeFrameUniformFromTerrain(
      drawListSlot.windowOriginX,
      drawListSlot.windowOriginY,
      0,
      0,
      0,
    )
    return drawablesRenderer.encodeInto(pass)
  },
})
drawablesRenderer.setSpriteAtlas(
  await loadSpriteAtlas(device.device, assets.sprites, {
    checkCompilation: device.checkCompilation,
  }),
)
const probe = benchProbe(client)

// The camera by hand, as `frame-bench.ts` (its `onCamera` never calls `integrate()`): the half
// extents `camera/transform.ts` derives for a 1280 x 720 viewport at this zoom.
const cameraState = client.cameraState
const ppt = Math.max(CANVAS_W, CANVAS_H) / tilesAcross
cameraState.centreX = CENTRE_X
cameraState.centreY = CENTRE_Y
cameraState.tilesAcross = tilesAcross
cameraState.halfExtentTilesX = CANVAS_W / (2 * ppt)
cameraState.halfExtentTilesY = CANVAS_H / (2 * ppt)

let framesRendered = 0
let marking = false
let markSeq = 0
let panHeld = true
let panFrames = 0
let recordsMin = 0
let recordsMax = 0
let droppedMax = 0

/** The triangle wave: 0 at the centre, up to `+AMP`, down to `-AMP`, back (period `4 AMP`). */
function panOffset(d: number): number {
  const p = d % (4 * PAN_AMP_TILES)
  if (p < PAN_AMP_TILES) return p
  if (p < 3 * PAN_AMP_TILES) return 2 * PAN_AMP_TILES - p
  return p - 4 * PAN_AMP_TILES
}

function onCamera(): void {
  if (!panHeld) panFrames += 1
  cameraState.centreX = CENTRE_X + panOffset(panFrames * PAN_TILES_PER_FRAME)

  const v = renderer.viewport
  const tilePx = pxPerTile(cameraState, v)
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
  fu.tilesPerPx = 1 / tilePx
  // The drawables' uniform is copied from the terrain's staged one in `encodeInto` (below).
  drawablesRenderer.acquire()
  if (marking) {
    const n = drawablesRenderer.recordCount()
    if (n < recordsMin) recordsMin = n
    if (n > recordsMax) recordsMax = n
    const d = drawablesRenderer.drawListDropped()
    if (d > droppedMax) droppedMax = d
  }
}

// `frame-bench.ts`'s `instrumentedScheduler`: the whole rAF callback between two marks while armed.
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

window.__beltsBench = {
  adapterInfo: device.adapterInfo,
  tilesAcross,
  errors: () => device.errors(),
  framesRendered: () => framesRendered,
  records: () => drawablesRenderer.recordCount(),
  recordsMin: () => recordsMin,
  recordsMax: () => recordsMax,
  dropped: () => drawablesRenderer.drawListDropped(),
  droppedMax: () => droppedMax,
  beltTiles: () => drawListSlot.header.getUint32(OFF_LAYER_COUNT + 4 * BELT_LAYER, true),
  layers: () => drawablesRenderer.nonEmptyLayerCount(),
  memGrows: () => ({ sim: probe.simGrows(), client: probe.clientGrows() }),
  startMarking(): void {
    markSeq = 0
    recordsMin = RECORDS_NONE
    recordsMax = 0
    droppedMax = 0
    marking = true
  },
  stopMarking(): void {
    marking = false
  },
  holdPan(): void {
    panHeld = true
    panFrames = 0
  },
  releasePan(): void {
    panHeld = false
  },
  park: () => parkWorkers(client),
  resume: () => resumeWorkers(client),
  start(): void {
    real.loop.resume()
  },
}

window.__pageReady = true
