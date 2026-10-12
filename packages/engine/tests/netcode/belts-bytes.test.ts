// `belts/saturated_view_*` (M47b, docs/decisions/0078 A4, A5): the bandwidth of transport
// replication on Tyler's worst viewport. The `fx-belts` `SaturatedView` world at full scale (M41's
// world, built at genesis: 144 rows of 256 belt tiles, 2,974 lines, 294,912 items, every lane
// packed and fed to saturation, a share of the sinks closing and reopening on M41's staggered
// schedule) seen whole by one client: sections 12 (`LineStructs`) and 13 (`Forecasts`) together,
// over 20 s of virtual time after the join settles, production hashing, the median network profile
// of 0010 (RTT 80 ms, jitter 20 ms; `interpolation/extrapolation_ratio`'s). `saturated_view_bytes`
// gates the (20 %, 100) cell on `counters.transport.downBytesPerSec`; `saturated_view_stress`
// records the (20 %, 20) cell in the row's source, not gated.
import { expect, test } from 'vitest'
import { serverInternals } from '../../src/server.js'
import { assertBudget } from '../../src/test/budget.js'
import { forecastCounters, lineItems } from '../../src/test/lines.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { type BeltsRegime, beltsBenchWorld, beltsFixture } from './support.js'

const TICK_HZ = 20
/** 0078 A4's world: `saturated_view_world(7, .., 144)`. */
const LINES = 2_974
/** The highest line id of the full-scale bench worlds (`Mixed` has 3,810 lines). */
const MAX_ID = 3_810
/** 20 s of virtual time after the join settles. */
const WINDOW_TICKS = 20 * TICK_HZ

// Per-test timeouts: vitest's default is 5 s. These scenarios run whole 1/64 or full-scale worlds
// through real frames (2-5 s on Tyler's M3 Max) and CI's runner is 5-10x slower (run 38251055049:
// netcode 36 s against 6.4 s locally; the arbiter and the gate timed out at 5 s). A timeout is a
// ceiling on a hang, not a budget: the suite's 10 s budget (scripts/suites.mjs) still gates locally.
const FAST_TIMEOUT_MS = 60_000
const SLOW_TIMEOUT_MS = 180_000

/** One run of the scenario: the window's numbers. `regime` and `view` default to the saturated
 * viewport; `lines` is how many lines the view holds once joined. */
