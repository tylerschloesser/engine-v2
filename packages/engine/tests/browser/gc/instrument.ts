// `measure()`: the Node-side driver of 0016 §3 steps 1-7 plus the M04 extras (docs/plan/04-zero-gc-
// harness.md, Planning decisions "Sequence"). CDP plumbing (`sessions.ts`/`cdp-flat.ts`) and pure
// analysis (`analyse.ts`) are both file-local concerns; this is where they meet the page's
// `window.__gc`/`window.__harness` API (`src/test/gc-page.ts`, `src/test/harness.ts`).
import type { Browser, Page } from '@playwright/test'
import type { NegativeControl } from '../../../src/test/controls.ts'
import type { GcPageApi, GcPageReady } from '../../../src/test/gc-page.ts'
import type { Harness } from '../../../src/test/harness.ts'
import { gcPage } from '../../support/budgets.ts'
import {
  analyseTrace,
  attributedBytes,
  verdict as computeVerdict,
  type GcCounts,
  type Profile,
  sumProfile,
  type TraceEvent,
  tracingStallWarning,
  type Verdict,
} from './analyse.ts'
import { attachFlatSessions, ENGINE_CDP_PORT_BASE } from './cdp-flat.ts'
import { attachTunnelSessions, type IsolateSession } from './sessions.ts'

declare global {
  interface Window {
    __gc?: GcPageApi
    __harness?: Harness
  }
}

// 0016 §3 step 5 and the spike's own reliability numbers (RESULT.md).
const TRACE_CATEGORIES = ['v8', 'devtools.timeline', 'blink.user_timing']
const SAMPLING_INTERVAL = 1
const FRAMES = 600
// `gc-loop`'s own tuned figure is 120; the production `yield`-protocol shell (`ControlBlock`,
// `worker/shell.ts`, `asHarness`) is a deeper call chain that needs more to reach steady optimised
// code (docs/plan/06b-workers-and-spawn.md, Deviations "fix round 2"). Applied globally (not a
// per-page option): with the two real allocation bugs on this path fixed (`parkWorkers`/
// `resumeWorkers`'s per-tick closure, `ManualClock.fireDue`'s per-`advance()` empty-Map iterator),
// `gc-loop` itself is unaffected by the higher figure (still well inside its own budget), so one
// constant is simpler than threading a per-page override through `measure()`/`zeroGcSuite` again.
const WARMUP = 8000
/** Warm-up frames are driven in this many separate `run()` calls (fix round 3; see the call site):
 * one pass warms the per-frame work but gives `run()`'s own resume/park path a single invocation,
 * which is too few for V8 to have allocated its feedback before the measured window. */
const WARMUP_PASSES = 8

export type GcMode = 'hardware' | 'software'
export type GcTransport = 'tunnel' | 'flat'

export type GcResult = {
  pageId: string
  control: NegativeControl
  mode: GcMode
  frames: number
  isolates: string[]
  crossOriginIsolated: boolean
  adapter: object | null
  gc: Record<string, GcCounts>
  /** Exact sampled bytes over the whole window (`sumProfile(...).total`), before dividing by
   * `frames`: the flat-transport parity test compares these exactly, per isolate. */
  totalBytes: Record<string, number>
  bytesPerFrame: Record<string, number>
  attributedBytesPerFrame: Record<string, number>
  byFn: Record<string, Record<string, number>>
  memoryBytes: { before: Record<string, number>; after: Record<string, number> }
  memGrows: Record<string, number>
  errors: string[]
  ms: { total: number; tracingStart: number }
  warnings: string[]
  verdict: Verdict
}

function gcModeFromEnv(): GcMode {
  return process.env.GC_MODE === 'software' ? 'software' : 'hardware'
}

export function gcTransportFromEnv(): GcTransport {
  return process.env.GC_CDP === 'flat' ? 'flat' : 'tunnel'
}

/** The `gc` project's own port formula (`playwright.config.ts`): base + this worker's index, so
 * `pnpm gc flat` reaches the same Chromium the `page`/`browser` fixtures already launched. */
function cdpPortForThisWorker(): number {
  return ENGINE_CDP_PORT_BASE + Number(process.env.TEST_PARALLEL_INDEX ?? 0)
}

/** Exported for `gc-loop.spec.ts`'s `gc: flat transport parity` test, which forces this transport
 * on one call and the tunnel on another against the same page. */
export async function flatAttachForThisWorker(page: Page, expectedWorkers: number) {
  return attachFlatSessions(cdpPortForThisWorker(), new URL(page.url()).pathname, expectedWorkers)
}

