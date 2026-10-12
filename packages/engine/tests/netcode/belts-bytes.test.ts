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
import { assertBudget } from '../../src/test/budget.js'
import { type BeltsRegime, BYTES_WINDOW_TICKS, measure, SATURATED_LINES } from './support.js'

const LINES = SATURATED_LINES
const WINDOW_TICKS = BYTES_WINDOW_TICKS

// Per-test timeouts: vitest's default is 5 s. These scenarios run whole 1/64 or full-scale worlds
// through real frames (2-5 s on Tyler's M3 Max) and CI's runner is 5-10x slower (run 38251055049:
// netcode 36 s against 6.4 s locally; the arbiter and the gate timed out at 5 s). A timeout is a
// ceiling on a hang, not a budget: the suite's 10 s budget (scripts/suites.mjs) still gates locally.
const FAST_TIMEOUT_MS = 60_000
const SLOW_TIMEOUT_MS = 180_000

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
}

test(
  'belts/saturated_view_bytes',
  async () => {
    const m = await measure({ SaturatedView: { jam_pct: 20, period: 100 } }, 4721)
    if (process.env.MEASURE) console.log(`MEASURE saturated (20, 100) ${JSON.stringify(m)}`)
    expectSteady(m, '(20 %, 100)')
    // M48c: a snapshot no longer re-puts a held line, so the join settles 12 ticks sooner
    // (156 lifted under M47b-M48b) and the 400-tick window starts earlier. Every figure is counted
    // on the delivery clock (RTT 80 ms, jitter 20 ms), and at this phase the last of the window's
    // 400 frames lands past its edge: 399 delivered, so bytes, States and corrections read one
    // frame (245 B, 12 States) under the 400-frame figures 3,958 B/s (51,072 + 28,084), 4,576 and
    // 228.8 that the same code reads with every anchored line forced again (294,878 items then:
    // a different 20 s of world time). The rate per 400 frames is unchanged.
    expect(m.items, 'items on the held lines at the end').toBe(294_881)
    expect(m.states, 'States in the window').toBe(4_564)
    expect(m.correctionsPerSec, 'corrections a second').toBe(228.2)
    expect(m.joinTicks, 'ticks to the settled join').toBe(144)
    expect(m.runs, 'visible runs at the end').toBe(150_958)
    expect(m.structsBytes, 'LineStructs bytes in the window').toBe(50_909)
    expect(m.forecastsBytes, 'Forecasts bytes in the window').toBe(28_002)
    expect(m.frames, 'frames delivered in the window').toBe(399)
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
    // M48c: the join settles at 146 ticks (159 before the snapshot dedupe); the bytes are the
    // same, items and runs are a later 20 s of world time (294,867 and 150,951 before).
    expect(m.items, 'items on the held lines at the end').toBe(294_872)
    expect(m.states, 'States in the window').toBe(22_880)
    expect(m.correctionsPerSec, 'corrections a second').toBe(1_144)
    expect(m.joinTicks, 'ticks to the settled join').toBe(146)
    expect(m.runs, 'visible runs at the end').toBe(150_955)
    expect(m.frames, 'a frame every tick').toBe(WINDOW_TICKS)
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
