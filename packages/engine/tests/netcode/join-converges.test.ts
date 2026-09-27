// `join-converges` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Tests added): K=4, a mix
// of actions, `assertConverged`. Every client's `ui()`-observable state (global scope: `motd`,
// `global_ticks`) is asserted identical across all four, and `assertConverged`'s own per-connection
// `region_hash` parity is checked for `connId 0` -- the harness's own doc comment on
// `assertConverged`'s `only` option explains why every other connection cannot currently reach
// parity (`ClientInstance::init`'s hardcoded `own_player = PlayerId(1)`, a real multi-connection
// identity being M28's own job, Non-scope here): this test still drives four real, independent
// `HeadlessClient`s and asserts everything the current engine can support about them.
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

    harness.assertConverged({ only: [0] })
  } finally {
    await harness.dispose()
  }
})
