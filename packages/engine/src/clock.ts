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
