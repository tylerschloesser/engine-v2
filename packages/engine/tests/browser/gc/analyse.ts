// Pure analysis of the two CDP artefacts the `gc` instrument collects (docs/decisions/0016 §3 steps
// 6-7; ported from spikes/zero-gc-webgpu/tests/harness.mjs's `sumProfile`/`analyseTrace`). No CDP,
// no Playwright: everything here is a function of already-captured JSON, so it is unit-testable on
// small canned samples (`gc/data/{trace,profile}-sample.json`) without a browser.

/** `HeapProfiler.stopSampling`'s `profile.head`: a call tree with exact `selfSize` per node
 * (`samplingInterval: 1`, 0016 §3 step 4). */
export type ProfileNode = {
  selfSize?: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  children?: ProfileNode[]
}
export type Profile = { head: ProfileNode }

/** One `Tracing.dataCollected` event. Only the fields analysis reads. */
export type TraceEvent = {
  name: string
  cat?: string
  ph?: string
  pid: number
  tid: number
  ts: number
  args?: { name?: string }
}

export type GcCounts = { MinorGC: number; MajorGC: number }

/** Total sampled bytes plus the top 8 allocation sites by bytes (what a failing test prints: 0016
 * §3 step 7).
 *
 * Every sampled byte counts, with no exemption by function name, size or isolate.
 * [0028](../../../../docs/decisions/0028-zero-gc-two-measured-windows.md) superseded the one
 * name-based exclusion this function briefly carried ([0027](../../../../docs/decisions/
 * 0027-zero-gc-excludes-blocking-primitive-bookkeeping.md), `waitForWake`): the bytes it was meant
 * to remove are a one-off V8 tier-up/code-installation burst that the sampled profile bills to
 * whichever JS frame happens to be executing when it lands -- measured on `waitForWake`,
 * `runBlockingLoop`, `body`, `call1`, `load`, `get detached` and `scope.onmessage` on one isolate
 * of one page -- so no set of names can catch it. `measure()` separates it by running two windows
 * and taking the lower total instead. */
export function sumProfile(profile: Profile): {
  total: number
  byFn: Record<string, number>
} {
  let total = 0
  const byFn = new Map<string, number>()
  const walk = (node: ProfileNode): void => {
    if (node.selfSize) {
      const cf = node.callFrame
      const key = `${cf.functionName || '(anonymous)'}@${(cf.url || '').split('/').pop()}:${cf.lineNumber + 1}`
      byFn.set(key, (byFn.get(key) ?? 0) + node.selfSize)
      total += node.selfSize
    }
    node.children?.forEach(walk)
  }
  walk(profile.head)
  return {
    total,
    byFn: Object.fromEntries([...byFn].sort((a, b) => b[1] - a[1]).slice(0, 8)),
  }
}

/** Inclusive `selfSize` of every node at or under a call frame whose `functionName` is in `roots`
 * (the software-mode arithmetic of 0016 caveat b: "bytes attributed to the engine's frame/tick
 * functions"). A node under a root stays attributed even if a deeper frame is also a root. */
export function attributedBytes(profile: Profile, roots: readonly string[]): number {
  const rootSet = new Set(roots)
  let total = 0
  const walk = (node: ProfileNode, underRoot: boolean): void => {
    const included = underRoot || rootSet.has(node.callFrame.functionName)
    if (included && node.selfSize) total += node.selfSize
    for (const child of node.children ?? []) walk(child, included)
  }
  walk(profile.head, false)
  return total
}

/**
 * Zero/non-zero `MinorGC`/`MajorGC` trace events per named isolate, inside the `window-start`/
 * `window-end` marks (0016 §3 step 6). Isolate names come from `gc-isolate:<name>` marks
 * (`__gc.markIsolates()`, Planning decisions "Naming isolates"): main is the thread of
 * `window-start` itself, so it is named even if its own mark event sorts after a GC event with the
 * same `ts`. A GC event whose isolate has no mark is bucketed as `unknown` rather than dropped, so a
 * naming bug shows up as a count instead of disappearing.
 */
