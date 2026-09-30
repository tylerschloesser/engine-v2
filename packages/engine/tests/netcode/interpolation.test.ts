// `interpolation.*` (docs/plan/30-interpolation.md, Tests added, netcode suite): remote players
// through the real client-worker interpolation path (`InterpBuffer`/`InterpDelay`) under the seeded
// conditioner on the virtual clock, plus the two conditioner-driven clock tests M26 owed
// (`host_clock_under_jitter`, `lead_tracks_rtt_under_jitter`). Fixture: `fx-presence`, whose client
// `frame` copies a non-default camera's centre and velocity into its presence sample, so a scenario
// drives any curve through `HeadlessClient.setView` (the "scripted path producer").
//
// Client 0 is the producer, client 1 the observer unless a test says otherwise. Every value here is
// derived from the conditioner's own settings, never tuned to pass.
import { expect, test } from 'vitest'
import { createNetHarness, type NetHarness } from '../../src/test/net-harness.js'
import type { PresenceSampleRow } from '../../src/test/presence-samples.js'
import { expectWithinBudget } from '../support/budgets.js'
import { loadFixture } from '../support/fixtures.js'
import { putsFixture } from './support.js'

const TICK_MS = 50
const TILE = 256 // Q24.8

interface Pose {
  x: number
  y: number
  vx: number
  vy: number
}

/** The known curve (tiles, tiles/s) a producer follows: at most 5.4 tiles/s, C-infinity. */
function pose(tMs: number, phase = 0): Pose {
  const s = tMs / 1000
  return {
    x: 30 + 8 * Math.sin(0.5 * s + phase),
    y: 4 * Math.sin(0.9 * s + 1 + phase),
    vx: 4 * Math.cos(0.5 * s + phase),
    vy: 3.6 * Math.cos(0.9 * s + 1 + phase),
  }
}
const MAX_SPEED = Math.hypot(4, 3.6) // tiles/s, an upper bound on |v| along `pose`

function drive(h: NetHarness, i: number, p: Pose): void {
  h.clients[i]?.setView({ x: p.x, y: p.y, halfW: 10, halfH: 10, velX: p.vx, velY: p.vy })
}

function observe(h: NetHarness, i: number): void {
  h.clients[i]?.setView({ x: 30, y: 0, halfW: 20, halfH: 20 })
}

async function make(
  seed: number,
  clients: number,
  extra: { frameMs?: number; transport?: 'memory' | 'ws'; hashAll?: boolean } = {},
) {
  return createNetHarness({
    fixture: await loadFixture('presence'),
    seed,
    clients,
    ...(extra.transport !== undefined ? { transport: extra.transport } : {}),
    ...(extra.frameMs !== undefined ? { clientFrameMs: extra.frameMs } : {}),
    ...(extra.hashAll !== undefined ? { hashAll: extra.hashAll } : {}),
  })
}

/** One producer sample is generated at the virtual time `t0` it is set (the frame that carries it
 * runs one tick later): drive client `i` along `pose` for `ticks` ticks, calling `after` after
 * each. */
async function run(
  h: NetHarness,
  ticks: number,
  producers: { i: number; phase: number }[],
  after?: (tick: number) => void,
): Promise<void> {
  for (let k = 0; k < ticks; k++) {
    for (const p of producers) drive(h, p.i, pose(h.clock.now(), p.phase))
    await h.advanceTicks(1)
    after?.(k)
  }
}

function only(rows: PresenceSampleRow[]): PresenceSampleRow | undefined {
  return rows.length === 1 ? rows[0] : undefined
}

/** The observer's worst distance from the curve evaluated at `render_t` minus the pipeline delay,
 * over `ticks` ticks at a constant one-way latency. Returns `{ checked, worst }`. */
