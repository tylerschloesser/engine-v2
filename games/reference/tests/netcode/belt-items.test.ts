// M53b (Tests): two players and items. Client 0 builds a spawner, three belts and a despawner;
// client 1 configures both spawner lanes (iron left, coal right, the belt's saturation), under 60 ms
// of latency with jitter. The host's engine makes the inserts (the schedule is transport state,
// 0079 §21) and the despawner sinks them; each replica follows the forecast. Over 200 ticks every
// line either replica holds carries exactly the host's items at the replica's own tick (each
// replica trails the host by its latency, so the host's items are kept by tick), and the forecast
// counters (the corrections each replica needed) are pinned.

import { forecastCounters, hostLineItems, lineItems, serverInternals } from 'engine/test'
import { expect, test } from 'vitest'
import { refHarness } from '../helpers/net.js'
import { runScript, SPAWNER_RUN, SPAWNER_STAND, script } from '../helpers/script.js'

const S = SPAWNER_RUN
const at = (dx: number) => ({ x: S.x + dx, y: S.y })

test('reference_belt_items_converge', async () => {
  const r = await refHarness({
    clients: 2,
    seed: 5300,
    conditions: { latencyMs: 60, jitterMs: 20 },
  })
  try {
    const [d0, d1] = r.drivers
    if (!d0 || !d1) throw new Error('two drivers')
    await runScript(script().panTo(SPAWNER_STAND), d1)
    await runScript(
      script()
        .panTo(SPAWNER_STAND)
        .placeBelt(S, 'East', 'Spawner')
        .placeBelt(at(1), 'East')
        .placeBelt(at(2), 'East')
        .placeBelt(at(3), 'East', 'Despawner'),
      d0,
    )
    await runScript(script().setSpawner(S, 0, 'iron').setSpawner(S, 1, 'coal'), d1)

    const inst = serverInternals(r.h.server).rawInstance
    if (!inst) throw new Error('no live sim instance')
    /** The host's items by tick: line id -> `[item, pos, ...]`. */
    const host = new Map<number, Map<number, number[]>>()
    const seen = [0, 0].map(() => ({ compared: 0, items: 0, ticks: new Set<number>() }))
    for (let i = 0; i < 200; i++) {
      await r.h.advanceTicks(1)
      const hd = hostLineItems(inst)
      host.set(hd.tick, new Map(hd.lines.map((l) => [l.id, l.items])))
      for (const [k, c] of r.h.clients.entries()) {
        const s = seen[k]
        if (!s) continue
        for (const id of host.get(hd.tick)?.keys() ?? []) {
          const cd = lineItems(c, id)
          if (cd === null) continue
          const want = host.get(cd.tick)?.get(id)
          const got = cd.lines[0]
          if (want === undefined || !got || got.unknown) continue
          expect(
            got.items,
            `client ${k}: tick ${cd.tick}: line ${id} (items as item, pos)`,
          ).toEqual(want)
          s.compared++
          s.items += want.length / 2
          s.ticks.add(cd.tick)
        }
      }
    }
    // Exact on the virtual clock (measured, the same twice): 199 of the 200 host ticks reached by
    // each replica's tick within the window (it trails by its latency, and the window's first tick
    // was compared from before it), 4 lines each (the spawner's pair and the run's pair: 796), and
    // 5,632 items, about 28 a tick over the four tiles' 32 places as the run fills and sinks.
    const compared = [199, 796, 5632]
    expect(
      seen.map((s) => [s.ticks.size, s.compared, s.items]),
      'ticks, (line, tick) pairs and items compared per client',
    ).toEqual([compared, compared])
    const counters = r.h.clients.map((c) => forecastCounters(c))
    // Pinned (each replica the same, measured): 11 run lists applied and 2 `State`s; `corrections`
    // counts the States and the lists of lines held before their frame (2 + 7). Fix round 1 added
    // one list: lane 1's `SetSpawner` re-sets lane 0's schedule too (10 -> 11, 8 -> 9). No arrival and no
    // late or unknown list: every scheduled insert was forecast (0078 A3 rule 4, A13), so items
    // flowing cost no correction.
    const want = {
      forecastsApplied: 11,
      stateMessagesApplied: 2,
      arrivalsApplied: 0,
      forecastSeenLate: 0,
      corrections: 9,
      listsUnknown: 0,
      recordsUnheld: 0,
    }
    expect(counters, 'forecast counters per client').toEqual([want, want])
    await r.h.settle()
    r.h.assertConverged()
  } finally {
    await r.dispose()
  }
}, 60_000)
