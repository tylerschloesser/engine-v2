// Production `Clock`/`Scheduler` (docs/decisions/0020 §8): every later subsystem takes
// `{ clock, scheduler }` by injection instead of naming ambient time. This is the only file in
// `src/` (outside `src/test/`) allowed to name `Date`, `performance`, `setTimeout`, `setInterval`
// or `requestAnimationFrame`, enforced by Biome's `noRestrictedGlobals` (biome.json override).
// Test code uses `createManualClock` (`src/test/manual-clock.ts`) instead.

export interface Clock {
  /** Monotonic milliseconds. */
  now(): number
}

export interface Scheduler {
  setTimer(cb: () => void, delayMs: number): number
  clearTimer(id: number): void
  requestFrame(cb: (tMs: number) => void): number
  cancelFrame(id: number): void
}

export const systemClock: Clock = {
  now: () => performance.now(),
}

export const systemScheduler: Scheduler = {
  // Cast away the two ambient global declarations (dom's `number` vs @types/node's
  // `NodeJS.Timeout`) fighting over one signature; only this file has to know that.
  setTimer: (cb, delayMs) => setTimeout(cb, delayMs) as unknown as number,
  clearTimer: (id) => clearTimeout(id),
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
}

/** docs/plan/15d-client-clock-allocation.md: the same shape as `SimHost.resync()`
 * (docs/decisions/0030) applied to a client frame path instead of a tick path. `clock.now()`'s
 * return is a fractional double -- V8 boxes a fresh `HeapNumber` for it on every read, the same
 * defect class 0030 fixed on the sim worker (measured there: ~11.92 B per read; measured here,
 * `stepFrame@client-*.js`: ~11.96 B/frame, docs/plan/15d, Deviations). Unlike 0030's own read, this
 * one boxes at ~12 B/read under forced `--no-opt --no-sparkplug` *and* under default V8 once moved
 * into this function's own accumulator (Deviations) -- not purely an interpreter-tier artefact here,
 * so the fix is about read *frequency*, not which V8 tier wins the compilation race. Reading the
 * clock only once every `resyncEvery` calls, and doing integer arithmetic between reads, cuts that
 * cost by the same factor; `next()` never returns or stores a fractional value, so no call in
 * between boxes either. Bounded, periodically-corrected drift (0030's own trade), not a
 * synthetic-only counter: `dtMs` is added between resyncs, but every `resyncEvery`th call throws
 * that account away and re-anchors on the real elapsed time, so a caller that needs approximate
 * real time (a rate limit paced against real elapsed seconds, say) keeps getting it -- just not
 * boxed on every call. */
export interface ResyncingClock {
  /** `dtMs`: this call's nominal/expected duration (a rAF delta, or a test's own step size) --
   * added between resyncs; ignored on a resync call, where the real clock is re-read instead. */
  next(dtMs: number): number
}

export function createResyncingClock(clock: Clock, resyncEvery: number): ResyncingClock {
  let base = 0
  // Forces a resync on the very first call: no real reading exists yet to accumulate from.
  let sinceSync = resyncEvery
  return {
    next(dtMs: number): number {
      sinceSync += 1
      if (sinceSync >= resyncEvery) {
        base = Math.floor(clock.now())
        sinceSync = 0
      } else {
        base += Math.floor(dtMs)
      }
      return base
    },
  }
}
