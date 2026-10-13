// `bench.frame_belts @slow` (M50; 0018 §9, 0076): a viewport full of belts under the desktop proxies.
// `belts-bench.html` (`pages/src/belts-bench.ts`): `fx-belts`' `SaturatedView` world at scale 1 (0076's
// worst case: 36,864 belt tiles, 294,912 items, every lane packed and flowing), a real connected
// client under real `requestAnimationFrame` (the `frame-bench` project's uncapped flags, one bench at
// a time: `--workers 1`), a 1280 x 720 canvas, a slow pan. Two scenes, one test: `zoom=max` (256
// tiles across, 5 px a tile: one belt sprite per belt tile, no item) and `zoom=64` (20 px a tile,
// the fixture's item cut: the most records with items, about 25,400).
// Each scene: the pan held at the centre, park, the client worker's `frame()` wrapper
// (`INSTALL_WORKER_WRAP`), resume, `start()`, the join waited on through the view's belt tiles, the
// record count and the replica's lines read at the held camera, the pan released, 120 warm-up and
// 300 timed frames (`bench.frame_worstcase`'s marks and trace reader; smoke 5 and 20 under
// SwiftShader).
//
// Asserted: `dropped == 0`; the belt sprites of each held view; the zoomout record count through the
// cap row `counters.render.beltsViewRecords` (`budgets.json`); every held line's run list applied
// and none `unknown` (items held, not only structures; the item records themselves move with the
// flow and are printed); `engine_mem_grows` 0 in both workers; the four gated p50s (zoomout, mid)
// through `bench-gate.mjs` against `baselines/frame-belts.json` (25 % and `minDeltaMs`, plus
// `limits`: main 1.3 ms, worker 2.7 ms). The baseline was measured at a 1-min load under 4
// (`sysctl -n vm.loadavg`); run it there too. Even there the gate is close: the mid worker's quiet
// maximum (2.281 ms) sits 0.045 under its 25 % line, and 1 of 13 quiet runs put the zoomout worker
// 39 % over (its bimodal p50, `conditions`). No upload assertion: a flat fixture world uploads no
// terrain.
import { expect, type Page, type TestInfo, test } from '@playwright/test'
// @ts-expect-error -- plain .mjs helper without types (the repo's scripts)
import { gate } from '../../../../scripts/lib/bench-gate.mjs'
import { assertBudget } from '../../src/test/budget.ts'
import type { TraceEvent } from './gc/analyse.ts'
import { attachTunnelSessions } from './gc/sessions.ts'
import {
  frameDurationsMs,
  INSTALL_WORKER_WRAP,
  percentile,
  TRACE_CATEGORIES,
} from './support/frame-trace.ts'
import { type AdapterInfo, expectAdapter, expectNoGpuErrors } from './support/gpu.ts'
import { openPage } from './support/page.ts'

