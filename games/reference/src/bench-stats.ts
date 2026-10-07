// The bench meter's rolling statistics, free of the engine and the DOM so a unit test can feed them
// synthetic samples (docs/plan/39o-large-save-tick-breakdown.md). Diagnostic, outside the zero-GC
// rule (`.claude/rules/hot-paths.md`): runs on the bench page's main thread only.

export const WINDOW_MS = 10_000

/** Samples of the last `WINDOW_MS`, with exact order statistics (nearest rank). */
export class Rolling {
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
  quantile(q: number): number {
    if (this.vs.length === 0) return 0
    const sorted = [...this.vs].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number
  }
  p50(): number {
    return this.quantile(0.5)
  }
  p95(): number {
    return this.quantile(0.95)
  }
  sum(): number {
    let s = 0
    for (const v of this.vs) s += v
    return s
  }
}

/** One timed sim-worker pass, in whole microseconds (`CB_SIM_*`, `sab/control.ts`). */
export type PassSample = {
  wholeUs: number
  sealUs: number
  tickUs: number
  frameUs: number
  /** 0: the pass ran no resync. */
  resyncUs: number
  catchupTicks: number
}

export type PartReadings = {
  tickP50Ms: number
  tickP95Ms: number
  sealP95Ms: number
  simTickP50Ms: number
  simTickP95Ms: number
  frameBuildP95Ms: number
  resyncP95Ms: number
  catchupTicksPer10s: number
}

export function createPartStats(): {
  push(t: number, s: PassSample): void
  readings(): PartReadings
} {
  const whole = new Rolling()
  const seal = new Rolling()
  const simTick = new Rolling()
  const frame = new Rolling()
  const resync = new Rolling()
  const catchup = new Rolling()
  return {
    push(t, s) {
      whole.push(t, s.wholeUs / 1000)
      seal.push(t, s.sealUs / 1000)
      simTick.push(t, s.tickUs / 1000)
      frame.push(t, s.frameUs / 1000)
      if (s.resyncUs > 0) resync.push(t, s.resyncUs / 1000)
      catchup.push(t, s.catchupTicks)
    },
    readings: () => ({
      tickP50Ms: whole.p50(),
      tickP95Ms: whole.p95(),
      sealP95Ms: seal.p95(),
      simTickP50Ms: simTick.p50(),
      simTickP95Ms: simTick.p95(),
      frameBuildP95Ms: frame.p95(),
      resyncP95Ms: resync.p95(),
      catchupTicksPer10s: catchup.sum(),
    }),
  }
}

// docs/plan/39s-sim-tick-tail.md: the per-tick series. `sim_tick` is timed in the sim worker for
// the paced tick of each pass and published through the control block (`CB_SIM_ONETICK_US`); the
// bench meter reads it once per rAF whenever the tick number moved and keeps the last `TICK_RING`
// of them here, with their tick numbers (a jump in the number is counted as `missed`).

export const TICK_RING = 4096
/** Histogram edges in ms: 0.5 ms wide to 10 ms (where the iPhone's median sits), coarser above. */
export const HIST_EDGES_MS: readonly number[] = [
  0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 12, 15, 20, 30,
  50,
]
export const TOP_TICKS = 20
const MAX_LAG = 512
const MIN_PERIOD_R = 0.3
const DETREND = 4
const PEAK_SHARE = 0.97

export type TickSummary = {
  /** Ticks in the ring, and the ticks the meter never saw (a gap in the tick number). */
  n: number
  missed: number
  /** `counts[i]` is the number of ticks below `HIST_EDGES_MS[i]` (and from the previous edge); the last is the rest. */
  counts: number[]
  /** The slowest ticks, slowest first. */
  top: { tick: number; ms: number }[]
  /** The first autocorrelation peak (in ticks) within 3 % of the best, or null. */
  period: number | null
  periodR: number
}

