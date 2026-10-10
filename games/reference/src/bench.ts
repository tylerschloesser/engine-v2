// The bench page (M36 step 6): `?bench=large-save`, the
// standard large save of 0020 section 9 played single-player with a bench HUD. **Bench builds only**:
// `main.ts` reaches this file through `if (__BENCH__)` (`vite build --mode bench`), so no other build
// carries it or reads the parameter (`bench.spec.ts` greps `dist/` for it). Diagnostic, outside the
// zero-GC rule (`.claude/rules/hot-paths.md`): it allocates freely, and only ever runs on this page.
//
// What it measures: the main rAF callback (a wrapper over the page's `Scheduler`), the client
// worker's `frame` call and the sim worker's tick-running pass (both timed inside the workers, into
// the control block, because `test.flags.timing` is set), p95 over the last 10 s each; plus
// `engine_mem_grows`, `tick`, and the draw-call and upload-byte counters per frame.
import type { Client } from 'engine'
import type { Scheduler } from 'engine/render'
import { RingConsumer, type RingStats, systemScheduler } from 'engine/render'
import { type BenchProbe, benchProbe, parkWorkers, resumeWorkers } from 'engine/test'
import { type BenchRequest, furnaceBlock } from './bench-request.js'
import {
  createPartStats,
  createPhaseStats,
  createTickRing,
  Rolling,
  type TickSummary,
} from './bench-stats.js'
import type { StartedGame } from './game.js'
import { DEFAULT_WORLD, type Host } from './mode.js'

export { type BenchRequest, benchRequest, furnaceBlock, MAX_TILES_ACROSS } from './bench-request.js'

/** The local world with the bench marker in its worldgen params and both state budgets raised to
 * hold the save (`WorldConfig` defaults would refuse it). Not persisted: 13 MB of snapshot each
 * visit is not what the page measures. */
export function benchHost(scale: number): Host {
  return {
    kind: 'local',
    world: {
      worldId: `bench-${scale}`,
      params: {
        ...DEFAULT_WORLD,
        worldgen: { bench: scale },
        maxEntities: Math.floor(262_144 / scale),
        maxModifiedTiles: Math.floor(1_048_576 / scale),
      },
    },
    connect: true,
  }
}

/** What `startGame` needs so the workers time themselves (`pace`: the sim keeps its real-time pacing
 * although `test` is present). */
export const BENCH_TEST_OPTIONS = { flags: { pace: true, timing: true } } as const

export type BenchHud = {
  scale: number
  engineMemGrows: { sim: number; client: number }
  tick: number
  mainP95Ms: number
  frameP95Ms: number
  tickP95Ms: number
  /** M39o: the whole pass's median and the parts of the pass (10 s window each). */
  tickP50Ms: number
  sealP95Ms: number
  simTickP50Ms: number
  simTickP95Ms: number
  frameBuildP95Ms: number
  resyncP95Ms: number
  catchupTicksPer10s: number
  /** M39ag: p50/p95 ms of the whole pass and its parts (`rest` = the untimed remainder). */
  parts: Record<string, [number, number]>
  /** M39s: the last 4,096 `sim_tick` durations, summarised. */
  tickSeries: TickSummary
  /** M39y: p50/p95 ms per `sim_tick` phase (all 0 unless the module is a `bench-phases` build). */
  phases: Record<string, [number, number]>
  framesRendered: number
  records: number
  dropped: number
  /** The most draw calls / upload bytes any one frame issued since `resetCounters()`. */
  drawCallsMax: number
  uploadBytesMax: number
  /** Upload records the client worker pushed that the frame loop has not drained yet, right now. */
  uploadBacklog: number
  /** Upload records the ring dropped (full ring). */
  uploadDrops: number
  /** The most records waiting in the ring at any frame since `resetCounters()`. */
  uploadBacklogMax: number
  /** Frames since `resetCounters()` whose drain hit the per-frame byte cap (the queue was not empty after it). */
  uploadFramesAtCap: number
}

