// `lifecycle` (docs/plan/28b-reconnect-and-lifecycle.md step 4, Tests added): the idle world --
// ticking stops on the tick that applies the last `Disconnected`, the idle delay (`host/
// lifecycle.ts`) pauses (snapshot + flush, `SimHost.pause()`) and calls `onIdle` exactly once, and
// a `Hello` while paused resumes ticking before the handshake is consumed (0013 "A new connection
// resumes the timer").
import { expect, test } from 'vitest'
import { serverInternals, worldServerTestHandle } from '../../src/server.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture, square } from './support.js'

/** 0013 "A disconnected player's state": 10 s grace, 200 ticks @ 50 ms (the fixture's own 20 Hz
 * default -- `DEFAULT_TICK_HZ`, `server.ts`). A few extra ticks cover the tick that actually
 * applies the queued `Disconnected` record and the `lifecycle.afterTick()` check right after it. */
const PAST_GRACE_TICKS = 210

/** `host/lifecycle.ts`'s own idle timer fires from inside `Scheduler.setTimer`'s synchronous
 * callback (`VirtualClock.advanceTo`'s own `fireDue()`), so it can only ever *start* the async
 * `SimHost.pause()` -> `onIdle()` sequence fire-and-forget, never await its completion itself
 * (`armIdleTimer`'s own doc comment). Draining a handful of microtask turns after the `advanceTo`
 * call that crossed the deadline is what lets a test observe the sequence's own effects
 * (`idleCalls`) synchronously afterward -- real production code never needs this, since real wall
 * time keeps passing regardless of what a caller awaits next. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

test('lifecycle/idle-stops-ticks-then-onidle', async () => {
  const seed = 4001
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()
    expect(serverInternals(harness.server).isTicking).toBe(true)

    harness.link(0).disconnect()
    await harness.advanceTicks(PAST_GRACE_TICKS)

    // The tick that applies the last `Disconnected` is the last tick run: ticking has already
    // stopped, well before the 30 s idle delay itself elapses.
    expect(serverInternals(harness.server).isTicking).toBe(false)
    const frozenAt = worldServerTestHandle(harness.server).counters.ticksRun
    expect(serverInternals(harness.server).idleCalls).toBe(0)

    // A further `advanceTicks` must not move the tick counter at all (`SimHost.stepTick` is
    // skipped whenever `!isTicking`, `net-harness.ts`'s own `advanceTicks`) -- "no tick is
    // skipped or inferred" (0013) cuts both ways: none due are skipped, and none not due are
    // invented either.
    await harness.advanceTicks(20)
    expect(worldServerTestHandle(harness.server).counters.ticksRun).toBe(frozenAt)

    // Past the 30 s idle delay (armed the instant ticking stopped, above): `SimHost.pause()`
    // (snapshot-if-dirty, flush) then `onIdle()`, exactly once.
    await harness.advanceTo(harness.clock.now() + 31_000)
    await flushMicrotasks()
    expect(serverInternals(harness.server).idleCalls).toBe(1)
    expect(worldServerTestHandle(harness.server).counters.ticksRun).toBe(frozenAt)
  } finally {
    await harness.dispose()
  }
})

test('lifecycle/hello-resumes', async () => {
  const seed = 4002
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()

    harness.link(0).disconnect()
    await harness.advanceTicks(PAST_GRACE_TICKS)
    await harness.advanceTo(harness.clock.now() + 31_000)
    await flushMicrotasks()
    expect(serverInternals(harness.server).idleCalls).toBe(1)
    expect(serverInternals(harness.server).isTicking).toBe(false)
    const frozenAt = worldServerTestHandle(harness.server).counters.ticksRun

    // A fresh connection's own first `Hello` resumes ticking *before* the handshake itself is
    // consumed (Scope): the new client still ends up joined and converged, proving `resume()` ran
    // in time for `pumpHandshakes` to ever drain its `attachQueue` entry at all.
    const second = harness.addClient()
    second.setCamera(square(1))
    await harness.settle()

    expect(serverInternals(harness.server).isTicking).toBe(true)
    expect(worldServerTestHandle(harness.server).counters.ticksRun).toBeGreaterThan(frozenAt)
    expect(second.status().live).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test('lifecycle/keep-ticking-when-empty', async () => {
  const seed = 4003
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed,
    clients: 1,
    world: { keepTickingWhenEmpty: true },
  })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()

    harness.link(0).disconnect()
    await harness.advanceTicks(PAST_GRACE_TICKS)
    // `Disconnected` still gets logged (grace is unaffected), but `keepTickingWhenEmpty` means
    // "zero online players" never arms `stopAfterNextTick` -- ticking never stops.
    expect(serverInternals(harness.server).isTicking).toBe(true)
    const before = worldServerTestHandle(harness.server).counters.ticksRun

    // Well past both the grace and the idle delay: still no idle sequence, and the tick counter
    // keeps moving the whole time.
    await harness.advanceTicks(700)
    expect(serverInternals(harness.server).idleCalls).toBe(0)
    expect(serverInternals(harness.server).isTicking).toBe(true)
    expect(worldServerTestHandle(harness.server).counters.ticksRun).toBeGreaterThan(before)
  } finally {
    await harness.dispose()
  }
})
