// `rates/*` (docs/plan/31-rates-and-integrity.md steps 3-4): chunk pacing, priority, soft cap and
// degrade, asserted through `assertBudget` against `counters.net.*` rows in `budgets.json` (each row
// names its 0010 cell or worked number). Everything runs on the virtual clock: byte counts and tick
// counts are functions of `(seed, scenario)` alone.
import { expect, test } from 'vitest'
import { MsgClass } from '../../src/server.js'
import { assertBudget } from '../../src/test/budget.js'
import { createNetHarness, type NetHarness } from '../../src/test/net-harness.js'
import { loadFixture } from '../support/fixtures.js'
import { denseWorld, putsFixture, worstSecondAfter } from './support.js'

const TICK_HZ = 20
/** The dense region: chunks (C0..C0+10) on both axes, 0010's 121-chunk maximum view (ring 1 of a
 * 9 x 9 visible rectangle), far from `fx-busy-field`'s steady field at the origin. */
const C0 = 40
const DENSE_CENTRE = (C0 + 5) * 32 + 16
/** A 256-tile view: half-extent 128, the clamp (0010). */
const MAX_VIEW = { halfW: 128, halfH: 128 }

function measure(name: string, counters: object) {
  if (process.env.MEASURE) console.log(`MEASURE ${name} ${JSON.stringify(counters)}`)
}

/** Bytes a client's enters cost on the wire: pristine coordinates plus snapshot entries. */
function enterBytes(c: { sections: Record<string, number> }): number {
  return (c.sections.ChunkEnterPristine ?? 0) + (c.sections.ChunkSnapshots ?? 0)
}