/** The shortest lag at which `x` repeats, from its autocorrelation; null if no lag reaches `MIN_PERIOD_R`. */
export function autocorrPeriod(raw: ArrayLike<number>): { period: number | null; r: number } {
  // High-pass first (minus a centred moving average): a slowly drifting level is correlated at
  // every short lag and would read as "period 2".
  const len = raw.length
  const n = Math.max(0, len - 2 * DETREND)
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let m = 0
    for (let j = i; j <= i + 2 * DETREND; j++) m += raw[j] as number
    x[i] = (raw[i + DETREND] as number) - m / (2 * DETREND + 1)
  }
  let mean = 0
  for (let i = 0; i < n; i++) mean += x[i] as number
  mean /= n || 1
  let energy = 0
  for (let i = 0; i < n; i++) energy += ((x[i] as number) - mean) ** 2
  if (energy === 0) return { period: null, r: 0 }
  const maxLag = Math.min(MAX_LAG, n >> 1)
  const r = new Float64Array(maxLag + 1)
  let best = 0
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0
    for (let i = 0; i + lag < n; i++)
      s += ((x[i] as number) - mean) * ((x[i + lag] as number) - mean)
    const rl = s / energy
    r[lag] = rl
    if (lag >= 2 && rl > best) best = rl
  }
  if (best < MIN_PERIOD_R) return { period: null, r: best }
  for (let lag = 2; lag <= maxLag; lag++) {
    const here = r[lag] as number
    // A peak, not the shoulder of one.
    if (here >= PEAK_SHARE * best && here >= (r[lag - 1] as number) && here >= (r[lag + 1] ?? -1))
      return { period: lag, r: here }
  }
  return { period: null, r: best }
}

export function createTickRing(capacity = TICK_RING): {
  push(tick: number, us: number): void
  summary(): TickSummary
  /** The whole ring, oldest first: `[tick, us]` pairs. */
  series(): [number, number][]
} {
  const ticks = new Int32Array(capacity)
  const us = new Int32Array(capacity)
  let count = 0
  let head = 0
  let missed = 0
  let lastTick = -1
  let cached: { period: number | null; r: number } = { period: null, r: 0 }
  let cachedAt = -1

  const at = (i: number): number => (head - count + i + capacity * 2) % capacity
  const series = (): [number, number][] => {
    const out: [number, number][] = []
    for (let i = 0; i < count; i++) out.push([ticks[at(i)] as number, us[at(i)] as number])
    return out
  }
  return {
    push(tick, v) {
      if (lastTick >= 0 && tick > lastTick + 1) missed += tick - lastTick - 1
      lastTick = tick
      ticks[head] = tick
      us[head] = v
      head = (head + 1) % capacity
      if (count < capacity) count++
    },
    series,
    summary() {
      const counts = new Array<number>(HIST_EDGES_MS.length + 1).fill(0)
      const s = series()
      for (const [, v] of s) {
        const ms = v / 1000
        let b = 0
        while (b < HIST_EDGES_MS.length && ms >= (HIST_EDGES_MS[b] as number)) b++
        counts[b] = (counts[b] as number) + 1
      }
      const top = [...s]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_TICKS)
        .map(([tick, v]) => ({ tick, ms: v / 1000 }))
      if (s.length >= 16 && lastTick - cachedAt >= 256) {
        // Laid out by tick number so a missed tick is a gap, not a shortened period; a gap is
        // filled with the median.
        const first = (s[0] as [number, number])[0]
        const sorted = s.map((p) => p[1]).sort((a, b) => a - b)
        const med = sorted[sorted.length >> 1] as number
        const x = new Float64Array(lastTick - first + 1).fill(med)
        for (const [t, v] of s) x[t - first] = v
        cached = autocorrPeriod(x)
        cachedAt = lastTick
      }
      return { n: s.length, missed, counts, top, period: cached.period, periodR: cached.r }
    },
  }
}
