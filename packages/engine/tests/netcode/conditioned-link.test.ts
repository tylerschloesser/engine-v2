// `conditioned-link` (M27, Tests added): latency,
// jitter and stall on a real client<->host link, and the same seed's `trace()` compared byte for
// byte across two independent runs (0020 §7's own reproducibility guarantee, "a run is reproducible
// from (seed, scenario) even over real sockets" -- proven here for the in-memory transport).
import { expect, test } from 'vitest'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture, square } from './support.js'

async function runScenario(seed: number): Promise<Uint8Array> {
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed,
    clients: 2,
    conditions: { latencyMs: 20, jitterMs: 10, stall: { p: 0.2, rtoMs: 40 } },
  })
  try {
    harness.clients.forEach((c, i) => {
      c.setCamera(square(i))
    })
    await harness.advanceTicks(15)
    harness.clients[0]?.dispatch({ SetMotd: { n: 7 } })
    await harness.advanceTicks(15)
    return harness.trace()
  } finally {
    await harness.dispose()
  }
}

test('conditioned-link: latency/jitter/stall, same seed gives an identical trace twice', async () => {
  const seed = 2001
  const traceA = await runScenario(seed)
  const traceB = await runScenario(seed)
  expect(traceA.length).toBeGreaterThan(0)
  expect(Array.from(traceA)).toEqual(Array.from(traceB))
})

test('conditioned-link: a stalled link still delivers, just later', async () => {
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed: 2002,
    clients: 1,
    conditions: { latencyMs: 5, jitterMs: 0 },
  })
  try {
    harness.clients[0]?.setCamera(square(0))
    await harness.advanceTicks(5)
    harness.link(0).stall(200) // virtual ms, both directions
    harness.clients[0]?.dispatch({ SetMotd: { n: 3 } })
    await harness.advanceTicks(3)
    // Still stalled: the confirmed result has not arrived yet.
    expect((harness.clients[0]?.ui() as { motd: number } | null)?.motd).not.toBe(3)
    await harness.advanceTicks(20) // past the stall's own rtoMs
    expect((harness.clients[0]?.ui() as { motd: number } | null)?.motd).toBe(3)
  } finally {
    await harness.dispose()
  }
})