test('rates/idle-sends-only-heartbeats', async () => {
  // `fx-machines` with nothing placed changes nothing, ever (its own `idle-world-costs-zero`).
  // M31b R1: hash-all off, this test asserts the heartbeat is the only thing sent: no sections at all (hash bytes are `integrity/`'s).
  const h = await createNetHarness({
    fixture: await loadFixture('machines'),
    seed: 3101,
    clients: 1,
    hashAll: false,
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
  // M31b R1: hash-all off, this test's ceiling is a byte budget (hash bytes are `integrity/`'s).
  const h = await createNetHarness({
    fixture: await loadFixture('busy-field'),
    seed: 3102,
    clients: 1,
    hashAll: false,
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
  // M31b R1: hash-all off, this test's ceiling is a byte budget (hash bytes are `integrity/`'s).
  const h = await createNetHarness({
    fixture: await putsFixture(),
    seed: 3103,
    clients: 1,
    hashAll: false,
  })
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
    let drainedAt = -1
    let burstSpentAt = -1
    let last = h.counters(1)
    // An action sent mid-drain (bucket empty, chunks queued) is answered within a few ticks: tick
    // frames are not queued behind chunk data.
    let step = 0
    let sentAt = -1
    let answeredAt = -1
    const stopResults = joiner.onActionResult(() => {
      if (answeredAt < 0) answeredAt = step
    })
    for (let i = 1; i <= 260; i++) {
      step = i
      if (i === 40) {
        expect(h.counters(1).queuedEnters, 'the bucket is draining').toBeGreaterThan(20)
        joiner.dispatch({ Fill: { cx: 200, cy: 200 } })
        sentAt = i
      }
      await h.advanceTicks(1)
      const c = h.counters(1)
      held.push(c.heldChunks - base.heldChunks)
      if (burstSpentAt < 0 && c.bucketTokens < 3000) burstSpentAt = h.hostTick()
      if (c.bucketTokens < 3000 && c.queuedEnters > 0) {
        // The bucket is empty: tick frames and acks keep flowing (a message at least every 500 ms).
        emptyTicks++
      }
      if (drainedAt < 0 && i > 2 && c.queuedEnters === 0) drainedAt = i
      last = c
    }
    // The worst 1 s of downlink once the burst is spent: refill plus tick frames, never the ceiling.
    const worst = worstSecondAfter(h, 1, burstSpentAt)
    const result = {
      enterBytes: enterBytes(last) - enterBytes(base),
      ticksToDrain: drainedAt,
      worstSecondBytesDown: worst,
    }
    measure('joinDense', {
      ...result,
      emptyTicks,
      lateVisibleTicksMax: last.lateVisibleTicksMax,
      at81: held.findIndex((n) => n >= 81),
    })
    // Visible first: the host's own order check reads 0, and by the time 81 chunks (a 9 x 9
    // visible rectangle) have arrived at most one frame's worth of ring-1 chunks came with them.
    expect(last.orderViolations, 'a chunk went out ahead of a visible one').toBe(0)
    const at81 = held.findIndex((n) => n >= 81)
    expect(at81, 'the visible rectangle arrives before the whole ring').toBeGreaterThan(0)
    expect(held[at81] ?? 0).toBeLessThanOrEqual(81 + 12)
    // The order itself: when the last visible chunk went out (`lateVisibleTicksMax` ticks after the
    // view was set), at most one frame's worth of other chunks had gone with them. A far-first or
    // FIFO queue has sent most of the ring by then.
    const lastVisibleIdx = last.lateVisibleTicksMax
    const heldAtLastVisible = Math.max(held[lastVisibleIdx - 1] ?? 0, held[lastVisibleIdx] ?? 0)
    measure('joinDenseOrder', { lastVisibleIdx, heldAtLastVisible })
    expect(
      heldAtLastVisible,
      'ring chunks went out before the last visible one',
    ).toBeLessThanOrEqual(81 + 8)
    expect(
      last.lateVisibleTicksMax,
      'visible chunks all land within the burst plus 4 s',
    ).toBeLessThan(90)
    expect(held[held.length - 1] ?? 0).toBeGreaterThanOrEqual(121 - 9) // the 9 far chunks may have left
    expect(emptyTicks).toBeGreaterThan(50)
    stopResults()
    measure('joinDenseAction', { sentAt, answeredAt })
    expect(answeredAt, 'the mid-drain action was never answered').toBeGreaterThan(0)
    expect(
      answeredAt - sentAt,
      'ticks until the mid-drain action was answered',
    ).toBeLessThanOrEqual(3)
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
    // 4 -> 2 -> 1 is two calm dwells of 2 s each (`RECOVER_SECS`); the loop starts about half a
    // second after the stall ended. A level that stepped down without its dwell would show here.
    expect(recovered, 'recovery took less than two 2 s dwells').toBeGreaterThanOrEqual(
      2 * 2 * TICK_HZ - 10,
    )
    await h.settle()
    h.assertConverged()
  } finally {
    await h.dispose()
  }
})

test('rates/results-survive-a-bundle', async () => {
  // M33d: a client applies a bundle's frames one by one and used to keep only the last frame's
  // `ActionResults`. Two actions a tick apart ride two frames of one bundle after a stall.
  const h = await createNetHarness({ fixture: await putsFixture(), seed: 3301, clients: 1 })
  try {
    const c0 = h.clients[0]
    if (!c0) throw new Error('no client')
    c0.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    const seqs: number[] = []
    c0.onActionResult((seq) => {
      seqs.push(seq)
    })
    await h.advanceTicks(20)
    h.link(0).stall(2_600)
    await h.advanceTicks(60)
    c0.dispatch({ SetMotd: { n: 1 } })
    await h.advanceTicks(1)
    c0.dispatch({ SetMotd: { n: 2 } })
    await h.advanceTicks(80)
    await h.settle()
    expect(h.counters(0).bundles, 'the run really sent bundles').toBeGreaterThan(0)
    expect(seqs).toEqual([1, 2])
  } finally {
    await h.dispose()
  }
}, 60_000)

test('rates/degrade-on-soft-cap', async () => {
  // No stall, no lag: every frame is acked. The soft cap alone (1,000 B/s here; the busy field
  // sends several times that) drives level 2 at once and level 4 after 2 s over the cap.
  // M31b R1: hash-all off. At level 4 a frame goes out every 4th tick, so `assertConverged` passes
  // only on the tick a held frame has just gone out; hash bytes shift that phase (measured: in
  // every hash mode the replica agrees with the host on every 4th tick and no desync is reported).
  const h = await createNetHarness({
    fixture: await loadFixture('busy-field'),
    seed: 3111,
    clients: 1,
    world: { bandwidth: { softCapBytesPerS: 1_000 } },
    hashAll: false,
  })
  try {
    h.clients[0]?.setView({ x: 30, y: 14, halfW: 40, halfH: 40 })
    let first2 = -1
    let first4 = -1
    const seen: number[] = []
    for (let i = 1; i <= 8 * TICK_HZ; i++) {
      await h.advanceTicks(1)
      const level = h.counters(0).degradeLevel
      if (level > 0 && seen[seen.length - 1] !== level) seen.push(level)
      if (level >= 2 && first2 < 0) first2 = i
      if (level === 4 && first4 < 0) first4 = i
    }
    const c = h.counters(0)
    measure('softCap', { seen, first2, first4, bundles: c.bundles })
    expect(seen, 'levels 1, 2, 4 with nothing stalled').toEqual([1, 2, 4])
    expect(first2, 'level 2 as soon as a 1 s window is over the cap').toBeGreaterThan(0)
    expect(first4 - first2, 'level 4 only after 2 s over the cap').toBeGreaterThanOrEqual(
      2 * TICK_HZ - 2,
    )
    expect(first4 - first2).toBeLessThanOrEqual(2 * TICK_HZ + 2)
    expect(c.bundles, 'held frames went out concatenated').toBeGreaterThan(0)
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

test('rates/uplink-panning', async () => {
  const h = await createNetHarness({ fixture: await putsFixture(), seed: 3110, clients: 1 })
  try {
    const c0 = h.clients[0]
    if (!c0) throw new Error('no client')
    c0.setCamera({ x: 0, y: 0, tilesAcross: 60 })
    await h.advanceTicks(40)
    const before = h.counters(0)
    c0.panTo(600, 0, 120) // 5 s at 120 tiles/s
    await h.advanceTicks(5 * TICK_HZ)
    const after = h.counters(0)
    const window = {
      bytesUp: after.bytesUp - before.bytesUp,
      batches: after.messagesUp - before.messagesUp,
    }
    measure('uplinkPan', window)
    assertBudget(window, 'net.uplinkPanningBytes5s')
    await h.settle()
    h.assertConverged()
  } finally {
    await h.dispose()
  }
})

test('rates/seven-remote-presences', async () => {
  // M31b R1: hash-all off, this test's ceiling is a byte budget (hash bytes are `integrity/`'s).
  const h = await createNetHarness({
    fixture: await loadFixture('presence'),
    seed: 3111,
    clients: 8,
    hashAll: false,
  })
  try {
    const observer = 7
    h.clients[observer]?.setView({ x: 30, y: 0, halfW: 20, halfH: 20 })
    const drive = () => {
      for (let i = 0; i < 7; i++) {
        const s = h.clock.now() / 1000
        const phase = i * 0.9
        h.clients[i]?.setView({
          x: 30 + 8 * Math.sin(0.5 * s + phase),
          y: 4 * Math.sin(0.9 * s + 1 + phase),
          halfW: 10,
          halfH: 10,
          velX: 4 * Math.cos(0.5 * s + phase),
          velY: 3.6 * Math.cos(0.9 * s + 1 + phase),
        })
      }
    }
    for (let k = 0; k < 50; k++) {
      drive()
      await h.advanceTicks(1)
    }
    const before = h.counters(observer)
    for (let k = 0; k < 10 * TICK_HZ; k++) {
      drive()
      await h.advanceTicks(1)
    }
    const after = h.counters(observer)
    const window = { bytesDown: after.bytesDown - before.bytesDown }
    measure('presence7', window)
    expect(h.clients[observer]?.samplePresences().length).toBe(7)
    assertBudget(window, 'net.sevenRemotePresencesBytes10s')
  } finally {
    await h.dispose()
  }
})

async function actionRateRun(seed: number, actionRate?: { perSecond: number; burst: number }) {
  const h = await createNetHarness({
    fixture: await putsFixture(),
    seed,
    clients: 1,
    ...(actionRate ? { world: { actionRate } } : {}),
  })
  try {
    const c0 = h.clients[0]
    if (!c0) throw new Error('no client')
    c0.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await h.advanceTicks(40)
    let limited = 0
    let confirmed = 0
    c0.onActionResult((_seq, result) => {
      if (typeof result === 'object' && 'Rejected' in result && 'Engine' in result.Rejected) {
        if (result.Rejected.Engine === 'RateLimited') limited++
      } else if (result === 'Confirmed') confirmed++
    })
    // Two bursts of 32 (the client's own pending cap), one tick apart once the first is acked.
    // (An admission-time rejection is unlogged, so it does not move `ack_seq`: the client's pending
    // queue keeps it until a later accepted action is acked, and `dispatch` refuses past 32.)
    let sent = 0
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 32; i++) {
        try {
          c0.dispatch({ SetMotd: { n: round * 100 + i } })
          sent++
        } catch {
          break
        }
      }
      await h.advanceTicks(3)
    }
    await h.settle()
    const c = h.counters(0)
    h.assertConverged()
    return { rateLimited: c.rateLimited, seenByClient: limited, confirmed, sent }
  } finally {
    await h.dispose()
  }
}

test('rates/action-rate-limited', async () => {
  // The engine default (0004: 20/s, burst 40), then a smaller burst: the limit moves with the config.
  const dflt = await actionRateRun(3112)
  const tight = await actionRateRun(3113, { perSecond: 20, burst: 10 })
  measure('actionRate', { dflt, tight })
  expect(dflt.seenByClient, 'the client hears RateLimited through onActionResult').toBe(
    dflt.rateLimited,
  )
  expect(tight.seenByClient).toBe(tight.rateLimited)
  expect(tight.rateLimited).toBeGreaterThan(dflt.rateLimited)
  expect(dflt.rateLimited + dflt.confirmed, 'every action is answered once').toBe(dflt.sent)
  expect(tight.rateLimited + tight.confirmed).toBe(tight.sent)
  assertBudget({ rateLimited: dflt.rateLimited }, 'net.actionRateLimitedDefault')
  assertBudget({ rateLimited: tight.rateLimited }, 'net.actionRateLimitedBurst10')
})

test('rates/camera-flood-dropped', async () => {
  const h = await createNetHarness({ fixture: await putsFixture(), seed: 3114, clients: 1 })
  try {
    h.clients[0]?.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await h.advanceTicks(60) // the client's own reports are over and out of the 1 s window
    const before = h.counters(0)
    // 40 camera-only uplink batches in one tick, injected on the client's end of its link:
    // `[Uplink][flags = camera][last_received_tick u32][0 actions][CameraReport 16 B]`.
    const batch = new Uint8Array(1 + 1 + 4 + 1 + 16)
    const dv = new DataView(batch.buffer)
    batch[0] = 0x02
    batch[1] = 0x01
    dv.setUint32(2, h.hostTick(), true)
    dv.setInt32(7, 5, true) // centre x
    dv.setInt32(11, 5, true)
    dv.setUint16(15, 10, true)
    dv.setUint16(17, 10, true)
    for (let i = 0; i < 40; i++) h.link(0).ends[1].send(MsgClass.ReliableOrdered, batch)
    await h.advanceTicks(2)
    const after = h.counters(0)
    const window = {
      sent: 40,
      accepted: 40 - (after.cameraReportsDropped - before.cameraReportsDropped),
    }
    measure('cameraFlood', window)
    assertBudget(window, 'net.cameraReportsAcceptedPerS')
  } finally {
    await h.dispose()
  }
})
