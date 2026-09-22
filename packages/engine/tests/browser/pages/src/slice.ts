// `slice.html`'s script (docs/plan/16-action-round-trip.md, step 6): the vertical slice itself --
// a real `createClient()` **single-player** topology (`host.connect: true`, fixture `puts`), real
// device/renderer (chunked world on screen), real camera/input (`createClient` installs both
// automatically on a real, document-attached canvas -- `device.ts`'s own precedent, unlike every
// manual-clock test fixture page), a real paced sim (`test.flags.pace = true`, `connected-paced.ts`'s
// own combination of "real-time pacing" + "the parked test-call channel stays reachable") and a
// Paint control. This is both the page `vertical_slice` (`vertical-slice.spec.ts`) drives *and* the
// page Tyler opens on the phone (`pnpm device:serve`, `docs/plan/device-checks.md` "M16: Vertical
// slice on the phone") -- one script, not a harness-driven `gc-*` page (`gc-slice.ts` is the
// separate, dedicated zero-GC-measured sibling: `installGcPage`'s manual-clock, harness-driven
// shape is incompatible with a real `requestAnimationFrame` production loop in the same script).
//
// The HUD (diagnostic only, outside the zero-GC rule, `device.ts`'s own precedent) shows exactly
// the field names `vertical_slice`'s own HUD-text assertion and `docs/plan/device-checks.md`'s
// "M16: Vertical slice on the phone" section both read (Provides, a contract M23/M39 also read):
// `confirmed`, `rejected`, `ring drops`, `engine_mem_grows` (per instance), `tick`. `?hud=0` hides
// the HUD element (a human running a long device session without the visual noise); the counters
// underneath it keep updating either way.
import type { Action } from '../../../../fixtures/puts/bindings/Action.ts'
import type { Reject } from '../../../../fixtures/puts/bindings/Reject.ts'
import { pxPerTile } from '../../../../src/camera/transform.ts'
import type { Client, ClientOptions } from '../../../../src/client.ts'
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import { systemClock, systemScheduler } from '../../../../src/clock.ts'
import {
  CLOCK_FIELD,
  ClockBlockView,
  readClockBlockInto,
  SessionState,
} from '../../../../src/clock-block.ts'
import { attachVisibilityHandling, createFrameLoop } from '../../../../src/frame-loop.ts'
import { installPageStyles } from '../../../../src/input/page-css.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import type { AdapterInfo, RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import type { FrameUniformValues, TerrainRenderer } from '../../../../src/render/terrain.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { createViewportController } from '../../../../src/render/viewport.ts'
import { RingConsumer, type RingStats } from '../../../../src/sab/ring.ts'
import {
  asHarness,
  type NetCounters,
  parkWorkers,
  netCounters as readNetCounters,
  worldHash as readWorldHash,
  resumeWorkers,
  simCounters,
} from '../../../../src/test/client.ts'
import {
  attachCameraInputTestHooks,
  injectPointer,
  type PointerPhase,
} from '../../../../src/test/input.ts'
import { readPixels, renderTo } from '../../../../src/test/render.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    /** Dispatches `Paint` at `(x, y)` with a resource layer distinct from pristine grass (`base:
     * 1, resource: 2` -- `connected-terrain.spec.ts`'s own `WATER`/identity-table precedent);
     * returns the `seq` `client.dispatch` itself returned. */
    __dispatchPaintAt?: (x: number, y: number) => number
    /** The production Paint control's own target: the tile under the screen centre, i.e. the
     * camera centre tile (an on-screen-centred camera, `pxPerTile`'s own space is device pixels,
     * irrelevant here -- the *world* tile under the centre is just the floor of the camera
     * centre). */
    __paintUnderCentre?: () => number
    // `__slice`-prefixed (not the bare `__confirmed`/`__rejected`/`__injectPointer` other pages in
    // this shared TS project already declare with a different type -- `puts-dispatch.ts`'s own
    // `__confirmed`/`__rejected` are plain `number` fields, `topology.ts`'s own `__injectPointer`
    // takes a 6th `pointerType` argument -- `declare global` merges across every page in one
    // project, so a same-named, differently-typed redeclaration is a real `tsc` error, not a
    // style choice).
    __sliceConfirmed?: () => number
    __sliceRejected?: () => number
    __sliceLastReject?: () => unknown
    __setCamera?: (x: number, y: number, tilesAcross: number) => void
    __sliceInjectPointer?: (
      phase: PointerPhase,
      id: number,
      cssX: number,
      cssY: number,
      tMs: number,
    ) => void
    __netCounters?: (conn?: number) => Promise<NetCounters>
    __worldHash?: () => Promise<string>
    __worldHashAndTick?: () => Promise<{ hash: string; tick: number }>
    __ringDrops?: () => number
    __tick?: () => number
    __hudText?: () => string
    __writeFrameUniform?: (v: FrameUniformValues) => void
    __renderAndRead?: (
      width: number,
      height: number,
    ) => Promise<{ width: number; height: number; data: number[] }>
    __errors?: () => string[]
    __adapterInfo?: () => AdapterInfo
  }
}

installPageStyles() // 0019 §3: pull-to-refresh structurally prevented, canvas touch-action

const params = new URL(location.href).searchParams
const hudVisible = params.get('hud') !== '0'

const hudEl = document.createElement('pre')
hudEl.id = 'hud'
document.body.appendChild(hudEl)
if (!hudVisible) hudEl.style.display = 'none'

const canvas = document.createElement('canvas')
document.body.appendChild(canvas)

const paintBtn = document.createElement('button')
paintBtn.id = 'paint-btn'
paintBtn.textContent = 'Paint'
document.body.appendChild(paintBtn)

const wasm = await fixtureWasm('puts')

const device: RendererDevice = await initDevice()
const renderer: TerrainRenderer = await createTerrainRenderer(device.device, {
  colorFormat: 'rgba8unorm',
  viewProbePasses: device.viewProbePasses,
  checkCompilation: device.checkCompilation,
})
const art = await loadTileArt(device.device, '/terrain/tiles.json', {
  checkCompilation: device.checkCompilation,
})
renderer.setTileArray(art.texture)
renderer.writeVisualTable(art.visualTableBytes)

const clientOptions: ClientOptions = {
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'slice', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  assets: { tiles: '/terrain/tiles.json' },
  // `connected-paced.ts`'s own combination: real-time sim pacing (the production default once a
  // connection is linked) *and* the parked-only `test-call` channel `worldHash`/`netCounters`
  // need -- `test: {}` alone would leave pacing off (`worker/sim.ts`'s `!message.test` gate).
  test: { flags: { pace: true } },
}
const client: Client = createClient(clientOptions)
attachCameraInputTestHooks(client, clientTestHandle(client).cameraBundle)

let workersReady = false
await client.ready
workersReady = true

// `device.ts`'s own precedent: `createFrameLoop`'s `render` phase writes whatever is currently in
// `renderer.frameUniform` (a mutable object the caller owns), so `onCamera` is where the real
// camera state (integrated by `client.camera.tick()` from real gestures) gets turned into that
// frame's `camTileX/Y`/`camFracX/Y`/`tilesPerPx` -- a different (device-pixel) space from `client.
// camera`'s own CSS-pixel one, `pxPerTile`'s own formula against `renderer.viewport`.
let lastCameraT: number | undefined
function onCamera(): void {
  const t = performance.now()
  const dtMs = lastCameraT === undefined ? 0 : t - lastCameraT
  lastCameraT = t
  client.camera.tick(dtMs) // real pan/pinch/wheel/WASD/inertia + semantic recognition

  const v = renderer.viewport
  const ppt = pxPerTile(client.cameraState, v)
  const camTileX = Math.floor(client.cameraState.centreX)
  const camTileY = Math.floor(client.cameraState.centreY)
  const fu = renderer.frameUniform
  fu.camTileX = camTileX
  fu.camTileY = camTileY
  fu.camFracX = client.cameraState.centreX - camTileX
  fu.camFracY = client.cameraState.centreY - camTileY
  fu.viewportPxW = v.widthPx
  fu.viewportPxH = v.heightPx
  fu.tilesPerPx = 1 / ppt
}