declare global {
  interface Window {
    __beltsBench?: {
      adapterInfo: AdapterInfo
      tilesAcross: number
      errors(): string[]
      framesRendered(): number
      records(): number
      recordsMin(): number
      recordsMax(): number
      dropped(): number
      droppedMax(): number
      beltTiles(): number
      layers(): number
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

// 0018 §9's desktop proxies.
const MAIN_BUDGET_MS = 1.3
const WORKER_BUDGET_MS = 2.7
// client, sim, gen0 (`genWorkers: 1`).
const EXPECTED_WORKERS = 3

/** The scenes: `zoom` query, the name in the baseline's metrics, the belt tiles of the held view
 * (`visible_tile_rect`: the centre (128, 72) plus the half extent and two tiles each way, floored,
 * clipped to the 256 x 144 stream: every one at 256 across, 69 x 41 at 64; the join is done when
 * the client draws all of them), the lines the replica holds there when that is a fixed number
 * (every line of the world at 256 across; at 64 across the held set moves between runs, 1,317 to
 * 1,364, not diagnosed, probably lines of chunks subscribed before the camera report settled and
 * still retained: printed, and each held line's list pinned instead, `listsApplied === held`), and
 * the non-empty DrawList layers at the held camera (belts only at 256 across; belts and items at 64
 * across, the fixture's 20 px item cut). */
const SCENES = [
  { zoom: 'max', name: 'zoomout', beltTiles: 36_864, linesHeld: 2_974, layers: 1 },
  { zoom: '64', name: 'mid', beltTiles: 69 * 41, linesHeld: null, layers: 2 },
] as const
type SceneSpec = (typeof SCENES)[number]

/** Read in the client worker while parked (`self.__engineInstance`, `test.flags`): the replica's
 * forecast counters (`client_forecast_counters`, `engine/test`'s `readForecastCounters`) and, over
 * every line id, the lines it holds with their lists (`client_line_items`: `-NotCached` when not
 * held; `unknown` set when its list never fit a frame) and the items they hold. */
const READ_REPLICA = `(() => {
  const inst = self.__engineInstance;
  const tx = () => inst.region(1).u8;
  const n = inst.call0(inst.x.client_forecast_counters);
  const fc = JSON.parse(new TextDecoder().decode(tx().slice(0, n)));
  let held = 0, unknown = 0, items = 0, overflow = 0;
  for (let id = 1; id <= 4096; id++) {
    const len = inst.call1(inst.x.client_line_items, id);
    if (len === -9) continue;
    held++;
    if (len <= 0) { overflow++; continue; }
    const u = tx();
    const dv = new DataView(u.buffer, u.byteOffset, len);
    unknown += dv.getUint32(12, true);
    items += dv.getUint32(16, true);
  }
  return JSON.stringify({ listsApplied: fc.forecastsApplied, listsUnknown: fc.listsUnknown, held, unknown, items, overflow });
})()`
type Replica = {
  listsApplied: number
  listsUnknown: number
  held: number
  unknown: number
  items: number
  overflow: number
}

// Same switch as `frame-bench.spec.ts`: the platform decides, never how long anything took.
const isSwiftShader = process.env.ENGINE_GPU === 'swiftshader'
const WARMUP_FRAMES = isSwiftShader ? 5 : 120
const TIMED_FRAMES = isSwiftShader ? 20 : 300
/** The join at scale 1: genesis builds 294,912 items, then the view's chunks and 2,974 lines.
 * 240 s under SwiftShader since 2026-10-13 (`bench.frame_belts @slow` read 333 s over its scenes
 * on CI runs 38391953558 and 38398376800; every CI ceiling was relaxed that day). */
const JOIN_TIMEOUT_MS = isSwiftShader ? 240_000 : 180_000
/** Frames between the join and the held read: the items' forecasts settle. */
const SETTLE_FRAMES = 60
const WORKER_SAMPLE_FLOOR = 12

type Scene = {
  spec: SceneSpec
  replica: Replica
  joinMs: number
  heldRecords: number
  heldBelts: number
  heldLayers: number
  mainMs: number[]
  workerMs: number[]
  recordsMin: number
  recordsMax: number
  dropped: number
  droppedMax: number
  memGrows: { sim: number; client: number }
}

async function framesAtLeast(page: Page, n: number, timeout = 120_000): Promise<void> {
  await page.waitForFunction((k) => (window.__beltsBench?.framesRendered() ?? 0) >= k, n, {
    timeout,
  })
}

async function runScene(page: Page, spec: SceneSpec, testInfo: TestInfo): Promise<Scene> {
  await openPage(page, `/belts-bench.html?zoom=${spec.zoom}`)
  expectAdapter(testInfo, await page.evaluate(() => window.__beltsBench?.adapterInfo ?? null))

  // A worker blocked in its `Atomics.wait` loop answers no CDP call: park, wrap, resume, then start
  // (`bench.frame_worstcase` has the story). The pan is held from the page's first frame.
  await page.evaluate(() => window.__beltsBench?.park())
  const { workers, close } = await attachTunnelSessions(page, EXPECTED_WORKERS)
  for (const w of workers) {
    const evaluated = await w.send('Runtime.evaluate', { expression: 'self.__engineIsolateName' })
    w.name = evaluated.result.value
  }
  const clientWorker = workers.find((w) => w.name === 'client')
  if (!clientWorker) throw new Error('bench.frame_belts: no client-isolate worker attached')
  await clientWorker.send('Runtime.evaluate', {
    expression: INSTALL_WORKER_WRAP,
    returnByValue: true,
  })
  await page.evaluate(() => window.__beltsBench?.resume())

  const belts = spec.beltTiles
  const joinStart = Date.now()
  await page.evaluate(() => window.__beltsBench?.start())
  // `>=`, not `===`: a frame drawing more belt sprites than the view has tiles (the cap row's
  // inject, a doubled emission) reaches the counts below instead of timing out here.
  await page.waitForFunction((n) => (window.__beltsBench?.beltTiles() ?? 0) >= n, belts, {
    timeout: JOIN_TIMEOUT_MS,
  })
  const joinMs = Date.now() - joinStart
  const joined = await page.evaluate(() => window.__beltsBench?.framesRendered() ?? 0)
  await framesAtLeast(page, joined + SETTLE_FRAMES)
  const held = await page.evaluate(() => ({
    records: window.__beltsBench?.records() ?? -1,
    belts: window.__beltsBench?.beltTiles() ?? -1,
    layers: window.__beltsBench?.layers() ?? -1,
  }))
  // The replica at the held camera: every held line has its list (items present, not only the
  // structures the belt sprites come from).
  await page.evaluate(() => window.__beltsBench?.park())
  const read = await clientWorker.send('Runtime.evaluate', {
    expression: READ_REPLICA,
    returnByValue: true,
  })
  await page.evaluate(() => window.__beltsBench?.resume())
  const replica = JSON.parse(read.result.value as string) as Replica

  await page.evaluate(() => window.__beltsBench?.releasePan())
  const released = await page.evaluate(() => window.__beltsBench?.framesRendered() ?? 0)
  await framesAtLeast(page, released + WARMUP_FRAMES)

  const browserSession = await page.context().browser()?.newBrowserCDPSession()
  if (!browserSession) throw new Error('bench.frame_belts: no browser CDP session')
  const events: TraceEvent[] = []
  browserSession.on('Tracing.dataCollected', (ev) => {
    events.push(...(ev.value as unknown as TraceEvent[]))
  })
  const traceDone = new Promise<void>((resolve) => {
    browserSession.once('Tracing.tracingComplete', () => resolve())
  })
  await browserSession.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { recordMode: 'recordUntilFull', includedCategories: TRACE_CATEGORIES },
  })
  // Read after `startMarking()` (`bench.frame_worstcase`: frames rendered during the round trip).
  const startFrames = await page.evaluate(() => {
    window.__beltsBench?.startMarking()
    return window.__beltsBench?.framesRendered() ?? 0
  })
  await framesAtLeast(page, startFrames + TIMED_FRAMES)
  await page.evaluate(() => window.__beltsBench?.stopMarking())
  const end = await page.evaluate(() => {
    const b = window.__beltsBench
    return {
      recordsMin: b?.recordsMin() ?? -1,
      recordsMax: b?.recordsMax() ?? -1,
      dropped: b?.dropped() ?? -1,
      droppedMax: b?.droppedMax() ?? -1,
      memGrows: b?.memGrows() ?? { sim: -1, client: -1 },
      errors: b?.errors() ?? [],
    }
  })
  await browserSession.send('Tracing.end')
  await traceDone
  await browserSession.detach()
  close?.()
  expectNoGpuErrors(end.errors)

  return {
    spec,
    replica,
    joinMs,
    heldRecords: held.records,
    heldBelts: held.belts,
    heldLayers: held.layers,
    mainMs: frameDurationsMs(events, 'mf-s-', 'mf-e-'),
    workerMs: frameDurationsMs(events, 'wf-s-', 'wf-e-'),
    recordsMin: end.recordsMin,
    recordsMax: end.recordsMax,
    dropped: end.dropped,
    droppedMax: end.droppedMax,
    memGrows: end.memGrows,
  }
}

test('bench.frame_belts @slow', async ({ page }, testInfo) => {
  test.setTimeout(SCENES.length * (JOIN_TIMEOUT_MS + 60_000))
  const scenes: Scene[] = []
  let p = page
  for (const spec of SCENES) {
    if (scenes.length > 0) {
      const next = await p.context().newPage()
      await p.close()
      p = next
    }
    scenes.push(await runScene(p, spec, testInfo))
  }

  const mode = isSwiftShader ? 'smoke' : 'full'
  const sample: Record<string, number> = {}
  for (const s of scenes) {
    const name = s.spec.name
    sample[`${name}MainP50Ms`] = percentile(s.mainMs, 0.5)
    sample[`${name}MainP95Ms`] = percentile(s.mainMs, 0.95)
    sample[`${name}WorkerP50Ms`] = percentile(s.workerMs, 0.5)
    sample[`${name}WorkerP95Ms`] = percentile(s.workerMs, 0.95)
    const r = s.replica
    console.log(
      `bench.frame_belts ${name} [${mode}]: join ${s.joinMs} ms, held records ${s.heldRecords} ` +
        `(belts ${s.heldBelts}), records over the pan ${s.recordsMin}-${s.recordsMax}, ` +
        `lines held ${r.held}, lists applied ${r.listsApplied}, unknown ${r.listsUnknown}/${r.unknown}, ` +
        `items held ${r.items}, frames=${s.mainMs.length}/${s.workerMs.length} ` +
        `warmup=${WARMUP_FRAMES} timed=${TIMED_FRAMES} ` +
        `engine_mem_grows sim ${s.memGrows.sim} client ${s.memGrows.client}`,
    )
    console.log(
      `  main   p50=${sample[`${name}MainP50Ms`]?.toFixed(3)}ms p95=${sample[`${name}MainP95Ms`]?.toFixed(3)}ms budget<=${MAIN_BUDGET_MS}ms`,
    )
    console.log(
      `  worker p50=${sample[`${name}WorkerP50Ms`]?.toFixed(3)}ms p95=${sample[`${name}WorkerP95Ms`]?.toFixed(3)}ms budget<=${WORKER_BUDGET_MS}ms`,
    )
  }

  // Hard in both modes: the counts, nothing dropped, no arena growth. The cap row (0069 §6) first:
  // the measured count at maximum zoom-out, held, under 75 % of `CAPACITY`.
  const zoomout = scenes[0] as Scene
  assertBudget({ records: zoomout.heldRecords }, 'render.beltsViewRecords')
  for (const s of scenes) {
    const name = s.spec.name
    expect(s.heldBelts, `${name}: belt sprites at the held camera`).toBe(s.spec.beltTiles)
    expect(s.heldLayers, `${name}: non-empty DrawList layers (1 belts, 2 items)`).toBe(
      s.spec.layers,
    )
    // Items present, not only structures: every held line got its list, none `unknown`.
    if (s.spec.linesHeld !== null) {
      expect(s.replica.held, `${name}: lines the replica holds`).toBe(s.spec.linesHeld)
    }
    expect(s.replica.listsApplied, `${name}: run lists applied, one a held line`).toBe(
      s.replica.held,
    )
    expect(s.replica.listsUnknown, `${name}: unknown lists applied`).toBe(0)
    expect(s.replica.unknown, `${name}: held lines marked unknown`).toBe(0)
    expect(s.replica.overflow, `${name}: lines too long for the read`).toBe(0)
    expect(s.dropped, `${name}: DrawList records dropped at the end`).toBe(0)
    expect(s.droppedMax, `${name}: DrawList records dropped, worst frame of the window`).toBe(0)
    expect(s.memGrows, `${name}: engine_mem_grows`).toEqual({ sim: 0, client: 0 })
    expect(s.mainMs.length, `${name}: main-thread rAF callback marks`).toBeGreaterThanOrEqual(
      TIMED_FRAMES,
    )
    if (s.workerMs.length < WORKER_SAMPLE_FLOOR) {
      const message = `${name}: client worker frame() marks captured: ${s.workerMs.length} below floor ${WORKER_SAMPLE_FLOOR}`
      if (isSwiftShader) console.warn(`warn: ${message} (0020 §10)`)
      else expect(s.workerMs.length, message).toBeGreaterThanOrEqual(WORKER_SAMPLE_FLOOR)
    }
  }

  // 0018 §9's proxies (the baseline's `limits`) and the 25 % rule on the four gated p50s. Fails only
  // on the baseline's machine; under SwiftShader it records and warns.
  gate('frame-belts', sample, { warnOnly: isSwiftShader, suite: 'frame-bench' })
  if (!isSwiftShader) {
    for (const name of ['zoomout', 'mid']) {
      expect(sample[`${name}MainP50Ms`], `${name} main p50 vs 0018 §9`).toBeLessThanOrEqual(
        MAIN_BUDGET_MS,
      )
      expect(sample[`${name}WorkerP50Ms`], `${name} worker p50 vs 0018 §9`).toBeLessThanOrEqual(
        WORKER_BUDGET_MS,
      )
    }
  }
})
