// `counters-exact` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Tests added): bytes per
// client per tick, exact, for a fixed seed -- pinned as literals (Constraints: "never computed from
// the code under test"). Seeds the bandwidth rows M31 asserts.
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
      { tick: 1, bytesDown: 25, bytesUp: 0 },
      { tick: 2, bytesDown: 0, bytesUp: 28 },
      { tick: 3, bytesDown: 58, bytesUp: 0 },
      { tick: 5, bytesDown: 0, bytesUp: 11 },
    ])
    expect(c.bytesDown).toBe(83)
    expect(c.bytesUp).toBe(39)
    expect(c.messagesDown).toBe(2)
    expect(c.messagesUp).toBe(2)
  } finally {
    await harness.dispose()
  }
})
