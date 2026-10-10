// `counters-exact` (M27, Tests added): bytes per
// client per tick, exact, for a fixed seed -- pinned as literals (Constraints: "never computed from
// the code under test"). Seeds the bandwidth rows M31 asserts.
//
// M28, re-measured at M28's gate: the connection opens with
// `Hello` (up, tick 1) and `Welcome` plus the first `Frame` (down, tick 2). `Hello.camera` is a
// zeroed "no camera yet" report that the host ignores (`ConnSlot.camera` stays `None`), so nothing
// is subscribed until this test's own `setCamera` reaches the host (up, tick 3); the subscription's
// chunk-enter frame follows at tick 4. The literals pinned before the gate (102 B down at tick 2)
// recorded a defect: `Host::attach` treated the zeroed report as a camera and subscribed around
// (0,0) before the client had one.
import { expect, test } from 'vitest'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture } from './support.js'

test('counters-exact: literal per-tick byte counts for a fixed seed', async () => {
  // M31b R1: hash-all off, this test pins literal per-tick byte counts (hash bytes are `integrity/`'s).
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed: 4001,
    clients: 1,
    hashAll: false,
  })
  try {
    harness.clients[0]?.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await harness.advanceTicks(3)
    harness.clients[0]?.dispatch({ SetMotd: { n: 1 } })
    await harness.advanceTicks(2)

    const c = harness.counters(0)
    expect(c.perTick).toEqual([
      { tick: 1, bytesDown: 0, bytesUp: 72 },
      { tick: 2, bytesDown: 54, bytesUp: 0 },
      { tick: 3, bytesDown: 0, bytesUp: 28 },
      { tick: 4, bytesDown: 58, bytesUp: 0 },
      { tick: 5, bytesDown: 0, bytesUp: 11 },
    ])
    expect(c.bytesDown).toBe(112)
    expect(c.bytesUp).toBe(111)
    expect(c.messagesDown).toBe(3)
    expect(c.messagesUp).toBe(3)
  } finally {
    await harness.dispose()
  }
})
