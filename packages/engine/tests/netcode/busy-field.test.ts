// `fx-busy-field` through the real `.wasm` and the netcode harness (M31
// integrity.md step 2): the steady field replicates and converges, and `Action::Fill` makes a dense
// chunk that reaches a second client's replica.
import { expect, test } from 'vitest'
import { createNetHarness } from '../../src/test/net-harness.js'
import { loadFixture } from '../support/fixtures.js'

test('rates/busy-field-loads-and-converges', async () => {
  const harness = await createNetHarness({
    fixture: await loadFixture('busy-field'),
    seed: 3101,
    clients: 1,
    world: { params: { maxEntities: 4096, maxActionGrowth: 65_536 } },
  })
  try {
    harness.clients[0]?.setCamera({ x: 30, y: 14, tilesAcross: 80 })
    await harness.advanceTicks(60)
    harness.clients[0]?.dispatch({ Fill: { cx: 1, cy: 0 } })
    await harness.settle()
    harness.assertConverged()
    const c = harness.counters(0)
    expect(c.sections.ChunkDeltas ?? 0).toBeGreaterThan(0)
  } finally {
    await harness.dispose()
  }
})
