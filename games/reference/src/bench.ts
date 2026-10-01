// The bench page (docs/plan/36-slow-tier-and-benchmarks.md step 6): `?bench=large-save`, the
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
import { systemScheduler } from 'engine/render'
import { type BenchProbe, benchProbe, parkWorkers, resumeWorkers } from 'engine/test'
import type { StartedGame } from './game.js'
import { DEFAULT_WORLD, type Host } from './mode.js'

/** `?bench=large-save[&scale=n][&pan=tiles-per-second]`: `scale` divides the save (1 = the full
 * 0020 section 9 save, 64 = the 1/64 one the fast test builds), `pan` is the camera's drift speed. */
export type BenchRequest = { scale: number; panTilesPerSecond: number }

export function benchRequest(search: string): BenchRequest | undefined {
  const p = new URLSearchParams(search)
  if (p.get('bench') !== 'large-save') return undefined
  const scale = Math.max(1, Math.floor(Number(p.get('scale') ?? 1)) || 1)
  const pan = Number(p.get('pan') ?? 12)
  return { scale, panTilesPerSecond: Number.isFinite(pan) ? pan : 12 }
}

// `bench.rs`'s shape: 262,144 / scale furnaces, 200 a chunk, chunks of 32 tiles in a square-ish
// block from the origin (`cols` wide, row-major).
const CHUNK_TILES = 32
const FURNACES_PER_CHUNK = 200

/** The centre of the furnace block and half of its shorter side, in tiles. */
export function furnaceBlock(scale: number): { x: number; y: number; halfSpan: number } {
  const chunks = Math.ceil(Math.floor(262_144 / scale) / FURNACES_PER_CHUNK)
  let cols = 1
  while (cols * cols < chunks) cols++
  const rows = Math.ceil(chunks / cols)
  return {
    x: (cols * CHUNK_TILES) / 2,
    y: (rows * CHUNK_TILES) / 2,
    halfSpan: (Math.min(cols, rows) * CHUNK_TILES) / 2,
  }
}

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

const WINDOW_MS = 10_000

class Rolling {
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
  p95(): number {
    if (this.vs.length === 0) return 0
    const sorted = [...this.vs].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] as number
  }
}

export type BenchHud = {
  scale: number
  engineMemGrows: { sim: number; client: number }
  tick: number
  mainP95Ms: number
  frameP95Ms: number
  tickP95Ms: number
  framesRendered: number
  records: number
  dropped: number
  /** The most draw calls / upload bytes any one frame issued since `resetCounters()`. */
  drawCallsMax: number
  uploadBytesMax: number
}

export type BenchApi = {
  hud(): BenchHud
  hudText(): string
  framesRendered(): number
  /** Arms `mf-s-n`/`mf-e-n` marks around every main rAF callback (`bench.frame_reference` reads them
   * from a trace, never from page-side deltas). */
  startMarking(): void
  stopMarking(): void
  resetCounters(): void
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
  const tick = new Rolling()
  let game: StartedGame | undefined
  let probe: BenchProbe | undefined
  let request: BenchRequest | undefined
  let marking = false
  let frames = 0
  let markN = 0
  let lastFrameN = 0
  let lastTickN = 0
  let lastDraws = 0
  let lastUpload = 0
  let drawCallsMax = 0
  let uploadBytesMax = 0

  function steer(): void {
    if (!game || !request) return
    const block = furnaceBlock(request.scale)
    // Triangle wave along x across the middle of the block, slow: the view stays over furnaces. The
    // step is per frame (`pan` tiles per second at 60 frames a second), so the pan covers the same
    // ground whether rAF runs at 60 Hz or, as in `bench.frame_reference`, uncapped.
    const amp = Math.max(0, block.halfSpan - 140)
    const d = (frames * (request.panTilesPerSecond / 60)) % (4 * amp || 1)
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
      tick.push(t, probe.tickUs() / 1000)
    }
    const draws = game.renderer.drawCalls()
    const upload = game.real.loop.uploadBytes()
    drawCallsMax = Math.max(drawCallsMax, draws - lastDraws)
    uploadBytesMax = Math.max(uploadBytesMax, upload - lastUpload)
    lastDraws = draws
    lastUpload = upload
  }

  function hud(): BenchHud {
    const g = game as StartedGame
    const p = probe as BenchProbe
    return {
      scale: (request as BenchRequest).scale,
      engineMemGrows: { sim: p.simGrows(), client: p.clientGrows() },
      tick: p.tickN(),
      mainP95Ms: main.p95(),
      frameP95Ms: frame.p95(),
      tickP95Ms: tick.p95(),
      framesRendered: frames,
      records: g.drawables.drawables.recordCount(),
      dropped: g.drawables.drawables.drawListDropped(),
      drawCallsMax,
      uploadBytesMax,
    }
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
      `drawables: ${h.records} (dropped ${h.dropped}), draws/frame max ${h.drawCallsMax}, upload B/frame max ${h.uploadBytesMax}`,
    ].join('\n')
  }

  return {
    scheduler,
    start(g: StartedGame, req: BenchRequest): BenchApi {
      game = g
      request = req
      probe = benchProbe(g.client as Client)
      // Max zoom-out over the middle of the dense block, before the first `Ui` can move it to the
      // spawn (`shouldMoveToSpawn` sees a camera that is no longer where the client made it).
      const block = furnaceBlock(req.scale)
      g.client.camera.moveTo(block.x, block.y, { tiles: 256, durationMs: 0 })
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
