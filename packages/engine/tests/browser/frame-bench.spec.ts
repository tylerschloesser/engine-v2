// `bench.frame_worstcase` (docs/plan/17b-sprites-and-frame-budget.md Scope, Planning decisions
// "Frame-time criterion lands here"): the repo's first frame-time exit criterion. `frame-bench.html`
// (a real, connected `fx-drawables` client under real `requestAnimationFrame`) at 0018 §6's own
// worst case -- 256x256 tiles, 65,536 drawables, maximum zoom-out -- 300 frames after 120 warm-up,
// medians taken from trace events between marks (never `performance.now()` deltas computed in page
// JS, the delegation prompt's own binding rule): the main-thread rAF callback (`mf-s-<n>`/`mf-e-<n>`
// marks the page itself makes, armed only for the timed window) and the client worker's own
// `frame()` call (`wf-s-<n>`/`wf-e-<n>` marks a CDP-injected wrapper over `self.__engineInstance
// .call1` makes -- a production worker cannot call `performance.mark` itself, `.claude/rules/
// hot-paths.md`, the same reasoning `tests/browser/gc/instrument.ts` already documents for its own
// `gc-isolate:*` marks). Asserted against 0018 §9's desktop proxy (main <= 1.3 ms, worker <= 2.7 ms)
// and against `baselines/frame.json` within 25% (0020 §9) -- both gate only on Tyler's Mac (0020
// §10: "Real-GPU rendering and timing runs happen only on Tyler's Mac"), so under the CI SwiftShader
// adapter this test still runs and still prints its numbers, but a budget/baseline miss is a warning
// there, the same convention `tests/wasm/worldgen-bench.test.ts` already uses for its own
// machine-dependent ms/chunk figure.
import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { TraceEvent } from './gc/analyse.ts'
import { attachTunnelSessions } from './gc/sessions.ts'
import { type AdapterInfo, expectAdapter, expectNoGpuErrors } from './support/gpu.ts'
import { openPage } from './support/page.ts'

declare global {
  interface Window {
    __frameBench?: {
      adapterInfo: AdapterInfo
      errors(): string[]
      framesRendered(): number
      /** The real published slot's own `record_count` (fix round 1: replaces a page-side constant
       * that compared with itself and proved nothing -- see `frame-bench.ts`'s own doc comment). */
      recordCount(): number
      dropped(): number
      startMarking(): void
      stopMarking(): void
      park(): Promise<void>
      resume(): Promise<void>
      start(): void
    }
  }
}

const RECORD_COUNT = 65_536 // 0018 §6: "65,536 drawables" == `DrawList::CAPACITY` exactly
// `host: { kind: 'local', connect: true }, genWorkers: 1` (`frame-bench.ts`): client, sim, gen0.
const EXPECTED_WORKERS = 3
const TRACE_CATEGORIES = ['v8', 'devtools.timeline', 'blink.user_timing']

// 0018 §9: "one third of each CPU share (main <= 1.3 ms, worker <= 2.7 ms at the reference game's
// worst-case view)".
const MAIN_BUDGET_MS = 1.3
const WORKER_BUDGET_MS = 2.7
const BASELINE_TOLERANCE = 0.25

// The one switch between "full" (real hardware, gates for real) and "smoke" (CI's own SwiftShader
// adapter) mode -- known from the platform (the same env var CI's own workflow sets, `isSwiftShader`
// already gates the budget/baseline/sample-floor checks on), never inferred from how long anything
// took. CI round 1: `ubuntu-latest` under `ENGINE_GPU=swiftshader` could not render 65,536 instanced
// quads/frame 120 times inside the 60 s warm-up wait at all (`TimeoutError`, run 35904901201) -- the
// setup wait itself, not a timing assertion, so warn-not-fail (which only covers the budget/
// baseline/sample-floor checks below) could not save it. Real hardware keeps today's own 120 + 300;
// smoke mode runs the identical page, the identical 65,536-record scene, and the identical park/
// wrap/resume/trace path end to end, only far fewer frames -- 5 warm-up (enough for the worker to
// take at least one real `frame()` call, which is all `recordCount()`/`dropped()` below need to read
// something real) + 20 measured (enough to be virtually certain of at least one `wf-*` mark pair
// even on a CPU an order of magnitude slower than this session's own Mac, without the wait itself
// risking the same timeout this mode exists to avoid). `recordCount === 65_536`/`dropped === 0` stay
// hard assertions in both modes; only the frame counts move, and only here.
const isSwiftShader = process.env.ENGINE_GPU === 'swiftshader'
const SMOKE_WARMUP_FRAMES = 5
const SMOKE_TIMED_FRAMES = 20
const WARMUP_FRAMES = isSwiftShader ? SMOKE_WARMUP_FRAMES : 120
const TIMED_FRAMES = isSwiftShader ? SMOKE_TIMED_FRAMES : 300

