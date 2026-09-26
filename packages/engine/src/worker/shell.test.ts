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
 * M23 fix round 1: `Shell.runAsync`, called *from inside* an active `body()` pass, used to leave
 * `fn` starved -- `runBlockingLoop` stored `W_PARKED = 1` (via `runAsync` itself) but then went
 * straight back to `Atomics.wait`, which blocks the whole thread, so `fn`'s own promise chain (a
 * microtask) never got a turn to run until *something else* woke that wait or it timed out; even
 * then, the loop's own next `runBodyOnce` call raced `fn`'s continuation rather than waiting for it.
 * Fixed: `runAsync` sets a `#leaveRequested` flag `runBlockingLoop` checks right after the pass that
 * called it, leaving immediately (no second `W_PARKED` store -- `runAsync` already made it) instead
 * of re-entering `Atomics.wait`. Proven failable: reverting `runBlockingLoop`'s own two
 * `consumeLeaveRequest()` checks (this test's own regression target) made this test hang until
 * `WAIT_MS`, misreading the timeout as a second wake and reaching `bodyCalls === 2` with `asyncRan`
 * still `false` -- confirmed by hand, reverted.
 */
test('shell.runAsync_from_inside_body_leaves_and_reenters', async () => {
  const control = new ControlBlock(createControlBlock())
  const shell = createShell(control, INDEX)
  let bodyCalls = 0
  let asyncRan = false
  let resolveAsync: () => void = () => {}
  const asyncGate = new Promise<void>((resolve) => {
    resolveAsync = resolve
  })
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const seen = shell.observeWake()
  Atomics.store(control.words, workerWord(INDEX, W_PARKED), 0)

  runBlockingLoop(
    shell,
    () => {
      bodyCalls++
      if (bodyCalls === 1) {
        shell.runAsync(async () => {
          await asyncGate
          asyncRan = true
        })
      } else {
        Atomics.store(control.words, workerWord(INDEX, W_YIELD), 1)
        control.wake(INDEX)
        resolveDone()
      }
    },
    () => WAIT_MS,
    seen,
  )

  // `runBlockingLoop` must already have returned, synchronously, right after the one pass that
  // called `runAsync` -- not after a real or timed-out `Atomics.wait`.
  expect(bodyCalls).toBe(1)
  expect(asyncRan).toBe(false)
  expect(Atomics.load(control.words, workerWord(INDEX, W_PARKED))).toBe(1)

  resolveAsync()
  await done

  expect(asyncRan).toBe(true)
  expect(bodyCalls).toBe(2) // the async chain's own `.finally()` re-entered and drained on entry
  expect(Atomics.load(control.words, workerWord(INDEX, W_PARKED))).toBe(1) // yielded out cleanly
})

/**
 * M23 fix round 1: coherence for `parkWorkers`/`attachHostLifecycle`'s `sim-pause` while a
 * `runAsync` chain is in flight -- `W_PARKED = 1` already means "not blocked, will accept a
 * `postMessage`" the same way it does after a yielded exit, so `resume()` (a park's own `{ type:
 * 'resume' }` handler) must not also start a second, concurrent `runBlockingLoop`: the in-flight
 * chain's own `.finally()` owns the next entry. `resume()` still clears `W_YIELD` (a park issued
 * while async work runs must not make the loop immediately re-yield once that work's own re-entry
 * happens).
 */
test('shell.resume_does_not_start_a_second_loop_while_async_is_in_flight', async () => {
  const control = new ControlBlock(createControlBlock())
  const shell = createShell(control, INDEX)
  let bodyCalls = 0
  let resolveAsync: () => void = () => {}
  const asyncGate = new Promise<void>((resolve) => {
    resolveAsync = resolve
  })
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const seen = shell.observeWake()
  Atomics.store(control.words, workerWord(INDEX, W_PARKED), 0)

  runBlockingLoop(
    shell,
    () => {
      bodyCalls++
      if (bodyCalls === 1) {
        shell.runAsync(async () => {
          await asyncGate
        })
      } else {
        Atomics.store(control.words, workerWord(INDEX, W_YIELD), 1)
        control.wake(INDEX)
        resolveDone()
      }
    },
    () => WAIT_MS,
    seen,
  )

  Atomics.store(control.words, workerWord(INDEX, W_YIELD), 1) // a park request lands mid-flight
  shell.resume()
  expect(bodyCalls).toBe(1) // resume() did not touch the loop itself
  expect(Atomics.load(control.words, workerWord(INDEX, W_YIELD))).toBe(0) // still cleared

  resolveAsync()
  await done

  expect(bodyCalls).toBe(2)
})

/**
 * M23 fix round 1, Planning decision 2's own "at most one at a time" precedent extended to `Shell`
 * itself: a second `runAsync` call while one is already in flight is queued, FIFO, never dropped.
 */
test('shell.runAsync_queues_a_second_call_while_one_is_in_flight', async () => {
  const control = new ControlBlock(createControlBlock())
  const shell = createShell(control, INDEX)
  let bodyCalls = 0
  const order: string[] = []
  let resolveFirst: () => void = () => {}
  const firstGate = new Promise<void>((resolve) => {
    resolveFirst = resolve
  })
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const seen = shell.observeWake()
  Atomics.store(control.words, workerWord(INDEX, W_PARKED), 0)

  runBlockingLoop(
    shell,
    () => {
      bodyCalls++
      if (bodyCalls === 1) {
        shell.runAsync(async () => {
          await firstGate
          order.push('first')
        })
        shell.runAsync(async () => {
          order.push('second')
        })
      } else {
        Atomics.store(control.words, workerWord(INDEX, W_YIELD), 1)
        control.wake(INDEX)
        resolveDone()
      }
    },
    () => WAIT_MS,
    seen,
  )

  expect(order).toEqual([]) // the second call did not run ahead of the first
  resolveFirst()
  await done

  expect(order).toEqual(['first', 'second'])
  expect(bodyCalls).toBe(2) // the loop re-entered once, after both settled -- not after the first
})

/**
 * Gate fix (docs/plan/23-persistence-opfs-and-lifecycle.md, "Open gate failures" 3): `stop()` while a
 * `runAsync` chain is in flight must prevent `#runQueued`'s own `.finally()` from re-entering the
 * loop at all, once that chain finally settles -- no further `body()` pass, ever. Proven failable: with
 * the `if (this.#stopped) return` guard removed from `#runQueued`'s `.finally()`, `bodyCalls` reaches
 * `2` here instead of staying at `1` (confirmed by hand, reverted).
 */
test('shell.stop_during_inflight_runAsync_prevents_reentry', async () => {
  const control = new ControlBlock(createControlBlock())
  const shell = createShell(control, INDEX)
  let bodyCalls = 0
  let resolveAsync: () => void = () => {}
  const asyncGate = new Promise<void>((resolve) => {
    resolveAsync = resolve
  })

  const seen = shell.observeWake()
  Atomics.store(control.words, workerWord(INDEX, W_PARKED), 0)

  runBlockingLoop(
    shell,
    () => {
      bodyCalls++
      if (bodyCalls === 1) {
        shell.runAsync(async () => {
          await asyncGate
        })
      }
    },
    () => WAIT_MS,
    seen,
  )

  expect(bodyCalls).toBe(1)
  shell.stop()
  resolveAsync()
  // Let every microtask the settled chain's own `.catch().finally()` schedules actually run.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  expect(bodyCalls).toBe(1) // no re-entry, no second pass, ever, once stopped
  expect(shell.stopped()).toBe(true)
})

/**
 * Gate fix (docs/plan/23-persistence-opfs-and-lifecycle.md, "Open gate failures" 4): `runAsync`
 * called before this worker's first `runBlockingLoop` has ever recorded a loop (`#loop` still `null`,
 * e.g. a hypothetical caller during `setup()`) must not drop `fn` -- queued instead, and run the
 * moment `setLoop` gives it a loop to leave from, exactly like a `runAsync` call from inside a body
 * pass (`shell.runAsync_from_inside_body_leaves_and_reenters`, above: one entry-drain pass, then
 * leave; the chain's own `.finally()` re-enters once it settles).
 */
test('shell.runAsync_before_first_loop_is_queued_not_dropped', async () => {
  const control = new ControlBlock(createControlBlock())
  const shell = createShell(control, INDEX)
  let ran = false
  let bodyCalls = 0
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  // No `runBlockingLoop` has ever run for this shell yet: `#loop` is still `null`.
  shell.runAsync(async () => {
    ran = true
  })
  expect(ran).toBe(false) // queued, not dropped -- nothing to leave from yet, so not runnable either

  const seen = shell.observeWake()
  Atomics.store(control.words, workerWord(INDEX, W_PARKED), 0)

  runBlockingLoop(
    shell,
    () => {
      bodyCalls++
      if (bodyCalls > 1) {
        Atomics.store(control.words, workerWord(INDEX, W_YIELD), 1)
        control.wake(INDEX)
        resolveDone()
      }
    },
    () => WAIT_MS,
    seen,
  )

  // `setLoop` (called at the very top of `runBlockingLoop`) drained the queued `fn` through the
  // ordinary `runAsync` machinery: the entry-drain pass still ran once, then the loop left instead of
  // waiting.
  expect(bodyCalls).toBe(1)
  expect(Atomics.load(control.words, workerWord(INDEX, W_PARKED))).toBe(1)

  await done

  expect(ran).toBe(true)
  expect(bodyCalls).toBe(2) // the async chain's own `.finally()` re-entered and drained on entry
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
