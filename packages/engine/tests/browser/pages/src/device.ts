// `device.html`: the manual fill-rate/HUD page (docs/plan/09b-terrain-art-and-lifecycle.md, step 7)
// Tyler opens on a phone through M03's `pnpm device:serve --tunnel` (`docs/plan/device-checks.md`,
// "M09b: Terrain fill rate"), and the host `canvas.spec.ts`'s two automated tests drive against
// (`canvas: presents`, `frame-loop: production runs phases in order`) -- the exit criterion "`device
// .html` runs the production `createFrameLoop` ... driven by `requestAnimationFrame` through the
// injected `Scheduler`" names this page specifically. Unlike every other real-client page in this
// suite (`terrain-client.ts`, `gc-terrain.ts`, `viewport.ts`), this one uses the *production*
// `systemClock`/`systemScheduler` (real `requestAnimationFrame`, real wall-clock time) -- 0020 §3's
// "browser tests never use real rAF pacing" rule is about lockstep determinism tests, not this page,
// which exists specifically to measure real frame pacing.
//
// The HUD is a diagnostic page, explicitly outside the zero-GC rule (Planning decisions): nothing
// here worries about per-frame allocation the way `.claude/rules/hot-paths.md` requires of
// production code.
import type { Client, RenderOptions } from '../../../../src/client.ts'
import { createClient } from '../../../../src/client.ts'
import type { Scheduler } from '../../../../src/clock.ts'
import { systemClock, systemScheduler } from '../../../../src/clock.ts'
import type { FramePhase, RealFrameLoop } from '../../../../src/frame-loop.ts'
import {
  attachVisibilityHandling,
  createRealFrameLoop,
  FRAME_PHASES,
} from '../../../../src/frame-loop.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import type { AdapterInfo, RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import type { TerrainRenderer } from '../../../../src/render/terrain.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
  }
}

// --- URL parameters (Seams, Provides) ------------------------------------------------------
// `tiles`/`x`/`y`/`autopan`/`scale`/`scaleCap`/`cutoff` are this milestone's own; `probe`/`harness`/
// `anchors`/`anchorMode`/`module` are reserved for M11/M17b/M18/M06b -- "reserved" means this page
// tolerates them (an unknown `URLSearchParams` key is simply never read), not that it acts on them.
const params = new URL(location.href).searchParams
const tilesAcross = params.has('tiles') ? Number(params.get('tiles')) : undefined
const startX = params.has('x') ? Number(params.get('x')) : 0
const startY = params.has('y') ? Number(params.get('y')) : 0
const autopan = params.get('autopan') === '1' || params.get('autopan') === 'true'
const renderOptions: RenderOptions = {}
if (params.has('scale')) renderOptions.scale = Number(params.get('scale'))
if (params.has('scaleCap')) renderOptions.scaleCap = Number(params.get('scaleCap'))
if (params.has('cutoff')) renderOptions.neighbourCutoffPx = Number(params.get('cutoff'))

// --- Rolling stats (10 s window; HUD-only, allocation not a concern here) -----------------
const WINDOW_MS = 10_000

class RollingStat {
  private readonly ts: number[] = []
  private readonly vs: number[] = []

  push(t: number, v: number): void {
    this.ts.push(t)
    this.vs.push(v)
    const cutoff = t - WINDOW_MS
    let drop = 0
    while (drop < this.ts.length && (this.ts[drop] as number) < cutoff) drop++
    if (drop > 0) {
      this.ts.splice(0, drop)
      this.vs.splice(0, drop)
    }
  }

  values(): readonly number[] {
    return this.vs
  }
}

function percentile(vals: readonly number[], p: number): number {
  if (vals.length === 0) return 0
  const sorted = [...vals].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx] as number
}

const rafInterval = new RollingStat()
const callbackDuration = new RollingStat()
const gpuLatency = new RollingStat()
let lastRafTime: number | undefined
let framesRendered = 0
let gpuSampleCounter = 0
const GPU_SAMPLE_EVERY_N_FRAMES = 30

