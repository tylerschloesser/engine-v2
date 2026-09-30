// `rates/*` (docs/plan/31-rates-and-integrity.md steps 3-4): chunk pacing, priority, soft cap and
// degrade, asserted through `assertBudget` against `counters.net.*` rows in `budgets.json` (each row
// names its 0010 cell or worked number). Everything runs on the virtual clock: byte counts and tick
// counts are functions of `(seed, scenario)` alone.
import { expect, test } from 'vitest'
import { assertBudget } from '../../src/test/budget.js'
import { createNetHarness, type NetHarness } from '../../src/test/net-harness.js'
import { loadFixture } from '../support/fixtures.js'
import { putsFixture } from './support.js'

const TICK_HZ = 20
/** The dense region: chunks (C0..C0+10) on both axes, 0010's 121-chunk maximum view (ring 1 of a
 * 9 x 9 visible rectangle), far from `fx-busy-field`'s steady field at the origin. */
const C0 = 40
const DENSE_CENTRE = (C0 + 5) * 32 + 16
const FAR = -3000
/** A 256-tile view: half-extent 128, the clamp (0010). */
const MAX_VIEW = { halfW: 128, halfH: 128 }

function measure(name: string, counters: object) {
  if (process.env.MEASURE) console.log(`MEASURE ${name} ${JSON.stringify(counters)}`)
}

/** `clients` clients on `fx-busy-field`: client 0 fills the dense region with `Fill` actions and
 * every client then sits at `FAR` (nothing subscribed near the fill). */
async function denseWorld(seed: number, clients: number): Promise<NetHarness> {
  const h = await createNetHarness({
    fixture: await loadFixture('busy-field'),
    seed,
    clients,
    world: { params: { maxEntities: 40_000, maxActionGrowth: 65_536 } },
  })
  for (const c of h.clients) c.setView({ x: FAR, y: FAR, halfW: 1, halfH: 1 })
  await h.advanceTicks(5)
  const filler = h.clients[0]
  if (!filler) throw new Error('no filler')
  let n = 0
  for (let cy = C0; cy <= C0 + 10; cy++) {
    for (let cx = C0; cx <= C0 + 10; cx++) {
      filler.dispatch({ Fill: { cx, cy } })
      if (++n % 24 === 0) await h.advanceTicks(6)
    }
  }
  await h.advanceTicks(30)
  return h
}

/** Bytes a client's enters cost on the wire: pristine coordinates plus snapshot entries. */
function enterBytes(c: { sections: Record<string, number> }): number {
  return (c.sections.ChunkEnterPristine ?? 0) + (c.sections.ChunkSnapshots ?? 0)
}

test('rates/idle-sends-only-heartbeats', async () => {
  // `fx-machines` with nothing placed changes nothing, ever (its own `idle-world-costs-zero`).
  const h = await createNetHarness({
    fixture: await loadFixture('machines'),
    seed: 3101,
    clients: 1,
  })
  try {
    h.clients[0]?.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await h.advanceTicks(40)
    const before = h.counters(0)
    await h.advanceTicks(10 * TICK_HZ)
    const after = h.counters(0)
    const window = {
      bytesDown: after.bytesDown - before.bytesDown,
      frames: after.frames - before.frames,
      sectionBytes:
        Object.values(after.sections).reduce((a, b) => a + b, 0) -
        Object.values(before.sections).reduce((a, b) => a + b, 0),
    }
    measure('idle', window)
    expect(window.sectionBytes, 'no section at all: only heartbeats').toBe(0)
    assertBudget(window, 'net.idleHeartbeatBytes10s')
    expect(after.maxEmitGap).toBeLessThanOrEqual(10)
  } finally {
    await h.dispose()
  }
})

