// `engine/test`: a deterministic `Clock` + `Scheduler` (docs/decisions/0020 §8). No wall clock: time
// only moves when `advance`/`frame` is called. Used by the harness (`harness.ts`) and by unit tests
// of anything injected with `{ clock, scheduler }`.
import type { Clock, Scheduler } from '../clock.js'

export interface ManualClock extends Clock, Scheduler {
  /** Advance by `ms`, firing every timer whose deadline is now due, in `(deadline, id)` order. */
  advance(ms: number): void
  /** Advance by `dtMs`, then run the frame callbacks registered so far exactly once. */
  frame(dtMs: number): void
}

type Timer = { id: number; deadline: number; cb: () => void }
type Frame = { id: number; cb: (tMs: number) => void }

export function createManualClock(startMs = 0): ManualClock {
  let now = startMs
  let nextId = 1
  const timers = new Map<number, Timer>()
  let frames: Frame[] = []

  function fireDue(): void {
    // Same optimisation as `frame()`'s own `frames.length === 0` check below, missed here until
    // fix round 2 (docs/plan/06b-workers-and-spawn.md, Deviations): `test/client.ts`'s `stepFrame`
    // calls `advance()` every frame, and no test page here ever registers a real timer, so the
    // common case is an empty `timers` Map. Without this check, `for (const timer of
    // timers.values())` still creates a `MapIterator` and calls `.next()` on it once per `advance()`
    // call regardless of size; under an unoptimised JIT tier that allocates a `{value, done}` result
    // object each time, which under CPU contention (a busy V8 background compiler thread completes
    // tier-up late) showed up as `main`'s single biggest contended-only allocation site.
    if (timers.size === 0) return
    for (;;) {
      let due: Timer | undefined
      for (const timer of timers.values()) {
        if (timer.deadline > now) continue
        if (
          !due ||
          timer.deadline < due.deadline ||
          (timer.deadline === due.deadline && timer.id < due.id)
        ) {
          due = timer
        }
      }
      if (!due) return
      timers.delete(due.id)
      due.cb()
    }
  }

  return {
    now: () => now,

    setTimer(cb, delayMs) {
      const id = nextId++
      timers.set(id, { id, deadline: now + delayMs, cb })
      return id
    },
    clearTimer(id) {
      timers.delete(id)
    },
    requestFrame(cb) {
      const id = nextId++
      frames.push({ id, cb })
      return id
    },
    cancelFrame(id) {
      frames = frames.filter((f) => f.id !== id)
    },

    advance(ms) {
      now += ms
      fireDue()
    },
    frame(dtMs) {
      now += dtMs
      // Callbacks registered while running are next frame's, not this one's. No client-role worker
      // exists before M06b, so `frames` is normally empty here; skip the array churn in that case
      // (measured: M04's gc-loop `main` budget, docs/plan/04-zero-gc-harness.md).
      if (frames.length === 0) return
      const due = frames
      frames = []
      for (const f of due) f.cb(now)
    },
  }
}