async function trackPath(
  seed: number,
  ticks: number,
  transport: 'memory' | 'ws',
): Promise<{ checked: number; worst: number }> {
  const h = await make(seed, 2, { transport })
  try {
    const LATENCY = 40
    h.link(0).set({ latencyMs: LATENCY, jitterMs: 0 })
    h.link(1).set({ latencyMs: LATENCY, jitterMs: 0 })
    observe(h, 1)
    await h.advanceTicks(transport === 'ws' ? 20 : 10)
    // A sample set at virtual time t0 rides the frame at t0 + 1 tick, arrives LATENCY later and is
    // stamped with the next whole host tick (up to 1 tick of alignment: 25 ms on average).
    const pipelineMs = TICK_MS + LATENCY + TICK_MS / 2
    let checked = 0
    let worst = 0
    await run(h, ticks, [{ i: 0, phase: 0 }], () => {
      const obs = h.clients[1]
      if (!obs) return
      const row = only(obs.samplePresences())
      if (!row || h.hostTick() < 80) return
      const renderMs = obs.interpCounters().renderTime * TICK_MS
      const want = pose(renderMs - pipelineMs)
      const err = Math.hypot(row.x / TILE - want.x, row.y / TILE - want.y)
      worst = Math.max(worst, err)
      checked++
    })
    return { checked, worst }
  } finally {
    await h.dispose()
  }
}

test('interpolation/constant_latency_tracks_path', async () => {
  const seed = 3001
  const { checked, worst } = await trackPath(seed, 260, 'memory')
  expect(checked).toBeGreaterThan(150)
  // Stated bound: a half-tick alignment error at MAX_SPEED (0.14 tile) plus the 10 Hz presence
  // sample spacing the Hermite fit absorbs, rounded up to half a tile.
  expect(worst, `seed ${seed}`).toBeLessThan(0.5)
})

// Real loopback sockets under the same conditioner (0020 section 7: one `ws` repeat). `@slow`: a
// real socket handshake and real per-tick event-loop yields cost seconds the fast `netcode` budget
// (10 s) cannot spare (ws-transport.test.ts's own Deviations).
test('interpolation/constant_latency_tracks_path ws @slow', async () => {
  const seed = 3011
  const { checked, worst } = await trackPath(seed, 160, 'ws')
  expect(checked).toBeGreaterThan(50)
  expect(worst, `seed ${seed}`).toBeLessThan(0.5)
}, 60_000)

test('interpolation/jitter_profile_adapts', async () => {
  const seed = 3002
  // Four client frames per 50 ms tick, so arrival times are seen finer than a tick.
  const h = await make(seed, 2, { frameMs: 12.5 })
  try {
    // 0010's assumed network: 40 ms one way (RTT 80, inside 60-100), jitter 30 ms (top of 10-30).
    h.link(0).set({ latencyMs: 40, jitterMs: 30 })
    h.link(1).set({ latencyMs: 40, jitterMs: 30 })
    observe(h, 1)
    await h.advanceTicks(10)
    const obs = h.clients[1]
    if (!obs) throw new Error('no observer')
    const delays: number[] = []
    const sampleDelay = () => delays.push(obs.interpCounters().interpDelayMs)
    await run(h, 300, [{ i: 0, phase: 0 }], sampleDelay)
    // 0040: max(2 x 100, 100 + p95 jitter) clamped to [200, 400] ms. A jitter sample is one gap
    // error, so at most 2 x 30 = 60 ms; the histogram's bin edge adds under 16 ms: 100 + 76 is
    // under the floor, so the delay settles on the floor.
    const settled = delays[delays.length - 1] as number
    expect(settled, `seed ${seed}`).toBeGreaterThanOrEqual(200)
    expect(settled, `seed ${seed}`).toBeLessThanOrEqual(200.001)
    // Never stepped: within one 50 ms tick the delay moves at most the 10% dilation limit (5 ms).
    for (let i = 1; i < delays.length; i++) {
      expect(Math.abs((delays[i] as number) - (delays[i - 1] as number))).toBeLessThanOrEqual(5.001)
    }
    // Worse jitter raises the delay, again without stepping: 150 ms of jitter gives a p95 gap error
    // well over 100 ms, so the formula's value is over 200 ms.
    h.link(0).set({ jitterMs: 150 })
    h.link(1).set({ jitterMs: 150 })
    const raised: number[] = []
    await run(h, 400, [{ i: 0, phase: 0 }], () => raised.push(obs.interpCounters().interpDelayMs))
    expect(raised[raised.length - 1] as number, `seed ${seed}`).toBeGreaterThan(210)
    expect(raised[raised.length - 1] as number).toBeLessThanOrEqual(400)
    for (let i = 1; i < raised.length; i++) {
      expect(Math.abs((raised[i] as number) - (raised[i - 1] as number))).toBeLessThanOrEqual(5.001)
    }
  } finally {
    await h.dispose()
  }
})

