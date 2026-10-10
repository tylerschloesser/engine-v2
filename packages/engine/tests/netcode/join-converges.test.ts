// `join-converges` (M27, Tests added): K=4, a mix
// of actions, `assertConverged`. Every client's `ui()`-observable state (global scope: `motd`,
// `global_ticks`) is asserted identical across all four, and `assertConverged()` (M27 gate round 1:
// every connection, not just `connId 0` -- `HeadlessClient`'s own `myPlayerId` now threads each
// connection's real `PlayerId` into its client config, `net-harness.ts`'s own doc comment) checks
// full `region_hash` parity for all four.
import { expect, test } from 'vitest'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture, square } from './support.js'

test('join-converges', async () => {
  const seed = 1001
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 4 })
  try {
    harness.clients.forEach((c, i) => {
      c.setCamera(square(i))
    })
    await harness.advanceTicks(10)

    // A mix of chunk-, global- and player-scoped actions, one per client, exercising every
    // handler `fx-puts` has that never rejects (0004's own "rejected actions" coverage is a
    // separate scenario, `harness-accepts-build-dir`'s own sibling suites do not need it here).
    harness.clients[0]?.dispatch({ Paint: { pos: { x: 2, y: 2 }, base: 1, resource: 0 } })
    harness.clients[1]?.dispatch({ Spawn: { at: { x: -3, y: 8 }, kind: 1 } })
    harness.clients[2]?.dispatch({ SetMotd: { n: 99 } })
    harness.clients[3]?.dispatch('Roll')

    await harness.settle()

    for (let i = 1; i < harness.clients.length; i++) {
      expect(harness.clients[i]?.ui()).toEqual(harness.clients[0]?.ui())
    }
    expect((harness.clients[0]?.ui() as { motd: number } | null)?.motd).toBe(99)

    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})