// `frame-loop.ts`'s own `createRealFrameLoop` always configures the canvas context with `navigator.
// gpu.getPreferredCanvasFormat()` (`render/viewport.ts`'s `configureCanvasContext`, no override) --
// `bgra8unorm` on most platforms. `__renderAndRead`'s own probe target is a fixed `rgba8unorm`
// offscreen texture (`engine/test.renderTo`'s own doc comment: "Creates a fresh `rgba8unorm`
// offscreen target"), and one `TerrainRenderer` draws into whatever target it is handed with its
// *one* pipeline's own fixed format -- a page that both draws to a real canvas *and* offers a pixel
// probe needs the two to agree, so this configures the canvas itself with `rgba8unorm` (a canvas
// format WebGPU always accepts, `bgra8unorm`/`rgba8unorm` both valid per spec, "preferred" is a
// performance hint, not a requirement) and builds `createViewportController`/`createFrameLoop`
// directly -- `createRealFrameLoop`'s own lower-level pieces -- instead of the format-fixed helper.
const ctx = canvas.getContext('webgpu')
if (!ctx) throw new Error('slice.ts: canvas.getContext("webgpu") returned null')
ctx.configure({ device: device.device, format: 'rgba8unorm', alphaMode: 'opaque' })

const viewport = createViewportController(canvas, renderer, {
  maxTextureDimension2D: device.device.limits.maxTextureDimension2D,
})
const loop = createFrameLoop({
  clock: systemClock,
  scheduler: systemScheduler,
  client,
  renderer,
  target: () => ctx.getCurrentTexture(),
  viewport,
  onCamera,
})
attachVisibilityHandling(loop)
loop.resume()