test('interpolation/stall_then_recover', async () => {
  const seed = 3003
  const h = await make(seed, 2)
  try {
    h.link(0).set({ latencyMs: 40, jitterMs: 0 })
    h.link(1).set({ latencyMs: 40, jitterMs: 0 })
    observe(h, 1)
    await h.advanceTicks(10)
    const obs = h.clients[1]
    if (!obs) throw new Error('no observer')
    const STALL_MS = 1000
    // Warm-up: the producer's first samples are its pre-curve default position.
    await run(h, 30, [{ i: 0, phase: 0 }])
    const trace: { mode: string; x: number; y: number }[] = []
    let stallAt = -1
    await run(h, 120, [{ i: 0, phase: 0 }], (k) => {
      if (k === 39) {
        h.link(0).stall(STALL_MS) // the producer's link: presence stops reaching the host
        stallAt = trace.length
      }
      const row = only(obs.samplePresences())
      if (row) trace.push({ mode: row.mode, x: row.x / TILE, y: row.y / TILE })
    })
    const modes = trace.map((t) => t.mode)
    // Interp before the stall, then Extrap, then Hold, then back to Interp: in that order.
    const first = (m: string, from = 0) => modes.indexOf(m, from)
    const iInterp = first('interp')
    const iExtrap = first('extrap', stallAt)
    const iHold = first('hold', iExtrap)
    const iBack = first('interp', iHold)
    expect(iInterp, `seed ${seed}`).toBeGreaterThanOrEqual(0)
    expect(iInterp).toBeLessThan(iExtrap)
    expect(iExtrap).toBeLessThan(iHold)
    expect(iHold).toBeLessThan(iBack)
    // Held: the position does not move at all for a stretch.
    const held = trace.slice(iHold, iBack)
    expect(held.length).toBeGreaterThan(3)
    for (const t of held) expect(t).toEqual(held[0])
    // Bound on recovery: the catch-up is one step (then a few frames of Hermite catch-up at up to
    // about twice the producer's speed), at most the distance the producer covered in the stall
    // plus the two ticks around it; everywhere else a tick moves at most MAX_SPEED x one tick
    // (plus rounding).
    const stepBound = MAX_SPEED * (TICK_MS / 1000) + 0.05
    const recoveryBound = MAX_SPEED * ((STALL_MS + 2 * TICK_MS) / 1000)
    let worstRecovery = 0
    for (let i = 1; i < trace.length; i++) {
      const a = trace[i - 1] as { x: number; y: number }
      const b = trace[i] as { x: number; y: number }
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      if (i > iHold - 1 && i <= iBack + 5) worstRecovery = Math.max(worstRecovery, d)
      else expect(d, `seed ${seed} tick ${i}`).toBeLessThanOrEqual(stepBound)
    }
    expect(worstRecovery).toBeLessThanOrEqual(recoveryBound)
  } finally {
    await h.dispose()
  }
})

