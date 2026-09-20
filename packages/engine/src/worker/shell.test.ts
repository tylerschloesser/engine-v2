import { expect, test } from 'vitest'
import { systemClock } from '../clock.js'
import { ControlBlock, createControlBlock, W_PARKED, W_YIELD, workerWord } from '../sab/control.js'
import { createShell, runBlockingLoop } from './shell.js'

const INDEX = 1
const WAIT_MS = 400

/**
 * The lost-wake window `Shell.observeWake` closes (fix round 3, docs/plan/06b-workers-and-spawn.md,
 * Deviations): a producer that sees `W_PARKED = 0` wakes the worker immediately, which can land
 * before the worker's blocking loop has read its own baseline. Re-entering with the value read
 * *before* the publish makes that wake a mismatch, so the first `Atomics.wait` returns at once
 * instead of sleeping on a wake that already happened. Driven here on this thread with the same
 * ordering, and timed: with the baseline read too late, the first wait would instead burn the whole
 * `WAIT_MS` timeout before the body ran.
 */
test('shell.resume_does_not_lose_a_wake', () => {
  const control = new ControlBlock(createControlBlock())
  const shell = createShell(control, INDEX)
  let bodyCalls = 0

  const seen = shell.observeWake() // what `Shell.resume()` reads before storing `W_PARKED = 0`
  Atomics.store(control.words, workerWord(INDEX, W_PARKED), 0)
  control.wake(INDEX) // the producer, racing the loop's own entry

  const t0 = systemClock.now()
  runBlockingLoop(
    shell,
    () => {
      bodyCalls++
      Atomics.store(control.words, workerWord(INDEX, W_YIELD), 1)
      control.wake(INDEX) // so the loop's next wait returns and it can see the yield
    },
    () => WAIT_MS,
    seen,
  )
  const elapsed = systemClock.now() - t0

  expect(bodyCalls).toBe(1)
  expect(elapsed).toBeLessThan(WAIT_MS / 2)
  expect(Atomics.load(control.words, workerWord(INDEX, W_PARKED))).toBe(1)
})

/**
 * The entry-drain fix (docs/plan/08b-gen-workers-and-queue.md, orchestrator decision 2 at the
 * step-5 boundary): `runBlockingLoop` must call `body(lastSeen)` once before its first
 * `Atomics.wait`, so a ring-driven worker resumed from parked drains whatever arrived while it
 * could not be woken (a wake issued while parked is not replayed on `resume()`, M06b Deviations).
 * Driven here with no producer at all: if the entry drain were missing, `body` would only run after
 * a real wake, and with none coming the wait would burn the whole `WAIT_MS` timeout.
 */
test('shell.entry_drains_before_waiting', () => {
  const control = new ControlBlock(createControlBlock())
  const shell = createShell(control, INDEX)
  let bodyCalls = 0

  const seen = shell.observeWake()
  Atomics.store(control.words, workerWord(INDEX, W_PARKED), 0)
  // No producer wakes this worker at all: the only way `body` can run before `WAIT_MS` elapses is
  // the entry drain itself.

  const t0 = systemClock.now()
  runBlockingLoop(
    shell,
    () => {
      bodyCalls++
      Atomics.store(control.words, workerWord(INDEX, W_YIELD), 1)
      control.wake(INDEX) // so the loop's next wait returns and it can see the yield
    },
    () => WAIT_MS,
    seen,
  )
  const elapsed = systemClock.now() - t0

  expect(bodyCalls).toBe(1)
  expect(elapsed).toBeLessThan(WAIT_MS / 2)
  expect(Atomics.load(control.words, workerWord(INDEX, W_PARKED))).toBe(1)
})
