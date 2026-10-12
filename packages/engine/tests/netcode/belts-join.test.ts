// `belts/join_at_scale @slow` and `belts/saturated_view_paced_bytes @slow` (M48b, docs/decisions/
// 0078 Consequences, 0079 §19 (e)): transport replication under the production chunk pacing
// (0010: a 48 KB/s chunk bucket with a 128 KB burst, the 16 KB/s soft cap and its degrade, delta
// collapse into snapshots). M47b lifted the pacing to measure sections 12 and 13 alone
// (`beltsBenchWorld`); these two keep it.
import { expect, test } from 'vitest'
import { forecastCounters, lineItems } from '../../src/test/lines.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { BENCH_CAPS, type BeltsRegime, beltsBenchWorld, beltsFixture, measure } from './support.js'

// Per-test timeouts (M47b's reason, `belts-forecast.test.ts`): CI's runner is 5-10x slower.
const SLOW_TIMEOUT_MS = 180_000

const TICK_HZ = 20
/** The `Mixed` world's line ids are 1..=3,810. */
const MAX_ID = 3_810

/** What one join of the 256 x 144 view at the densest window measured. */
async function join(
  regime: BeltsRegime,
  paced: boolean,
  seed: number,
  hashMode: 'production' | 'all',
) {
  // M45's full `Mixed` world (seed 7: 3,810 lines, 220 x 545 tiles; M48c: or `MixedFeeders`, the
  // same lines and items at rest fed by stateless feeders), a client joining with the 256 x 144
  // view at M46's densest window (centre tile (96, 224)).
  const h = await createNetHarness({
    fixture: await beltsFixture(),
    seed,
    clients: 1,
    world: { ...beltsBenchWorld(regime, 1, BENCH_CAPS, paced), debugHashMode: hashMode },
  })
  try {
    const client = h.clients[0]
    if (!client) throw new Error('one client')
    client.setView({ x: 96, y: 224, halfW: 128, halfH: 72 })
    const heldIds = () => {
      const ids: number[] = []
      for (let id = 1; id <= MAX_ID; id++) if (lineItems(client, id) !== null) ids.push(id)
      return ids
    }
    // Fully held: no enter queued, every chunk of the view revealed, and over the last second no
    // list applied and no line newly held (checked each second). The join's time is the tick the
    // last list landed; the bytes and counters are read at that tick, on the delivery clock (the
    // harness counts a message when the client receives it, so a frame built before the cutoff
    // and held by degrade counts only once delivered).
    let tick = 0
    let lists = 0
    let prevHeld = -1
    let cut = { tick: 0, c: h.counters(0) }
    const checks: { tick: number; held: number; queued: number; level: number }[] = []
    for (;;) {
      await h.advanceTicks(1)
      tick++
      const n = forecastCounters(client).forecastsApplied
      if (n !== lists) {
        lists = n
        cut = { tick, c: h.counters(0) }
      }
      if (tick % TICK_HZ === 0) {
        const c = h.counters(0)
        const now = heldIds().length
        checks.push({ tick, held: now, queued: c.queuedEnters, level: c.degradeLevel })
        const quiet = tick - cut.tick >= TICK_HZ
        if (quiet && now === prevHeld && c.queuedEnters === 0 && client.status().revealed) break
        prevHeld = now
      }
      if (tick > 120 * TICK_HZ)
        throw new Error(`no settled join in 120 s: ${JSON.stringify(checks)}`)
    }
    const ids = heldIds()
    const unknownHeld = ids.filter((id) => lineItems(client, id)?.lines[0]?.unknown).length
    const c = cut.c
    let framed = c.header
    for (const v of Object.values(c.sections)) framed += v
    const m = {
      joinTicks: cut.tick,
      held: ids.length,
      lists,
      listsUnknown: forecastCounters(client).listsUnknown,
      /** A put the replica could not hold leaves its list for an unheld line (`follow.rs`). */
      recordsUnheld: forecastCounters(client).recordsUnheld,
      unknownHeld,
      bytesDown: c.bytesDown,
      sections: c.sections,
      /** Frame headers (10 B a frame). */
      header: c.header,
      /** `bytesDown` less every frame's sections and header: the `Welcome` and bundle framing. */
      other: c.bytesDown - framed,
      frames: c.frames,
      heldChunks: c.heldChunks,
      collapses: c.collapses,
      bundles: c.bundles,
      level: c.degradeLevel,
    }
    // A put the replica dropped reports a chunk desync against its anchor (`client/core.rs`);
    // under hash-all every held chunk's hash also covers its anchored structures, so a line
    // anchored in a held chunk and missing on the client mismatches.
    return { m, checks, ids, desyncs: h.desyncs() }
  } finally {
    await h.dispose()
  }
}

