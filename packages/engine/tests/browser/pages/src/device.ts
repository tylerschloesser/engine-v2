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
//
// M11 step 8 (docs/plan/11-camera-and-input.md, Scope: "device.html additions: gestures enabled,
// `?module=url`, and `?probe=memory`"): `onCamera` below is no longer a hand-written stand-in for
// the camera -> frame-uniform maths (docs/plan/09b-terrain-art-and-lifecycle.md Deviations,
// "Interpretation calls") -- `client.camera.tick()` is the real `CameraIntegrator`/
// `SemanticRecognizer`, driven by the real gesture listeners `createClient` now installs on this
// page's own canvas/window (`src/client.ts`); this page only still computes the GPU frame uniform's
// own `camTileX/Y`/`camFracX/Y`/`tilesPerPx` by hand, using `transform.ts`'s `pxPerTile` verbatim
// against the *render* viewport (device pixels) -- a different space from the camera's own internal
// CSS-pixel one (`camera/transform.ts`'s own doc comment), which is why this can't also come from
// `client.camera.read()`.
import { pxPerTile } from '../../../../src/camera/transform.ts'
import type { Client, ClientOptions, RenderOptions } from '../../../../src/client.ts'
import { createClient } from '../../../../src/client.ts'
import type { Scheduler } from '../../../../src/clock.ts'
import { systemClock, systemScheduler } from '../../../../src/clock.ts'
import type { FramePhase, RealFrameLoop } from '../../../../src/frame-loop.ts'
import {
  attachVisibilityHandling,
  createRealFrameLoop,
  FRAME_PHASES,
} from '../../../../src/frame-loop.ts'
import { installPageStyles } from '../../../../src/input/page-css.ts'
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
// `tiles`/`x`/`y`/`autopan`/`scale`/`scaleCap`/`cutoff` are M09b's own; `anchors`/`anchorMode` are
// reserved for M18 -- "reserved" means this page tolerates them (an unknown `URLSearchParams` key is
// simply never read), not that it acts on them. `module`/`probe` (with `probe=memory`'s own
// `touch`/`sim`/`client`) are this range's own (M11 step 8), `harness` is M17b's.
const params = new URL(location.href).searchParams
const tilesAcross = params.has('tiles') ? Number(params.get('tiles')) : undefined
const startX = params.has('x') ? Number(params.get('x')) : 0
const startY = params.has('y') ? Number(params.get('y')) : 0
const autopan = params.get('autopan') === '1' || params.get('autopan') === 'true'
const renderOptions: RenderOptions = {}
if (params.has('scale')) renderOptions.scale = Number(params.get('scale'))
if (params.has('scaleCap')) renderOptions.scaleCap = Number(params.get('scaleCap'))
if (params.has('cutoff')) renderOptions.neighbourCutoffPx = Number(params.get('cutoff'))
// 0017 §4 fallback (M11-boot's own *If it fails*): post the compiled `Module` by default; `?module
// =url` instead posts `wasmUrl` and lets each worker compile it itself.
const postModule = params.get('module') !== 'url'

const wasm = await fixtureWasm('terrain')

