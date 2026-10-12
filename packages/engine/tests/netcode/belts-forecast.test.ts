// `belts/forecast_*` (M47b, docs/decisions/0078 A3, A8): transport forecasts through real frames.
// The `fx-belts` bench world is built at genesis (`BeltsParams.bench`, its regime in the worldgen
// marker); its spawners declare their schedule (`set_spawner`), the `SaturatedView` world's sinks
// toggle on M41's jam schedule and the `InserterLike` world edits its lines, all inside the game's
// tick. A client holds the lines whose chunk set meets its view and follows their items from the
// host's `LineStructs` and `Forecasts` sections alone. The arbiter compares, every tick, the items
// on every line the client holds with the host's (`engine/test`'s `lineItems`, `hostLineItems`).
import { expect, test } from 'vitest'
import { serverInternals } from '../../src/server.js'
import {
  forecastCounters,
  hostLineItems,
  type LineItemsDump,
  lineItems,
} from '../../src/test/lines.js'
import { createNetHarness, type NetHarness } from '../../src/test/net-harness.js'
import { type BeltsRegime, beltsBenchWorld, beltsFixture } from './support.js'

/** The arbiter's small worlds' caps (1/64: about 60 lines and 4,000 items). */
const SMALL = { maxLines: 4_096, maxItems: 16_384 }

// Per-test timeouts: vitest's default is 5 s. These scenarios run whole 1/64 or full-scale worlds
// through real frames (2-5 s on Tyler's M3 Max) and CI's runner is 5-10x slower (run 38251055049:
// netcode 36 s against 6.4 s locally; the arbiter and the gate timed out at 5 s). A timeout is a
// ceiling on a hang, not a budget: the suite's 10 s budget (scripts/suites.mjs) still gates locally.
const FAST_TIMEOUT_MS = 60_000

function host(h: NetHarness): LineItemsDump {
  const inst = serverInternals(h.server).rawInstance
  if (!inst) throw new Error('no live sim instance')
  return hostLineItems(inst)
}

/** What one arbiter run saw. */
interface Seen {
  /** Ticks the client's forecast tick equalled the host's (every one compared). */
  ticks: number
  /** Ticks the client was not at the host's tick (no frame yet: the join). */
  lagging: number
  /** Ticks no frame came for, which the arbiter stepped the client through itself. */
  caughtUp: number
  /** `(line, tick)` pairs compared, and the items in them. */
  compared: number
  items: number
  /** `(line, tick)` pairs skipped: the client holds the line's items as `unknown`. */
  unknown: number
  maxHeld: number
  /** Lines held, and lines on the host, at the last tick. */
  held: number
  lines: number
  /** Full view: compared ticks before every line was held (the join's puts spill over frames),
   * and whether every line has been held since. */
  partial: number
  whole: boolean
}

/**
 * Runs `ticks` ticks; after each, every line the client holds (and knows the items of) must hold
 * exactly the host's items, kind and position, front to back. Throws naming the world, tick and
 * line on the first difference. The client may lag the host only before the first compared tick
 * (the join); a lagging tick after it fails. `fullView`: the whole world is in view, so once every
 * host line is held (the join's puts spill over a few frames) every compared tick must hold all.
 */
async function arbitrate(
  h: NetHarness,
  index: number,
  label: string,
  ticks: number,
  fullView = false,
): Promise<Seen> {
  const client = h.clients[index]
  if (!client) throw new Error(`no client ${index}`)
  const seen: Seen = {
    ticks: 0,
    lagging: 0,
    caughtUp: 0,
    compared: 0,
    items: 0,
    unknown: 0,
    maxHeld: 0,
    held: 0,
    lines: 0,
    partial: 0,
    whole: false,
  }
  for (let i = 0; i < ticks; i++) {
    const frames = h.counters(index).frames
    await h.advanceTicks(1)
    const hd = host(h)
    let held = 0
    let lagging = false
    let caught = false
    for (const hl of hd.lines) {
      let cd = lineItems(client, hl.id)
      if (cd === null) continue
      held++
      if (cd.tick !== hd.tick && cd.tick >= 0 && !caught && h.counters(index).frames === frames) {
        // No frame for this tick: nothing changed for the client. It steps this tick when its
        // next frame comes, by the same call (`on_frame` catches up first); the arbiter takes
        // that step now to compare this tick (the native arbiter's rule).
        client.forecastCatchUp(hd.tick)
        caught = true
        seen.caughtUp++
        cd = lineItems(client, hl.id)
        if (cd === null) throw new Error(`${label}: line ${hl.id} dropped by a catch-up`)
      }
      if (cd.tick !== hd.tick) {
        if (seen.ticks > 0) {
          throw new Error(
            `${label}: tick ${hd.tick}: line ${hl.id}: the client is at tick ${cd.tick} after the join`,
          )
        }
        lagging = true
        break
      }
      const l = cd.lines[0]
      if (!l) throw new Error(`${label}: line ${hl.id}: empty dump`)
      if (l.unknown) {
        seen.unknown++
        continue
      }
      const want = hl.items
      if (l.items.length !== want.length || l.items.some((v, k) => v !== want[k])) {
        expect(
          pairs(l.items),
          `${label}: tick ${hd.tick}: line ${l.id}: client vs host (items as [item, pos])`,
        ).toEqual(pairs(want))
      }
      seen.compared++
      seen.items += want.length / 2
    }
    if (lagging || held === 0) {
      if (seen.ticks > 0) throw new Error(`${label}: tick ${hd.tick}: no line held after the join`)
      seen.lagging++
      continue
    }
    if (fullView) {
      if (held === hd.lines.length) seen.whole = true
      else if (seen.whole) {
        // Once the join has put every line, a line in view is never dropped (a budget `Gone`
        // would leave it uncompared while it is gone).
        throw new Error(`${label}: tick ${hd.tick}: ${held} of ${hd.lines.length} lines held`)
      } else seen.partial++
    }
    seen.ticks++
    seen.maxHeld = Math.max(seen.maxHeld, held)
    seen.held = held
    seen.lines = hd.lines.length
  }
  return seen
}

