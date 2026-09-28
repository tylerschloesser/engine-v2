// `reconnect` (docs/plan/28b-reconnect-and-lifecycle.md steps 3-4, Tests added): pending-action
// resend and `Lost` (step 3), grace and its interaction with the logged connection events (step
// 4). Steps 1-2's own coverage (`epoch-and-resync.test.ts`) is Non-scope here; `reconnect/cost`
// and `resume-keeps-unchanged-chunks`/`changed-while-away` (the resume-hint round trip, never
// wired into a live `sim_attach` call by any milestone through this one) are step 5's own scope,
// left for that delegation.
import { expect, test } from 'vitest'
import type { ActionOutcome } from '../../src/client.js'
import { SessionState } from '../../src/clock-block.js'
import { worldServerTestHandle } from '../../src/server.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture, square } from './support.js'

/** A write-ahead log frame's own `count` field (0005 Formats), the same reader `handshake.
 * test.ts`'s own `frameRecordCount` uses -- duplicated here rather than shared/exported, matching
 * that file's own precedent of a small private reader per test file. */
function frameRecordCount(frame: Uint8Array): number {
  let pos = 0
  for (let i = 0; i < 2; i++) {
    // skip `len varint`, then `tick_delta varint`
    for (;;) {
      const b = frame[pos]
      pos++
      if (b === undefined || (b & 0x80) === 0) break
    }
  }
  let value = 0
  let shift = 0
  for (;;) {
    const b = frame[pos]
    if (b === undefined) throw new Error('frameRecordCount: truncated')
    pos++
    value |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return value >>> 0
    shift += 7
  }
}

test('reconnect/pending-resent-once', async () => {
  const seed = 3001
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()

    const results: [number, ActionOutcome][] = []
    client.onActionResult((seq, result) => results.push([seq, result]))

    // Dispatched but never flushed to the wire (0 ticks advanced): the connection dies before the
    // action is even sent, let alone admitted -- the host has never seen it.
    const seq = client.dispatch({ Paint: { pos: { x: 3, y: 3 }, base: 1, resource: 0 } })
    harness.link(0).disconnect()
    harness.link(0).reconnect()

    await harness.settle()
    harness.assertConverged()

    // Resent on the reconnect's own `Welcome` (`unacked_after`) and applied exactly once: a
    // `Confirmed` (or a game rejection) shows up, never `Lost` (which would mean the host claims
    // to have already processed it before it was ever sent).
    const own = results.filter(([s]) => s === seq)
    expect(own.length).toBeGreaterThan(0)
    expect(own.some(([, r]) => r === 'Lost')).toBe(false)
  } finally {
    await harness.dispose()
  }
})

test('reconnect/lost-ack-reports-lost', async () => {
  const seed = 3002
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()

    const results: [number, ActionOutcome][] = []
    client.onActionResult((seq, result) => results.push([seq, result]))

    const seq = client.dispatch({ Paint: { pos: { x: 4, y: 4 }, base: 1, resource: 0 } })
    // Exactly 2: the action is flushed to the wire on tick 1's own `stepFrame` and admitted
    // (`on_uplink`) on tick 2's own delivery release -- *not yet applied* (that needs tick 3's own
    // `sim_tick()`). Disconnecting here, before a 3rd `advanceTicks` call, guarantees the drop
    // happens before the ack could ever have been built, let alone delivered: `pending_records` is
    // sim state, not connection state, so grace-period ticking still applies it once reconnected,
    // but with no live `ConnSlot` left to carry a `Confirmed` ack through at the time it does.
    await harness.advanceTicks(2)
    harness.link(0).disconnect()
    harness.link(0).reconnect()

    await harness.settle()
    harness.assertConverged()

    const own = results.filter(([s]) => s === seq)
    expect(own.some(([, r]) => r === 'Lost')).toBe(true)
    // Applied exactly once: no `Confirmed`/`Rejected` from a duplicate re-admit riding the resend
    // (the host's own dedup floor, `store.last_seq`, drops it) -- `Lost` is the only verdict this
    // seq ever gets.
    expect(own.every(([, r]) => r === 'Lost')).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test('reconnect/bye-skips-grace', async () => {
  const seed = 3003
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()

    const simHost = worldServerTestHandle(harness.server)
    let records = 0
    const originalLogSink = simHost.logSink
    simHost.logSink = (bytes) => {
      records += frameRecordCount(bytes)
      originalLogSink?.(bytes)
    }

    // `HeadlessClient.leave()`: sends `Bye{Leave}` then closes -- 0013 "an explicit `Bye` skips
    // the grace" (`host/lifecycle.ts`'s `playerLeft`, not `connectionDropped`).
    client.leave()
    // Nowhere near the 10 s grace: `Disconnected` must already be logged well inside this window
    // if `Bye` really skipped the grace timer rather than merely starting a shorter one.
    await harness.advanceTicks(5)

    expect(records).toBeGreaterThan(0)
  } finally {
    await harness.dispose()
  }
})

test('reconnect/within-grace-logs-nothing', async () => {
  const seed = 3004
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()

    const simHost = worldServerTestHandle(harness.server)
    let records = 0
    const originalLogSink = simHost.logSink
    simHost.logSink = (bytes) => {
      records += frameRecordCount(bytes)
      originalLogSink?.(bytes)
    }

    // An ungraceful close, immediately reconnected (well inside the 10 s grace): the log must
    // gain no record at all from this whole episode -- neither `Disconnected` (the grace timer is
    // cancelled by the reconnect before it can fire) nor `Connected` (`suppressConnected`, `host/
    // handshake.ts`'s own `buildAttachInput` field, set from `lifecycle.isWithinGrace`).
    harness.link(0).disconnect()
    harness.link(0).reconnect()
    await harness.settle()
    harness.assertConverged()

    expect(records).toBe(0)
  } finally {
    await harness.dispose()
  }
})

test('reconnect/panic-recovery-resync', async () => {
  const seed = 3006
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()
    harness.assertConverged()

    // `harness.panicServer()` (from M24's own Deviations, this milestone's to build): `trapSim` +
    // `await simHost.recover()` -- the open connection stays open (Traps: "Connections stay open
    // across recovery"), sees a second `Welcome` at the new epoch, and converges again.
    await harness.panicServer()
    await harness.settle()

    expect(worldServerTestHandle(harness.server).epoch).toBeGreaterThan(0)
    expect(client.status().sessionState).toBe(SessionState.Online)
    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})

test('reconnect/after-grace-logs-disconnected', async () => {
  const seed = 3005
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()

    const simHost = worldServerTestHandle(harness.server)
    let records = 0
    const originalLogSink = simHost.logSink
    simHost.logSink = (bytes) => {
      records += frameRecordCount(bytes)
      originalLogSink?.(bytes)
    }

    harness.link(0).disconnect()
    // Still inside the 10 s grace (200 ticks @ 50 ms): nothing logged yet.
    await harness.advanceTicks(150)
    expect(records).toBe(0)

    // Past the grace: `Disconnected` is queued by the timer and applied at the next tick.
    await harness.advanceTicks(100)
    expect(records).toBeGreaterThan(0)
  } finally {
    await harness.dispose()
  }
})
