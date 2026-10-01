// `bench.frame_reference @slow` (docs/plan/36-slow-tier-and-benchmarks.md step 6; 0018 §9, 0020 §9):
// the reference game single-player on the standard large save (`?bench=large-save`, the bench build
// of `games/reference`), camera at maximum zoom-out over the dense furnace block, a slow pan, real
// `requestAnimationFrame` under M17b's `frame-bench` project flags. The same measurement as
// `bench.frame_worstcase` (`frame-bench.spec.ts`): main-thread rAF callback and client-worker `frame`
// durations read from trace events between marks, never from page-side deltas. Gated against 0018
// §9's desktop proxies (main <= 1.3 ms, worker <= 2.7 ms) and `baselines/frame-reference.json` within
// 25 % through `scripts/lib/bench-gate.mjs` (only under the baseline's machine fingerprint; warn-only
// under SwiftShader). Draw-call and upload-byte counters are asserted in the same run against
// `budgets.json`, and the bench HUD's fields are asserted to exist and to be non-zero.
//
// The bench build is made here: `vite build --mode bench` in `games/reference` (cargo feature `bench`,
// output `dist-bench/`, never `dist/`), served by its own `vite preview`, both killed after the run.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
// @ts-expect-error -- plain .mjs helper without types (the repo's scripts)
import { gate } from '../../../../scripts/lib/bench-gate.mjs'
import { budget } from '../support/budgets.ts'
import type { TraceEvent } from './gc/analyse.ts'
import { attachTunnelSessions } from './gc/sessions.ts'
import {
  frameDurationsMs,
  INSTALL_WORKER_WRAP,
  percentile,
  TRACE_CATEGORIES,
} from './support/frame-trace.ts'
import { expectAdapter } from './support/gpu.ts'
import { openPage } from './support/page.ts'

type BenchHud = {
  engineMemGrows: { sim: number; client: number }
  tick: number
  mainP95Ms: number
  frameP95Ms: number
  tickP95Ms: number
  records: number
  dropped: number
  drawCallsMax: number
  uploadBytesMax: number
}

declare global {
  interface Window {
    __bench?: {
      hud(): BenchHud
      hudText(): string
      framesRendered(): number
      startMarking(): void
      stopMarking(): void
      resetCounters(): void
      adapter(): never
      park(): Promise<void>
      resume(): Promise<void>
    }
  }
}

const REFERENCE = fileURLToPath(new URL('../../../../games/reference/', import.meta.url))
// The frame-bench suite's own port (`scripts/suites.mjs`: 4519) plus an offset no other server uses.
const PORT = Number(process.env.ENGINE_TEST_PORT ?? 4517) + 12
const BASE = `http://127.0.0.1:${PORT}`
const BUILD_BOUND_MS = 240_000

// 0018 §9: one third of each CPU share (main <= 1.3 ms, worker <= 2.7 ms) at the reference game's
// worst-case view.
const MAIN_BUDGET_MS = 1.3
const WORKER_BUDGET_MS = 2.7
// client, sim, gen0 (`genWorkers: 1`).
const EXPECTED_WORKERS = 3

// Same switch as `frame-bench.spec.ts`: the platform decides, never how long anything took.
const isSwiftShader = process.env.ENGINE_GPU === 'swiftshader'
const WARMUP_FRAMES = isSwiftShader ? 5 : 300
const TIMED_FRAMES = isSwiftShader ? 20 : 2000
// The view at maximum zoom-out over the block holds ~8,500 furnaces (1280x720: 12,800 at most).
const MIN_RECORDS = 5000

let preview: ChildProcess | undefined

test.beforeAll(async () => {
  test.setTimeout(BUILD_BOUND_MS + 60_000)
  const build = spawnSync('pnpm', ['exec', 'vite', 'build', '--mode', 'bench'], {
    cwd: REFERENCE,
    encoding: 'utf8',
    timeout: BUILD_BOUND_MS,
  })
  if (build.status !== 0) {
    throw new Error(`vite build --mode bench failed:\n${build.stdout}\n${build.stderr}`)
  }
  preview = spawn(
    'pnpm',
    [
      'exec',
      'vite',
      'preview',
      '--mode',
      'bench',
      '--host',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--strictPort',
    ],
    { cwd: REFERENCE, stdio: 'ignore' },
  )
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const r = await fetch(`${BASE}/index.html`)
      if (r.ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`bench preview did not come up on ${BASE}`)
    await new Promise((r) => setTimeout(r, 200))
  }
})

