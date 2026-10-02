// 0012 "Predicted set": the client runs no tick rules. `fx-puts`'s tick rule bumps `Global::day`
// once a simulated second on the host; a client that ran it too would move its own replica while
// its downlink is held. Held for 45 ticks (two day bumps on the host), the replica must not move.
import { expect, test } from 'vitest'
import { worldServerTestHandle } from '../../src/server.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture } from './support.js'

test('prediction/client-runs-no-tick-rules', async () => {
  const h = await createNetHarness({ fixture: await putsFixture(), seed: 1201, clients: 1 })
  try {
    const client = h.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await h.advanceTicks(25)
    await h.settle()
    h.assertConverged()
    const before = client.replicaHash()
    const host = worldServerTestHandle(h.server)
    const hostBefore = host.regionHash(0)

    h.link(0).stall(2_600) // inside the 3 s dead-peer timeout: no frame reaches the client
    await h.advanceTicks(45)

    expect(client.replicaHash(), 'no frame arrived and no tick rule ran: replica unchanged').toBe(
      before,
    )
    // Not vacuous: the host did tick on (its own state moved), and the replica catches up after.
    expect(host.regionHash(0), 'the host ticked on and its own state moved').not.toBe(hostBefore)
    await h.advanceTicks(60)
    await h.settle()
    h.assertConverged()
    expect(client.replicaHash()).not.toBe(before)
  } finally {
    await h.dispose()
  }
})