export type BenchApi = {
  hud(): BenchHud
  hudText(): string
  /** The whole per-tick ring, oldest first: `[tick, sim_tick us]` pairs (M39s. */
  tickSeries(): [number, number][]
  framesRendered(): number
  /** Arms `mf-s-n`/`mf-e-n` marks around every main rAF callback (`bench.frame_reference` reads them
   * from a trace, never from page-side deltas). */
  startMarking(): void
  stopMarking(): void
  resetCounters(): void
  /** Moves the camera to the pan's first position and holds it there (the test then lets the view
   * stream in, parks the workers, wraps `frame`, resumes). */
  holdPan(): void
  /** Stops the pan where it is. */
  stopPan(): void
  /** Starts the pan from its first position, counting frames from now: the camera path inside the
   * timed window is then the same every run, whatever the page and CDP round trips took before. */
  releasePan(): void
  adapter(): unknown
  /** `engine/test`'s park/resume of every worker (a CDP `Runtime.evaluate` reaches a worker only
   * while it is parked). */
  park(): Promise<void>
  resume(): Promise<void>
}

declare global {
  interface Window {
    __bench?: BenchApi
  }
}

export type BenchMeter = {
  /** Pass to `startGame({ scheduler })`: wraps the page's rAF so every callback is timed. */
  scheduler: Scheduler
  /** After `startGame` returned: camera, HUD and `window.__bench`. */
  start(game: StartedGame, req: BenchRequest): BenchApi
}