export async function measure(
  regime: BeltsRegime,
  seed: number,
  view = { x: 128, y: 72, halfW: 128, halfH: 72 },
  lines = LINES,
) {
  const world = beltsBenchWorld(
    regime,
    1,
    // The bench caps (`bench_host.rs`): the recommended line cap (its tile index holds 8 tiles a
    // line: this world has 73,728 lane tiles) and an item cap that never binds.
    { maxLines: 32_768, maxItems: 393_216 },
  )
  const h = await createNetHarness({
    fixture: await beltsFixture(),
    seed,
    clients: 1,
    clientFrameMs: 12.5,
    world: { ...world, debugHashMode: 'production' },
  })
  try {
    const client = h.clients[0]
    if (!client) throw new Error('one client')
    h.link(0).set({ latencyMs: 40, jitterMs: 20 })
    // The whole 256 x 144 viewport (0010's clamp is 256 tiles a side).
    client.setView(view)
    // The join: every line put with its list (about 1.9 MB of lists at the put budget's 16 KB a
    // frame); it has settled once `lines` lists arrived and none for a second.
    let joinTicks = 0
    let quiet = 0
    let last = -1
    while (quiet < TICK_HZ) {
      await h.advanceTicks(1)
      const n = forecastCounters(client).forecastsApplied
      quiet = n >= lines && n === last ? quiet + 1 : 0
      last = n
      if (++joinTicks > 1_200) {
        throw new Error(`the join never settled: ${JSON.stringify(forecastCounters(client))}`)
      }
    }
    const c0 = h.counters(0)
    const f0 = forecastCounters(client)
    await h.advanceTicks(WINDOW_TICKS)
    const c1 = h.counters(0)
    const f1 = forecastCounters(client)
    const section = (c: typeof c0, name: string) => c.sections[name] ?? 0
    const structs = section(c1, 'LineStructs') - section(c0, 'LineStructs')
    const forecasts = section(c1, 'Forecasts') - section(c0, 'Forecasts')
    // The visible runs at the end (a run: consecutive items of one kind `SPACING` apart).
    let runs = 0
    let items = 0
    let held = 0
    const inst = serverInternals(h.server).rawInstance
    if (!inst) throw new Error('no live sim instance')
    for (let id = 1; id <= MAX_ID; id++) {
      const d = lineItems(client, id)
      if (!d) continue
      held++
      const it = d.lines[0]?.items ?? []
      items += it.length / 2
      for (let k = 0; k < it.length; k += 2) {
        if (k === 0 || it[k] !== it[k - 2] || (it[k + 1] as number) - (it[k - 1] as number) !== 64)
          runs++
      }
    }
    const corrections = f1.corrections - f0.corrections
    return {
      joinTicks,
      held,
      items,
      runs,
      transportDownBytesPerSec: Math.round((structs + forecasts) / (WINDOW_TICKS / TICK_HZ)),
      structsBytes: structs,
      forecastsBytes: forecasts,
      frames: c1.frames - c0.frames,
      states: f1.stateMessagesApplied - f0.stateMessagesApplied,
      lists: f1.forecastsApplied - f0.forecastsApplied,
      lateLists: corrections - (f1.stateMessagesApplied - f0.stateMessagesApplied),
      arrivals: f1.arrivalsApplied - f0.arrivalsApplied,
      forecastSeenLate: f1.forecastSeenLate - f0.forecastSeenLate,
      correctionsPerRunPerSec: corrections / runs / (WINDOW_TICKS / TICK_HZ),
      /** 0078 §5's `transport.correctionsPerSec`: States and lists for held lines, per second. */
      correctionsPerSec: corrections / (WINDOW_TICKS / TICK_HZ),
      unknown: f1.listsUnknown,
      degradeLevel: c1.degradeLevel,
    }
  } finally {
    await h.dispose()
  }
}

/** What both cells assert besides their own counts: the whole view held, nothing but States after
 * the join, every frame sent, nothing late, no degrade (level 1: a frame every tick). */
function expectSteady(m: Awaited<ReturnType<typeof measure>>, cell: string): void {
  expect(m.held, `${cell}: every line of the viewport held`).toBe(LINES)
  expect(m.lists, `${cell}: no run list after the join`).toBe(0)
  expect(m.lateLists, `${cell}: no run list for a held line`).toBe(0)
  expect(m.arrivals, `${cell}: no arrival`).toBe(0)
  expect(m.forecastSeenLate, `${cell}: forecastSeenLate`).toBe(0)
  expect(m.unknown, `${cell}: unknown lists`).toBe(0)
  expect(m.degradeLevel, `${cell}: degrade level (1 = every tick)`).toBe(1)
  expect(m.frames, `${cell}: a frame every tick`).toBe(WINDOW_TICKS)
}

test(
  'belts/saturated_view_bytes',
  async () => {
    const m = await measure({ SaturatedView: { jam_pct: 20, period: 100 } }, 4721)
    if (process.env.MEASURE) console.log(`MEASURE saturated (20, 100) ${JSON.stringify(m)}`)
    expectSteady(m, '(20 %, 100)')
    expect(m.items, 'items on the held lines at the end').toBe(294_878)
    expect(m.states, 'States in the window').toBe(4_576)
    expect(m.correctionsPerSec, 'corrections a second').toBe(228.8)
    expect(m.joinTicks, 'ticks to the settled join').toBe(156)
    expect(m.runs, 'visible runs at the end').toBe(150_958)
    expect(m.structsBytes, 'LineStructs bytes in the window').toBe(51_072)
    expect(m.forecastsBytes, 'Forecasts bytes in the window').toBe(28_084)
    assertBudget(m, 'transport.downBytesPerSec')
  },
  FAST_TIMEOUT_MS,
)

