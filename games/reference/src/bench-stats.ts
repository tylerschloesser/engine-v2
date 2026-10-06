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
