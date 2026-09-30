// `integrity/*` (docs/plan/31b-desync-hashes.md, Tests added): the desync hashes through the real
// `.wasm` and the netcode harness. Every scenario here opts into production-cadence hashing
// (`world.debugHashMode: 'production'`); the hash-all default and its scenarios are step 4's.
import { expect, test } from 'vitest'
import { createNetHarness, type NetHarness } from '../../src/test/net-harness.js'
import { loadFixture } from '../support/fixtures.js'
import { putsFixture, square } from './support.js'

const PRODUCTION = { debugHashMode: 'production' } as const

/** Ticks for one full sweep of what client `i` holds (one chunk per 4 ticks) plus resync latency. */
function sweepTicks(h: NetHarness, i: number): number {
  return (h.counters(i).heldChunks + 4) * 4 + 30
}

test('integrity/clean-session-no-reports', async () => {
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed: 4101,
    clients: 2,
    world: PRODUCTION,
  })
  try {
    harness.clients[0]?.setCamera(square(0))
    harness.clients[1]?.setCamera({ x: 12, y: 4, tilesAcross: 20 })
    await harness.advanceTicks(10)
    for (let k = 0; k < 12; k++) {
      harness.clients[k % 2]?.dispatch({
        Paint: { pos: { x: k, y: 3 }, base: 2 + (k % 3), resource: 0 },
      })
      harness.clients[(k + 1) % 2]?.dispatch({ SetNote: { n: k } })
      if (k % 4 === 0) harness.clients[0]?.dispatch({ SetMotd: { n: k } })
      await harness.advanceTicks(25)
    }
    await harness.settle()
    harness.assertConverged()
    // A quiet run long enough for several full sweeps and two Global/OwnPlayer hash rounds.
    await harness.advanceTicks(sweepTicks(harness, 0) * 2 + 250)
    await harness.settle()
    harness.assertConverged()
    expect(harness.desyncs()).toEqual([])
    expect(harness.hostDesyncs().count).toBe(0)
    // Hashes were on the wire: nothing above is vacuous.
    expect(harness.counters(0).sections.Hashes ?? 0).toBeGreaterThan(0)
  } finally {
    await harness.dispose()
  }
})

test('integrity/clean-session-busy-field-no-reports', async () => {
  const harness = await createNetHarness({
    fixture: await loadFixture('busy-field'),
    seed: 4102,
    clients: 1,
    world: { ...PRODUCTION, params: { maxEntities: 4096, maxActionGrowth: 65_536 } },
  })
  try {
    harness.clients[0]?.setCamera({ x: 30, y: 14, tilesAcross: 80 })
    await harness.advanceTicks(200)
    await harness.settle()
    harness.assertConverged()
    expect(harness.desyncs()).toEqual([])
    expect(harness.counters(0).sections.Hashes ?? 0).toBeGreaterThan(0)
  } finally {
    await harness.dispose()
  }
})

test('integrity/corrupt-chunk-heals', async () => {
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed: 4103,
    clients: 1,
    world: PRODUCTION,
  })
  try {
    harness.clients[0]?.setCamera(square(0))
    await harness.advanceTicks(12)
    await harness.settle()
    harness.assertConverged()
    harness.clients[0]?.corruptChunk(0, 0)
    expect(harness.clients[0]?.replicaHash()).not.toBe(
      harness.clients[0]?.replicaHash() === '' ? '' : undefined,
    )
    await harness.advanceTicks(sweepTicks(harness, 0))
    await harness.settle()
    // Reported on both sides, healed within one sweep period.
    const client = harness.desyncs()
    expect(client.length).toBe(1)
    expect(client[0]).toMatchObject({ scope: 'chunk', cx: 0, cy: 0 })
    expect(client[0]?.hostHash).not.toBe(client[0]?.clientHash)
    const host = harness.hostDesyncs()
    expect(host.count).toBe(1)
    expect(host.reports[0]).toMatchObject({ scope: 'chunk', cx: 0, cy: 0 })
    harness.assertConverged()
    // And it stays healed: another sweep reports nothing new.
    await harness.advanceTicks(sweepTicks(harness, 0))
    await harness.settle()
    expect(harness.desyncs().length).toBe(1)
    expect(harness.hostDesyncs().count).toBe(1)
  } finally {
    await harness.dispose()
  }
})

