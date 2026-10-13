// M56 (Netcode): the 4x4 balancer (`LAYOUTS.balancer`, `tests/helpers/layout.ts`) on the real
// server. Client 0 builds it at the host's action rate (`buildPaced`) and saturates its four
// spawners (iron, coal, wood, stone, both lanes); then a client joins late and, for 400 ticks, every
// line it holds carries exactly the host's items at its own tick, the forecast counters pinned: each
// `Arrival` it applies is a fork crossing (the client never decides a fork) or an item surfacing at
// an underground exit (0078 A8, A14). The second test measures the balancer's replication cost:
// sections 12 and 13 (`LineStructs` and `Forecasts`) over 20 s of steady flow, against 0078 A5's
// 16,384 B/s ceiling and A9's gated 3,946.

import { forecastCounters, hostLineItems, lineItems, serverInternals } from 'engine/test'
import { expect, test } from 'vitest'
import { buildPaced, LAYOUTS, layoutActions, parseLayout } from '../helpers/layout.js'
import { type RefHarness, refHarness } from '../helpers/net.js'

/** The balancer's top-left (6 x 7 tiles of free land at `world.json`'s seed, inside the chunks every
 * client holds by default). */
const AT = { x: -4, y: -13 }
/** Spawners west to east: iron, coal, wood, stone (`ItemId`), as in `scenarios.rs`. */
const FEED = [1, 3, 2, 0]
const CAMERA = { x: AT.x + 3, y: AT.y + 3.5, tilesAcross: 20 }

/** Builds the balancer from client 0 and returns the ticks the paced build took. */
async function build(r: RefHarness): Promise<number> {
  const c0 = r.h.clients[0]
  if (!c0) throw new Error('client 0')
  const layout = parseLayout(LAYOUTS.balancer)
  const { ticks } = await buildPaced(
    c0,
    (n) => r.h.advanceTicks(n),
    layoutActions(layout, AT, FEED),
  )
  return ticks
}

/** The balancer's line ids by role when its 27 placements apply in one host tick, as native
 * `RefScenario::lay` places them (`scenarios.rs` reads the same ids from the topology; the test
 * checks the build landed so: 76 lines, the hidden ones those no client holds): the splitters'
 * output lines (the forks' targets), the underground exits' lines and the hidden lines. */
const OUTPUTS = [7, 8, 11, 12, 19, 20, 23, 24, 55, 56, 59, 60, 63, 64, 67, 68]
const EXITS = [25, 26, 39, 40]
const HIDDEN = [41, 42, 51, 52]

