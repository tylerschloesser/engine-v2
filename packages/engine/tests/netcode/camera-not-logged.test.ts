// Spec simulation R7: camera and viewport updates are not actions: they never mutate the world and
// are neither logged nor needed for replay. `camera_walk_changes_no_state` (Rust) shows the state
// hash does not move; this is the log half, over a real host: every frame `SimHost.logSink` receives
// is what `Persistence` appends to the log, so a pan that appended anything would show here.
import { expect, test } from 'vitest'
import { worldServerTestHandle } from '../../src/server.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture, square } from './support.js'

test('camera-reports-append-no-log-record', async () => {
  const h = await createNetHarness({ fixture: await putsFixture(), seed: 3901, clients: 1 })
  try {
    const client = h.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await h.settle()
    h.assertConverged()

    const host = worldServerTestHandle(h.server)
    const original = host.logSink
    let frames = 0
    host.logSink = (bytes) => {
      frames++
      original?.(bytes)
    }
    const heldBefore = h.counters(0).heldChunks

    // Pan across 400 tiles in 40 ticks: 40 camera reports, a new subscription each time.
    for (let i = 1; i <= 40; i++) {
      client.setCamera(square(i * 10))
      await h.advanceTicks(1)
    }
    await h.settle()

    expect(h.counters(0).heldChunks, 'the reports reached the host (chunks followed)').not.toBe(
      heldBefore,
    )
    expect(frames, 'no log frame was written for a camera report').toBe(0)
    h.assertConverged()
  } finally {
    await h.dispose()
  }
})
