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
 * M17c step 3, fix round 2 (docs/plan/17c-client-park-stall.md): a park request whose own
 * `W_YIELD = 1` store and wake land before `runBlockingLoop`'s own first wait -- inside the gap
 * `Shell.resume()` leaves between reading `W_WAKE` (`seen`) and calling here, or symmetrically at
 * `worker.ts`'s first entry or `Shell.runAsync`'s re-entry -- used to be invisible until a *further*
 * wake arrived, because the loop checked `W_YIELD` only *after* a wait returned. With the park's own
 * wake already folded into `seen` (the same absorption `shell.resume_does_not_lose_a_wake`, above,
 * relies on for a *real* wake), nothing sends a further one, and the worker slept for the whole
 * timeout instead of noticing the yield already set. Constructed directly here with the same
 * single-thread technique the other tests in this file use, and a *finite* `timeoutMs` so a
 * still-broken protocol times out instead of hanging the test: `W_YIELD = 1` and the wake are stored
 * *before* `seen` is even read, exactly mirroring the interleaving a `parkWorkers` wake landing
 * inside `Shell.resume()`'s own steps would produce -- a real occurrence, found live over CDP
 * `Debugger.pause` against `zero_gc_action neg object main`, named the `client` worker genuinely
 * blocked inside `waitForWake`, reached through exactly this path.
 */
test('shell.checks_yield_before_its_own_first_wait', () => {
  const control = new ControlBlock(createControlBlock())
  const shell = createShell(control, INDEX)
  let bodyCalls = 0

  // The race: a park request lands before `seen` is even read. `Shell.resume()`'s own steps are not
  // replayed here (this test drives `runBlockingLoop` directly, the way every test in this file
  // does) -- what matters is only that `W_YIELD` and the wake are both already visible before `seen`
  // captures its own baseline.
  Atomics.store(control.words, workerWord(INDEX, W_YIELD), 1)
  control.wake(INDEX)
  const seen = shell.observeWake() // absorbs the park's own wake, same baseline `Shell.resume()` reads
  Atomics.store(control.words, workerWord(INDEX, W_PARKED), 0)

  const t0 = systemClock.now()
  runBlockingLoop(
    shell,
    () => {
      bodyCalls++
    },
    () => WAIT_MS,
    seen,
  )
  const elapsed = systemClock.now() - t0

  expect(bodyCalls).toBe(1) // the entry drain only; the loop never runs a wake-driven pass at all
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