test('rates/steady-busy-field', async () => {
  const h = await createNetHarness({
    fixture: await loadFixture('busy-field'),
    seed: 3102,
    clients: 1,
  })
  try {
    // Both chunks of the 200-machine field visible.
    h.clients[0]?.setView({ x: 30, y: 14, halfW: 40, halfH: 40 })
    await h.advanceTicks(80)
    const before = h.counters(0)
    await h.advanceTicks(5 * TICK_HZ)
    const after = h.counters(0)
    const window = {
      bytesDown: after.bytesDown - before.bytesDown,
      chunkDeltas: (after.sections.ChunkDeltas ?? 0) - (before.sections.ChunkDeltas ?? 0),
      degradeLevel: after.degradeLevel,
    }
    measure('steady', window)
    assertBudget(window, 'net.steadyBusyFieldBytes5s')
    expect(after.degradeLevel, 'a steady busy field never engages degrade').toBe(1)
    h.assertConverged()
  } finally {
    await h.dispose()
  }
})

test('rates/join-wilderness', async () => {
  const h = await createNetHarness({ fixture: await putsFixture(), seed: 3103, clients: 1 })
  try {
    h.clients[0]?.setView({ x: 5000, y: 5000, ...MAX_VIEW })
    await h.advanceTicks(30)
    const c = h.counters(0)
    measure('joinWild', { ...c, perTick: undefined })
    expect(c.heldChunks).toBe(121)
    assertBudget(c, 'net.joinWildernessMaxZoomBytes')
    h.assertConverged()
  } finally {
    await h.dispose()
  }
})

test('rates/join-dense-visible-first', async () => {
  const h = await denseWorld(3104, 2)
  try {
    const joiner = h.clients[1]
    if (!joiner) throw new Error('no joiner')
    const base = h.counters(1)
    joiner.setView({ x: DENSE_CENTRE, y: DENSE_CENTRE, ...MAX_VIEW })
    const held: number[] = []
    let emptyTicks = 0
    let gapWhileEmpty = 0
    let drainedAt = -1
    let burstSpentAt = -1
    let last = h.counters(1)
    for (let i = 1; i <= 260; i++) {
      await h.advanceTicks(1)
      const c = h.counters(1)
      held.push(c.heldChunks - base.heldChunks)
      if (burstSpentAt < 0 && c.bucketTokens < 3000) burstSpentAt = h.hostTick()
      if (c.bucketTokens < 3000 && c.queuedEnters > 0) {
        // The bucket is empty: tick frames and acks keep flowing (a message at least every 500 ms).
        emptyTicks++
        gapWhileEmpty = Math.max(gapWhileEmpty, c.maxEmitGap)
      }
      if (drainedAt < 0 && i > 2 && c.queuedEnters === 0) drainedAt = i
      last = c
    }
    // The worst 1 s of downlink once the burst is spent: refill plus tick frames, never the ceiling.
    const perTick = new Map(h.counters(1).perTick.map((r) => [r.tick, r.bytesDown]))
    let worst = 0
    for (let t = burstSpentAt + 1; t + TICK_HZ <= h.hostTick(); t++) {
      let sum = 0
      for (let k = 0; k < TICK_HZ; k++) sum += perTick.get(t + k) ?? 0
      worst = Math.max(worst, sum)
    }
    const result = {
      enterBytes: enterBytes(last) - enterBytes(base),
      ticksToDrain: drainedAt,
      worstSecondBytesDown: worst,
    }
    measure('joinDense', {
      ...result,
      emptyTicks,
      gapWhileEmpty,
      lateVisibleTicksMax: last.lateVisibleTicksMax,
      at81: held.findIndex((n) => n >= 81),
    })
    // Visible first: the host's own order check reads 0, and by the time 81 chunks (a 9 x 9
    // visible rectangle) have arrived at most one frame's worth of ring-1 chunks came with them.
    expect(last.orderViolations, 'a chunk went out ahead of a visible one').toBe(0)
    const at81 = held.findIndex((n) => n >= 81)
    expect(at81, 'the visible rectangle arrives before the whole ring').toBeGreaterThan(0)
    expect(held[at81] ?? 0).toBeLessThanOrEqual(81 + 12)
    expect(
      last.lateVisibleTicksMax,
      'visible chunks all land within the burst plus 4 s',
    ).toBeLessThan(90)
    expect(held[held.length - 1] ?? 0).toBeGreaterThanOrEqual(121 - 9) // the 9 far chunks may have left
    expect(emptyTicks).toBeGreaterThan(50)
    expect(gapWhileEmpty, 'frames flow while the bucket is empty').toBeLessThanOrEqual(10)
    assertBudget(result, 'net.joinDenseMaxZoomEnterBytes')
    assertBudget(result, 'net.joinDenseMaxZoomTicks')
    assertBudget(result, 'net.hardCeilingBytesPerS')
    h.assertConverged()
  } finally {
    await h.dispose()
  }
}, 120_000)