// --- Test-only phase-order log (Tests added: `frame-loop.production_runs_phases_in_order`) -----
// Bounded so a real, multi-minute device session never grows this unbounded; the automated test
// only ever needs a handful of frames' worth.
const PHASE_LOG_FRAMES = 40
const PHASE_LOG_CAP = FRAME_PHASES.length * PHASE_LOG_FRAMES
const phaseLog: FramePhase[] = []

function onPhase(phase: FramePhase): void {
  if (phaseLog.length < PHASE_LOG_CAP) phaseLog.push(phase)
}

// --- Device/renderer/client setup -----------------------------------------------------------
const hudEl = document.getElementById('hud') as HTMLPreElement
const canvas = document.createElement('canvas')
document.body.appendChild(canvas)

const device: RendererDevice = await initDevice()
const gpuApi = (navigator as unknown as { gpu: GPU }).gpu
const renderer: TerrainRenderer = await createTerrainRenderer(device.device, {
  colorFormat: gpuApi.getPreferredCanvasFormat(),
  viewProbePasses: device.viewProbePasses,
  checkCompilation: device.checkCompilation,
})
const art = await loadTileArt(device.device, '/terrain/tiles.json', {
  checkCompilation: device.checkCompilation,
})
renderer.setTileArray(art.texture)
renderer.writeVisualTable(art.visualTableBytes)

const wasm = await fixtureWasm('terrain')
const client: Client = createClient({
  canvas,
  wasm,
  host: { kind: 'remote', url: 'ws://unused.invalid' },
  assets: { tiles: '/terrain/tiles.json' },
  render: renderOptions,
})
let workersReady = false
await client.ready
workersReady = true

if (tilesAcross !== undefined) client.cameraState.tilesAcross = tilesAcross
client.cameraState.centreX = startX
client.cameraState.centreY = startY
// 0018 §6: "tiles across the long axis" -- half that per axis, a stand-in for M11's own camera ->
// half-extent maths (Non-scope).
client.cameraState.halfExtentTilesX = client.cameraState.tilesAcross / 2
client.cameraState.halfExtentTilesY = client.cameraState.tilesAcross / 2

// ~4 tiles/second (gc-terrain.ts's own scripted-pan precedent, halved: this page runs at real rAF
// pacing for minutes at a time, not a fixed 600-frame window). `frame-loop.ts`'s own "camera" phase
// is a no-op in production until M11 (Non-scope: "the device page uses scripted motion via
// `autopan`"), so this callback both drives the pan *and* stands in for M11's own camera -> frame-
// uniform maths (`camTile`/`camFrac`/`tilesPerPx`), computed fresh every tick from whatever
// `renderer.viewport` currently is (already applied for this frame: `viewport?.applyPending()` runs
// before `onPhase('camera')`/`onCamera()` in `frame-loop.ts`'s own `tick()`).
const PAN_TILES_PER_SECOND = 4
let lastCameraT: number | undefined
function onCamera(): void {
  const t = performance.now()
  if (autopan) {
    const dtS = lastCameraT === undefined ? 0 : (t - lastCameraT) / 1000
    client.cameraState.centreX += PAN_TILES_PER_SECOND * dtS
  }
  lastCameraT = t

  const v = renderer.viewport
  const longAxisPx = Math.max(v.widthPx, v.heightPx, 1)
  const tilesPerPx = client.cameraState.tilesAcross / longAxisPx
  const camTileX = Math.floor(client.cameraState.centreX)
  const camTileY = Math.floor(client.cameraState.centreY)
  const fu = renderer.frameUniform
  fu.camTileX = camTileX
  fu.camTileY = camTileY
  fu.camFracX = client.cameraState.centreX - camTileX
  fu.camFracY = client.cameraState.centreY - camTileY
  fu.viewportPxW = v.widthPx
  fu.viewportPxH = v.heightPx
  fu.tilesPerPx = tilesPerPx
}