test('reference_balancer_two_clients_exact @slow', async () => {
  const r = await refHarness({
    clients: 1,
    seed: 5600,
    conditions: { latencyMs: 60, jitterMs: 20 },
    cameras: [CAMERA],
  })
  try {
    const ticks = await build(r)
    // The late joiner: a second player whose first view is the balancer, joined once it flows.
    await r.h.advanceTicks(100)
    const late = r.h.addClient()
    late.setCamera(CAMERA)
    const inst = serverInternals(r.h.server).rawInstance
    if (!inst) throw new Error('no live sim instance')
    /** The host's items by tick, and the fork crossings and exit emergences counted by tick. */
    const host = new Map<number, Map<number, number[]>>()
    const events = new Map<number, number>()
    let total = 0
    let c0 = forecastCounters(late)
    let t0 = -1
    const seen = { compared: 0, items: 0, ticks: new Set<number>() }
    // 60 ticks for the join to settle, then 400 compared.
    for (let i = 0; i < 460; i++) {
      if (i === 60) {
        c0 = forecastCounters(late)
        t0 = lineItems(late, OUTPUTS[0] as number)?.tick ?? -1
      }
      await r.h.advanceTicks(1)
      const hd = hostLineItems(inst)
      const lines = new Map(hd.lines.map((l) => [l.id, l.items]))
      host.set(hd.tick, lines)
      // A crossing lands within one step (24) of a 128-position line's back; on these lines nothing
      // waits there (the despawners drain every output).
      for (const id of [...OUTPUTS, ...EXITS]) {
        const it = lines.get(id) ?? []
        for (let k = 1; k < it.length; k += 2) if ((it[k] as number) >= 128 - 24) total++
      }
      events.set(hd.tick, total)
      if (i < 60) continue
      for (const id of lines.keys()) {
        const cd = lineItems(late, id)
        if (cd === null) continue
        const want = host.get(cd.tick)?.get(id)
        const got = cd.lines[0]
        if (want === undefined || !got || got.unknown) continue
        expect(got.items, `late: tick ${cd.tick}: line ${id} (items as item, pos)`).toEqual(want)
        seen.compared++
        seen.items += want.length / 2
        seen.ticks.add(cd.tick)
      }
    }
    const c1 = forecastCounters(late)
    const t1 = lineItems(late, OUTPUTS[0] as number)?.tick ?? -1
    // The build: 35 actions (27 placements, 8 spawner lanes) in 10 ticks at the host's rate, its
    // 27 placements in one host tick, so the line ids are native `lay`'s: 76 lines, the four
    // hidden ones the only lines the late client does not hold.
    const ids = [...(host.get(t1)?.keys() ?? [])]
    expect(
      [ticks, ids.length, ids.filter((id) => lineItems(late, id) === null)],
      'build ticks, host lines, lines the late client does not hold',
    ).toEqual([10, 76, HIDDEN])
    // Measured (the same twice), exact on the virtual clock: the late client's ticks 196 to 596
    // (it trails the host by its latency); on every one of them its 72 held lines carried the host's
    // items at that tick (28,800 (line, tick) pairs, 88,787 items; 88,800 before M61: the splitter
    // pairs' turn and shared toggle pass the inputs straight through in lockstep and compressed
    // landings sit right behind the tail, so which items cross which fork, and when, moved, and the
    // lines hold 13 fewer item-ticks over the window).
    expect([t0, t1], "the late client's window").toEqual([196, 596])
    expect(
      [seen.ticks.size, seen.compared, seen.items],
      'ticks, (line, tick) pairs and items compared',
    ).toEqual([400, 28_800, 88_787])
    // Every `Arrival` is a fork crossing or an item surfacing at an exit: 2,999 in the window (3,000
    // before M61: the same 7.5 a tick, the window's phase against the lockstep flow taking one), the
    // host's 2,999 crossings onto the 16 splitter output lines and emergences onto the 4 exit lines
    // over the same ticks (7.5 a tick: each item crosses two forks, and S_a's half of them one
    // underground). No list after the join (72, one per held line), no State, nothing late.
    expect(c1.arrivalsApplied - c0.arrivalsApplied, 'arrivals = fork crossings + emergences').toBe(
      (events.get(t1) ?? -1) - (events.get(t0) ?? -1),
    )
    expect(c1.arrivalsApplied - c0.arrivalsApplied, 'arrivals in the window').toBe(2_999)
    // M61 (the input turn, compressed fork landings, the shared toggle): 36 States, all corrections
    // (32 while the flow builds up before the window, 4 in it), each a splitter input's front held
    // or released where its forecast had it move (a front waiting its turn, a landing pushed right
    // behind the tail); they cost bytes, never exactness (every compared pair above is equal).
    expect(c1.stateMessagesApplied - c0.stateMessagesApplied, 'States in the window').toBe(4)
    expect(c1, "the late client's forecast counters").toEqual({
      forecastsApplied: 72,
      stateMessagesApplied: 36,
      arrivalsApplied: 3_386,
      forecastSeenLate: 0,
      corrections: 36,
      listsUnknown: 0,
      recordsUnheld: 0,
    })
    await r.h.settle()
    r.h.assertConverged()
  } finally {
    await r.dispose()
  }
}, 120_000)

test('reference_balancer_arrival_bytes @slow', async () => {
  const r = await refHarness({
    clients: 1,
    seed: 5601,
    conditions: { latencyMs: 60, jitterMs: 20 },
    cameras: [CAMERA],
  })
  try {
    await build(r)
    // Past the first items' trips (84 ticks to the last output): steady flow.
    await r.h.advanceTicks(200)
    const c = r.h.clients[0]
    if (!c) throw new Error('client 0')
    const read = () => {
      const s = r.h.counters(0).sections
      return { structs: s.LineStructs ?? 0, forecasts: s.Forecasts ?? 0, f: forecastCounters(c) }
    }
    const a = read()
    await r.h.advanceTicks(400)
    const b = read()
    const window = {
      structs: b.structs - a.structs,
      forecasts: b.forecasts - a.forecasts,
      arrivals: b.f.arrivalsApplied - a.f.arrivalsApplied,
      states: b.f.stateMessagesApplied - a.f.stateMessagesApplied,
      lists: b.f.forecastsApplied - a.f.forecastsApplied,
    }
    // Measured (the same twice), exact on the virtual clock: over 20 s (400 ticks) of steady flow
    // the balancer costs 27,791 bytes of sections 12 and 13, all `Forecasts` (no structure changes):
    // 2,999 `Arrival`s (16 fork outputs and 4 underground exits, 7.5 a tick) at 9.27 B each with the
    // section framing, no State, no list. That is 1,389.55 B/s (M61; before it 27,850 B, 3,000
    // arrivals, 1,392.5 B/s: one arrival less to the window's phase against the lockstep flow, the
    // other 50 B in the records' encodings, measured): 8.5 % of 0078 A5's 16,384 B/s
    // ceiling and 35 % of A9's gated saturated-viewport cell (3,946 B/s, `fx-belts`' straight
    // lines); per saturated lane through the balancer 174 B/s, against A14's 148 B/s per saturated
    // underground pair (both lanes). Recorded as a 0078 amendment (M56).
    expect(window, 'sections 12 and 13 over 20 s').toEqual({
      structs: 0,
      forecasts: 27_791,
      arrivals: 2_999,
      states: 0,
      lists: 0,
    })
    await r.h.settle()
    r.h.assertConverged()
  } finally {
    await r.dispose()
  }
}, 120_000)