type Baseline = {
  recordCount: number
  frames: number
  warmupFrames: number
  measuredAt: string
  conditions: string
  mainMs: { p50: number; p95: number }
  workerMs: { p50: number; p95: number }
}

const baselineUrl = new URL('../../baselines/frame.json', import.meta.url)

function percentile(vals: readonly number[], p: number): number {
  if (vals.length === 0) return 0
  const sorted = [...vals].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx] as number
}

/** Every `<startPrefix><n>`/`<endPrefix><n>` mark pair's own duration, ms -- `ts` is microseconds
 * (Chrome trace convention), so the difference is divided by 1000. Marks are matched by name alone
 * (never by pid/tid): `mf-*`/`wf-*` are each emitted by exactly one thread in this whole trace. */
function frameDurationsMs(
  events: readonly TraceEvent[],
  startPrefix: string,
  endPrefix: string,
): number[] {
  const starts = new Map<string, number>()
  for (const e of events) {
    if (!e.cat?.includes('blink.user_timing')) continue
    if (e.name.startsWith(startPrefix)) starts.set(e.name.slice(startPrefix.length), e.ts)
  }
  const durations: number[] = []
  for (const e of events) {
    if (!e.cat?.includes('blink.user_timing')) continue
    if (!e.name.startsWith(endPrefix)) continue
    const n = e.name.slice(endPrefix.length)
    const s = starts.get(n)
    if (s !== undefined) durations.push((e.ts - s) / 1000)
  }
  return durations
}

/** Installed once, before the real rAF loop ever starts, over the client worker's own
 * `Runtime.evaluate` session -- wraps `EngineInstance.call1` (`self.__engineInstance`, exposed only
 * because `frame-bench.ts` passes `test: { flags: {} }`) so every call whose `fn` is `inst.x.frame`
 * (the client role's own `frame(t_ms)` export, `worker/client.ts`'s `body()`) is bracketed by a
 * `wf-s-<n>`/`wf-e-<n>` mark pair, unconditionally, for the rest of the worker's life -- cheap
 * enough (one extra property check plus two marks per frame) that there is no need to ever remove
 * it, and removing it would mean parking the worker a second time, mid-benchmark, which is exactly
 * what this sequence is designed to avoid (below). Only marks that land inside the `Tracing.start`/
 * `Tracing.end` window are ever read back (`frameDurationsMs`), so warm-up frames' own marks are
 * simply never collected, not specially suppressed. */
const INSTALL_WORKER_WRAP = `(() => {
  const inst = self.__engineInstance;
  if (!inst || inst.__frameBenchWrapped) return 'skip';
  const orig = Object.getPrototypeOf(inst).call1;
  const frameFn = inst.x.frame;
  let n = 0;
  inst.call1 = function (fn, a) {
    if (fn === frameFn) {
      self.performance.mark('wf-s-' + n);
      const r = orig.call(inst, fn, a);
      self.performance.mark('wf-e-' + n);
      n += 1;
      return r;
    }
    return orig.call(inst, fn, a);
  };
  inst.__frameBenchWrapped = true;
  return 'installed';
})()`