export function createBenchMeter(): BenchMeter {
  const main = new Rolling()
  const frame = new Rolling()
  const parts = createPartStats()
  const ticks = createTickRing()
  const phases = createPhaseStats()
  let game: StartedGame | undefined
  let probe: BenchProbe | undefined
  let request: BenchRequest | undefined
  let marking = false
  let frames = 0
  let markN = 0
  let lastFrameN = 0
  let panFrame0 = 0
  let panHeld = false
  let heldD = 0
  const lastD = 0
  let lastTickN = 0
  let lastDraws = 0
  let lastUpload = 0
  let drawCallsMax = 0
  let uploadBytesMax = 0
  let framesAtCap = 0
  let backlogMax = 0
  const ringStats: RingStats = { drops: 0, pushed: 0, popped: 0 }
  let ring: RingConsumer | undefined

  function steer(): void {
    if (!game || !request) return
    const block = furnaceBlock(request.scale)
    // Triangle wave along x across the middle of the block, slow: the view stays over furnaces. The
    // step is per frame (`pan` tiles per second at 60 frames a second), so the pan covers the same
    // ground whether rAF runs at 60 Hz or, as in `bench.frame_reference`, uncapped.
    const amp = Math.max(0, block.halfSpan - 140)
    const d = panHeld
      ? 0
      : ((frames - panFrame0) * (request.panTilesPerSecond / 60)) % (4 * amp || 1)
    const x = block.x + (d < 2 * amp ? -amp + d : 3 * amp - d)
    game.client.camera.moveTo(x, block.y, { durationMs: 0 })
  }

  const scheduler: Scheduler = {
    ...systemScheduler,
    requestFrame(cb) {
      return systemScheduler.requestFrame((tMs) => {
        steer()
        if (marking) performance.mark(`mf-s-${markN}`)
        const t = performance.now()
        cb(tMs)
        const dt = performance.now() - t
        if (marking) {
          performance.mark(`mf-e-${markN}`)
          markN++
        }
        frames++
        main.push(t, dt)
        sample(t)
      })
    },
  }

  function sample(t: number): void {
    if (!probe || !game) return
    const fn = probe.frameN()
    if (fn !== lastFrameN) {
      lastFrameN = fn
      frame.push(t, probe.frameUs() / 1000)
    }
    const tn = probe.tickN()
    if (tn !== lastTickN) {
      lastTickN = tn
      parts.push(t, {
        wholeUs: probe.tickUs(),
        sealUs: probe.sealUs(),
        tickUs: probe.simTickUs(),
        frameUs: probe.frameBuildUs(),
        resyncUs: probe.resyncUs(),
        catchupTicks: probe.catchupTicks(),
      })
      ticks.push(tn, probe.simTickUs())
      phases.push(t, probe.phaseUs)
    }
    const draws = game.renderer.drawCalls()
    const upload = game.real.loop.uploadBytes()
    drawCallsMax = Math.max(drawCallsMax, draws - lastDraws)
    uploadBytesMax = Math.max(uploadBytesMax, upload - lastUpload)
    if (upload - lastUpload >= 65_536 - 4112) framesAtCap++
    backlogMax = Math.max(backlogMax, backlog().uploadBacklog)
    lastDraws = draws
    lastUpload = upload
  }

  function hud(): BenchHud {
    const g = game as StartedGame
    const p = probe as BenchProbe
    const pr = parts.readings()
    return {
      scale: (request as BenchRequest).scale,
      engineMemGrows: { sim: p.simGrows(), client: p.clientGrows() },
      tick: p.tickN(),
      mainP95Ms: main.p95(),
      frameP95Ms: frame.p95(),
      tickP95Ms: pr.tickP95Ms,
      tickP50Ms: pr.tickP50Ms,
      sealP95Ms: pr.sealP95Ms,
      simTickP50Ms: pr.simTickP50Ms,
      simTickP95Ms: pr.simTickP95Ms,
      frameBuildP95Ms: pr.frameBuildP95Ms,
      resyncP95Ms: pr.resyncP95Ms,
      catchupTicksPer10s: pr.catchupTicksPer10s,
      parts: pr.parts,
      tickSeries: ticks.summary(),
      phases: phases.readings(),
      framesRendered: frames,
      records: g.drawables.drawables.recordCount(),
      dropped: g.drawables.drawables.drawListDropped(),
      drawCallsMax,
      uploadBytesMax,
      ...backlog(),
      uploadFramesAtCap: framesAtCap,
      uploadBacklogMax: backlogMax,
    }
  }

  function backlog(): { uploadBacklog: number; uploadDrops: number } {
    ring?.stats(ringStats)
    return { uploadBacklog: ringStats.pushed - ringStats.popped, uploadDrops: ringStats.drops }
  }

  function hudText(): string {
    const h = hud()
    const ms = (v: number): string => v.toFixed(2)
    return [
      `bench large-save (1/${h.scale})`,
      `engine_mem_grows: sim ${h.engineMemGrows.sim}, client ${h.engineMemGrows.client}`,
      `tick: ${h.tick}`,
      `main p95: ${ms(h.mainP95Ms)} ms`,
      `frame p95: ${ms(h.frameP95Ms)} ms`,
      `tick p95: ${ms(h.tickP95Ms)} ms`,
      `  tick p50 ${ms(h.tickP50Ms)}, seal p95 ${ms(h.sealP95Ms)}, sim_tick p50/p95 ${ms(h.simTickP50Ms)} / ${ms(h.simTickP95Ms)}, frame build p95 ${ms(h.frameBuildP95Ms)}, resync p95 ${ms(h.resyncP95Ms)} ms; catch-up ticks/10s ${h.catchupTicksPer10s}`,
      `drawables: ${h.records} (dropped ${h.dropped}), draws/frame max ${h.drawCallsMax}, upload B/frame max ${h.uploadBytesMax}, upload backlog ${h.uploadBacklog}, at cap ${h.uploadFramesAtCap} frames, drops ${h.uploadDrops}`,
    ].join('\n')
  }

  return {
    scheduler,
    start(g: StartedGame, req: BenchRequest): BenchApi {
      game = g
      request = req
      probe = benchProbe(g.client as Client)
      // A second view of the upload ring, for its counters only: it never pops.
      ring = new RingConsumer(g.client.uploadRing)
      // Max zoom-out over the middle of the dense block, before the first `Ui` can move it to the
      // spawn (`shouldMoveToSpawn` sees a camera that is no longer where the client made it).
      const block = furnaceBlock(req.scale)
      g.client.camera.moveTo(block.x, block.y, { tiles: req.tilesAcross, durationMs: 0 })
      const el = document.createElement('pre')
      el.id = 'bench-hud'
      el.style.cssText =
        'position:fixed;left:8px;top:8px;margin:0;padding:6px 8px;background:#000c;color:#9f9;font:12px/1.35 monospace;z-index:10;pointer-events:none'
      document.body.appendChild(el)
      // The HUD refreshes on its own timer, never in the rAF callback it measures.
      setInterval(() => {
        el.textContent = hudText()
      }, 250)
      const api: BenchApi = {
        hud,
        hudText,
        tickSeries: () => ticks.series(),
        framesRendered: () => frames,
        startMarking() {
          marking = true
        },
        stopMarking() {
          marking = false
        },
        resetCounters() {
          drawCallsMax = 0
          uploadBytesMax = 0
          framesAtCap = 0
          backlogMax = 0
        },
        holdPan() {
          panHeld = true
          heldD = 0
        },
        stopPan() {
          panHeld = true
          heldD = lastD
        },
        releasePan() {
          panHeld = false
          panFrame0 = frames
        },
        adapter: () => g.device.adapterInfo,
        park: () => parkWorkers(g.client),
        resume: () => resumeWorkers(g.client),
      }
      window.__bench = api
      return api
    },
  }
}
