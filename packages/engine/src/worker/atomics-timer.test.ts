// `AtomicsTimer` (docs/decisions/0032-atomics-timer-bounds-external-wakes.md) driven through the
// exact protocol `runBlockingLoop` + `worker/sim.ts`'s `body()` use: `timeoutMs()` before every
// wait, then `poll()` when that wait timed out (the wake word did not change) or `interrupt()` when
// an external wake ended it. Simulated time, with a clock that counts its own reads.
import { expect, test } from 'vitest'
import { createAtomicsTimer } from './atomics-timer.js'

type Run = { fires: number[]; reads: number; wakes: number }

/**
 * Runs the loop for `totalMs` of simulated time with an external wake every `wakeEveryMs` (0 =
 * none). Every timed-out wait overshoots by `overshootMs` (Chrome's own `Atomics.wait` does, by
 * ~1-3 ms on small timeouts). Returns the fire times, clock reads and loop passes.
 */
function simulate(intervalMs: number, totalMs: number, wakeEveryMs: number, overshootMs = 0): Run {
  let now = 1000.25 // fractional, like `performance.now()`
  const run: Run = { fires: [], reads: 0, wakes: 0 }
  const clock = {
    now: () => {
      run.reads++
      return now
    },
  }
  const t = createAtomicsTimer(clock)
  const start = now
  t.timer.every(intervalMs, () => {
    run.fires.push(now - start)
  })
  run.reads = 0
  let nextWake = wakeEveryMs > 0 ? start + wakeEveryMs : Number.POSITIVE_INFINITY
  while (now - start < totalMs) {
    run.wakes++
    const wait = t.timeoutMs()
    if (now + wait + overshootMs <= nextWake) {
      now += wait + overshootMs
      t.poll()
    } else {
      now = nextWake
      nextWake += wakeEveryMs
      t.interrupt()
    }
  }
  return run
}

test('atomics_timer_fires_once_per_interval_without_reading_the_clock_when_undisturbed', () => {
  const run = simulate(50, 2000, 0)
  expect(run.fires.length).toBe(40)
  expect(run.reads).toBe(0)
  expect(run.wakes).toBe(40)
})

test('atomics_timer_keeps_pace_under_frequent_external_wakes', () => {
  // The M16d defect: a wake every 16 ms restarted a 50 ms wait forever and nothing fired.
  for (const wakeEvery of [0.25, 1, 5, 16, 17, 25, 33, 49]) {
    for (const overshoot of [0, 2]) {
      const what = `wake every ${wakeEvery} ms, overshoot ${overshoot} ms`
      const run = simulate(50, 2000, wakeEvery, overshoot)
      // Never early: fire k is at or after (k + 1) x 50 ms.
      for (let k = 0; k < run.fires.length; k++) {
        expect(run.fires[k], what).toBeGreaterThanOrEqual((k + 1) * 50)
      }
      // Never far behind: at most one interval short over 2 s.
      expect(run.fires.length, what).toBeGreaterThanOrEqual(39)
      // One to three clock reads per fire at a realistic producer rate (measured 1.0-3.1); at a
      // pathological one (a wake every quarter millisecond) still a small fraction of wakes
      // (measured at most 0.18), never one per wake.
      if (wakeEvery >= 5) expect(run.reads, what).toBeLessThanOrEqual(run.fires.length * 3.5)
      expect(run.reads, what).toBeLessThanOrEqual(run.wakes / 5)
    }
  }
})

test('atomics_timer_never_fires_on_an_interruption_alone', () => {
  let now = 0
  const t = createAtomicsTimer({ now: () => now })
  let fires = 0
  t.timer.every(50, () => {
    fires++
  })
  // Interruptions only, no time passing: never fires, however many.
  for (let i = 0; i < 100; i++) {
    expect(t.timeoutMs()).toBeGreaterThan(0)
    t.interrupt()
  }
  expect(fires).toBe(0)
  // The clock says the deadline passed: the next interruption that reads it fires, once.
  now = 60
  for (let i = 0; i < 100 && fires === 0; i++) {
    t.timeoutMs()
    t.interrupt()
  }
  expect(fires).toBe(1)
})

test('atomics_timer_restarts_the_schedule_after_a_long_stall', () => {
  let now = 0
  const t = createAtomicsTimer({ now: () => now })
  let fires = 0
  t.timer.every(50, () => {
    fires++
  })
  now = 1000 // a long park: 20 intervals
  for (let i = 0; i < 100 && fires === 0; i++) {
    t.timeoutMs()
    t.interrupt()
  }
  expect(fires).toBe(1)
  // One fire, not twenty back to back: the next deadline is a full interval away.
  for (let i = 0; i < 20; i++) {
    t.timeoutMs()
    t.interrupt()
  }
  expect(fires).toBe(1)
})

test('atomics_timer_stop_disarms', () => {
  const t = createAtomicsTimer({ now: () => 0 })
  let fires = 0
  const stop = t.timer.every(50, () => {
    fires++
  })
  t.timeoutMs()
  stop()
  expect(t.timeoutMs()).toBe(Number.POSITIVE_INFINITY)
  t.poll()
  expect(fires).toBe(0)
})
