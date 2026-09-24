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
import { clientTestHandle, createClient } from '../../../../src/client.ts'
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
import { loadSpriteAtlas } from '../../../../src/render/atlas.ts'
import type { AdapterInfo, RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import {
  attachDrawables,
  createDrawablesRenderer,
  type DrawablesRenderer,
} from '../../../../src/render/drawables.ts'
import type { TerrainRenderer } from '../../../../src/render/terrain.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import {
  asHarness,
  dispatchRaw,
  pumpUntilLive,
  stepSimTickSync,
} from '../../../../src/test/client.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    /** `?harness=1` (docs/plan/17b-sprites-and-frame-budget.md, Planning decisions "Manual harness
     * shape"): Tyler's own troubleshooting via the Playwright CLI skill; the HUD text is the primary
     * output (`docs/plan/device-checks.md`, M17b: read from the browser's own DevTools UI, not this
     * hook). */
    __deviceHarness?: {
      errors(): string[]
      viewProbePasses: boolean
      sabWriteTextureOk: boolean
      memoryBytes(): Record<string, number>
    }
    /** docs/plan/18-picking-and-overlay.md step 8 (`device.html?anchors=50`): the `anchors` browser
     * test's own hook, reading the exact world tile a device-check ring/button sits at -- the same
     * grid `fixtures/overlay/src/lib.rs`'s own `extract()` uses, computed once here so a spec never
     * duplicates the formula. `i` is `1..=50` (the pick id `extract()` assigns, `pick_id - 1` is the
     * grid index). */
    __anchorsRingWorld?: (pickId: number) => { x: number; y: number }
  }
}

// --- URL parameters (Seams, Provides) ------------------------------------------------------
// `tiles`/`x`/`y`/`autopan`/`scale`/`scaleCap`/`cutoff` are M09b's own; `module`/`probe` (with
// `probe=memory`'s own `touch`/`sim`/`client`) are this range's own (M11 step 8), `harness` is
// M17b's. `anchors`/`anchorMode` (M18 step 8): `anchors=50` switches this page to `fx-overlay` and
// the picking/overlay device check (`runAnchorsCheck`, below) instead of the fill-rate HUD;
// `anchorMode=translate` opts that check into the per-anchor `translate()` fallback (0019
// "Alternatives rejected") instead of the default custom-property mechanism.
const params = new URL(location.href).searchParams
const tilesAcross = params.has('tiles') ? Number(params.get('tiles')) : undefined
const startX = params.has('x') ? Number(params.get('x')) : 0
const startY = params.has('y') ? Number(params.get('y')) : 0
const autopan = params.get('autopan') === '1' || params.get('autopan') === 'true'
const anchorsCount = params.has('anchors') ? Number(params.get('anchors')) : undefined
const anchorMode = params.get('anchorMode') === 'translate' ? 'translate' : 'properties'
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

// --- `?harness=1` (docs/plan/17b-sprites-and-frame-budget.md, Planning decisions "Manual harness
// shape"; docs/plan/device-checks.md, M17b: desktop Safari and Firefox, closing 0018 Consequences'
// deferral -- "the CDP instrument of 0016 is Chromium-only"). A real, connected `fx-drawables`
// client (`gc-drawables.ts`'s own topology, TerrainRenderer + DrawablesRenderer + sprite atlas)
// stepped -- not real rAF: Tyler drives this from his own DevTools "record" button, so a fast,
// deterministic step count (`engine/test.stepFrame`, the same lockstep every zero-GC page uses) is
// what lets the recording bracket exactly this page's own work, unlike `device.html`'s default real-
// rAF HUD mode -- through 120 warm-up frames then 600 measured frames, then prints every probe the
// deferral named: any `uncapturederror`, the `GPUTexture`-as-view probe, whether `writeTexture`
// accepted a SAB-backed view (or the staged-copy path engaged, `render/upload.ts`), whether
// `writeBuffer` from a SAB-backed view (`drawablesRenderer.acquire()`, real production path) ran
// error-free, and `memory.buffer.byteLength` per instance (`engine/test.memoryBytes`, already a SAB
// read -- no worker round trip needed).
const HARNESS_WARMUP_FRAMES = 120
const HARNESS_MEASURED_FRAMES = 600