test('interpolation/resting_player_stays_solid', async () => {
  const seed = 3004
  const h = await make(seed, 2)
  try {
    observe(h, 1)
    // The producer parks at a fixed, non-default position with zero velocity.
    h.clients[0]?.setView({ x: 31, y: 2, halfW: 10, halfH: 10 })
    await h.advanceTicks(30)
    const obs = h.clients[1]
    if (!obs) throw new Error('no observer')
    const before = h.counters(0).perTick.length
    const alphas: number[] = []
    for (let k = 0; k < 100; k++) {
      await h.advanceTicks(1)
      const row = only(obs.samplePresences())
      alphas.push(row ? row.alpha : 0)
    }
    // 5 s at rest: the remote never fades (re-relayed held sample refreshes the silence timer).
    expect(
      alphas.every((a) => a === 1),
      `seed ${seed}`,
    ).toBe(true)
    // No uplink presence bytes at rest beyond the keepalive: 0010 says at least one batch per 1 s,
    // and a batch with no actions, camera or presence is 1 type + 1 flags + 4 tick + 1 count = 7 B.
    const window = h.counters(0).perTick.slice(before)
    const up = window.reduce((n, t) => n + t.bytesUp, 0)
    const KEEPALIVE_BATCH_BYTES = 7
    expect(up, `seed ${seed}`).toBeLessThanOrEqual(6 * KEEPALIVE_BATCH_BYTES)
  } finally {
    await h.dispose()
  }
})

test('interpolation/disconnect_removes_at_once', async () => {
  const seed = 3005
  const h = await make(seed, 2)
  try {
    observe(h, 1)
    await h.advanceTicks(10)
    const obs = h.clients[1]
    if (!obs) throw new Error('no observer')
    await run(h, 40, [{ i: 0, phase: 0 }])
    expect(obs.samplePresences().length, `seed ${seed}`).toBe(1)
    h.clients[0]?.leave()
    // One tick for the host to see the close, then the next frame carries `Gone`: the remote is
    // no longer drawn in that frame (alpha 0 at once, not faded over 2.5 s).
    await h.advanceTicks(1)
    await h.advanceTicks(1)
    expect(obs.samplePresences().length).toBe(0)
  } finally {
    await h.dispose()
  }
})

/** Runs the median network profile and returns extrapolated / rendered frames over the window. */
async function extrapolationRatio(seed: number, jitterMs: number): Promise<number> {
  const h = await make(seed, 2, { frameMs: 12.5 })
  try {
    h.link(0).set({ latencyMs: 40, jitterMs })
    h.link(1).set({ latencyMs: 40, jitterMs })
    observe(h, 1)
    await h.advanceTicks(10)
    const obs = h.clients[1]
    if (!obs) throw new Error('no observer')
    await run(h, 100, [{ i: 0, phase: 0 }]) // let the delay settle
    const a = obs.interpCounters()
    await run(h, 300, [{ i: 0, phase: 0 }])
    const b = obs.interpCounters()
    return (
      (b.interpExtrapolatedFrames - a.interpExtrapolatedFrames) /
      (b.interpRenderedFrames - a.interpRenderedFrames)
    )
  } finally {
    await h.dispose()
  }
}

test('interpolation/extrapolation_ratio', async () => {
  // The median network profile of 0010: RTT 80 ms (in 60-100), jitter 20 ms (in 10-30).
  const ratio = await extrapolationRatio(3006, 20)
  // 0040: with the delay sized from the presence sample interval, at most one frame in five
  // extrapolates (0.607 under 0010's frame-interval term; the brief's line is 0.2).
  expect(ratio).toBeGreaterThanOrEqual(0)
  expect(ratio).toBeLessThanOrEqual(0.2)
})