/**
 * Runs the whole measurement window against an already-`openPage`d `page` (Planning decisions
 * "Sequence" starts at "attach sessions": navigation and the cross-origin-isolation/console-error
 * contract are `tests/browser/support/page.ts`'s `openPage`, called by the suite before this) whose
 * script called `installGcPage` (`window.__gc` and `window.__harness` both present). `attach` lets a
 * caller (the flat-transport parity test) supply `cdp-flat.ts`'s session pair instead of the default
 * tunnel.
 */
export async function measure(
  page: Page,
  browser: Browser,
  opts: {
    pageId: string
    control?: NegativeControl
    attach?: (
      page: Page,
      expectedWorkers: number,
    ) => Promise<{ main: IsolateSession; workers: IsolateSession[]; close?: () => void }>
  },
): Promise<GcResult> {
  const mode = gcModeFromEnv()
  const control = opts.control ?? null
  const budgets = gcPage(opts.pageId)
  // 0016 caveat b: "A page whose `software` is `null` fails in that mode with 'no software budget
  // for <pageId>'." Checked before the (costly) measurement itself.
  if (mode === 'software' && budgets.software === null) {
    throw new Error(`gc verdict: no software budget for ${opts.pageId}`)
  }
  const frames = mode === 'software' ? (budgets.software?.frames ?? FRAMES) : FRAMES
  const warnings: string[] = []
  const t0 = performance.now()

  const ready = await page.evaluate(() => window.__gc?.ready)
  if (!ready) {
    throw new Error(
      `gc instrument: page for '${opts.pageId}' has no window.__gc (installGcPage not called?)`,
    )
  }

  const expectedWorkers = ready.isolates.length - 1 // every isolate but main
  const attach =
    opts.attach ??
    (gcTransportFromEnv() === 'flat' ? flatAttachForThisWorker : attachTunnelSessions)
  const { main, workers, close: closeSessions } = await attach(page, expectedWorkers)

  // Name every worker session (Planning decisions "Naming isolates", CDP side).
  for (const w of workers) {
    const evaluated = await w.send('Runtime.evaluate', { expression: 'self.__engineIsolateName' })
    w.name = evaluated.result.value
  }
  const sessions: IsolateSession[] = [main, ...workers]

  // Fixed warm-up (docs/plan/06b-workers-and-spawn.md, Deviations "fix round 2"): the tiering
  // hypothesis explained the *symptom* (unoptimised code boxes more per call) but the actual
  // per-frame allocation, on inspection, came from two real bugs on this path -- `parkWorkers`/
  // `resumeWorkers`'s poll predicate allocated a fresh closure and ran `Array.prototype.every`
  // every tick (`src/test/client.ts`), and `ManualClock.fireDue` built a `Map` iterator on every
  // `advance()` call even with zero timers (`src/test/manual-clock.ts`) -- both scaling with how
  // long parking/ticking took, not with frame count, which is why no warm-up count (nor an
  // adaptive warm-up-until-stable loop, tried and removed here) fixed them. With both fixed, a
  // short fixed warm-up (matching `gc-loop`'s own long-tuned figure) is enough.
  // Split into `WARMUP_PASSES` calls, not one (fix round 3, same Deviations): the per-frame work
  // inside `run()` was already warm after one long pass, but `run()`'s own *entry and exit* path --
  // `harness.resume()` -> the worker's `armedLoop` invocation -> two `post()` calls -> `harness
  // .park()` -- ran exactly once per pass, so with a single pass the measured window was that
  // path's second-ever invocation, right at V8's lazy-feedback-allocation threshold. The feedback
  // allocation for `armedLoop` (28 B + 108 B, measured per-sample) then landed inside the window on
  // roughly a third of runs and before it on the rest: exactly the 136 B `gc: flat transport
  // parity` kept catching on `sim`. Same total frames, so no measurement is shortened.
  for (let i = 0; i < WARMUP_PASSES; i++) {
    await page.evaluate((n) => window.__gc?.run(n, false), WARMUP / WARMUP_PASSES)
  }
  const memBefore = await page.evaluate(() => window.__gc?.memoryBytes())
  if (!memBefore) throw new Error('gc instrument: memoryBytes() before the window returned nothing')

  for (const s of sessions) {
    await s.send('HeapProfiler.enable')
    await s.send('HeapProfiler.collectGarbage')
  }

  const browserSession = await browser.newBrowserCDPSession()
  const events: TraceEvent[] = []
  browserSession.on('Tracing.dataCollected', (ev) =>
    events.push(...(ev.value as unknown as TraceEvent[])),
  )
  const traceDone = new Promise<void>((resolve) =>
    browserSession.once('Tracing.tracingComplete', () => resolve()),
  )
  const tGcStart = performance.now()
  await browserSession.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { recordMode: 'recordUntilFull', includedCategories: TRACE_CATEGORIES },
  })
  const tracingStartMs = performance.now() - tGcStart
  const stall = tracingStallWarning(tracingStartMs)
  if (stall) warnings.push(stall)

  // Marks every isolate through CDP directly, not `window.__gc.markIsolates()` (orchestrator
  // decision 3, docs/plan/06b-workers-and-spawn.md): a production worker cannot call
  // `performance.mark` itself (`.claude/rules/hot-paths.md` restricts it to `src/clock.ts` and
  // `src/test/**`) and this milestone adds no new `postMessage` type to ask one to. Workers are
  // still parked here (the warmup `run()` above ends with `harness.park()`, and the measured
  // `run()` below resumes them itself), so this is safe on every page, harness-driven (`gc-loop`)
  // or production-topology (`topology`, `echo`) alike; `gc-page.ts`'s own `markIsolates()` stays
  // available (M04's harness-worker message path), just unused from here on.
  // Workers only: `main` still marks itself through `page.evaluate()`, same as before (a page
  // script can always call `performance.mark` itself; only a production *worker* cannot). A second
  // CDP session issuing `Runtime.evaluate` against `main` alongside Playwright's own automation
  // session measurably moved `gc-loop`'s own `main` bytesPerFrame past its budget (Deviations);
  // `returnByValue: true` and the trailing `; undefined` avoid retaining the `PerformanceMark`
  // object `performance.mark()` returns as a remote object for the rest of the CDP session.
  for (const w of workers) {
    await w.send('Runtime.evaluate', {
      expression: `self.performance.mark('gc-isolate:' + self.__engineIsolateName); undefined`,
      returnByValue: true,
    })
  }
  await page.evaluate(() => performance.mark('gc-isolate:main'))

  for (const s of sessions) {
    await s.send('HeapProfiler.startSampling', {
      samplingInterval: SAMPLING_INTERVAL,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    })
  }

  await page.evaluate((c) => window.__gc?.setControl(c), control)

  const runResult = await page.evaluate((n) => window.__gc?.run(n, true), frames)
  if (!runResult) throw new Error('gc instrument: run() returned nothing')

  const rawProfiles: Record<string, Profile> = {}
  for (const s of sessions) {
    const { profile } = await s.send('HeapProfiler.stopSampling')
    rawProfiles[s.name] = profile
  }
  await browserSession.send('Tracing.end')
  await traceDone

  const trace = analyseTrace(events)

  const memAfter = await page.evaluate(() => window.__gc?.memoryBytes())
  const memGrows = await page.evaluate(() => window.__gc?.memGrows())
  if (!memAfter || !memGrows)
    throw new Error('gc instrument: memoryBytes()/memGrows() after the window returned nothing')

  await browserSession.detach()

  const bytesPerFrame: Record<string, number> = {}
  const attributedBytesPerFrame: Record<string, number> = {}
  const byFn: Record<string, Record<string, number>> = {}
  const totalBytes: Record<string, number> = {}
  const attributedBytesTotal: Record<string, number> = {}
  for (const [name, profile] of Object.entries(rawProfiles)) {
    const summed = sumProfile(profile)
    totalBytes[name] = summed.total
    bytesPerFrame[name] = summed.total / frames
    byFn[name] = summed.byFn
    const roots = budgets.isolates[name]?.attributionRoots ?? []
    const attributed = attributedBytes(profile, roots)
    attributedBytesTotal[name] = attributed
    attributedBytesPerFrame[name] = attributed / frames
  }

  const verdict = computeVerdict(
    { frames, gc: trace.gc, totalBytes, attributedBytesTotal },
    budgets,
    mode,
  )

  closeSessions?.()

  return {
    pageId: opts.pageId,
    control,
    mode,
    frames,
    isolates: ready.isolates,
    crossOriginIsolated: ready.crossOriginIsolated,
    adapter: ready.adapter,
    gc: trace.gc,
    totalBytes,
    bytesPerFrame,
    attributedBytesPerFrame,
    byFn,
    memoryBytes: { before: memBefore, after: memAfter },
    memGrows,
    errors: runResult.errors,
    ms: { total: performance.now() - t0, tracingStart: tracingStartMs },
    warnings,
    verdict,
  }
}

export type { GcPageReady }