// --- Action results ----------------------------------------------------------------------------
let confirmed = 0
let rejected = 0
let lastReject: unknown
client.onActionResult<Reject>((_seq, result) => {
  if (result === 'Confirmed') confirmed += 1
  else {
    rejected += 1
    lastReject = result
  }
})

function paintAt(x: number, y: number): number {
  const action: Action = { Paint: { pos: { x, y }, base: 1, resource: 2 } }
  return client.dispatch(action)
}

window.__dispatchPaintAt = paintAt
window.__paintUnderCentre = () =>
  paintAt(Math.floor(client.cameraState.centreX), Math.floor(client.cameraState.centreY))
paintBtn.addEventListener('click', () => {
  window.__paintUnderCentre?.()
})

window.__sliceConfirmed = () => confirmed
window.__sliceRejected = () => rejected
window.__sliceLastReject = () => lastReject

window.__setCamera = (x, y, tilesAcross) => {
  client.cameraState.centreX = x
  client.cameraState.centreY = y
  client.cameraState.tilesAcross = tilesAcross
}
window.__sliceInjectPointer = (phase, id, cssX, cssY, tMs) => {
  injectPointer(client, phase, id, cssX, cssY, tMs)
}

// `worldHash`/`netCounters` both require the sim worker parked (`test/client.ts`'s own doc
// comments): this page's sim ticks in real time (`test.flags.pace`), so -- unlike a `stepTick`-
// driven page, already parked between calls -- a reading has to park first and resume afterward
// (`connected-paced.ts`'s own `__simCounters`, verbatim shape) so pacing keeps running once the
// read completes.
window.__netCounters = async (conn) => {
  await parkWorkers(client)
  const c = await readNetCounters(client, conn)
  await resumeWorkers(client)
  return c
}
window.__worldHash = async () => {
  await parkWorkers(client)
  const h = await readWorldHash(client)
  await resumeWorkers(client)
  return h
}
// `vertical_slice`'s own worldHash-vs-native-reference check: `worldHash()` and `simCounters().
// ticksRun` (== the sim's own current `Tick.0`, this page never drives a manual `CB_SIM_STEP_REQ`
// tick itself) read inside the *same* park window, so the pair is self-consistent even though
// real-time pacing keeps advancing the instant this call resumes -- reading them through two
// separate park/resume round trips (`__worldHash`/`__tick` above) would risk the sim ticking
// again between the two reads.
window.__worldHashAndTick = async () => {
  await parkWorkers(client)
  const h = await readWorldHash(client)
  const counters = await simCounters(client)
  await resumeWorkers(client)
  return { hash: h, tick: counters.ticksRun }
}