/** One cell of `join_at_scale`: the paced join and its lifted reference, checked and pinned. */
async function cell(regime: BeltsRegime, pins: JoinPins) {
  const paced = await join(regime, true, 4821, 'production')
  // The reference set: the same view joined with the chunk pacing lifted (every enter in the
  // first frames, M47b's measuring setup). The engine exposes no host-side query of which lines
  // meet a view (an ABI addition, out of M48b's scope), so the lifted join stands in. Hash-all
  // there: the independent check that every line anchored in a held chunk is held.
  const lifted = await join(regime, false, 4821, 'all')
  if (process.env.MEASURE) {
    console.log(
      `MEASURE join ${JSON.stringify({ regime, paced: paced.m, checks: paced.checks, lifted: lifted.m })}`,
    )
  }
  const label = JSON.stringify(regime)
  expect(lifted.desyncs, `${label}: lifted join, hash-all: no chunk desync`).toEqual([])
  expect(paced.desyncs, `${label}: paced join: no chunk desync`).toEqual([])
  expect(paced.ids, `${label}: the held set equals the lifted join's`).toEqual(lifted.ids)
  // M48c: a snapshot re-puts only what the client lacks, so no held line's list goes twice.
  expect(paced.m.lists, `${label}: lists applied, one per line held`).toBe(paced.m.held)
  expect(paced.m, `${label}: the join, measured`).toEqual(pins.paced)
  expect(paced.checks, `${label}: each second: lines held, enters queued, degrade level`).toEqual(
    pins.checks,
  )
  expect(lifted.m, `${label}: the lifted join`).toEqual(pins.lifted)
}

type JoinPins = {
  paced: Awaited<ReturnType<typeof join>>['m']
  checks: Awaited<ReturnType<typeof join>>['checks']
  lifted: Awaited<ReturnType<typeof join>>['m']
}

test(
  'belts/join_at_scale @slow',
  async () => {
    await cell('Mixed', { paced: JOIN_PINS, checks: JOIN_CHECKS, lifted: LIFTED_PINS })
    await cell('MixedFeeders', {
      paced: FEEDERS_PINS,
      checks: FEEDERS_CHECKS,
      lifted: FEEDERS_LIFTED_PINS,
    })
  },
  SLOW_TIMEOUT_MS,
)

/** `join_at_scale`'s `Mixed` figures (seed 4821), pinned: a moved pin is a finding. M48b read 377
 * ticks (18.85 s) and 2,915,247 B with 2,724 lists for 1,850 lines; M48c's snapshot re-puts only
 * what the client lacks (and the bucket prices only that): 139 ticks (6.95 s), one list per line.
 * The spawners' chunk deltas are still a third of the bytes (`MixedFeeders` below has none). */
const JOIN_PINS = {
  joinTicks: 139,
  held: 1_850,
  lists: 1_850,
  listsUnknown: 0,
  recordsUnheld: 0,
  unknownHeld: 0,
  bytesDown: 1_467_333,
  sections: {
    Global: 39,
    OwnPlayer: 3,
    ChunkSnapshots: 13_743,
    LineStructs: 64_761,
    Forecasts: 912_145,
    ChunkDeltas: 474_328,
    Hashes: 428,
    ChunkEnterPristine: 76,
  },
  header: 1_370,
  other: 440,
  frames: 137,
  heldChunks: 88,
  collapses: 64,
  bundles: 44,
  level: 4,
}
/** Each second of the paced join: lines held, enters queued, degrade level. */
const JOIN_CHECKS = [
  { tick: 20, held: 445, queued: 72, level: 2 },
  { tick: 40, held: 906, queued: 62, level: 2 },
  { tick: 60, held: 1_076, queued: 56, level: 4 },
  { tick: 80, held: 1_228, queued: 52, level: 4 },
  { tick: 100, held: 1_453, queued: 33, level: 4 },
  { tick: 120, held: 1_664, queued: 26, level: 4 },
  { tick: 140, held: 1_850, queued: 0, level: 4 },
  { tick: 160, held: 1_850, queued: 0, level: 4 },
]
/** The lifted join (the reference set's run, hash-all), pinned too. */
const LIFTED_PINS = {
  joinTicks: 63,
  held: 1_850,
  lists: 1_850,
  listsUnknown: 0,
  recordsUnheld: 0,
  unknownHeld: 0,
  bytesDown: 1_240_541,
  sections: {
    Global: 39,
    OwnPlayer: 3,
    Hashes: 2_189,
    ChunkSnapshots: 7_765,
    LineStructs: 64_732,
    Forecasts: 907_346,
    ChunkDeltas: 257_741,
    ChunkEnterPristine: 74,
  },
  header: 610,
  other: 42,
  frames: 61,
  heldChunks: 88,
  collapses: 0,
  bundles: 0,
  level: 1,
}

