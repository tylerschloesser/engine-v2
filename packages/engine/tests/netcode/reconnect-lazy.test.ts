// M34c step 8 (M34c Deviations): `link(i).reconnect()` after
// an outage longer than the grace. The client's redial backoff has grown by then; the fresh end must
// be accepted when the client dials it, not when `reconnect()` is called (the host closes an end that
// sends no `Hello` within 5 s).
import { expect, test } from 'vitest'
import { SessionState } from '../../src/clock-block.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture, square } from './support.js'

test('reconnect/lazy-after-long-outage', async () => {
  const seed = 3090
  const h = await createNetHarness({ fixture: await putsFixture(), seed, clients: 2 })
  try {
    const [a, keeper] = h.clients
    if (!a || !keeper) throw new Error('need 2 clients')
    a.setCamera(square(0))
    keeper.setCamera(square(1)) // stays online: the world keeps ticking through the outage
    await h.settle()
    const before = a.status().linkUpCount
    const tickBefore = a.status().tick

    h.link(0).disconnect()
    await h.advanceTicks(260) // past the 200-tick grace: the redial backoff is at its cap
    h.link(0).reconnect()
    const trace: string[] = []
    for (let i = 0; i < 5; i++) {
      await h.advanceTicks(50)
      const s = a.status()
      trace.push(`+${(i + 1) * 50}: linkUpCount ${s.linkUpCount} live ${s.live} tick ${s.tick}`)
    }
    const s = a.status()
    expect(s.linkUpCount, `seed ${seed}: ${trace.join(' | ')}`).toBeGreaterThan(before)
    expect(s.live, trace.join(' | ')).toBe(true)
    // A frozen tick is a client whose redial reached a dead end (`live` alone keeps its old value).
    expect(
      s.tick,
      `seed ${seed}: the client receives frames again: ${trace.join(' | ')}`,
    ).toBeGreaterThan(tickBefore + 250)
    expect(s.sessionState).toBe(SessionState.Online)
    await h.settle()
    h.assertConverged()
  } finally {
    await h.dispose()
  }
}, 30_000)