test('integrity/skipped-delta-heals', async () => {
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed: 4104,
    clients: 1,
    world: PRODUCTION,
  })
  try {
    harness.clients[0]?.setCamera(square(0))
    await harness.advanceTicks(12)
    await harness.settle()
    harness.assertConverged()
    harness.skipDelta(0, 0, 0)
    harness.clients[0]?.dispatch({ Paint: { pos: { x: 2, y: 2 }, base: 5, resource: 0 } })
    await harness.advanceTicks(3)
    await harness.settle()
    // The dropped delta left the replica behind the host, until a hash says so.
    await harness.advanceTicks(sweepTicks(harness, 0))
    await harness.settle()
    const client = harness.desyncs()
    expect(client.length).toBeGreaterThanOrEqual(1)
    expect(client[0]).toMatchObject({ scope: 'chunk', cx: 0, cy: 0 })
    expect(harness.hostDesyncs().count).toBeGreaterThanOrEqual(1)
    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})

test('integrity/global-mismatch-heals', async () => {
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed: 4105,
    clients: 1,
    world: PRODUCTION,
  })
  try {
    harness.clients[0]?.setCamera(square(0))
    await harness.advanceTicks(12)
    await harness.settle()
    harness.assertConverged()
    // `Global` changes every simulated second in fx-puts; drop its updates until the 5 s hash.
    harness.skipGlobalDelta(0)
    harness.clients[0]?.dispatch({ SetMotd: { n: 77 } })
    await harness.advanceTicks(10)
    // The dropped updates left the replica's `Global` behind the host's (no settle: it would run
    // past the 5 s hash that heals this).
    expect(() => harness.assertConverged()).toThrow(/mismatches/)
    expect(harness.desyncs()).toEqual([])
    // The 5 s `Global` hash reports it, `ResyncChunk` with the reserved coordinate asks, the next
    // frame carries `Global` and `OwnPlayer` in full.
    await harness.advanceTicks(130)
    await harness.settle()
    const client = harness.desyncs()
    expect(client.length).toBeGreaterThanOrEqual(1)
    expect(client[0]).toMatchObject({ scope: 'global' })
    const host = harness.hostDesyncs()
    expect(host.reports[0]).toMatchObject({ scope: 'global' })
    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})

test('integrity/resync-respects-bucket', async () => {
  const harness = await createNetHarness({
    fixture: await loadFixture('busy-field'),
    seed: 4106,
    clients: 1,
    world: {
      ...PRODUCTION,
      params: { maxEntities: 4096, maxActionGrowth: 65_536 },
      // 20 B per tick: a dense chunk (~4 KB) is ~200 ticks of debt.
      bandwidth: { chunkRefillBytesPerS: 400, chunkBurstBytes: 500 },
    },
  })
  try {
    harness.clients[0]?.setCamera({ x: 144, y: 112, tilesAcross: 40 })
    await harness.advanceTicks(10)
    harness.clients[0]?.dispatch({ Fill: { cx: 3, cy: 3 } })
    harness.clients[0]?.dispatch({ Fill: { cx: 4, cy: 3 } })
    // Two dense chunks come down through the slow bucket; wait for the queue to empty.
    let guard = 0
    while (guard++ < 200 && (harness.counters(0).queuedEnters > 0 || guard < 20)) {
      await harness.advanceTicks(10)
    }
    await harness.advanceTicks(120)
    await harness.settle()
    harness.assertConverged()
    expect(harness.desyncs()).toEqual([])

    harness.clients[0]?.corruptChunk(3, 3)
    harness.clients[0]?.corruptChunk(4, 3)
    const snapshotTicks: number[] = []
    let prev = harness.counters(0).sections.ChunkSnapshots ?? 0
    for (let t = 0; t < 900 && snapshotTicks.length < 2; t++) {
      await harness.advanceTicks(1)
      const now = harness.counters(0).sections.ChunkSnapshots ?? 0
      if (now - prev >= 1000) snapshotTicks.push(harness.hostTick())
      prev = now
    }
    expect(snapshotTicks.length).toBe(2)
    // The two resync snapshots are paid from the chunk bucket one after the other: the second
    // waits out the first's ~200-tick debt (the two reports are at most a sweep apart, < 100).
    expect((snapshotTicks[1] ?? 0) - (snapshotTicks[0] ?? 0)).toBeGreaterThan(100)
    await harness.advanceTicks(60)
    await harness.settle()
    harness.assertConverged()
    expect(harness.desyncs().length).toBe(2)
  } finally {
    await harness.dispose()
  }
})