// --- `ring drops`: sum of `stats().drops` over every `SabSet` ring (Scope) ----------------------
// Side-effect-free reads (`RingConsumer.stats` only `Atomics.load`s the shared drop counter, never
// touches the pop cursor), so building one `RingConsumer` per ring purely to read `.stats()` never
// disturbs whatever real consumer already drains that ring.
const { sabs } = clientTestHandle(client)
const ringSabsForHud: SharedArrayBuffer[] = [
  sabs.uploadRing,
  sabs.actionRing,
  sabs.inputRing,
  sabs.uiRing,
  sabs.uplink,
  sabs.downlink,
  ...sabs.genRequest,
  ...sabs.genResult,
]
const ringConsumersForHud = ringSabsForHud.map((sab) => new RingConsumer(sab))
const ringStatsScratch: RingStats = { drops: 0, pushed: 0, popped: 0 }
function ringDrops(): number {
  let total = 0
  for (const c of ringConsumersForHud) {
    c.stats(ringStatsScratch)
    total += ringStatsScratch.drops
  }
  return total
}
window.__ringDrops = ringDrops

// --- `tick`: `authoritative_tick` from the clock block (Scope) ----------------------------------
const clockView = new ClockBlockView(sabs.clockBlock)
const clockScratch = new Uint32Array(6)
function authoritativeTick(): number {
  readClockBlockInto(clockView, clockScratch)
  return clockScratch[CLOCK_FIELD.AuthoritativeTick] as number
}
function sessionLive(): boolean {
  readClockBlockInto(clockView, clockScratch)
  return clockScratch[CLOCK_FIELD.SessionState] === SessionState.Live
}
window.__tick = authoritativeTick

// --- `engine_mem_grows` per instance (Scope: `asHarness(client).memGrows()`) --------------------
// Requires the worker parked (`Harness.memGrows`'s own doc comment): read on a slower cadence than
// the rest of the HUD, each reading its own brief park/resume pair, the same cost
// `connected-paced.ts`'s real-time page already accepts for a parked-only reading.
let memGrows: Record<string, number> = {}
async function refreshMemGrows(): Promise<void> {
  if (!workersReady) return
  await parkWorkers(client)
  memGrows = await asHarness(client).memGrows()
  await resumeWorkers(client)
}
setInterval(() => {
  refreshMemGrows().catch(() => {})
}, 3000)

// --- HUD text -------------------------------------------------------------------------------
function memGrowsText(): string {
  const names = Object.keys(memGrows).sort()
  if (names.length === 0) return '(pending)'
  return names.map((n) => `${n}=${memGrows[n]}`).join(' ')
}

function hudText(): string {
  return [
    'slice.html',
    `isolated: ${globalThis.crossOriginIsolated}`,
    `adapter: ${JSON.stringify(device.adapterInfo)}`,
    `workers ready: ${workersReady}`,
    `session live: ${workersReady ? sessionLive() : false}`,
    `confirmed: ${confirmed}`,
    `rejected: ${rejected}`,
    `ring drops: ${ringDrops()}`,
    `engine_mem_grows: ${memGrowsText()}`,
    `tick: ${workersReady ? authoritativeTick() : 0}`,
  ].join('\n')
}

function renderHud(): void {
  hudEl.textContent = hudText()
}
setInterval(renderHud, 200)
renderHud()
window.__hudText = hudText

// --- GPU readback probe (`vertical_slice`'s own terrain probes, `connected-terrain.ts`'s own
// `__writeFrameUniform`/`__renderAndRead` shape verbatim: the `Renderable` overload of `renderTo`,
// not `Client`'s -- the real render loop above already keeps `renderer`'s page/indirection
// textures converged via its own `uploadDrain`, so a second, independent `RingConsumer` here would
// race it over the same ring). -----------------------------------------------------------------
window.__writeFrameUniform = (v) => {
  renderer.writeFrameUniform(v)
}
window.__renderAndRead = async (width, height) => {
  const target = renderTo(renderer, { width, height })
  const pixels = await readPixels(target)
  return { width: pixels.width, height: pixels.height, data: Array.from(pixels.data) }
}
window.__errors = () => device.errors()
window.__adapterInfo = () => device.adapterInfo

window.__pageReady = true
