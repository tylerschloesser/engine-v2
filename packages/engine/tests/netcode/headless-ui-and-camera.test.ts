// `headless-ui-and-camera` (M27, Tests added):
// `ui()` returns the fixture's last `Ui` JSON (M16b's kind-1 record, decoded directly off
// `client_poll_ui()` -- `headless-client.ts`'s own `pollUi()`); `setCamera` moves the subscription
// (a real chunk-enter burst reaches the client once its view moves somewhere new).
import { expect, test } from 'vitest'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture } from './support.js'

test('headless-ui-and-camera: ui() is null before the first Ui record, then the fixture JSON', async () => {
  const harness = await createNetHarness({ fixture: await putsFixture(), seed: 5001, clients: 1 })
  try {
    expect(harness.clients[0]?.ui()).toBeNull()

    harness.clients[0]?.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await harness.advanceTicks(3)
    expect(harness.clients[0]?.ui()).toEqual({ motd: 0, note: 0, note_until: 0, global_ticks: 1 })

    harness.clients[0]?.dispatch({ SetMotd: { n: 42 } })
    await harness.advanceTicks(3)
    expect((harness.clients[0]?.ui() as { motd: number } | null)?.motd).toBe(42)
  } finally {
    await harness.dispose()
  }
})

test('headless-ui-and-camera: setCamera moves the subscription (a real chunk burst)', async () => {
  const harness = await createNetHarness({ fixture: await putsFixture(), seed: 5002, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await harness.advanceTicks(5)
    const before = harness.counters(0).bytesDown

    // Far enough away that the new view shares no chunks with the old one.
    client.setCamera({ x: 100_000, y: 100_000, tilesAcross: 20 })
    await harness.advanceTicks(5)
    const after = harness.counters(0).bytesDown

    expect(after).toBeGreaterThan(before)
  } finally {
    await harness.dispose()
  }
})