test('interpolation/rebase_drops_and_recovers', async () => {
  const seed = 3012
  const h = await make(seed, 2, { frameMs: 12.5 })
  try {
    h.link(0).set({ latencyMs: 40, jitterMs: 20 })
    h.link(1).set({ latencyMs: 40, jitterMs: 20 })
    observe(h, 1)
    await h.advanceTicks(10)
    const obs = h.clients[1]
    if (!obs) throw new Error('no observer')
    await run(h, 120, [{ i: 0, phase: 0 }])
    expect(obs.samplePresences().length, `seed ${seed}`).toBe(1)
    // Delay has settled to the floor; a rebase snaps it to the initial value and drops every remote.
    expect(obs.interpCounters().interpDelayMs).toBe(200)
    obs.rebase()
    obs.stepFrame(TICK_MS / 4)
    expect(obs.interpCounters().interpDelayMs).toBe(250)
    expect(obs.samplePresences().length).toBe(0)
    // The producer keeps moving: its next relayed sample brings it back, `interp` or `hold`, never
    // an extrapolation sweep.
    const modes = new Set<string>()
    await run(h, 60, [{ i: 0, phase: 0 }], () => {
      for (const r of obs.samplePresences()) modes.add(r.mode)
    })
    expect(modes.size).toBeGreaterThan(0)
    expect(modes.has('extrap') && modes.size === 1).toBe(false)
  } finally {
    await h.dispose()
  }
})

test('interpolation/seed_reproducible', async () => {
  const once = async () => {
    const h = await make(3007, 2, { frameMs: 25 })
    try {
      h.link(0).set({ latencyMs: 40, jitterMs: 25 })
      h.link(1).set({ latencyMs: 40, jitterMs: 25 })
      observe(h, 1)
      await h.advanceTicks(10)
      const obs = h.clients[1]
      if (!obs) throw new Error('no observer')
      const rows: unknown[] = []
      await run(h, 150, [{ i: 0, phase: 0 }], () => {
        rows.push(obs.samplePresences(), obs.interpCounters().interpDelayMs)
      })
      return { rows, trace: Array.from(h.trace()) }
    } finally {
      await h.dispose()
    }
  }
  const a = await once()
  const b = await once()
  expect(a.rows.length).toBeGreaterThan(100)
  expect(a.rows).toEqual(b.rows)
  expect(a.trace).toEqual(b.trace)
})

test('interpolation/presence_bytes_budget', async () => {
  const seed = 3008
  // M31b R1: hash-all off, this test's ceiling is a byte budget (hash bytes are `integrity/`'s).
  const h = await make(seed, 8, { hashAll: false })
  try {
    observe(h, 7)
    await h.advanceTicks(10)
    const TICKS = 200
    const producers = Array.from({ length: 7 }, (_, i) => ({ i, phase: i * 0.9 }))
    await run(h, 40, producers) // warm-up: chunk enters and the first samples
    const start = h.counters(7).perTick.length
    await run(h, TICKS, producers) // 10 s of seven moving remotes
    const window = h.counters(7).perTick.slice(start)
    const bytes = window.reduce((n, t) => n + t.bytesDown, 0)
    const perSec = bytes / ((TICKS * TICK_MS) / 1000)
    expect(h.clients[7]?.samplePresences().length, `seed ${seed}`).toBe(7)
    expectWithinBudget('counters.presence.downBytesPerSec7Remotes', perSec)
  } finally {
    await h.dispose()
  }
})