/** M48c: the `MixedFeeders` cell (seed 4821), the same lines and items at rest fed by stateless
 * feeders (0079 §19 (e)): no chunk delta, no collapse; 126 ticks (6.30 s), 949,162 B. M49 (0078 A12
 * revised): a line holder gets a frame every tick, header-only when nothing changed, so 18 more
 * frames (89 before: 180 B of headers, 30 B of bundle framing, 15 B of hashes) and 4 more bundles;
 * the join settles a tick sooner (127 ticks, 948,754 B before). Fix rounds 2-3: a hold keeps the
 * latest header-only frame (replacing the header-only one held before it) instead of dropping it,
 * and holds a hashes-only frame whole: 123 frames, 39 bundles, hashes 391 B (339 when round 2 let
 * hashes-only frames be replaced too), 949,162 B. */
const FEEDERS_PINS = {
  joinTicks: 126,
  held: 1_850,
  lists: 1_850,
  listsUnknown: 0,
  recordsUnheld: 0,
  unknownHeld: 0,
  bytesDown: 949_162,
  sections: {
    Global: 39,
    OwnPlayer: 3,
    ChunkSnapshots: 5_489,
    LineStructs: 64_751,
    Forecasts: 876_849,
    Hashes: 391,
    ChunkEnterPristine: 76,
  },
  header: 1_230,
  other: 334,
  frames: 123,
  heldChunks: 88,
  collapses: 0,
  bundles: 39,
  level: 4,
}
/** Each second of the paced `MixedFeeders` join. */
const FEEDERS_CHECKS: JoinPins['checks'] = [
  { tick: 20, held: 448, queued: 71, level: 2 },
  { tick: 40, held: 910, queued: 62, level: 2 },
  { tick: 60, held: 1_076, queued: 56, level: 4 },
  { tick: 80, held: 1_286, queued: 42, level: 4 },
  { tick: 100, held: 1_562, queued: 28, level: 4 },
  { tick: 120, held: 1_791, queued: 22, level: 4 },
  { tick: 140, held: 1_850, queued: 0, level: 4 },
  { tick: 160, held: 1_850, queued: 0, level: 4 },
]
/** The lifted `MixedFeeders` join (hash-all). */
const FEEDERS_LIFTED_PINS = {
  joinTicks: 61,
  held: 1_850,
  lists: 1_850,
  listsUnknown: 0,
  recordsUnheld: 0,
  unknownHeld: 0,
  bytesDown: 958_055,
  sections: {
    Global: 39,
    OwnPlayer: 3,
    Hashes: 2_149,
    ChunkSnapshots: 5_464,
    LineStructs: 64_726,
    Forecasts: 884_968,
    ChunkEnterPristine: 74,
  },
  header: 590,
  other: 42,
  frames: 59,
  heldChunks: 88,
  collapses: 0,
  bundles: 0,
  level: 1,
}

// M47b's gated cell, (20 %, 100), seed 4721, with the default caps (0079 §19 (e)): `measure()`'s window
// starts once the join has settled with no enter queued. Pinned whole; recorded in the source of
// `counters.transport.downBytesPerSec` (its gate stays the lifted cell).
test(
  'belts/saturated_view_paced_bytes @slow',
  async () => {
    const m = await measure(
      { SaturatedView: { jam_pct: 20, period: 100 } },
      4721,
      undefined,
      undefined,
      true,
    )
    if (process.env.MEASURE) console.log(`MEASURE paced (20, 100) ${JSON.stringify(m)}`)
    expect(m, 'the paced cell (the row source records it)').toEqual(PACED_PINS)
  },
  SLOW_TIMEOUT_MS,
)

/** `saturated_view_paced_bytes`' window (seed 4721), pinned: a moved pin is a finding. M48c: the
 * join settles at 456 ticks (790 under M48b's forced re-put of every anchored line); the bytes
 * are the same, items and runs are a later 20 s of world time (294,877 and 150,950 before). */
const PACED_PINS = {
  joinTicks: 456,
  held: 2_974,
  items: 294_869,
  runs: 150_959,
  transportDownBytesPerSec: 3_958,
  structsBytes: 51_072,
  forecastsBytes: 28_084,
  frames: 400,
  states: 4_576,
  lists: 0,
  lateLists: 0,
  arrivals: 0,
  forecastSeenLate: 0,
  correctionsPerRunPerSec: 4_576 / 150_959 / 20,
  correctionsPerSec: 228.8,
  unknown: 0,
  degradeLevel: 4,
  collapses: 0,
  bundles: 100,
}