export function analyseTrace(events: readonly TraceEvent[]): {
  gc: Record<string, GcCounts>
  outside: GcCounts
  windowMs: number
  traceEvents: number
  /** Every isolate name the trace's own `gc-isolate:<name>` mark discovery actually produced --
   * the same `isolateNames` map A keys its GC-event attribution by -- regardless of that mark's own
   * `ts` (gate round 3, docs/plan/09-renderer-terrain.md Deviations: "instrument A looks at this
   * page's thread X", kept in the fast tier once `burst` negative controls move to `@slow` for
   * every page but `gc-loop`). Deviation from the decision text, which asked for "at least one
   * event inside the window-start/window-end marks": every `gc-isolate:<name>` mark is sent (via
   * CDP `Runtime.evaluate`, `instrument.ts`) *before* `window.__gc.run`'s own `window-start` mark,
   * so it is never inside the window on a real page -- checked here by running a clean page and
   * finding every worker isolate absent under that literal reading (only `main` read present, by
   * the `window-start`/`window-end` events themselves, on its own thread). What the assertion can
   * actually prove from a clean run's own trace is unfiltered: did this isolate's naming mark reach
   * the recorded trace *at all* -- catching a `Tracing.start` capture race (0016 caveat a) or a
   * misattributed pid:tid dropping the mark, the same way a missing isolate would previously only
   * surface through a `burst` control landing its GC event in the `unknown` bucket instead. */
  presentIsolates: Set<string>
} {
  let start: TraceEvent | undefined
  let end: TraceEvent | undefined
  const isolateNames = new Map<string, string>() // "pid:tid" -> name
  for (const e of events) {
    if (!e.cat?.includes('blink.user_timing')) continue
    if (e.name === 'window-start') start = e
    else if (e.name === 'window-end') end = e
    else if (e.name.startsWith('gc-isolate:'))
      isolateNames.set(`${e.pid}:${e.tid}`, e.name.slice(11))
  }
  if (!start || !end)
    throw new Error('gc analyse: window-start/window-end marks not found in trace')
  if (!isolateNames.has(`${start.pid}:${start.tid}`))
    isolateNames.set(`${start.pid}:${start.tid}`, 'main')

  const gc: Record<string, GcCounts> = {}
  const outside: GcCounts = { MinorGC: 0, MajorGC: 0 }
  for (const e of events) {
    if (e.name !== 'MinorGC' && e.name !== 'MajorGC') continue
    if (e.ph === 'E') continue // count each GC once (a 'B'/begin or an 'X'/complete event)
    if (e.pid !== start.pid) continue
    if (e.ts < start.ts || e.ts > end.ts) {
      outside[e.name]++
      continue
    }
    const name = isolateNames.get(`${e.pid}:${e.tid}`) ?? 'unknown'
    if (!gc[name]) gc[name] = { MinorGC: 0, MajorGC: 0 }
    gc[name][e.name]++
  }

  const presentIsolates = new Set(isolateNames.values())

  return {
    gc,
    outside,
    windowMs: (end.ts - start.ts) / 1000,
    traceEvents: events.length,
    presentIsolates,
  }
}

/** A `Tracing.start` call slower than this (0016 caveat a) is a warning, never a budget failure. */
export const TRACING_STALL_WARNING_MS = 2000

/** `gc-tracing-start-stall <ms>` when `tracingStartMs` is over the threshold, else `null`. */
export function tracingStallWarning(tracingStartMs: number): string | null {
  return tracingStartMs > TRACING_STALL_WARNING_MS
    ? `gc-tracing-start-stall ${Math.round(tracingStartMs)}ms`
    : null
}

export type IsolateClass = 'strict' | 'budgeted'

export type IsolateBudget = {
  class: IsolateClass
  bytesPerFrame?: number
  bytesPerMessage?: number
  formula: string
  attributionRoots: string[]
}

export type VerdictInput = {
  frames: number
  gc: Record<string, GcCounts>
  /** Exact sampled bytes (`sumProfile(...).total`) per isolate over the window. */
  totalBytes: Record<string, number>
  /** Per isolate, `attributedBytes(profile, roots)` over the window (software mode only). */
  attributedBytesTotal?: Record<string, number>
}

export type Verdict = {
  /** `true` when every asserted isolate passes both A and B. */
  pass: boolean
  A: Record<string, boolean>
  B: Record<string, boolean>
}

/**
 * The two assertions of 0016 §3 steps 6-7 for every isolate the page's budget names. Hardware mode
 * compares `totalBytes / frames` with `bytesPerFrame`/`bytesPerMessage`; software mode (0016 caveat
 * b) compares `attributedBytesTotal / frames` with `software.isolates.<name>.attributedBytesPerFrame`
 * instead, because harness overhead no longer amortises at the smaller software `frames`.
 */
export function verdict(
  input: VerdictInput,
  page: {
    isolates: Record<string, IsolateBudget>
    software: null | { isolates: Record<string, { attributedBytesPerFrame: number }> }
  },
  mode: 'hardware' | 'software',
): Verdict {
  const A: Record<string, boolean> = {}
  const B: Record<string, boolean> = {}
  for (const [name, budget] of Object.entries(page.isolates)) {
    const counts = input.gc[name] ?? { MinorGC: 0, MajorGC: 0 }
    A[name] =
      budget.class === 'strict' ? counts.MinorGC + counts.MajorGC === 0 : counts.MajorGC === 0

    if (mode === 'software') {
      const softBudget = page.software?.isolates[name]
      if (!softBudget) throw new Error(`gc verdict: no software budget for ${name}`)
      const attributed = (input.attributedBytesTotal?.[name] ?? 0) / input.frames
      B[name] = attributed <= softBudget.attributedBytesPerFrame
    } else {
      const limit = budget.bytesPerFrame ?? budget.bytesPerMessage
      if (limit === undefined) throw new Error(`gc verdict: isolate ${name} has no byte budget`)
      const actual = (input.totalBytes[name] ?? 0) / input.frames
      B[name] = actual <= limit
    }
  }
  const pass = Object.values(A).every(Boolean) && Object.values(B).every(Boolean)
  return { pass, A, B }
}