async function runHarness(): Promise<void> {
  const hudEl = document.getElementById('hud') as HTMLPreElement
  const log: string[] = []
  function report(): void {
    hudEl.textContent = log.join('\n')
  }
  function say(line: string): void {
    log.push(line)
    report()
  }
  say('device.html?harness=1: starting…')

  const harnessWasm = await fixtureWasm('drawables')
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)

  const device: RendererDevice = await initDevice()
  const gpuApi = (navigator as unknown as { gpu: GPU }).gpu
  const colorFormat = gpuApi.getPreferredCanvasFormat()
  const renderer: TerrainRenderer = await createTerrainRenderer(device.device, {
    colorFormat,
    viewProbePasses: device.viewProbePasses,
    checkCompilation: device.checkCompilation,
  })
  const assets = { tiles: '/terrain/tiles.json', sprites: '/drawables/sprites.json' }
  const art = await loadTileArt(device.device, assets.tiles, {
    checkCompilation: device.checkCompilation,
  })
  renderer.setTileArray(art.texture, art.gpuBytes)
  renderer.writeVisualTable(art.visualTableBytes)

  const client: Client = createClient({
    canvas,
    wasm: harnessWasm,
    host: {
      kind: 'local',
      world: { worldId: 'harness', params: { seed: '1', worldgen: null } },
      connect: true,
    },
    genWorkers: 1,
    assets,
  })
  await pumpUntilLive(client)
  const harness = asHarness(client)

  // docs/plan/18-picking-and-overlay.md gate round 1: no `drawListSab`/own `TripleReader` --
  // `driveOne` below calls `client.pick.acquire()` once, before `drawablesRenderer.acquire()`.
  const drawablesRenderer: DrawablesRenderer = await createDrawablesRenderer(device.device, {
    colorFormat,
    drawListSlot: clientTestHandle(client).drawListSlot,
    checkCompilation: device.checkCompilation,
  })
  attachDrawables(renderer, drawablesRenderer)
  const spriteAtlas = await loadSpriteAtlas(device.device, assets.sprites, {
    checkCompilation: device.checkCompilation,
  })
  drawablesRenderer.setSpriteAtlas(spriteAtlas)

  // A modest population (`gc-drawables.ts`'s own precedent, not M17b's own 65,536-record worst
  // case): this check is about the SAB/GPUTexture probes and allocation growth over the step count,
  // not frame time (`bench.frame_worstcase` owns that).
  const cameraState = client.cameraState
  cameraState.centreX = 0
  cameraState.centreY = 0
  cameraState.tilesAcross = 24
  cameraState.halfExtentTilesX = 120
  cameraState.halfExtentTilesY = 120
  const POPULATE_COUNT = 300
  const GRID_COLS = 20
  const GRID_SPACING = 4
  let seq = 1
  for (let i = 0; i < POPULATE_COUNT; i++) {
    const gx = i % GRID_COLS
    const gy = Math.floor(i / GRID_COLS)
    const x = (gx - GRID_COLS / 2) * GRID_SPACING
    const y = (gy - Math.ceil(POPULATE_COUNT / GRID_COLS) / 2) * GRID_SPACING
    const sprite = i % 10 === 0
    const bytes = new TextEncoder().encode(
      JSON.stringify({ Spawn: { at: { x, y }, small: false, layer: 0, sprite } }),
    )
    dispatchRaw(client, seq, bytes)
    seq += 1
    harness.stepFrame(1000 / 60)
    stepSimTickSync(client, 1)
  }
  harness.stepFrame(1000 / 60)
  stepSimTickSync(client, 1)
  harness.stepTick()

  const target = device.device.createTexture({
    size: [64, 64],
    format: colorFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })
  renderer.frameUniform.viewportPxW = 64
  renderer.frameUniform.viewportPxH = 64
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

  function driveOne(): void {
    harness.stepFrame(1000 / 60)
    stepSimTickSync(client, 1)
    harness.stepTick()
    client.pick.acquire() // the one real TripleReader.acquire() over drawList, this frame
    drawablesRenderer.acquire() // the real SAB-backed writeBuffer path this check reports on
    renderer.writeFrameUniform(renderer.frameUniform)
    renderer.draw(target)
  }

  // `docs/plan/device-checks.md`'s own M17b steps: "record, press 'run' on the page, stop after it
  // prints" -- setup (above) is one-time and not what the check measures, so it runs immediately;
  // the actual warm-up + measured steps wait for this button, so Tyler's own DevTools recording
  // (started first) brackets only the work being checked.
  say('setup complete -- press Run to start the 120 warm-up + 600 measured frames.')
  const runButton = document.createElement('button')
  runButton.textContent = 'Run'
  runButton.id = 'harness-run'
  // Plain in-flow elements paint under a `position: fixed` canvas regardless of DOM order (CSS
  // paint order: positioned descendants paint after non-positioned ones) -- `device.html`'s own
  // canvas covers the whole viewport, so without this the button exists but nothing can click it
  // (found running this step's own Chromium verification: Playwright's `click()` reported "canvas
  // intercepts pointer events" until this was added).
  runButton.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:1000;font:14px ui-monospace,monospace;padding:6px 14px;'
  document.body.appendChild(runButton)
  // Setup (the awaits above -- WASM/device/asset loading, population) is what `window.__pageReady`
  // conventionally marks the end of (`packages/engine/CLAUDE.md`, "Adding a browser spec"); the
  // button click below is a manual gate on top of that, not part of it, so `__pageReady` fires here,
  // not after the click (nothing automated opens this page in `harness=1` mode today, but a Node
  // script driving it by hand, per the binding rule this step was built under, still needs a real
  // signal to click "Run" against instead of guessing a timeout).
  window.__pageReady = true
  await new Promise<void>((resolve) => {
    runButton.addEventListener('click', () => resolve(), { once: true })
  })
  runButton.remove()

  say(`warm-up: ${HARNESS_WARMUP_FRAMES} frames…`)
  for (let i = 0; i < HARNESS_WARMUP_FRAMES; i++) driveOne()

  say(`measured: ${HARNESS_MEASURED_FRAMES} frames…`)
  for (let i = 0; i < HARNESS_MEASURED_FRAMES; i++) driveOne()

  const memBytes = await harness.memoryBytes()
  const errors = device.errors()
  say('')
  say('harness=1 result (stop your DevTools recording now):')
  say(`  uncapturederror: ${errors.length === 0 ? 'none' : JSON.stringify(errors)}`)
  say(`  GPUTexture-as-view probe: ${device.viewProbePasses}`)
  say(
    `  writeTexture from SAB view: ${device.sabWriteTextureOk ? 'accepted' : 'rejected (staged-copy path engaged)'}`,
  )
  say(
    `  writeBuffer from SAB view (drawablesRenderer.acquire, ` +
      `${HARNESS_WARMUP_FRAMES + HARNESS_MEASURED_FRAMES} calls): ` +
      `${errors.length === 0 ? 'accepted (no uncapturederror)' : 'see uncapturederror above'}`,
  )
  say('  memory.buffer.byteLength per instance:')
  for (const [name, bytes] of Object.entries(memBytes)) say(`    ${name}: ${bytes}`)

  window.__deviceHarness = {
    errors: () => errors,
    viewProbePasses: device.viewProbePasses,
    sabWriteTextureOk: device.sabWriteTextureOk,
    memoryBytes: () => memBytes,
  }
}

