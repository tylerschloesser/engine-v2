// M55 (Tests): two players and an underground pair. Client 0 builds a spawner, an underground
// entrance, an exit two tiles on (a gap of two), a belt and a despawner; client 1 saturates both
// spawner lanes (iron left, coal right), under 60 ms of latency with jitter. The hidden lines (one per
// lane, `(gap + 1) x 256` with no segments) are sim state no client holds (0079 §17): an item
// vanishes at the entrance's hood on the replica and surfaces at the exit as an `Arrival` (0078 A8).
// Over 200 ticks every line either replica holds carries exactly the host's items at the replica's
// own tick, neither replica holds a hidden line while the host's hold items, each replica applied
// one `Arrival` per item that emerged at the exit by its tick, and the `Forecasts` bytes of the
// window are pinned (for M56's measurements: the cost of a saturated pair).

import {
  forecastCounters,
  hostLineItems,
  lineItems,
  lineStructures,
  serverInternals,
} from 'engine/test'
import { expect, test } from 'vitest'
import { refHarness } from '../helpers/net.js'
import {
  runScript,
  script,
  UNDERGROUND_FEED,
  UNDERGROUND_IN_AT,
  UNDERGROUND_OUT_AT,
  UNDERGROUND_STAND,
} from '../helpers/script.js'

const F = UNDERGROUND_FEED
const X = UNDERGROUND_OUT_AT
const at = (dx: number) => ({ x: X.x + dx, y: X.y })