function pairs(flat: number[]): [number, number][] {
  const out: [number, number][] = []
  for (let k = 0; k < flat.length; k += 2) out.push([flat[k] as number, flat[k + 1] as number])
  return out
}

/** What one world measures, pinned exactly (seed 4701 + index): a moved pin is a finding. */
interface Pins {
  lagging: number
  /** Full-view worlds: compared ticks before every line was held (`null`: a partial view). */
  partial: number | null
  caughtUp: number
  compared: number
  items: number
  maxHeld: number
  held: number
  lines: number
  arrivals: number
  states: number
  lists: number
}

const FULL = { x: 128, halfW: 128, halfH: 72 }

/** The spike's seven 1/64 worlds (M41 Deviations, Extension 3): name, regime, view, pins. A view is
 * `x, y, halfW, halfH` in tiles; the whole of a world is 256 tiles wide at most (the clamp). */
const WORLDS: {
  label: string
  regime: BeltsRegime
  view: { x: number; y: number; halfW: number; halfH: number }
  pins: Pins
}[] = [
  {
    label: 'saturated-view (20, 20)',
    regime: { SaturatedView: { jam_pct: 20, period: 20 } },
    view: { ...FULL, y: 1 },
    pins: {
      lagging: 3,
      partial: 1,
      caughtUp: 73,
      compared: 16_025,
      items: 1_213_871,
      maxHeld: 54,
      held: 54,
      lines: 54,
      arrivals: 0,
      states: 209,
      lists: 54,
    },
  },
  {
    label: 'saturated-view (50, 30)',
    regime: { SaturatedView: { jam_pct: 50, period: 30 } },
    view: { ...FULL, y: 1 },
    pins: {
      lagging: 3,
      partial: 1,
      caughtUp: 7,
      compared: 16_025,
      items: 1_214_129,
      maxHeld: 54,
      held: 54,
      lines: 54,
      arrivals: 0,
      states: 560,
      lists: 54,
    },
  },
  {
    label: 'mixed',
    regime: 'Mixed',
    view: { ...FULL, y: 8 },
    pins: {
      lagging: 3,
      partial: 1,
      caughtUp: 0,
      compared: 23_138,
      items: 1_202_072,
      maxHeld: 78,
      held: 78,
      lines: 78,
      arrivals: 0,
      states: 0,
      lists: 78,
    },
  },
  {
    label: 'inserter-like',
    regime: 'InserterLike',
    view: { ...FULL, y: 8 },
    pins: {
      lagging: 3,
      partial: 1,
      caughtUp: 0,
      compared: 23_138,
      items: 1_031_354,
      maxHeld: 78,
      held: 78,
      lines: 78,
      arrivals: 412,
      states: 4,
      lists: 3_440,
    },
  },
  {
    label: 'saturated-view (50, 30) at speed 72',
    regime: { SaturatedView: { jam_pct: 50, period: 30, speed: 72 } },
    view: { ...FULL, y: 1 },
    pins: {
      lagging: 3,
      partial: 1,
      caughtUp: 0,
      compared: 16_025,
      items: 1_169_579,
      maxHeld: 54,
      held: 54,
      lines: 54,
      arrivals: 2,
      states: 560,
      lists: 54,
    },
  },
  // At the front of every chain, so the client holds the fronts and not the lines feeding them:
  // their items reach it as arrivals (M41's "arrivals from invisible lines").
  {
    label: 'mixed, 64-tile view',
    regime: 'Mixed',
    view: { x: 16, y: 8, halfW: 32, halfH: 72 },
    pins: {
      lagging: 3,
      partial: null,
      caughtUp: 0,
      compared: 21_361,
      items: 1_168_651,
      maxHeld: 72,
      held: 72,
      lines: 78,
      arrivals: 417,
      states: 0,
      lists: 72,
    },
  },
  {
    label: 'mixed, empty at the start',
    regime: 'MixedEmpty',
    view: { ...FULL, y: 8 },
    pins: {
      lagging: 3,
      partial: 0,
      caughtUp: 0,
      compared: 23_166,
      items: 232_275,
      maxHeld: 78,
      held: 78,
      lines: 78,
      arrivals: 0,
      states: 1,
      lists: 78,
    },
  },
]