// @slow: 3.1 s alone (the join and 20 s of the full-scale world), recorded, not gated against the
// ceiling; the gated (20 %, 100) cell keeps the scenario in the fast tier. Its bytes are pinned so the
// row's `source`, which records them, cannot drift.
test(
  'belts/saturated_view_stress @slow',
  async () => {
    const m = await measure({ SaturatedView: { jam_pct: 20, period: 20 } }, 4722)
    if (process.env.MEASURE) console.log(`MEASURE saturated (20, 20) ${JSON.stringify(m)}`)
    expectSteady(m, '(20 %, 20)')
    expect(m.items, 'items on the held lines at the end').toBe(294_867)
    expect(m.states, 'States in the window').toBe(22_880)
    expect(m.correctionsPerSec, 'corrections a second').toBe(1_144)
    expect(m.joinTicks, 'ticks to the settled join').toBe(159)
    expect(m.runs, 'visible runs at the end').toBe(150_951)
    expect(m.structsBytes, 'LineStructs bytes in the window').toBe(251_760)
    expect(m.forecastsBytes, 'Forecasts bytes in the window').toBe(137_600)
    expect(m.transportDownBytesPerSec, 'recorded in the row source').toBe(19_468)
  },
  SLOW_TIMEOUT_MS,
)

// @slow (recorded, not gated): the row's `source` quotes three more cells of the same scenario
// (seed 4730): no jams, (5 %, 100) and the `Mixed` world's centre viewport. Pinned exactly so the
// `source` cannot drift.
test(
  'belts/saturated_view_cells @slow',
  async () => {
    const cells = [
      {
        label: 'no jams',
        regime: { SaturatedView: { jam_pct: 0, period: 0 } } as BeltsRegime,
        view: undefined,
        lines: LINES,
        want: {
          transportDownBytesPerSec: 0,
          structsBytes: 0,
          forecastsBytes: 0,
          held: 2_974,
          lists: 0,
          arrivals: 0,
        },
      },
      {
        label: '(5 %, 100)',
        regime: { SaturatedView: { jam_pct: 5, period: 100 } } as BeltsRegime,
        view: undefined,
        lines: LINES,
        want: {
          transportDownBytesPerSec: 995,
          structsBytes: 13_080,
          forecastsBytes: 6_816,
          held: 2_974,
          lists: 0,
          arrivals: 0,
        },
      },
      {
        label: 'Mixed centre viewport',
        regime: 'Mixed' as BeltsRegime,
        // The world is 220 x 545 tiles; the view at its centre.
        view: { x: 110, y: 272, halfW: 128, halfH: 72 },
        // The lines the view holds once joined (the `held` pin below): the join has settled once
        // that many lists arrived and none for a second, the same rule as the saturated cells.
        lines: 1_584,
        want: {
          transportDownBytesPerSec: 0,
          structsBytes: 0,
          forecastsBytes: 0,
          held: 1_584,
          lists: 0,
          arrivals: 0,
        },
      },
    ]
    for (const c of cells) {
      const m = await measure(c.regime, 4730, c.view, c.lines)
      if (process.env.MEASURE) console.log(`MEASURE ${c.label} ${JSON.stringify(m)}`)
      const got = {
        transportDownBytesPerSec: m.transportDownBytesPerSec,
        structsBytes: m.structsBytes,
        forecastsBytes: m.forecastsBytes,
        held: m.held,
        lists: m.lists,
        arrivals: m.arrivals,
      }
      expect(got, `${c.label}: the cell as the row's source records it`).toEqual(c.want)
    }
  },
  SLOW_TIMEOUT_MS,
)
