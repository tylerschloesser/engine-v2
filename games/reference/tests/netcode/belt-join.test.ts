// `reference_join_at_scale @slow` (M57; 0078 Consequences' late-join criterion, A10-A11): the
// reference world at scale. Client 0 builds the bench page's belt field (`LAYOUTS['bench-field']`,
// 48 saturated runs over the 256 x 144 view, 12,264 placements; `sim/src/bench.rs` writes the same
// field at genesis for `?bench=belts`) with `buildPaced` at a raised action rate, on a flat
// `world.json` world (no resource, no water: every tile buildable) with `world.json`'s caps; its 96
// spawner lanes run saturated for 400 ticks; then one client joins with the 256 x 144 view over the
// field at the default pacing (0010: the 48 KB/s chunk bucket, the 16 KB/s soft cap and its degrade).
// The `belts-join.test.ts` measurement (`packages/engine/tests/netcode`): joined = no enter queued,
// the view revealed, no list applied and no line newly held for 1 s; the join's time is the tick the
// last list landed; the bytes by section on the delivery clock up to that tick; the degrade level.
// Unlike the fixture's, the reference game's belts are entities: every one rides `ChunkSnapshots`
// through the chunk bucket. A lifted join (pacing out of reach, hash-all) is the reference set: the
// held lines equal, no desync. Pinned exact on the virtual clock.

import {
  forecastCounters,
  type HeadlessClient,
  hostLineItems,
  lineItems,
  type NetHarness,
  serverInternals,
} from 'engine/test'
import { expect, test } from 'vitest'
import { buildPaced, LAYOUTS, layoutActions, parseLayout } from '../helpers/layout.js'
import { refHarness } from '../helpers/net.js'

const TICK_HZ = 20
/** The field's top-left: the origin, as the bench page's. */
const AT = { x: 0, y: 0 }
/** Run k's spawner makes `FEED[k % 4]` (`bench.rs`'s `FEED`: iron, coal, wood, stone). */
const FEED = Array.from({ length: 48 }, (_, k) => [1, 3, 2, 0][k % 4] as number)
/** `world.json`'s worldgen with no resource and no water (the noise's height is within [-1, 1]). */
const FLAT = {
  iron_density: 0,
  wood_density: 0,
  stone_density: 0,
  coal_density: 0,
  deep_water_level: -2,
  water_level: -2,
}
/** 32 actions a tick: the client's pending queue (32) is then the bound. */
const BUILD_RATE = { perSecond: 640, burst: 640 }
const FLOW_TICKS = 400
/** The field full (it fills in about 2,800 ticks: 98,2xx items, `bench_belts.rs`). */
const FULL_TICKS = 3_000
const LIFTED = 1_000_000_000

/** The host's lines `client`'s replica holds. `client_line_items` answers `NotCached` for a line it
 * does not hold; a held full line (2,048 items) overflows the dump's Tx region, which still says it
 * is held (the status is checked after `NotCached`, `lines.ts`). */
function heldIds(client: HeadlessClient, ids: number[]): number[] {
  return ids.filter((id) => {
    try {
      return lineItems(client, id) !== null
    } catch (e) {
      if (e instanceof Error && e.message.endsWith('Tx too small')) return true
      throw e
    }
  })
}