test('interpolation/host_clock_under_jitter', async () => {
  const seed = 3009
  const h = await make(seed, 2, { frameMs: 12.5 })
  try {
    const LATENCY = 40
    const JITTER = 30
    h.link(0).set({ latencyMs: LATENCY, jitterMs: JITTER })
    h.link(1).set({ latencyMs: LATENCY, jitterMs: JITTER })
    observe(h, 1)
    await h.advanceTicks(10)
    const obs = h.clients[1]
    if (!obs) throw new Error('no observer')
    let prev = -Infinity
    let worstLag = 0
    let best = Infinity
    let n = 0
    await run(h, 300, [{ i: 0, phase: 0 }], () => {
      const est = obs.interpCounters().hostClockNow
      // Monotone: the estimate never moves backwards.
      expect(est, `seed ${seed}`).toBeGreaterThanOrEqual(prev)
      prev = est
      if (h.hostTick() > 100) {
        // How far the estimate trails the host's true tick. It reads the tick as of a frame's
        // arrival, so it trails by at least the one-way latency and at most latency plus the
        // jitter range plus a tick of alignment, plus 0.5 tick for the slew.
        const lag = h.hostTick() - est
        worstLag = Math.max(worstLag, lag)
        best = Math.min(best, lag)
        n++
      }
    })
    expect(n).toBeGreaterThan(150)
    const oneWayTicks = LATENCY / TICK_MS
    const jitterTicks = JITTER / TICK_MS
    expect(best, `seed ${seed}`).toBeGreaterThanOrEqual(oneWayTicks - 1)
    expect(worstLag, `seed ${seed}`).toBeLessThanOrEqual(oneWayTicks + jitterTicks + 1.5)
  } finally {
    await h.dispose()
  }
})

test('interpolation/lead_tracks_rtt_under_jitter', async () => {
  const seed = 3010
  // fx-puts, not fx-presence: a second client repainting one tile every tick keeps a host frame
  // arriving every tick, so the measured client's own tick stays current (an idle world would only
  // send a heartbeat every 10 ticks and `LeadEstimator`'s `ack.tick - auth_tick_at_dispatch`
  // sample would measure that staleness too).
  const h = await createNetHarness({
    fixture: await putsFixture(),
    seed,
    clients: 2,
    clientFrameMs: 12.5,
  })
  try {
    const LATENCY = 60
    const JITTER = 20
    h.link(0).set({ latencyMs: LATENCY, jitterMs: JITTER })
    h.clients[0]?.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    h.clients[1]?.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await h.advanceTicks(20)
    const c = h.clients[0]
    const spam = h.clients[1]
    if (!c || !spam) throw new Error('no clients')
    let acks = 0
    c.onActionResult(() => {
      acks++
    })
    const leads: number[] = []
    let leadsAfter8 = 0
    for (let k = 0; k < 120; k++) {
      spam.dispatch({ Paint: { pos: { x: 3, y: 3 }, base: 1 + (k % 2), resource: 0 } })
      if (k % 4 === 0) c.dispatch({ Paint: { pos: { x: 2, y: 2 }, base: 1, resource: 0 } })
      await h.advanceTicks(1)
      const s = c.status()
      if (acks >= 8) {
        if (leadsAfter8 === 0) leadsAfter8 = leads.length
        leads.push(s.predictedTick - s.tick)
      } else {
        leads.push(-1)
      }
    }
    expect(acks, `seed ${seed}`).toBeGreaterThanOrEqual(8)
    // Ground truth: RTT is two latencies plus the mean jitter draw (uniform in [0, JITTER]) each
    // way; the 12.5 ms client frame adds a negligible wake delay. Lead = ceil(rtt / tick) + 1.
    const rttMs = 2 * LATENCY + JITTER
    const want = Math.ceil(rttMs / TICK_MS) + 1
    const settled = leads[leads.length - 1] as number
    expect(
      Math.abs(settled - want),
      `seed ${seed} lead ${settled} want ${want}`,
    ).toBeLessThanOrEqual(1)
    // Own-timer corrections are bounded by the jitter range: after 8 acks one ack moves the lead
    // by at most the jitter range in ticks, rounded up, plus one.
    const stepBound = Math.ceil(JITTER / TICK_MS) + 1
    for (let i = leadsAfter8 + 1; i < leads.length; i++) {
      expect(Math.abs((leads[i] as number) - (leads[i - 1] as number))).toBeLessThanOrEqual(
        stepBound,
      )
    }
  } finally {
    await h.dispose()
  }
})