test.afterAll(() => {
  preview?.kill()
})

test('bench.frame_reference @slow', async ({ page, browser }, testInfo) => {
  await openPage(page, `${BASE}/index.html?bench=large-save`)

  expectAdapter(testInfo, await page.evaluate(() => window.__bench?.adapter() ?? null))

  // The save is generated and the first view's furnaces are in the DrawList.
  await page.waitForFunction(() => (window.__bench?.hud().records ?? 0) >= 5000, null, {
    timeout: 120_000,
  })

  // A worker blocked in its `Atomics.wait` loop answers no CDP `Runtime.evaluate`: park, install the
  // `frame()` wrapper over the client worker's instance (`test.flags` exposes it), resume, all before
  // anything is measured (`bench.frame_worstcase` has the story).
  await page.evaluate(() => window.__bench?.park())
  const { workers, close } = await attachTunnelSessions(page, EXPECTED_WORKERS)
  for (const w of workers) {
    const evaluated = await w.send('Runtime.evaluate', { expression: 'self.__engineIsolateName' })
    w.name = evaluated.result.value
  }
  const clientWorker = workers.find((w) => w.name === 'client')
  if (!clientWorker) throw new Error('bench.frame_reference: no client-isolate worker attached')
  await clientWorker.send('Runtime.evaluate', {
    expression: INSTALL_WORKER_WRAP,
    returnByValue: true,
  })
  await page.evaluate(() => window.__bench?.resume())

  await page.waitForFunction((n) => (window.__bench?.framesRendered() ?? 0) >= n, WARMUP_FRAMES, {
    timeout: 120_000,
  })

  const afterWarmup = await page.evaluate(() => window.__bench?.hud() as BenchHud)
  expect(
    afterWarmup.records,
    'DrawList records after warm-up (a dense base)',
  ).toBeGreaterThanOrEqual(MIN_RECORDS)
  expect(afterWarmup.dropped, 'DrawList records dropped').toBe(0)

  const browserSession = await browser.newBrowserCDPSession()
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
  const startFrames = await page.evaluate(() => {
    window.__bench?.resetCounters()
    window.__bench?.startMarking()
    return window.__bench?.framesRendered() ?? 0
  })
  await page.waitForFunction(
    (n) => (window.__bench?.framesRendered() ?? 0) >= n,
    startFrames + TIMED_FRAMES,
    { timeout: 120_000 },
  )
  await page.evaluate(() => window.__bench?.stopMarking())
  const hud = await page.evaluate(() => window.__bench?.hud() as BenchHud)
  const hudText = await page.evaluate(() => window.__bench?.hudText() ?? '')
  await browserSession.send('Tracing.end')
  await traceDone
  await browserSession.detach()
  close?.()

  expect(hud.dropped, 'DrawList records dropped at the end').toBe(0)
  expect(hud.records, 'DrawList records at the end of the window').toBeGreaterThanOrEqual(
    MIN_RECORDS,
  )

  // Counters of the same run against `budgets.json`: at most one terrain draw plus one per non-empty
  // layer, and the 64 KiB per-frame upload budget (0018 §3).
  expect(hud.drawCallsMax, 'draw calls per frame').toBeLessThanOrEqual(
    budget('counters.render.drawCallsMax'),
  )
  expect(hud.uploadBytesMax, 'upload bytes per frame').toBeLessThanOrEqual(
    budget('counters.render.uploadBytesPerFrame'),
  )
  // The save fits the default arena (0046): no instance grew.
  expect(hud.engineMemGrows, 'engine_mem_grows').toEqual({ sim: 0, client: 0 })

  // The bench HUD: every field present and the three p95s non-zero (M39 reads them on the phone).
  expect(hudText).toMatch(/engine_mem_grows: sim 0, client 0/)
  expect(hudText).toMatch(/^tick: [1-9]\d*$/m)
  for (const field of ['main p95', 'frame p95', 'tick p95']) {
    const m = hudText.match(new RegExp(`^${field}: ([0-9.]+) ms$`, 'm'))
    expect(m, `HUD field "${field}" is present`).not.toBeNull()
    expect(Number(m?.[1]), `HUD field "${field}" is non-zero`).toBeGreaterThan(0)
  }
  expect(hud.mainP95Ms).toBeGreaterThan(0)
  expect(hud.frameP95Ms).toBeGreaterThan(0)
  expect(hud.tickP95Ms).toBeGreaterThan(0)
  expect(hud.tick).toBeGreaterThan(0)

  const mainMs = frameDurationsMs(events, 'mf-s-', 'mf-e-')
  const workerMs = frameDurationsMs(events, 'wf-s-', 'wf-e-')
  expect(mainMs.length, 'main-thread rAF callback marks captured').toBeGreaterThanOrEqual(
    TIMED_FRAMES,
  )
  // Floor from `bench.frame_worstcase`'s own reasoning: a handful of worker samples is not a median.
  const WORKER_SAMPLE_FLOOR = 12
  if (workerMs.length < WORKER_SAMPLE_FLOOR) {
    const message = `client worker frame() marks captured: ${workerMs.length} below floor ${WORKER_SAMPLE_FLOOR}`
    if (isSwiftShader) console.warn(`warn: ${message} (0020 §10)`)
    else expect(workerMs.length, message).toBeGreaterThanOrEqual(WORKER_SAMPLE_FLOOR)
  }

  const sample = {
    mainP50Ms: percentile(mainMs, 0.5),
    mainP95Ms: percentile(mainMs, 0.95),
    mainP99Ms: percentile(mainMs, 0.99),
    workerP50Ms: percentile(workerMs, 0.5),
    workerP95Ms: percentile(workerMs, 0.95),
    workerP99Ms: percentile(workerMs, 0.99),
  }
  const mode = isSwiftShader ? 'smoke' : 'full'
  console.log(
    `bench.frame_reference [${mode}]: records=${hud.records} frames=${mainMs.length}/${workerMs.length} ` +
      `warmup=${WARMUP_FRAMES} timed=${TIMED_FRAMES} swiftshader=${isSwiftShader} ` +
      `drawCallsMax=${hud.drawCallsMax} uploadBytesMax=${hud.uploadBytesMax}`,
  )
  console.log(
    `  main   p50=${sample.mainP50Ms.toFixed(3)}ms p95=${sample.mainP95Ms.toFixed(3)}ms p99=${sample.mainP99Ms.toFixed(3)}ms budget<=${MAIN_BUDGET_MS}ms`,
  )
  console.log(
    `  worker p50=${sample.workerP50Ms.toFixed(3)}ms p95=${sample.workerP95Ms.toFixed(3)}ms p99=${sample.workerP99Ms.toFixed(3)}ms budget<=${WORKER_BUDGET_MS}ms`,
  )
  console.log(`  HUD: ${hudText.replaceAll('\n', ' | ')}`)

  // 0018 §9's proxies and the 25 % rule against the baseline: the helper reads `limits` from the
  // baseline (`frame-reference.json`: mainP50Ms 1.3, workerP50Ms 2.7) and fails only on the baseline
  // machine; under SwiftShader it records and warns.
  gate('frame-reference', sample, { warnOnly: isSwiftShader, suite: 'frame-bench' })
  if (!isSwiftShader) {
    expect(sample.mainP50Ms, 'main p50 vs 0018 §9 desktop proxy').toBeLessThanOrEqual(
      MAIN_BUDGET_MS,
    )
    expect(sample.workerP50Ms, 'worker p50 vs 0018 §9 desktop proxy').toBeLessThanOrEqual(
      WORKER_BUDGET_MS,
    )
  }
})
