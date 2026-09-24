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
//
// **Re-measured and halved, M16c step 3** (docs/plan/16c-browser-suite-time.md, Deviations):
// attribution (Node-side `performance.now()` marks around each phase of `measure()`, temporary,
// not committed) found this loop -- not the two 600-frame measured windows 0028 protects -- is the
// dominant per-test fixed cost: ~1.45-1.5 s of `echo clean`'s own ~1.75 s internal `measure()` time
// (each measured window is only ~0.11 s). `input`'s own `main` isolate is the one page in this
// repo historically fragile to warm-up (0028's own Amendment): re-measured here at every value from
// 8000 down to 2000, `--repeat-each` batches, quiet and under `--load 10` --
// 4000: stable at 181.6-181.7 B/frame (matches the *pre-0028* historical 181.673-181.913 baseline
// exactly, i.e. fully JIT-settled, comfortably under the 190 budget); 3000: 186.1-187.0 (too close
// to 190 to keep as a committed margin); 2000: 196.2-196.7, over budget outright (a real, recurring
// cost across both 0028 windows, not a one-off JIT burst -- insufficient warm-up, not noise). 4000
// is therefore the floor with headroom preserved; every `budgets.json` number is unchanged. Full
// `gc` project (77 tests, every page, `@slow` burst included) at 4000: 3/3 clean runs, 77/77 passing
// each time, quiet and under `--load 10` (`docs/plan/16c-browser-suite-time.md`'s own verification);
// fast tier alone (48 tests) fell from 17.4 s to 12.3 s wall.
const WARMUP = 4000
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
  /** `analyseTrace(...).presentIsolates`, as an array (gate round 3, docs/plan/
   * 09-renderer-terrain.md Deviations): isolate names with at least one trace event inside the
   * window, proving the CDP thread-discovery A depends on actually found that isolate's thread. */
  presentIsolates: string[]
  /** Exact sampled bytes over the whole window (`sumProfile(...).total`), before dividing by
   * `frames`: the flat-transport parity test compares these exactly, per isolate. */
  totalBytes: Record<string, number>
  bytesPerFrame: Record<string, number>
  attributedBytesPerFrame: Record<string, number>
  byFn: Record<string, Record<string, number>>
  /** [0028](../../../../docs/decisions/0028-zero-gc-two-measured-windows.md): both measured
   * windows' own byte totals per isolate, `[first, second]`. `totalBytes` is the lower of the two;
   * the pair is reported alongside so the discarded window is always visible next to the verdict
   * and the minimum is never a silent subtraction. */
  windowBytes: Record<string, [number, number]>
  /** `sumProfile(...).byFn` for *both* windows, `[first, second]`, per isolate -- the same call
   * already made to fill `windowBytes` above, its `byFn` half kept instead of discarded. `byFn`
   * itself only ever carries the chosen (lower) window's sites; a mismatch whose cause is an event
   * landing in both windows at a different magnitude (gc-parity defect-fix session, 2026-09-21:
   * `scope.onmessage` on `gc-loop`'s `sim`, 388 B in the first window vs 348 B in the second, same
   * page load) is invisible in `byFn`/`windowBytes` alone and needs both windows' own sites next to
   * each other to name. */
  windowByFn: Record<string, [Record<string, number>, Record<string, number>]>
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
    /** Extra frames driven, through the same `window.__gc.run(n, false)` warm-up path, right after
     * the `WARMUP_PASSES` loop and still before `HeapProfiler.startSampling` (docs/plan/
     * 09-renderer-terrain.md, Deviations "Gate fix round 2"). `terrain`'s own `client` isolate races
     * a background (concurrent) TurboFan recompilation of the hot `waitForWake`/`runBlockingLoop`
     * path against the profiler's own start on roughly a third of runs (measured: `--no-concurrent-
     * recompilation` made the flake a *constant* reading, `--no-lazy-feedback-allocation` did too --
     * both point at JIT-tier finalization, not a per-pass leak or per-wake box: the extra bytes
     * attribute to whichever of `waitForWake`/`commit`/`load`/`store` happens to be on the stack
     * when the finalization lands, never scaling with the window's own wake/pass counts). Driving
     * the identical production path for longer, still entirely inside the always-allocation-free
     * warm-up phase, gives that recompilation time to land before sampling starts instead of during
     * it -- 0/140 failures at 300-500 extra frames in isolated repro, against ~30% at 0 and ~15% at
     * 200 (a real threshold, not a smooth "rarer with more frames" curve, docs/plan/
     * 09-renderer-terrain.md, Deviations "Gate fix round 2" has the full table). Default 0: every
     * other page's own warm-up (and terrain's own negative controls, which trip on `client` anyway
     * and are unaffected either way) is unchanged.
     *
     * Superseded as a *fix* by [0028](../../../../docs/decisions/0028-zero-gc-two-measured-windows.md)
     * (M11 fix round 3), which handles the same mechanism for every page at once. M11 re-measured
     * this knob on the `input` page and found it moves the event's phase rather than settling it:
     * `extraSettleFrames: 500` there took `client`'s burst rate from 8/80 runs to 72/80. `terrain`
     * keeps its 500 because that page's own numbers were derived with it; the option is not one a
     * new page should reach for. */
    extraSettleFrames?: number
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
  // M19b (docs/plan/19b-sim-park-while-armed.md): `gc: flat transport parity` calls `measure()`
  // twice against the same page (tunnel, then flat) inside one test; a `park`/`send` timeout thrown
  // from inside one of the `page.evaluate` calls below used to carry no way to tell which of the two
  // it came from short of reading the stack trace by hand. `attach.name` names the function actually
  // in use (`attachTunnelSessions`/`flatAttachForThisWorker`, or a caller-supplied one), which is
  // exactly "which of the two measures" for that test; every other caller passes no `attach` at all,
  // so this is `gcTransportFromEnv()`'s own tunnel/flat choice there.
  const transportLabel = opts.attach ? attach.name || 'custom' : gcTransportFromEnv()
  const { main, workers, close: closeSessions } = await attach(page, expectedWorkers)

  // Name every worker session (Planning decisions "Naming isolates", CDP side).
  for (const w of workers) {
    const evaluated = await w.send('Runtime.evaluate', { expression: 'self.__engineIsolateName' })
    w.name = evaluated.result.value
  }
  const sessions: IsolateSession[] = [main, ...workers]

  // M19b: labels a `park`/`send` timeout thrown from inside `fn` with which `measure()` call
  // (`transportLabel`, above) and which phase of it was running -- the other half of "which of the
  // two `measure`s it follows" (docs/plan/19b-sim-park-while-armed.md, exit criterion 1). Only
  // wraps `page.evaluate` calls that reach `installGcPage`'s own `run()` (Seams), which is what can
  // throw a `harness.park()`/`resume()` timeout in the first place.
  async function runPhase<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(`measure[${transportLabel}] ${label}: ${message}`)
    }
  }

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
    await runPhase(`warmup pass ${i + 1}/${WARMUP_PASSES}`, () =>
      page.evaluate((n) => window.__gc?.run(n, false), WARMUP / WARMUP_PASSES),
    )
  }
  const extraSettleFrames = opts.extraSettleFrames
  if (extraSettleFrames) {
    await runPhase('extra settle', () =>
      page.evaluate((n) => window.__gc?.run(n, false), extraSettleFrames),
    )
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

  const startSampling = async (): Promise<void> => {
    for (const s of sessions) {
      await s.send('HeapProfiler.startSampling', {
        samplingInterval: SAMPLING_INTERVAL,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      })
    }
  }
  const stopSampling = async (): Promise<Record<string, Profile>> => {
    const out: Record<string, Profile> = {}
    for (const s of sessions) {
      const { profile } = await s.send('HeapProfiler.stopSampling')
      out[s.name] = profile
    }
    return out
  }

  await page.evaluate((c) => window.__gc?.setControl(c), control)

  // 0028: two consecutive measured windows, identical in every way but the `window-start`/
  // `window-end` marks, which only the second carries (so assertion A keeps its single 600-frame
  // trace window, exactly as 0016 §3 step 6 defines it). Assertion B's byte total is the *lower* of
  // the two per isolate. A V8 tier-up/code-installation event is one-off by construction -- once a
  // function is compiled it is not compiled again -- so it lands in at most one of the two windows;
  // real per-frame allocation lands in both and survives the minimum untouched. Nothing is excluded
  // by name, by size or by isolate: the discriminator is the one property the budget actually
  // asserts, "does this recur every frame?".
  await startSampling()
  const firstRun = await runPhase('measured window 1', () =>
    page.evaluate((n) => window.__gc?.run(n, false), frames),
  )
  if (!firstRun) throw new Error('gc instrument: run() returned nothing')
  const firstProfiles = await stopSampling()

  await startSampling()
  const runResult = await runPhase('measured window 2', () =>
    page.evaluate((n) => window.__gc?.run(n, true), frames),
  )
  if (!runResult) throw new Error('gc instrument: run() returned nothing')
  const secondProfiles = await stopSampling()

  // Per isolate, the window with the lower total wins outright -- its profile is what `byFn` and
  // the software-mode `attributedBytes` are then read from too, so a failure's own printed
  // allocation sites always belong to the total it failed on.
  const rawProfiles: Record<string, Profile> = {}
  const windowBytes: Record<string, [number, number]> = {}
  const windowByFn: Record<string, [Record<string, number>, Record<string, number>]> = {}
  for (const name of Object.keys(secondProfiles)) {
    const first = firstProfiles[name] as Profile
    const second = secondProfiles[name] as Profile
    const firstSummed = sumProfile(first)
    const secondSummed = sumProfile(second)
    const totals: [number, number] = [firstSummed.total, secondSummed.total]
    windowBytes[name] = totals
    windowByFn[name] = [firstSummed.byFn, secondSummed.byFn]
    rawProfiles[name] = totals[0] <= totals[1] ? first : second
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
    presentIsolates: [...trace.presentIsolates],
    totalBytes,
    bytesPerFrame,
    attributedBytesPerFrame,
    byFn,
    windowBytes,
    windowByFn,
    memoryBytes: { before: memBefore, after: memAfter },
    memGrows,
    errors: [...firstRun.errors, ...runResult.errors],
    ms: { total: performance.now() - t0, tracingStart: tracingStartMs },
    warnings,
    verdict,
  }
}

export type { GcPageReady }