test(
  'belts/forecast_client_matches_host',
  async () => {
    const fixture = await beltsFixture()
    for (const [i, w] of WORLDS.entries()) {
      const h = await createNetHarness({
        fixture,
        seed: 4701 + i,
        clients: 1,
        world: beltsBenchWorld(w.regime, 64, SMALL),
      })
      try {
        const client = h.clients[0]
        if (!client) throw new Error('one client')
        client.setView(w.view)
        const full = w.view.halfW === 128
        const seen = await arbitrate(h, 0, w.label, 300, full)
        const fc = forecastCounters(client)
        if (process.env.MEASURE) console.log(`MEASURE ${w.label} ${JSON.stringify({ seen, fc })}`)
        const got: Pins = {
          lagging: seen.lagging,
          partial: full ? seen.partial : null,
          caughtUp: seen.caughtUp,
          compared: seen.compared,
          items: seen.items,
          maxHeld: seen.maxHeld,
          held: seen.held,
          lines: seen.lines,
          arrivals: fc.arrivalsApplied,
          states: fc.stateMessagesApplied,
          lists: fc.forecastsApplied,
        }
        expect(got, `${w.label}: the measured counts`).toEqual(w.pins)
        if (full) expect(seen.whole, `${w.label}: every line held`).toBe(true)
        expect(seen.ticks, `${w.label}: every tick after the join compared`).toBe(
          300 - w.pins.lagging,
        )
        expect(seen.unknown, `${w.label}: unknown lists`).toBe(0)
        expect(fc.recordsUnheld, `${w.label}: records for unheld lines`).toBe(0)
        h.assertConverged()
      } finally {
        await h.dispose()
      }
    }
  },
  FAST_TIMEOUT_MS,
)

/** `forecast_corrected_on_jam`: run lists for held lines by the end of its 10-tick join (pinned). */
const PRE_JOIN_LISTS = 0

test(
  'belts/forecast_corrected_on_jam',
  async () => {
    // Every sink of the 1/64 saturated view closes and reopens (100 %, period 40, staggered by M41's
    // seeded phases): a closing halts a packed lane chain, a reopening releases it. Each is a `State`
    // for the lines it moves, in the frame of the tick it happens (the arbiter compares every tick, so
    // a correction a frame late would show as items past their stop), and never a `RunList`: once
    // the join has put every line with its list, no list arrives again.
    const h = await createNetHarness({
      fixture: await beltsFixture(),
      seed: 4711,
      clients: 1,
      world: beltsBenchWorld({ SaturatedView: { jam_pct: 100, period: 40 } }, 64, SMALL),
    })
    try {
      const client = h.clients[0]
      if (!client) throw new Error('one client')
      client.setView({ x: 128, y: 1, halfW: 128, halfH: 72 })
      await arbitrate(h, 0, 'join', 10)
      const before = forecastCounters(client)
      const seen = await arbitrate(h, 0, 'saturated-view (100, 40)', 120, true)
      const after = forecastCounters(client)
      const states = after.stateMessagesApplied - before.stateMessagesApplied
      const lists = after.corrections - after.stateMessagesApplied
      if (process.env.MEASURE) console.log(`MEASURE jam ${JSON.stringify({ seen, before, after })}`)
      expect(seen.ticks, 'every tick compared').toBe(120)
      expect(states, 'the jams forming and clearing were corrected by states').toBe(324)
      expect(seen.partial, 'every line held from the first compared tick').toBe(0)
      expect(
        before.corrections - before.stateMessagesApplied,
        'run lists for held lines during the join',
      ).toBe(PRE_JOIN_LISTS)
      expect(lists, 'run lists for lines held before their frame').toBe(PRE_JOIN_LISTS)
      expect(after.forecastsApplied, 'no run list after the join').toBe(before.forecastsApplied)
      expect(after.arrivalsApplied, 'no arrival').toBe(before.arrivalsApplied)
    } finally {
      await h.dispose()
    }
  },
  FAST_TIMEOUT_MS,
)