// --- `?anchors=50[&anchorMode=translate]` (docs/plan/18-picking-and-overlay.md step 8;
// docs/plan/device-checks.md, "M18: Picking and overlay anchoring") -- Tyler's own fill/pinch check
// for overlay anchoring on a real phone (0019 Consequences: "Deferred to Phase 2/3 manual device
// checks: anchoring on iOS Safari"), and the one exit criterion needing a real running page:
// "device.html?anchors=50 shows pick_id on the HUD". A real, connected `fx-overlay` client (unlike
// `runFillRateHud`'s `fx-terrain`): its own real `extract()` draws 50 pickable rings on a fixed grid
// (`fixtures/overlay/src/lib.rs`'s own `RING_COUNT`/`RING_COLS`/`RING_ROWS`/`RING_SPACING_TILES`,
// mirrored below) and 4 circles orbiting the origin, each also published through `DrawList::anchor`.
// This page mounts one small DOM button per ring, anchored (`client.overlay.anchor`, `align:
// 'bottom'`, the default) to the *same* world tile-centre a ring sits at, and one DOM marker per
// slot anchor (`client.overlay.anchorSlot`) -- Tyler pans/pinches with real touch gestures (the same
// real `installPointerListeners`/`installWheelListeners` every other mode here already installs) and
// watches for anchor swim against the canvas. `align: 'bottom'` also makes the automated `anchors`
// browser test's own "click the ring, not the button" case trivial: the button's own box sits
// entirely *above* its anchor point (`translate(-50%, -100%)`), so a click exactly at the ring's own
// screen centre never lands on the button.
const RING_COUNT = 50
const RING_COLS = 10
const RING_ROWS = 5
const RING_SPACING_TILES = 3
const ANCHOR_SLOT_COUNT = 4
const RING_BUTTON_CSS =
  'width:14px;height:14px;padding:0;font-size:8px;line-height:14px;text-align:center;'

function ringWorld(pickId: number): { x: number; y: number } {
  const i = pickId - 1
  const col = i % RING_COLS
  const row = Math.floor(i / RING_COLS)
  const tx = (col - Math.trunc(RING_COLS / 2)) * RING_SPACING_TILES
  const ty = (row - Math.trunc(RING_ROWS / 2)) * RING_SPACING_TILES
  return { x: tx + 0.5, y: ty + 0.5 }
}