async function join(seed: number, paced: boolean, flowTicks: number) {
  const r = await refHarness({
    clients: 1,
    seed,
    world: {
      params: { worldgen: FLAT },
      actionRate: BUILD_RATE,
      debugHashMode: paced ? 'production' : 'all',
      ...(paced
        ? {}
        : {
            bandwidth: {
              softCapBytesPerS: LIFTED,
              chunkRefillBytesPerS: LIFTED,
              chunkBurstBytes: LIFTED,
              hardCapBytesPerS: LIFTED,
            },
          }),
    },
  })
  try {
    const h: NetHarness = r.h
    const builder = h.clients[0]
    if (!builder) throw new Error('client 0')
    const layout = parseLayout(LAYOUTS['bench-field'])
    const built = await buildPaced(
      builder,
      (n) => h.advanceTicks(n),
      layoutActions(layout, AT, FEED),
      BUILD_RATE,
    )
    // The host's line ids, read before the flow fills the dump past the Tx region (the field's
    // lines never change after the build).
    const inst = serverInternals(h.server).rawInstance
    if (!inst) throw new Error('no live sim instance')
    const hostIds = hostLineItems(inst).lines.map((l) => l.id)
    await h.advanceTicks(flowTicks)
    const client = h.addClient()
    client.setView({ x: AT.x + 128, y: AT.y + 72, halfW: 128, halfH: 72 })
    let tick = 0
    let lists = 0
    let prevHeld = -1
    let cut = { tick: 0, c: h.counters(1) }
    const checks: { tick: number; held: number; queued: number; level: number }[] = []
    for (;;) {
      await h.advanceTicks(1)
      tick++
      const n = forecastCounters(client).forecastsApplied
      if (n !== lists) {
        lists = n
        cut = { tick, c: h.counters(1) }
      }
      if (tick % TICK_HZ === 0) {
        const c = h.counters(1)
        const now = heldIds(client, hostIds).length
        checks.push({ tick, held: now, queued: c.queuedEnters, level: c.degradeLevel })
        const quiet = tick - cut.tick >= TICK_HZ
        if (quiet && now === prevHeld && c.queuedEnters === 0 && client.status().revealed) break
        prevHeld = now
      }
      if (tick > 120 * TICK_HZ)
        throw new Error(`no settled join in 120 s: ${JSON.stringify(checks)}`)
    }
    const ids = heldIds(client, hostIds)
    const c = cut.c
    let framed = c.header
    for (const v of Object.values(c.sections)) framed += v
    const m = {
      joinTicks: cut.tick,
      held: ids.length,
      lists,
      listsUnknown: forecastCounters(client).listsUnknown,
      recordsUnheld: forecastCounters(client).recordsUnheld,
      bytesDown: c.bytesDown,
      sections: c.sections,
      header: c.header,
      other: c.bytesDown - framed,
      frames: c.frames,
      heldChunks: c.heldChunks,
      collapses: c.collapses,
      bundles: c.bundles,
      level: c.degradeLevel,
    }
    return {
      build: {
        ticks: built.ticks,
        actions: layout.placements.length + 96,
        hostLines: hostIds.length,
      },
      m,
      checks,
      ids,
      desyncs: h.desyncs(),
    }
  } finally {
    await r.dispose()
  }
}

test('reference_join_at_scale @slow', async () => {
  for (const [flow, pins] of [
    [FLOW_TICKS, PINS_400],
    [FULL_TICKS, PINS_FULL],
  ] as const) {
    const paced = await join(5700, true, flow)
    const lifted = await join(5700, false, flow)
    expect(lifted.desyncs, `${flow}: lifted join, hash-all: no chunk desync`).toEqual([])
    expect(paced.desyncs, `${flow}: paced join: no chunk desync`).toEqual([])
    expect(paced.ids, `${flow}: the held set equals the lifted join's`).toEqual(lifted.ids)
    expect(paced.m.lists, `${flow}: lists applied, one per line held`).toBe(paced.m.held)
    expect(paced.build, `${flow}: the paced build`).toEqual(pins.build)
    expect(paced.m, `${flow}: the join, measured`).toEqual(pins.paced)
    expect(paced.checks, `${flow}: each second: lines held, enters queued, degrade level`).toEqual(
      pins.checks,
    )
    expect(lifted.m, `${flow}: the lifted join`).toEqual(pins.lifted)
  }
}, 900_000)

