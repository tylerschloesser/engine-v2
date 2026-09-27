// `counters-exact` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Tests added): bytes per
// client per tick, exact, for a fixed seed -- pinned as literals (Constraints: "never computed from
// the code under test"). Seeds the bandwidth rows M31 asserts.
//
// docs/plan/28-sessions-and-reconnect.md: re-measured (Deviations) -- the connection now opens
// with `Hello` (up, tick 1) and `Welcome` (down, tick 2, the same tick `sim_attach` first runs and
// this connection's own first real `Frame` also goes out, both traced under one tick bucket) before
// any game traffic. `client_hello()`'s own `Hello.camera` is always a zeroed `CameraReport` (no
// real camera exists yet at that point in a connection's life, `game_instance.rs`'s own doc
// comment): the real one this test's own `setCamera` queued only reaches the host afterward, over
// the ordinary `client_poll_uplink` path, so the subscription (and its own chunk-enter Frame
// traffic) that used to land inside the first two ticks now lands outside this test's own 5-tick
// window -- `bytesDown` after tick 2 is genuinely `0` here, not a bug (`assertConverged()`-based
// scenarios elsewhere in this suite prove eventual convergence still holds).
import { expect, test } from 'vitest'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture } from './support.js'

test('counters-exact: literal per-tick byte counts for a fixed seed', async () => {
  const harness = await createNetHarness({ fixture: await putsFixture(), seed: 4001, clients: 1 })
  try {
    harness.clients[0]?.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await harness.advanceTicks(3)
    harness.clients[0]?.dispatch({ SetMotd: { n: 1 } })
    await harness.advanceTicks(2)

    const c = harness.counters(0)
    expect(c.perTick).toEqual([
      { tick: 1, bytesDown: 0, bytesUp: 72 },
      { tick: 2, bytesDown: 102, bytesUp: 0 },
      { tick: 3, bytesDown: 0, bytesUp: 28 },
      { tick: 5, bytesDown: 0, bytesUp: 11 },
    ])
    expect(c.bytesDown).toBe(102)
    expect(c.bytesUp).toBe(111)
    expect(c.messagesDown).toBe(2)
    expect(c.messagesUp).toBe(3)
  } finally {
    await harness.dispose()
  }
})