test('bench.frame_worstcase @slow', async ({ page, browser }, testInfo) => {
  await openPage(page, '/frame-bench.html')

  const setup = await page.evaluate(() => ({
    adapter: window.__frameBench?.adapterInfo ?? null,
  }))
  expectAdapter(testInfo, setup.adapter)

  // A worker blocked in its normal `Atomics.wait` loop never processes a CDP `Runtime.evaluate`
  // (found empirically, this milestone: the loop's own synchronous call stack never returns to the
  // isolate's message pump except through the park protocol's own handshake) -- park every worker,
  // install the wrapper, then resume, all before `start()` below ever runs a real frame, so nothing
  // measured races this one-time CDP round trip (`frame-bench.ts`'s own `park`/`resume`/`start`).
  await page.evaluate(() => window.__frameBench?.park())

  const { workers, close } = await attachTunnelSessions(page, EXPECTED_WORKERS)
  for (const w of workers) {
    const evaluated = await w.send('Runtime.evaluate', { expression: 'self.__engineIsolateName' })
    w.name = evaluated.result.value
  }
  const clientWorker = workers.find((w) => w.name === 'client')
  if (!clientWorker) throw new Error('bench.frame_worstcase: no client-isolate worker attached')

  await clientWorker.send('Runtime.evaluate', {
    expression: INSTALL_WORKER_WRAP,
    returnByValue: true,
  })

  await page.evaluate(() => window.__frameBench?.resume())
  await page.evaluate(() => window.__frameBench?.start())

  // Warm-up: 120 real rAF frames, unmarked on the main thread (JIT tiers, inline caches, lazily
  // created GPU state -- the spike's own `WARMUP` precedent, `spikes/zero-gc-webgpu/tests/
  // harness.mjs`); the worker wrapper above is already marking every `frame()` call, but nothing
  // reads those marks back until `Tracing.start` below.
  await page.waitForFunction(
    (n) => (window.__frameBench?.framesRendered() ?? 0) >= n,
    WARMUP_FRAMES,
    { timeout: 60_000 },
  )

  // Fix round 1 (coordinator review): the record count and drop count of the slot main actually
  // `acquire()`d, read off `DrawablesRenderer`'s own live header fields -- not a page-side constant,
  // which proves nothing about what `extract()`/`visible()` produced. Read once here (after
  // warm-up, so at least one real published frame exists) and once more at the end of the timed
  // window (below): both must show the full worst case, not a partial one `visible()`'s own clip
  // silently narrowed.
  const afterWarmup = await page.evaluate(() => ({
    recordCount: window.__frameBench?.recordCount() ?? -1,
    dropped: window.__frameBench?.dropped() ?? -1,
  }))
  expect(afterWarmup.recordCount, 'published record_count after warm-up').toBe(RECORD_COUNT)
  expect(afterWarmup.dropped, 'published dropped after warm-up').toBe(0)

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

  // `startFrames` is read *after* `startMarking()` resolves, not before (found by measurement: a
  // capture taken before it left several early frames of the "timed window" unmarked -- rendered
  // during this call's own CDP round trip, at ~1500 fps under uncapped rAF -- undercounting the
  // main-thread mark pairs actually collected below).
  const startFrames = await page.evaluate(() => {
    window.__frameBench?.startMarking()
    return window.__frameBench?.framesRendered() ?? 0
  })

  // Timed window: 300 real rAF frames (`--disable-frame-rate-limit --disable-gpu-vsync`, the
  // `frame-bench` project's own launch flags, make this fast wall-clock despite being real rAF).
  await page.waitForFunction(
    (n) => (window.__frameBench?.framesRendered() ?? 0) >= n,
    startFrames + TIMED_FRAMES,
    { timeout: 60_000 },
  )

  // Read again at the end of the timed window (still measuring `recordCount()`/`dropped()`'s own
  // live state, not a snapshot from earlier that a mid-run regression could have moved past).
  const atEnd = await page.evaluate(() => ({
    recordCount: window.__frameBench?.recordCount() ?? -1,
    dropped: window.__frameBench?.dropped() ?? -1,
  }))
  expect(atEnd.recordCount, 'published record_count at the end of the timed window').toBe(
    RECORD_COUNT,
  )
  expect(atEnd.dropped, 'published dropped at the end of the timed window').toBe(0)

  await page.evaluate(() => window.__frameBench?.stopMarking())
  await browserSession.send('Tracing.end')
  await traceDone
  await browserSession.detach()
  close?.()

  const gpuErrors = await page.evaluate(() => window.__frameBench?.errors() ?? [])
  expectNoGpuErrors(gpuErrors)

  const mainMs = frameDurationsMs(events, 'mf-s-', 'mf-e-')
  const workerMs = frameDurationsMs(events, 'wf-s-', 'wf-e-')
  expect(mainMs.length, 'main-thread rAF callback marks captured').toBeGreaterThanOrEqual(
    TIMED_FRAMES,
  )
  // Fix round 2 (coordinator review, sample-size nit): `toBeGreaterThan(0)` let a single worker
  // sample (or a handful) stand in for the whole p50/p95 -- a worker that is running but badly
  // starved (a park/resume regression that only *partly* breaks wake delivery, say) would still
  // pass. `WORKER_SAMPLE_FLOOR` is set from this session's own repeated measurements at this exact
  // scene on Tyler's Mac (baselines/frame.json's own "Fix round 1"/"Fix round 2" Deviations): 20-24
  // `wf-*` pairs per 300-main-frame window, every run, dozens of runs across two fix rounds -- never
  // below 20. 12 is a little over half that floor: real machine-load jitter (the very thing that
  // motivated moving this suite to `solo: true`, below) can plausibly cost a few samples without the
  // worker being starved, but a run in the low single digits is not jitter, it is something
  // structurally wrong with wake delivery -- caught here, verified by injection (Deviations).
  // **Also gated on `isSwiftShader`** (found running this exact check under `CI=true ENGINE_GPU=
  // swiftshader`, Fix round 2 item 5): a software adapter's own per-call cost at 65,536 records is
  // high enough (measured: 2 samples in the same window, against 20-24 on real hardware) that this
  // is the *same* machine-dependent timing effect the budget/baseline checks below already warn
  // instead of fail on (0020 §10), not a real starvation bug -- SwiftShader was never proven to
  // starve the worker's own wake delivery, only to make each wake far slower. Left uncalibrated for
  // smoke mode's own much smaller `TIMED_FRAMES` (CI round 1): `isSwiftShader` already implies smoke
  // mode (below), so this floor only ever fires as a hard failure in full mode, where it stays
  // exactly the figure it was measured against.
  const WORKER_SAMPLE_FLOOR = 12
  if (workerMs.length < WORKER_SAMPLE_FLOOR) {
    const message = `client worker frame() marks captured: ${workerMs.length} below floor ${WORKER_SAMPLE_FLOOR}`
    if (isSwiftShader) {
      console.warn(`warn: ${message} (0020 §10: real-GPU timing gates only on Tyler's Mac)`)
    } else {
      expect(workerMs.length, message).toBeGreaterThanOrEqual(WORKER_SAMPLE_FLOOR)
    }
  }

  const mainP50 = percentile(mainMs, 0.5)
  const mainP95 = percentile(mainMs, 0.95)
  const workerP50 = percentile(workerMs, 0.5)
  const workerP95 = percentile(workerMs, 0.95)

  const baselineExists = existsSync(baselineUrl)
  const baseline = baselineExists
    ? (JSON.parse(readFileSync(baselineUrl, 'utf8')) as Baseline)
    : null

  // Named explicitly (not just `warmup=`/`swiftshader=`, both already printed) so a CI log's own
  // reader does not mistake a smoke run's own tiny numbers for a full one (CI round 1).
  const mode = isSwiftShader ? 'smoke' : 'full'
  console.log(
    `bench.frame_worstcase [${mode}]: records=${RECORD_COUNT} frames=${mainMs.length}/${workerMs.length} ` +
      `warmup=${WARMUP_FRAMES} timed=${TIMED_FRAMES} swiftshader=${isSwiftShader}`,
  )
  console.log(
    `  main   p50=${mainP50.toFixed(3)}ms p95=${mainP95.toFixed(3)}ms budget<=${MAIN_BUDGET_MS}ms` +
      (baseline ? ` baseline.p50=${baseline.mainMs.p50}ms (+/-${BASELINE_TOLERANCE * 100}%)` : ''),
  )
  console.log(
    `  worker p50=${workerP50.toFixed(3)}ms p95=${workerP95.toFixed(3)}ms budget<=${WORKER_BUDGET_MS}ms` +
      (baseline
        ? ` baseline.p50=${baseline.workerMs.p50}ms (+/-${BASELINE_TOLERANCE * 100}%)`
        : ''),
  )

  function assertOrWarn(actual: number, limit: number, label: string): void {
    if (actual <= limit) return
    const message = `${label}: ${actual.toFixed(3)}ms exceeds ${limit.toFixed(3)}ms`
    if (isSwiftShader) {
      console.warn(`warn: ${message} (0020 §10: real-GPU timing gates only on Tyler's Mac)`)
      return
    }
    expect(actual, message).toBeLessThanOrEqual(limit)
  }

  assertOrWarn(mainP50, MAIN_BUDGET_MS, 'main p50 vs 0018 §9 desktop proxy')
  assertOrWarn(workerP50, WORKER_BUDGET_MS, 'worker p50 vs 0018 §9 desktop proxy')
  if (baseline) {
    assertOrWarn(
      mainP50,
      baseline.mainMs.p50 * (1 + BASELINE_TOLERANCE),
      `main p50 vs baseline ${baseline.mainMs.p50}ms`,
    )
    assertOrWarn(
      workerP50,
      baseline.workerMs.p50 * (1 + BASELINE_TOLERANCE),
      `worker p50 vs baseline ${baseline.workerMs.p50}ms`,
    )
  }
})