// A thin wrapper around `systemScheduler` (still real `requestAnimationFrame` underneath -- the
// exit criterion's own "driven by `requestAnimationFrame` through the injected `Scheduler`"):
// measures the real rAF interval and this frame's whole JS callback duration (0018 §9's "main-
// thread rAF callback" budget), and samples GPU latency via `onSubmittedWorkDone()` once every
// `GPU_SAMPLE_EVERY_N_FRAMES` frames (Planning decisions "HUD contents").
const instrumentedScheduler: Scheduler = {
  setTimer: (cb, ms) => systemScheduler.setTimer(cb, ms),
  clearTimer: (id) => systemScheduler.clearTimer(id),
  requestFrame: (cb) =>
    systemScheduler.requestFrame((tMs) => {
      if (lastRafTime !== undefined) rafInterval.push(tMs, tMs - lastRafTime)
      lastRafTime = tMs
      const start = performance.now()
      cb(tMs)
      const dur = performance.now() - start
      callbackDuration.push(performance.now(), dur)
      framesRendered += 1
      gpuSampleCounter += 1
      if (gpuSampleCounter % GPU_SAMPLE_EVERY_N_FRAMES === 0) {
        const gpuStart = performance.now()
        device.device.queue.onSubmittedWorkDone().then(() => {
          const now = performance.now()
          gpuLatency.push(now, now - gpuStart)
        })
      }
    }),
  cancelFrame: (id) => systemScheduler.cancelFrame(id),
}

const real: RealFrameLoop = createRealFrameLoop({
  client,
  renderer,
  canvas,
  clock: systemClock,
  scheduler: instrumentedScheduler,
  render: renderOptions,
  maxTextureDimension2D: device.device.limits.maxTextureDimension2D,
  onCamera,
  onPhase,
})
attachVisibilityHandling(real.loop)
real.loop.resume()

// --- HUD text ---------------------------------------------------------------------------------
function fmt(n: number, digits = 1): string {
  return n.toFixed(digits)
}

function renderHud(): void {
  const v = renderer.viewport
  const raf = rafInterval.values()
  const cb = callbackDuration.values()
  const gpuVals = gpuLatency.values()
  const over20 = raf.filter((x) => x > 20).length
  const lines = [
    `device.html  (tiles=${client.cameraState.tilesAcross} autopan=${autopan ? 1 : 0})`,
    `isolated: ${globalThis.crossOriginIsolated}`,
    `adapter.info: ${JSON.stringify(device.adapterInfo)}`,
    `workers ready: ${workersReady}`,
    `canvas: ${v.widthPx}x${v.heightPx}px  dpr=${v.dpr}  renderScale=${v.renderScale}`,
    `rAF interval p50/p95/worst (10s): ${fmt(percentile(raf, 0.5))} / ${fmt(percentile(raf, 0.95))} / ${fmt(raf.length ? Math.max(...raf) : 0)} ms  (n=${raf.length})`,
    `rAF intervals >20ms (10s): ${over20}`,
    `main rAF callback p95 (10s): ${fmt(percentile(cb, 0.95), 2)} ms`,
    `GPU latency p95 (10s, sampled every ${GPU_SAMPLE_EVERY_N_FRAMES} frames): ${fmt(percentile(gpuVals, 0.95), 2)} ms  (n=${gpuVals.length})`,
    `frames rendered: ${framesRendered}`,
  ]
  hudEl.textContent = lines.join('\n')
}

setInterval(renderHud, 200)
renderHud()

// --- Test hook (canvas.spec.ts: `canvas: presents`, `frame-loop: production runs phases in
// order`) -- and Tyler's own manual troubleshooting via the Playwright CLI skill. ----------------
window.__device = {
  adapterInfo(): AdapterInfo {
    return device.adapterInfo
  },
  framesRendered(): number {
    return framesRendered
  },
  phaseLog(): FramePhase[] {
    return phaseLog.slice()
  },
  errors(): string[] {
    return device.errors()
  },
}

window.__pageReady = true