async function runAnchorsCheck(count: number, mode: 'properties' | 'translate'): Promise<void> {
  installPageStyles()
  const hudEl = document.getElementById('hud') as HTMLPreElement
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)

  const device: RendererDevice = await initDevice()
  const gpuApi = (navigator as unknown as { gpu: GPU }).gpu
  const colorFormat = gpuApi.getPreferredCanvasFormat()
  const renderer: TerrainRenderer = await createTerrainRenderer(device.device, {
    colorFormat,
    viewProbePasses: device.viewProbePasses,
    checkCompilation: device.checkCompilation,
  })
  const assets = { tiles: '/terrain/tiles.json', sprites: '/drawables/sprites.json' }
  const art = await loadTileArt(device.device, assets.tiles, {
    checkCompilation: device.checkCompilation,
  })
  renderer.setTileArray(art.texture, art.gpuBytes)
  renderer.writeVisualTable(art.visualTableBytes)

  const overlayWasm = await fixtureWasm('overlay')
  const clientOptions: ClientOptions = {
    canvas,
    wasm: overlayWasm,
    host: { kind: 'remote', url: 'ws://unused.invalid' },
    genWorkers: 1,
    assets,
    test: { flags: {}, game: { seed: '0x1', params: null } },
    overlay: { mode },
  }
  const client: Client = createClient(clientOptions)
  await client.ready

  client.cameraState.centreX = startX
  client.cameraState.centreY = startY
  if (tilesAcross !== undefined) client.cameraState.tilesAcross = tilesAcross

  const drawListSlot = clientTestHandle(client).drawListSlot
  const drawablesRenderer: DrawablesRenderer = await createDrawablesRenderer(device.device, {
    colorFormat,
    drawListSlot,
    checkCompilation: device.checkCompilation,
  })
  attachDrawables(renderer, drawablesRenderer)
  const spriteAtlas = await loadSpriteAtlas(device.device, assets.sprites, {
    checkCompilation: device.checkCompilation,
  })
  drawablesRenderer.setSpriteAtlas(spriteAtlas)

  // 50 buttons, each anchored to the same tile a real Rust-drawn ring sits at (`ringWorld`, mirrors
  // `fixtures/overlay/src/lib.rs`'s own grid). `count` is honoured only for a smaller manual check;
  // the fixture's own `extract()` always draws the full 50 regardless (a smaller `count` here just
  // mounts fewer buttons over the same fixed ring field).
  for (let i = 0; i < Math.min(count, RING_COUNT); i++) {
    const btn = document.createElement('button')
    const pickId = i + 1
    btn.textContent = String(pickId)
    btn.style.cssText = RING_BUTTON_CSS
    const w = ringWorld(pickId)
    client.overlay.anchor(btn, w.x, w.y)
  }
  for (let slot = 0; slot < ANCHOR_SLOT_COUNT; slot++) {
    const el = document.createElement('div')
    el.textContent = `●${slot}`
    el.style.cssText = 'color:#f0f;font:12px ui-monospace,monospace;'
    client.overlay.anchorSlot(el, slot)
  }

  let lastPickIdHud = '-'
  client.input.on('tap', (e) => {
    lastPickIdHud = e.pickId === 0 ? '-' : String(e.pickId)
  })

  let lastCameraT: number | undefined
  function onCamera(): void {
    const t = performance.now()
    const dtMs = lastCameraT === undefined ? 0 : t - lastCameraT
    lastCameraT = t
    client.camera.tick(dtMs)
  }

  const real: RealFrameLoop = createRealFrameLoop({
    client,
    renderer,
    canvas,
    clock: systemClock,
    scheduler: systemScheduler,
    maxTextureDimension2D: device.device.limits.maxTextureDimension2D,
    onCamera,
    onOverlay: () => client.overlay.update(),
  })
  attachVisibilityHandling(real.loop)
  real.loop.resume()

  function renderHud(): void {
    const lines = [
      `device.html?anchors=${count}&anchorMode=${mode}`,
      `isolated: ${globalThis.crossOriginIsolated}`,
      `adapter.info: ${JSON.stringify(device.adapterInfo)}`,
      `camera: tilesAcross=${client.cameraState.tilesAcross} centre=(${client.cameraState.centreX.toFixed(2)},${client.cameraState.centreY.toFixed(2)})`,
      `pick_id: ${lastPickIdHud}`,
    ]
    hudEl.textContent = lines.join('\n')
  }
  setInterval(renderHud, 100)
  renderHud()

  window.__anchorsRingWorld = ringWorld
}

if (params.get('harness') === '1') {
  await runHarness()
} else if (params.get('probe') === 'memory') {
  await runMemoryProbe()
} else if (anchorsCount !== undefined) {
  await runAnchorsCheck(anchorsCount, anchorMode)
} else {
  await runFillRateHud()
}

window.__pageReady = true