test('reference_underground_items_emerge', async () => {
  const r = await refHarness({
    clients: 2,
    seed: 5500,
    conditions: { latencyMs: 60, jitterMs: 20 },
  })
  try {
    const [d0, d1] = r.drivers
    const [c0, c1] = r.h.clients
    if (!d0 || !d1 || !c0 || !c1) throw new Error('two clients')
    await runScript(script().panTo(UNDERGROUND_STAND), d1)
    await runScript(
      script()
        .panTo(UNDERGROUND_STAND)
        .placeBelt(F, 'East', 'Spawner')
        .placeBelt(UNDERGROUND_IN_AT, 'East', 'UndergroundIn')
        .placeBelt(X, 'East', 'UndergroundOut')
        .placeBelt(at(1), 'East')
        .placeBelt(at(2), 'East', 'Despawner'),
      d0,
    )
    // The replica's structure: the entrance's lanes lead `Next` into lines it does not hold (the
    // hidden ones); the exit's are the other two half-tile (128) lines.
    const held = lineStructures(c0)
    const ids = new Set(held.map((l) => l.id))
    const entrance = held.filter((l) => l.out.kind === 'Next' && !ids.has(l.out.line))
    const hidden = entrance.map((l) => (l.out.kind === 'Next' ? l.out.line : -1))
    const exit = held.filter((l) => l.len === 128 && !entrance.includes(l)).map((l) => l.id)
    expect([entrance.length, hidden.length, exit.length], 'entrance, hidden, exit lanes').toEqual([
      2, 2, 2,
    ])
    expect(new Set(lineStructures(c1).map((l) => l.id)), 'both replicas hold the same').toEqual(ids)

    const f0 = r.h.clients.map((c) => forecastCounters(c))
    const s0 = r.h.clients.map((_, k) => r.h.counters(k).sections.Forecasts ?? 0)
    await runScript(script().setSpawner(F, 0, 'iron').setSpawner(F, 1, 'coal'), d1)

    const inst = serverInternals(r.h.server).rawInstance
    if (!inst) throw new Error('no live sim instance')
    /** The host's items by tick: line id -> `[item, pos, ...]`; and the items emerged by tick. */
    const host = new Map<number, Map<number, number[]>>()
    const emerged = new Map<number, number>()
    let total = 0
    let hiddenHeld = 0
    const seen = [0, 0].map(() => ({ compared: 0, items: 0, ticks: new Set<number>() }))
    /** The steady half of the window (ticks 100 to 200: both lanes flowing through the pair). */
    let mid: { f: number[]; s: number[]; states: number[]; lists: number[] } | null = null
    for (let i = 0; i < 200; i++) {
      if (i === 100) {
        const f = r.h.clients.map((c) => forecastCounters(c))
        mid = {
          f: f.map((x) => x.arrivalsApplied),
          s: r.h.clients.map((_, k) => r.h.counters(k).sections.Forecasts ?? 0),
          states: f.map((x) => x.stateMessagesApplied),
          lists: f.map((x) => x.forecastsApplied),
        }
      }
      await r.h.advanceTicks(1)
      const hd = hostLineItems(inst)
      const lines = new Map(hd.lines.map((l) => [l.id, l.items]))
      host.set(hd.tick, lines)
      // An item that entered an exit lane this tick sits within one step (24) of its back (128).
      for (const id of exit) {
        const it = lines.get(id) ?? []
        for (let k = 1; k < it.length; k += 2) if ((it[k] as number) >= 128 - 24) total++
      }
      emerged.set(hd.tick, total)
      for (const id of hidden) hiddenHeld = Math.max(hiddenHeld, (lines.get(id)?.length ?? 0) / 2)
      for (const [k, c] of r.h.clients.entries()) {
        const s = seen[k]
        if (!s) continue
        for (const id of hidden) expect(lineItems(c, id), `client ${k}: hidden ${id}`).toBeNull()
        for (const id of host.get(hd.tick)?.keys() ?? []) {
          const cd = lineItems(c, id)
          if (cd === null) continue
          const want = host.get(cd.tick)?.get(id)
          const got = cd.lines[0]
          if (want === undefined || !got || got.unknown) continue
          expect(got.items, `client ${k}: tick ${cd.tick}: line ${id}`).toEqual(want)
          s.compared++
          s.items += want.length / 2
          s.ticks.add(cd.tick)
        }
      }
    }
    const f1 = r.h.clients.map((c) => forecastCounters(c))
    const arrivals = f1.map((f, k) => f.arrivalsApplied - (f0[k]?.arrivalsApplied ?? 0))
    const reached = r.h.clients.map((c) => lineItems(c, exit[0] as number)?.tick ?? -1)
    const bytes = r.h.clients.map(
      (_, k) => (r.h.counters(k).sections.Forecasts ?? 0) - (s0[k] ?? 0),
    )
    const steady = r.h.clients.map((_, k) => ({
      arrivals: (f1[k]?.arrivalsApplied ?? 0) - (mid?.f[k] ?? 0),
      bytes: (r.h.counters(k).sections.Forecasts ?? 0) - (mid?.s[k] ?? 0),
      states: (f1[k]?.stateMessagesApplied ?? 0) - (mid?.states[k] ?? 0),
      lists: (f1[k]?.forecastsApplied ?? 0) - (mid?.lists[k] ?? 0),
    }))
    // Measured (the same twice), exact on the virtual clock. The host's hidden lanes held up to 12
    // items (768 positions at the saturation spacing). Each replica reached host tick 311 and
    // applied 115 `Arrival`s, the items emerged at the exit by then (117 by the host's last tick).
    expect(hiddenHeld, 'the host held items underground').toBe(12)
    expect([total, reached], 'items emerged by the host, ticks reached').toEqual([117, [311, 311]])
    for (const [k, t] of reached.entries()) {
      expect(arrivals[k], `client ${k}: one Arrival per item emerged by its tick ${t}`).toBe(
        emerged.get(t),
      )
    }
    // The steady half (both lanes saturated, items flowing through): 74 arrivals in 100 ticks (14.8 items a
    // second against the two lanes' 15), 740 `Forecasts` bytes and nothing else in that section (no
    // State, no list): 10 bytes an `Arrival`, 148 B/s per saturated pair (0.9 % of 0010's 16 KB/s
    // soft cap; M56 measures). The whole window, the configuring lists included, is 1,206 bytes.
    const want = { arrivals: 74, bytes: 740, states: 0, lists: 0 }
    expect(steady, 'the steady half per client').toEqual([want, want])
    expect(bytes, 'Forecasts bytes in the window').toEqual([1206, 1206])
    const compared = [199, 1592, 4992]
    expect(
      seen.map((s) => [s.ticks.size, s.compared, s.items]),
      'ticks, (line, tick) pairs and items compared per client',
    ).toEqual([compared, compared])
    // 13 lists and 6 States (the edits and the configuring), 115 arrivals, no late or unknown list.
    const counters = {
      forecastsApplied: 13,
      stateMessagesApplied: 6,
      arrivalsApplied: 115,
      forecastSeenLate: 0,
      corrections: 11,
      listsUnknown: 0,
      recordsUnheld: 0,
    }
    expect(f1, 'forecast counters per client').toEqual([counters, counters])
    await r.h.settle()
    r.h.assertConverged()
  } finally {
    await r.dispose()
  }
}, 60_000)
