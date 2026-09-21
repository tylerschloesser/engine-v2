// `AtomicsTimer` (docs/plan/13-sim-host-tick-loop.md, Scope "Sim worker kind"): an implementation
// of `HostServices['timer']` (`server.ts`) built on top of `runBlockingLoop`'s own
// `timeoutMs: () => number` (`worker/shell.ts`), so `Atomics.wait` itself is what the sim worker
// blocks in between ticks (0015 §2) instead of a `setInterval`/spin loop -- M06b's park/resume
// protocol keeps working unchanged, since this is still an ordinary `timeoutMs` function.
//
// Needs nothing from `SimHost` beyond the fixed `ms` `SimHost.start()`/`resume()` pass to
// `services.timer.every(ms, fn)` exactly once each time they arm (docs/plan/
// 13-sim-host-tick-loop.md, Deviations, "`HostServices.timer`'s exact shape"): `onFire`'s own
// `due` calculation is self-correcting from wall time, so calling `fn` a little early or a little
// late never matters, which is what lets `poll()` below be a plain deadline check called
// unconditionally on every `body()` pass (real wake or timeout) rather than something that needs
// to know *why* `Atomics.wait` returned.
//
// `.claude/rules/hot-paths.md`: `nextFireAt`/`ms` are plain module-scope-free locals mutated in
// place (no per-call object), and `timeoutMs()`/`poll()` return/compute values from arithmetic on
// them directly -- the same shape `worker/shell.ts`'s own `noTimeout()` doc comment demands
// ("integer milliseconds, no double-valued temporary" beyond what the subtraction itself produces).

const INFINITE_TIMEOUT_MS: number = Number.POSITIVE_INFINITY

export interface HostTimer {
  every(ms: number, fn: () => void): () => void
}

export interface AtomicsTimer {
  /** `HostServices['timer']` (`server.ts`), unchanged shape: what `SimHost.start()`/`resume()`
   * call `every(ms, fn)` on. */
  readonly timer: HostTimer
  /** `LoopState.timeoutMs` (`worker/shell.ts`): time until the next deadline, or `Infinity` while
   * not armed (`stop()` already called, or `every()` never called at all -- a test topology that
   * never calls `SimHost.start()`). Read fresh before every `Atomics.wait`. */
  timeoutMs: () => number
  /**
   * Runs the registered `fn` once for every interval boundary already passed (0, one, or more --
   * a worker that slept past several intervals catches up by calling `fn` that many times, each
   * `onFire` call still only as expensive as one self-correcting pacing check), advancing
   * `nextFireAt` by `ms` after each call. Called on every `body()` pass regardless of why
   * `Atomics.wait` returned: a no-op before the deadline (one comparison, no allocation).
   */
  poll(): void
}

/** `clock`'s own `now()` is called fresh on every check (no caching): `SimHost`'s pacing is
 * wall-clock-driven by design (Scope "Pacing"), and this timer's whole job is answering "how long
 * until the next deadline" against that same clock. */
export function createAtomicsTimer(clock: { now(): number }): AtomicsTimer {
  let armed = false
  let ms = 0
  let nextFireAt = 0
  let fn: (() => void) | null = null

  function poll(): void {
    if (!armed) return
    while (clock.now() >= nextFireAt) {
      const callback = fn
      nextFireAt += ms
      if (callback) callback()
    }
  }

  function timeoutMs(): number {
    if (!armed) return INFINITE_TIMEOUT_MS
    const remaining = nextFireAt - clock.now()
    return remaining > 0 ? remaining : 0
  }

  const timer: HostTimer = {
    every(intervalMs, callback) {
      ms = intervalMs
      fn = callback
      nextFireAt = clock.now() + intervalMs
      armed = true
      return () => {
        armed = false
        fn = null
      }
    },
  }

  return { timer, timeoutMs, poll }
}
