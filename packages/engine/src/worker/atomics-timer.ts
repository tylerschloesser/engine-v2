// `AtomicsTimer` (docs/plan/13-sim-host-tick-loop.md, Scope "Sim worker kind"): an implementation
// of `HostServices['timer']` (`server.ts`) built on top of `runBlockingLoop`'s own
// `timeoutMs: () => number` (`worker/shell.ts`), so `Atomics.wait` itself is what the sim worker
// blocks in between ticks (0015 §2) instead of a `setInterval`/spin loop -- M06b's park/resume
// protocol keeps working unchanged, since this is still an ordinary `timeoutMs` function.
//
// docs/plan/13b-tick-timing-allocation.md (Deviations): this used to read `clock.now()` on every
// `poll()`/`timeoutMs()` call to decide whether a tick's own deadline had passed, and to compute
// `Atomics.wait`'s own timeout precisely. Both boxed a fresh `HeapNumber` per call in the
// interpreter tier -- a fractional double, never a Smi -- exceeding the strict 8 B/frame budget
// even for one read, every real wake in production (`worker/sim.ts` arms this unconditionally
// there). Fixed by removing every clock read from this file: `timeoutMs()` always answers the same
// fixed, integer `ms` (armed) or the module-level `INFINITE_TIMEOUT_MS` constant (idle), and
// `poll()` fires its callback unconditionally on every wake while armed, no due check. Accuracy
// (was a real deadline check here) moves to `SimHost`'s own periodic resync (`server.ts`'s
// `runPacedTick`/`resync`, ADR amending M13): assuming every wake is exactly one tick's worth of
// elapsed time drifts by however long the tick's own work took, bounded and corrected there every
// `RESYNC_TICKS` ticks, never here. This file no longer needs a `clock` at all -- `createAtomicsTimer`
// takes none, unlike its M13 shape (Seams: not a Provides rename, the only two Consumers of
// `AtomicsTimer` are `worker/sim.ts` and this file's own tests).

const INFINITE_TIMEOUT_MS: number = Number.POSITIVE_INFINITY

export interface HostTimer {
  every(ms: number, fn: () => void): () => void
}

export interface AtomicsTimer {
  /** `HostServices['timer']` (`server.ts`), unchanged shape: what `SimHost.start()`/`resume()`
   * call `every(ms, fn)` on. */
  readonly timer: HostTimer
  /** `LoopState.timeoutMs` (`worker/shell.ts`): time until the next deadline, or `Infinity` while
   * not armed. A fixed, already-integer local either way -- never computed from the clock. */
  timeoutMs: () => number
  /**
   * Calls the registered `fn` once, unconditionally, whenever armed -- called on every `body()`
   * pass regardless of why `Atomics.wait` returned. A no-op before `every()` is ever called, or
   * after its returned stop function runs.
   */
  poll(): void
}

export function createAtomicsTimer(): AtomicsTimer {
  let armed = false
  let ms = 0
  let fn: (() => void) | null = null

  function poll(): void {
    if (!armed) return
    const callback = fn
    if (callback) callback()
  }

  function timeoutMs(): number {
    return armed ? ms : INFINITE_TIMEOUT_MS
  }

  const timer: HostTimer = {
    every(intervalMs, callback) {
      ms = intervalMs
      fn = callback
      armed = true
      return () => {
        armed = false
        fn = null
      }
    },
  }

  return { timer, timeoutMs, poll }
}