test('rates/bucket-refill-exact', async () => {
  const h = await denseWorld(3105, 2)
  try {
    const joiner = h.clients[1]
    if (!joiner) throw new Error('no joiner')
    const start = h.counters(1)
    expect(start.bucketTokens, 'a fresh bucket is full').toBe(128_000)
    assertBudget({ bucketTokens: start.bucketTokens }, 'net.bucketBurst')
    // Spend it: join a dense view, and once the queue is empty watch the bucket refill.
    joiner.setView({ x: DENSE_CENTRE, y: DENSE_CENTRE, ...MAX_VIEW })
    for (let i = 0; i < 200; i++) {
      await h.advanceTicks(1)
      if (i > 5 && h.counters(1).queuedEnters === 0) break
    }
    expect(h.counters(1).queuedEnters).toBe(0)
    const deltas: number[] = []
    let prev = h.counters(1).bucketTokens
    expect(prev, 'the join left the bucket nearly empty').toBeLessThan(10_000)
    for (let i = 0; i < 6; i++) {
      await h.advanceTicks(1)
      const now = h.counters(1).bucketTokens
      deltas.push(now - prev)
      prev = now
    }
    measure('refill', { deltas, prev })
    for (const d of deltas) assertBudget({ refillPerTick: d }, 'net.bucketRefillBytesPerTick')
  } finally {
    await h.dispose()
  }
}, 120_000)

test('rates/degrade-on-stall', async () => {
  const h = await createNetHarness({
    fixture: await loadFixture('busy-field'),
    seed: 3106,
    clients: 1,
  })
  try {
    h.clients[0]?.setView({ x: 30, y: 14, halfW: 40, halfH: 40 })
    await h.advanceTicks(80)
    expect(h.counters(0).degradeLevel).toBe(1)
    const levels: number[] = []
    // 2.6 s, inside 0010's 0.3-3 s stalls and under the link's 3 s dead-peer timeout: uplink and
    // downlink both held.
    h.link(0).stall(2_600)
    for (let i = 0; i < 3 * TICK_HZ; i++) {
      await h.advanceTicks(1)
      levels.push(h.counters(0).degradeLevel)
    }
    const stalled = h.counters(0)
    const seen = [...new Set(levels)]
    measure('stall', { seen, bundles: stalled.bundles, gap: stalled.maxEmitGap })
    expect(seen, 'levels 1, then 2, then 4').toEqual([1, 2, 4])
    assertBudget({ maxLevel: Math.max(...levels) }, 'net.degradeMaxLevel')
    expect(stalled.bundles, 'held frames went out concatenated').toBeGreaterThan(0)
    // The stall ends: the client applies every bundled frame one by one, the level steps back
    // down (one level per calm 2 s), and the replica converges.
    let recovered = -1
    for (let i = 0; i < 12 * TICK_HZ; i++) {
      await h.advanceTicks(1)
      if (h.counters(0).degradeLevel === 1) {
        recovered = i
        break
      }
    }
    measure('recover', { recovered })
    expect(recovered, 'back to level 1 after the stall').toBeGreaterThan(0)
    await h.settle()
    h.assertConverged()
  } finally {
    await h.dispose()
  }
})