/** After 400 ticks of flow (items on each run's first 37 tiles, about 14,400 of them). The build: 12,360
 * actions (12,264 placements, 96 spawner lanes) in 1,161 ticks at 32 a tick (the pending queue's
 * bound), 348 host lines, 336 replicated (the 12 hidden lines of the 6 underground pairs never are).
 * The join: 19 ticks (0.95 s) and 174,064 B, against 0078's 10 s for this view (the fixture's
 * `Mixed` world: 137 ticks, 986,734 B). `ChunkSnapshots` is 87 % of it: 151,203 B for the 12,264
 * belt entities of 77 held chunks (12.3 B a belt entity, the entities and their chunks' framing),
 * through the 48 KB/s chunk bucket's 128 KB burst; the degrade level stays 1. */
const PINS_400 = {
  build: {
    ticks: 1161,
    actions: 12_360,
    hostLines: 348,
  },
  paced: {
    joinTicks: 19,
    held: 336,
    lists: 336,
    listsUnknown: 0,
    recordsUnheld: 0,
    bytesDown: 174_064,
    sections: {
      Global: 24,
      OwnPlayer: 13,
      ChunkSnapshots: 151_203,
      Presence: 10,
      Hashes: 65,
      LineStructs: 11_763,
      Forecasts: 10_641,
      ChunkEnterPristine: 84,
    },
    header: 170,
    other: 91,
    frames: 17,
    heldChunks: 77,
    collapses: 0,
    bundles: 0,
    level: 1,
  },
  checks: [
    {
      tick: 20,
      held: 336,
      queued: 0,
      level: 1,
    },
    {
      tick: 40,
      held: 336,
      queued: 0,
      level: 1,
    },
  ],
  lifted: {
    joinTicks: 9,
    held: 336,
    lists: 336,
    listsUnknown: 0,
    recordsUnheld: 0,
    bytesDown: 173_764,
    sections: {
      Global: 24,
      OwnPlayer: 13,
      Hashes: 2202,
      ChunkSnapshots: 151_188,
      Presence: 10,
      LineStructs: 11_751,
      Forecasts: 8337,
      ChunkEnterPristine: 78,
    },
    header: 70,
    other: 91,
    frames: 7,
    heldChunks: 77,
    collapses: 0,
    bundles: 0,
    level: 1,
  },
}

/** The field full (3,000 ticks: 98,2xx items, `bench_belts.rs`): a saturated lane is one run in its
 * list, so `Forecasts` grows only to 16,820 B; 20 ticks (1.0 s), 180,256 B. */
const PINS_FULL = {
  build: {
    ticks: 1161,
    actions: 12_360,
    hostLines: 348,
  },
  paced: {
    joinTicks: 20,
    held: 336,
    lists: 336,
    listsUnknown: 0,
    recordsUnheld: 0,
    bytesDown: 180_256,
    sections: {
      Global: 24,
      OwnPlayer: 13,
      ChunkSnapshots: 151_206,
      Presence: 10,
      Hashes: 65,
      LineStructs: 11_763,
      Forecasts: 16_820,
      ChunkEnterPristine: 84,
    },
    header: 180,
    other: 91,
    frames: 18,
    heldChunks: 77,
    collapses: 0,
    bundles: 0,
    level: 1,
  },
  checks: [
    {
      tick: 20,
      held: 336,
      queued: 0,
      level: 1,
    },
    {
      tick: 40,
      held: 336,
      queued: 0,
      level: 1,
    },
  ],
  lifted: {
    joinTicks: 9,
    held: 336,
    lists: 336,
    listsUnknown: 0,
    recordsUnheld: 0,
    bytesDown: 178_211,
    sections: {
      Global: 24,
      OwnPlayer: 13,
      Hashes: 2202,
      ChunkSnapshots: 151_188,
      Presence: 10,
      LineStructs: 11_751,
      Forecasts: 12_784,
      ChunkEnterPristine: 78,
    },
    header: 70,
    other: 91,
    frames: 7,
    heldChunks: 77,
    collapses: 0,
    bundles: 0,
    level: 1,
  },
}
