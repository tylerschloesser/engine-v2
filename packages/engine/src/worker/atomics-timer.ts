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
// `poll()` fired its callback on every wake while armed, no due check (both superseded by M16d,
// below; still no clock read). Accuracy
// (was a real deadline check here) moves to `SimHost`'s own periodic resync (`server.ts`'s
// `runPacedTick`/`resync`, ADR amending M13): assuming every wake is exactly one tick's worth of
// elapsed time drifts by however long the tick's own work took, bounded and corrected there every
// `RESYNC_TICKS` ticks, never here. This file no longer needs a `clock` at all -- `createAtomicsTimer`
// takes none, unlike its M13 shape (Seams: not a Provides rename, the only two Consumers of
// `AtomicsTimer` are `worker/sim.ts` and this file's own tests).

import type { Clock } from '../clock.js'

// docs/decisions/0032-atomics-timer-bounds-external-wakes.md (M16d, amends 0030 §2): firing on
// *every* timed-out wait was correct only while nothing else woke the sim worker. Once a producer
// woke it more often than once per interval (a linked client's uplink every frame), each wake
// restarted `Atomics.wait` at the full interval, no wait ever timed out, and no tick ran for
// seconds. The timer now keeps two integer bounds on "now" against an integer deadline, in
// milliseconds since it was armed:
// - `lo`, proven: advanced only by waits that *timed out* (`poll()`: each lasted at least its
//   length);
// - `hi`, estimated: advanced by every wait handed out (an interrupted wait lasted at most its
//   length; processing between waits is not counted, so it can only make a read come later).
// It fires when `lo` reaches the deadline, which needs no clock at all while nothing interrupts it
// (one full-length wait per interval, exactly 0030's shape). A wait an external wake ended
// (`interrupt()`) credits nothing to `lo`; once `hi` says the deadline may have passed, the clock
// is read -- one `clock.now()` -- both bounds snap to it, and the timer fires if it is due. While
// interrupted, waits are capped at a quantum so `hi` overshoots real time by little and that read
// lands near the deadline: about one read per tick while a producer is active, none while it is
// not. Never early (the fire decision is `lo` or a real reading); late by at most one quantum plus
// scheduling. 0030's resync still owns long-run accuracy and catch-up.

const INFINITE_TIMEOUT_MS: number = Number.POSITIVE_INFINITY

/** The quantum starts at `ms >> QUANTUM_SHIFT` (an eighth of the interval: 6 ms at 20 Hz) and is
 * halved, down to 1 ms, whenever two interruptions arrive with no completed wait between them (a
 * producer waking faster than the quantum: a smaller quantum makes `hi` overshoot less per
 * interruption, so the clock is read less often); it is reset when a whole interval passes
 * uninterrupted. */
const QUANTUM_SHIFT = 3

export interface HostTimer {
  every(ms: number, fn: () => void): () => void
}

export interface AtomicsTimer {
  /** `HostServices['timer']` (`server.ts`), unchanged shape: what `SimHost.start()`/`resume()`
   * call `every(ms, fn)` on. */
  readonly timer: HostTimer
  /** `LoopState.timeoutMs` (`worker/shell.ts`), read before every `Atomics.wait`: time until the
   * deadline by the upper bound, capped at the quantum while interrupted, `Infinity` while not
   * armed. Always an integer, never computed from a clock. */
  timeoutMs: () => number
  /**
   * The wait `timeoutMs()` last handed out *timed out*: the caller (`worker/sim.ts`'s `body()`)
   * calls this only when its wake word did not change, i.e. nothing called `ControlBlock.wake()`.
   * Credits that wait to the proven bound and calls the registered `fn` once if the deadline is
   * reached. A no-op while not armed.
   */
  poll(): void
  /**
   * The wait `timeoutMs()` last handed out was ended by an external wake (`ControlBlock.wake()`,
   * the wake word changed): credits nothing, caps further waits at the quantum, and -- only if the
   * upper bound says the deadline may have passed -- reads the clock once and fires if it has. A
   * no-op while not armed or with no wait outstanding.
   */
  interrupt(): void
}

/** `clock` is read once per `every()` (the origin) and, while external wakes interrupt the wait,
 * about once per interval; never by `timeoutMs()` or `poll()`. */
export function createAtomicsTimer(clock: Clock): AtomicsTimer {
  let armed = false
  let ms = 0
  let fn: (() => void) | null = null
  let baseQuantum = 1
  let quantum = 1
  /** Integer milliseconds of `clock` at `every()`, rounded up; `lo`/`hi`/`due` are relative to it. */
  let originMs = 0
  let lo = 0
  let hi = 0
  let due = 0
  /** The wait last handed out by `timeoutMs()` and not yet reported as timed out; `-1` if none. */
  let pending = -1
  /** An interruption was seen since the last fire. */
  let interrupted = false
  /** Waits are capped at `quantum`: this interval or the previous one was interrupted. */
  let capped = false
  /** A wait timed out since the last interruption. */
  let creditedSinceInterrupt = true

  /** Reads the clock only when the bounds disagree about the deadline (`lo` short of it, `hi` at or
   * past it) -- never while nothing has interrupted a wait, since then `lo === hi` -- and fires if
   * it is due. */
  function settle(): void {
    if (lo < due && hi >= due) {
      lo = Math.floor(clock.now()) - originMs
      hi = lo
    }
    if (lo < due) return
    // Behind by a whole interval or more (a long park, a stalled thread): restart the schedule
    // from here rather than firing back to back -- catching up is `SimHost.resync`'s job (0030 §3).
    due = due + ms > lo ? due + ms : lo + ms
    capped = interrupted
    if (!capped) quantum = baseQuantum
    interrupted = false
    const callback = fn
    if (callback) callback()
  }

  function poll(): void {
    if (!armed) return
    if (pending > 0) lo += pending
    pending = -1
    creditedSinceInterrupt = true
    settle()
  }

  function interrupt(): void {
    if (!armed || pending < 0) return
    pending = -1
    if (!creditedSinceInterrupt && quantum > 1) quantum >>= 1
    creditedSinceInterrupt = false
    interrupted = true
    capped = true
    settle()
  }

  function timeoutMs(): number {
    if (!armed) {
      pending = -1
      return INFINITE_TIMEOUT_MS
    }
    let wait = due - hi
    if (wait < 0) wait = 0
    if (capped && wait > quantum) wait = quantum
    pending = wait
    hi += wait
    return wait
  }

  const timer: HostTimer = {
    every(intervalMs, callback) {
      ms = intervalMs
      baseQuantum = intervalMs >> QUANTUM_SHIFT
      if (baseQuantum < 1) baseQuantum = 1
      quantum = baseQuantum
      fn = callback
      // `+ 1`: at or after the real origin, so `floor(now) - originMs` never exceeds the real
      // elapsed time and a read can never prove a deadline early.
      originMs = Math.floor(clock.now()) + 1
      lo = 0
      hi = 0
      due = intervalMs
      pending = -1
      interrupted = false
      capped = false
      creditedSinceInterrupt = true
      armed = true
      return () => {
        armed = false
        fn = null
      }
    },
  }

  return { timer, timeoutMs, poll, interrupt }
}
