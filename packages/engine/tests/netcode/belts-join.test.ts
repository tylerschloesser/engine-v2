// `belts/join_at_scale @slow` and `belts/saturated_view_paced_bytes @slow` (M48b, docs/decisions/
// 0078 Consequences, 0079 §19 (e)): transport replication under the production chunk pacing
// (0010: a 48 KB/s chunk bucket with a 128 KB burst, the 16 KB/s soft cap and its degrade, delta
// collapse into snapshots). M47b lifted the pacing to measure sections 12 and 13 alone
// (`beltsBenchWorld`); these two keep it.
import { expect, test } from 'vitest'
import { forecastCounters, lineItems } from '../../src/test/lines.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { BENCH_CAPS, beltsBenchWorld, beltsFixture, measure } from './support.js'

// Per-test timeouts (M47b's reason, `belts-forecast.test.ts`): CI's runner is 5-10x slower.
const SLOW_TIMEOUT_MS = 180_000

const TICK_HZ = 20
/** The `Mixed` world's line ids are 1..=3,810. */
const MAX_ID = 3_810

/** What one join of the 256 x 144 view at the densest window measured. */
async function join(paced: boolean, seed: number, hashMode: 'production' | 'all') {
  // M45's full `Mixed` world (seed 7: 3,810 lines, 220 x 545 tiles), a client joining with the
  // 256 x 144 view at M46's densest window (centre tile (96, 224)).
  const h = await createNetHarness({
    fixture: await beltsFixture(),
    seed,
    clients: 1,
    world: { ...beltsBenchWorld('Mixed', 1, BENCH_CAPS, paced), debugHashMode: hashMode },
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

test(
  'belts/join_at_scale @slow',
  async () => {
    const paced = await join(true, 4821, 'production')
    // The reference set: the same view joined with the chunk pacing lifted (every enter in the
    // first frames, M47b's measuring setup). The engine exposes no host-side query of which lines
    // meet a view (an ABI addition, out of this milestone's scope), so the lifted join stands in.
    // Hash-all there: the independent check that every line anchored in a held chunk is held.
    const lifted = await join(false, 4821, 'all')
    if (process.env.MEASURE) {
      console.log(
        `MEASURE join ${JSON.stringify({ paced: paced.m, checks: paced.checks, lifted: lifted.m })}`,
      )
    }
    expect(lifted.desyncs, 'lifted join, hash-all: no chunk desync').toEqual([])
    expect(paced.desyncs, 'paced join: no chunk desync').toEqual([])
    expect(paced.ids, "the held set equals the lifted join's").toEqual(lifted.ids)
    expect(paced.m, 'the join, measured').toEqual(JOIN_PINS)
    expect(paced.checks, 'each second: lines held, enters queued, degrade level').toEqual(
      JOIN_CHECKS,
    )
    expect(lifted.m, 'the lifted join').toEqual(LIFTED_PINS)
  },
  SLOW_TIMEOUT_MS,
)

/** `join_at_scale`'s figures (seed 4821), pinned: a moved pin is a finding. 18.85 s of virtual time,
 * over 0078's 10 s: recorded for the manager (M48b Deviations), not acted on here. */
const JOIN_PINS = {
  joinTicks: 377,
  held: 1850,
  lists: 2724,
  listsUnknown: 0,
  recordsUnheld: 0,
  unknownHeld: 0,
  bytesDown: 2_915_247,
  sections: {
    Global: 39,
    OwnPlayer: 3,
    ChunkSnapshots: 24_195,
    LineStructs: 95_625,
    Forecasts: 1_477_699,
    ChunkDeltas: 1_311_511,
    Hashes: 1261,
    ChunkEnterPristine: 76,
  },
  header: 3750,
  other: 1088,
  frames: 375,
  heldChunks: 88,
  collapses: 177,
  bundles: 113,
  level: 4,
}
/** Each second of the paced join: lines held, enters queued, degrade level. */
const JOIN_CHECKS = [
  { tick: 20, held: 408, queued: 75, level: 2 },
  { tick: 40, held: 552, queued: 74, level: 2 },
  { tick: 60, held: 682, queued: 70, level: 4 },
  { tick: 80, held: 789, queued: 66, level: 4 },
  { tick: 100, held: 910, queued: 63, level: 4 },
  { tick: 120, held: 945, queued: 61, level: 4 },
  { tick: 140, held: 1_018, queued: 59, level: 4 },
  { tick: 160, held: 1_076, queued: 56, level: 4 },
  { tick: 180, held: 1_112, queued: 55, level: 4 },
  { tick: 200, held: 1_192, queued: 52, level: 4 },
  { tick: 220, held: 1_228, queued: 50, level: 4 },
  { tick: 240, held: 1_286, queued: 44, level: 4 },
  { tick: 260, held: 1_336, queued: 35, level: 4 },
  { tick: 280, held: 1_454, queued: 33, level: 4 },
  { tick: 300, held: 1_590, queued: 29, level: 4 },
  { tick: 320, held: 1_664, queued: 26, level: 4 },
  { tick: 340, held: 1_724, queued: 24, level: 4 },
  { tick: 360, held: 1_804, queued: 22, level: 4 },
  { tick: 380, held: 1_850, queued: 3, level: 4 },
  { tick: 400, held: 1_850, queued: 0, level: 4 },
]
/** The lifted join (the reference set's run, hash-all), pinned too. */
const LIFTED_PINS = {
  joinTicks: 78,
  held: 1850,
  lists: 2253,
  listsUnknown: 0,
  recordsUnheld: 0,
  unknownHeld: 0,
  bytesDown: 1_557_474,
  sections: {
    Global: 39,
    OwnPlayer: 3,
    ChunkSnapshots: 7785,
    LineStructs: 78_989,
    Forecasts: 1_146_521,
    ChunkDeltas: 320_770,
    ChunkEnterPristine: 76,
    Hashes: 2_489,
  },
  header: 760,
  other: 42,
  frames: 76,
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

/** `saturated_view_paced_bytes`' window (seed 4721), pinned: a moved pin is a finding. */
const PACED_PINS = {
  joinTicks: 790,
  held: 2_974,
  items: 294_877,
  runs: 150_950,
  transportDownBytesPerSec: 3_958,
  structsBytes: 51_072,
  forecastsBytes: 28_084,
  frames: 400,
  states: 4_576,
  lists: 0,
  lateLists: 0,
  arrivals: 0,
  forecastSeenLate: 0,
  correctionsPerRunPerSec: 4_576 / 150_950 / 20,
  correctionsPerSec: 228.8,
  unknown: 0,
  degradeLevel: 4,
  collapses: 0,
  bundles: 100,
}