test('rates/degrade-heartbeat-held', async () => {
  // An idle world under a stall reaches level 4; the heartbeat interval (0010: a frame at least
  // every 500 ms) still holds, because a due heartbeat flushes the hold.
  const h = await createNetHarness({
    fixture: await loadFixture('machines'),
    seed: 3109,
    clients: 1,
  })
  try {
    h.clients[0]?.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await h.advanceTicks(80)
    h.link(0).stall(2_600)
    let level = 1
    for (let i = 0; i < 3 * TICK_HZ; i++) {
      await h.advanceTicks(1)
      level = Math.max(level, h.counters(0).degradeLevel)
    }
    const c = h.counters(0)
    measure('heartbeatHeld', { level, gap: c.maxEmitGap })
    expect(level).toBe(4)
    assertBudget({ maxEmitGapTicks: c.maxEmitGap }, 'net.degradeHeartbeatGapTicks')
    await h.settle()
    h.assertConverged()
  } finally {
    await h.dispose()
  }
})

test('rates/deltas-collapse-to-snapshot', async () => {
  const h = await createNetHarness({ fixture: await putsFixture(), seed: 3107, clients: 1 })
  try {
    const c0 = h.clients[0]
    if (!c0) throw new Error('no client')
    c0.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await h.advanceTicks(30)
    const before = h.counters(0)
    // Thirty adjacent tiles in one tick: their deltas (about 6 B each) outgrow the chunk's snapshot
    // (4 B a tile in one run), so the host sends the snapshot instead.
    for (let i = 0; i < 30; i++) {
      c0.dispatch({ Paint: { pos: { x: i, y: 0 }, base: 2 + (i % 5), resource: 0 } })
    }
    await h.settle()
    const after = h.counters(0)
    const window = {
      collapses: after.collapses - before.collapses,
      snapshotBytes: (after.sections.ChunkSnapshots ?? 0) - (before.sections.ChunkSnapshots ?? 0),
      deltaBytes: (after.sections.ChunkDeltas ?? 0) - (before.sections.ChunkDeltas ?? 0),
    }
    measure('collapse', window)
    assertBudget(window, 'net.collapseToSnapshotCollapses')
    expect(window.snapshotBytes, 'the chunk went out as a snapshot').toBeGreaterThan(0)
    h.assertConverged()
  } finally {
    await h.dispose()
  }
})

test('rates/teleport-drops-queued-enters', async () => {
  const h = await denseWorld(3108, 2)
  try {
    const joiner = h.clients[1]
    if (!joiner) throw new Error('no joiner')
    joiner.setView({ x: DENSE_CENTRE, y: DENSE_CENTRE, ...MAX_VIEW })
    await h.advanceTicks(30) // the burst is spent, most of the region still queued
    const mid = h.counters(1)
    expect(mid.queuedEnters).toBeGreaterThan(20)
    // Teleport into wilderness: the new view's enters are cheap and visible, so they go first, and
    // the old queue is evicted over the 128-chunk cap instead of being paid for.
    joiner.setView({ x: 20_000, y: 20_000, ...MAX_VIEW })
    await h.advanceTicks(60)
    const end = h.counters(1)
    const result = {
      capEvictions: end.capEvictions,
      queuedEnters: end.queuedEnters,
      wastedBytes: enterBytes(end) - enterBytes(mid),
    }
    measure('teleport', result)
    expect(end.queuedEnters).toBe(0)
    expect(end.capEvictions).toBeGreaterThan(0)
    assertBudget(result, 'net.teleportWastedEnterBytes')
    h.assertConverged()
  } finally {
    await h.dispose()
  }
}, 120_000)