/** M09b step 7's own page, unchanged: the fill-rate/lifecycle HUD, gestures now real (M11). */
async function runFillRateHud(): Promise<void> {
  installPageStyles() // 0019 §3 page CSS: pull-to-refresh structurally prevented, canvas touch-action

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
  renderer.setTileArray(art.texture, art.gpuBytes)
  renderer.writeVisualTable(art.visualTableBytes)

  const clientOptions: ClientOptions = {
    canvas,
    wasm,
    host: { kind: 'remote', url: 'ws://unused.invalid' },
    assets: { tiles: '/terrain/tiles.json' },
    render: renderOptions,
  }
  if (!postModule) clientOptions.test = { flags: { postModule: false } }
  const client: Client = createClient(clientOptions)
  let workersReady = false
  await client.ready
  workersReady = true

  if (tilesAcross !== undefined) client.cameraState.tilesAcross = tilesAcross
  client.cameraState.centreX = startX
  client.cameraState.centreY = startY

  // ~4 tiles/second (gc-terrain.ts's own scripted-pan precedent, halved: this page runs at real rAF
  // pacing for minutes at a time, not a fixed 600-frame window). Direct `centreX` nudging, same as
  // before M11 (Non-scope: "the device page uses scripted motion via `autopan`") -- `client.camera.
  // tick()` below integrates real gestures on top of it exactly the way it would for any other
  // programmatic camera movement (`moveTo`, a follow target, ...).
  const PAN_TILES_PER_SECOND = 4
  let lastCameraT: number | undefined
  function onCamera(): void {
    const t = performance.now()
    const dtMs = lastCameraT === undefined ? 0 : t - lastCameraT
    lastCameraT = t
    if (autopan) client.cameraState.centreX += PAN_TILES_PER_SECOND * (dtMs / 1000)

    client.camera.tick(dtMs) // real pan/pinch/wheel/WASD/inertia + semantic recognition (M11)

    // The frame uniform's own `camTileX/Y`/`camFracX/Y`/`tilesPerPx` are in *device* pixels
    // (`renderer.viewport`), a different space from `client.camera`'s own CSS-pixel one -- see this
    // file's own header comment. `pxPerTile` is `transform.ts`'s real formula, used verbatim.
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
      `camera: restored=${client.camera.restored}  cursorTile=(${client.cameraState.cursorTileX},${client.cameraState.cursorTileY}) valid=${client.cameraState.cursorValid}`,
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
}

// --- `?probe=memory` (docs/plan/device-checks.md, M11-memory) -------------------------------
async function runMemoryProbe(): Promise<void> {
  const hudEl = document.getElementById('hud') as HTMLPreElement
  const log: string[] = []
  function report(): void {
    hudEl.textContent = log.join('\n')
  }
  function say(line: string): void {
    log.push(line)
    report()
  }

  // Step 1: grow a scratch memory in 64 MiB steps to 1 GiB, recording the ceiling this tab allows
  // before the browser refuses (or kills the page) -- independent of the real engine.
  const MIB = 1024 * 1024
  const STEP_MIB = 64
  const MAX_MIB = 1024
  say('probe=memory: (1) scratch memory ceiling')
  let reachedMiB = 0
  const chunks: Uint8Array[] = []
  for (let mib = STEP_MIB; mib <= MAX_MIB; mib += STEP_MIB) {
    try {
      const bytes = new Uint8Array(STEP_MIB * MIB)
      bytes.fill(1) // touch every page so the OS actually commits it, not just reserves it
      chunks.push(bytes)
      reachedMiB = mib
      say(`  ${mib} MiB: ok`)
    } catch (e) {
      say(`  ${mib} MiB: failed (${String(e)})`)
      break
    }
  }
  say(`(1) ceiling: ${reachedMiB} MiB reached`)
  chunks.length = 0 // release before (2)/(3): a real engine instance needs its own headroom

  // Steps 2/3: the default topology beside the real WebGPU context, `autopan` for 2 minutes; step 3
  // repeats step 2 with `&touch=1`. `&sim=`/`&client=` (MiB) let a re-run after a failure narrow the
  // arenas per the checklist's own *If it fails* rule.
  const simMiB = params.has('sim') ? Number(params.get('sim')) : undefined
  const clientMiB = params.has('client') ? Number(params.get('client')) : undefined
  const PROBE_DURATION_MS = 2 * 60 * 1000

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
  renderer.setTileArray(art.texture, art.gpuBytes)
  renderer.writeVisualTable(art.visualTableBytes)

  async function runTopology(withTouch: boolean): Promise<void> {
    const label = withTouch ? '(3) touch=1' : '(2) touch=0'
    say(`${label}: starting`)
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const arenas: { sim?: number; client?: number } = {}
    if (simMiB !== undefined) arenas.sim = simMiB * MIB
    if (clientMiB !== undefined) arenas.client = clientMiB * MIB
    const options: ClientOptions = {
      canvas,
      wasm,
      host: { kind: 'remote', url: 'ws://unused.invalid' },
      assets: { tiles: '/terrain/tiles.json' },
      ...(Object.keys(arenas).length > 0 ? { arenas } : {}),
    }
    const client = createClient(options)
    await client.ready
    // "every arena page written": not built (Deviations) -- no ABI export exists to force-touch a
    // worker's whole arena from main; `withTouch` still runs the identical 2-minute session so a
    // hand run can compare HUD numbers/tab memory with and without it, per the checklist's own
    // instruction to "record all three [runs]".
    const real = createRealFrameLoop({
      client,
      renderer,
      canvas,
      clock: systemClock,
      scheduler: systemScheduler,
      maxTextureDimension2D: device.device.limits.maxTextureDimension2D,
      onCamera() {
        client.cameraState.centreX += 4 / 60 // ~4 tiles/second at 60Hz, same rate as the HUD page
        client.camera.tick(1000 / 60)
      },
    })
    real.loop.resume()

    const start = performance.now()
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        const elapsedS = Math.round((performance.now() - start) / 1000)
        log[log.length - 1] = `${label}: ${elapsedS}s / ${PROBE_DURATION_MS / 1000}s`
        report()
        if (performance.now() - start >= PROBE_DURATION_MS) {
          clearInterval(id)
          resolve()
        }
      }, 1000)
    })
    real.dispose()
    client.destroy()
    canvas.remove()
    say(`${label}: completed without a reload`)
  }

  await runTopology(false)
  await runTopology(true)
  say('probe=memory: complete')
}

if (params.get('probe') === 'memory') {
  await runMemoryProbe()
} else {
  await runFillRateHud()
}

window.__pageReady = true
