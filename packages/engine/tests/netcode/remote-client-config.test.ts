// `remote_client_without_game_config_matches_host` (M33f, ADR 0042): a `HeadlessClient`
// created with no `game` takes the world from `Welcome`, builds its generator then, and ends up
// with the host's replica and the pristine terrain a client configured directly would hold.
// `createNetHarness` passes no `game` to its clients, so `clients[0]` is the remote-style client;
// `direct` below is the same client built the old way (`clientsConfiguredAtInit`).
import { expect, test } from 'vitest'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture, square } from './support.js'

test('remote_client_without_game_config_matches_host', async () => {
  const seed = 3301
  const fixture = await putsFixture()
  const harness = await createNetHarness({ fixture, seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.advanceTicks(10)
    await harness.settle()

    // Replicated state matches the host's.
    harness.assertConverged()

    // `revealed` is true only once every chunk of the visible rectangle has its pristine terrain
    // generated locally, by a generator that exists only because `Welcome` configured the client
    // (a bounded check: `settle` has returned; without the generator it stays false).
    expect(client.status().revealed, 'the visible rectangle is held and generated').toBe(true)
    const generated = client.chunkHash(0, 0)
    expect(generated, 'chunk (0,0) resident').not.toBeNull()

    // A client configured at construction (the escape hatch) holds the same chunk.
    const direct = await createNetHarness({
      fixture,
      seed,
      clients: 1,
      clientsConfiguredAtInit: true,
    })
    try {
      const other = direct.clients[0]
      if (!other) throw new Error('no client')
      other.setCamera(square(0))
      await direct.advanceTicks(10)
      await direct.settle()
      expect(other.chunkHash(0, 0)).toBe(generated)
    } finally {
      await direct.dispose()
    }
  } finally {
    await harness.dispose()
  }
})
