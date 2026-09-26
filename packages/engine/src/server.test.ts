// `SimHost` unit coverage (docs/plan/13-sim-host-tick-loop.md Tests added, step 2): pacing, the
// catch-up cap, seal-before-tick ordering, pause/resume and the warmer budget, all against a fake
// [`SimInstance`] (not a hand-rolled `EngineInstance`: `server.ts`'s own doc comment on
// `SimInstance` explains why) and a manual clock/timer double -- no real `.wasm` here (step 3
// drives the real fixture).
import { expect, test, vi } from 'vitest'
import { Status } from './abi.js'
import {
  buildSimInstanceConfig,
  createSimHostFromInstance,
  MAX_CATCHUP_TICKS,
  RESYNC_TICKS,
  type SimInstance,
  seedToHexU64,
  WARM_BUDGET_MS,
} from './server.js'

/** `Game::TICK_RATE`'s own default (`TickRate::HZ_20`) and `server.ts`'s own hardcoded rate
 * (Deviations): 20 Hz, 50 ms per tick. */
const TICK_MS = 50

function manualClock(startMs = 0) {
  let now = startMs
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}

/** A `HostServices.timer` double: `every()` records the one callback `SimHost.start()`/`resume()`
 * registers (a real `SimHost` only ever has one live timer), `fire()` invokes it unless the
 * returned stop function was called since. */
function manualTimer() {
  let fn: (() => void) | null = null
  return {
    services: {
      every: (_ms: number, cb: () => void) => {
        fn = cb
        return () => {
          fn = null
        }
      },
    },
    fire() {
      fn?.()
    },
  }
}

function fakeSim(overrides: Partial<SimInstance> = {}): SimInstance {
  return {
    simGenesis: () => Status.Ok,
    simTick: () => Status.Ok,
    simSealFrame: () => ({ len: 0 }),
    simHash: () => '0000000000000000',
    simWarmOne: () => 0,
    tickHz: () => 20,
    simConnect: () => Status.Ok,
    simReattach: () => Status.Ok,
    simDisconnect: () => Status.Ok,
    simAdmit: () => Status.Ok,
    simBuildFrame: () => ({ len: 0 }),
    rxBytes: () => 0,
    txBytes: () => 0,
    ...overrides,
  }
}

test('simhost_paces_one_tick_per_fire', () => {
  // docs/plan/13b-tick-timing-allocation.md (ADR amending M13): pacing no longer checks a per-fire
  // deadline against the clock at all (that check is what boxed on the strict isolate) -- every
  // fire runs exactly one tick, unconditionally. Real accuracy is `resync`'s job, covered below;
  // this test is the "fires unconditionally" half on its own, well under one resync window.
  const clock = manualClock()
  const timer = manualTimer()
  const host = createSimHostFromInstance(fakeSim(), { clock, timer: timer.services })
  host.start()

  timer.fire()
  expect(host.counters.ticksRun).toBe(1)

  // No wall-clock advance at all between fires: still one tick per fire, proving there is no
  // hidden due-check left (the old assertion this replaces, "a fire before the next deadline runs
  // nothing", asserted the opposite on purpose -- that check is exactly what this milestone removed).
  timer.fire()
  timer.fire()
  expect(host.counters.ticksRun).toBe(3)
  expect(host.counters.ticksDropped).toBe(0)
})

test('simhost_resync_reads_the_configured_tick_rate', () => {
  // "20 Hz is hardcoded" gap (M13 Deviations), still closed: `resync`'s own expected-elapsed math
  // (`ticksSinceSync * tickMs`) must use the real configured rate, not a hardcoded 50 ms, or a
  // correctly-paced 40 Hz host would misreport every resync window as overrun.
  const HZ = 40
  const HZ_MS = 1000 / HZ // 25, an exact integer already (Math.round is a no-op here).
  const clock = manualClock()
  const timer = manualTimer()
  const host = createSimHostFromInstance(fakeSim({ tickHz: () => HZ }), {
    clock,
    timer: timer.services,
  })
  host.start()

  // Exactly RESYNC_TICKS fires, the clock advancing by exactly HZ_MS between each -- a host paced
  // correctly at the *configured* 40 Hz, not the old 20 Hz default (which would read this as
  // running fast, never overrun, so this alone would not distinguish the two rates the way the
  // overrun assertion below does).
  for (let i = 0; i < RESYNC_TICKS; i++) {
    clock.advance(HZ_MS)
    timer.fire()
  }
  expect(host.counters.ticksRun).toBe(RESYNC_TICKS)
  expect(host.counters.tickOverruns).toBe(0)
  expect(host.counters.ticksDropped).toBe(0)
})

test('simhost_resync_catches_up_and_drops_within_cap', () => {
  const clock = manualClock()
  const timer = manualTimer()
  const host = createSimHostFromInstance(fakeSim(), { clock, timer: timer.services })
  host.start()

  // RESYNC_TICKS fires, each assumed to cost TICK_MS with no clock read -- but wall time actually
  // advances by 10x TICK_MS before each fire (10x more than budgeted per tick over the whole
  // window), so the resync this triggers finds the window far behind schedule. The very first
  // advance becomes the resync anchor itself (`ensureSyncBase` reads "now" at the first tick), so
  // only the other RESYNC_TICKS - 1 advances count toward elapsed time against a budget of
  // RESYNC_TICKS whole ticks: behind by (RESYNC_TICKS - 1) * 10 - RESYNC_TICKS = 62 ticks' worth.
  for (let i = 0; i < RESYNC_TICKS; i++) {
    clock.advance(TICK_MS * 10)
    timer.fire()
  }

  // `RESYNC_TICKS` ticks already ran (one per fire, unconditionally) plus `MAX_CATCHUP_TICKS`
  // caught up synchronously inside the resync; the remainder of the backlog is dropped.
  const behindTicks = (RESYNC_TICKS - 1) * 10 - RESYNC_TICKS
  expect(host.counters.ticksRun).toBe(RESYNC_TICKS + MAX_CATCHUP_TICKS)
  expect(host.counters.ticksDropped).toBe(behindTicks - MAX_CATCHUP_TICKS)
  expect(host.counters.tickOverruns).toBe(1)

  // The resync anchor moved forward by everything it just accounted for: with no further
  // wall-clock advance, the next RESYNC_TICKS fires find nothing behind schedule.
  for (let i = 0; i < RESYNC_TICKS; i++) timer.fire()
  expect(host.counters.ticksDropped).toBe(behindTicks - MAX_CATCHUP_TICKS)
})

test('simhost_seal_precedes_tick', () => {
  const clock = manualClock()
  const timer = manualTimer()
  const order: string[] = []
  const sim: SimInstance = {
    simGenesis: () => Status.Ok,
    simSealFrame: () => {
      order.push('seal')
      return { len: 4, bytes: new Uint8Array([1, 2, 3, 4]) }
    },
    simTick: () => {
      order.push('tick')
      return Status.Ok
    },
    simHash: () => '0000000000000000',
    simWarmOne: () => 0,
    tickHz: () => 20,
    simConnect: () => Status.Ok,
    simReattach: () => Status.Ok,
    simDisconnect: () => Status.Ok,
    simAdmit: () => Status.Ok,
    simBuildFrame: () => ({ len: 0 }),
    rxBytes: () => 0,
    txBytes: () => 0,
  }
  const logSpy = vi.fn((bytes: Uint8Array) => order.push(`log:${bytes.length}`))
  const host = createSimHostFromInstance(sim, { clock, timer: timer.services })
  host.logSink = logSpy

  host.stepTick(1)

  expect(order).toEqual(['seal', 'log:4', 'tick'])
  expect(logSpy).toHaveBeenCalledTimes(1)
  expect(logSpy.mock.calls[0]?.[0]).toEqual(new Uint8Array([1, 2, 3, 4]))
})

test('simhost_seal_precedes_tick: logSink is not called when len is 0', () => {
  const clock = manualClock()
  const timer = manualTimer()
  const logSpy = vi.fn()
  const host = createSimHostFromInstance(fakeSim(), { clock, timer: timer.services })
  host.logSink = logSpy
  host.stepTick(3)
  expect(logSpy).not.toHaveBeenCalled()
  expect(host.counters.ticksRun).toBe(3)
})

test('simhost_pause_stops_ticks', () => {
  const clock = manualClock()
  const timer = manualTimer()
  const host = createSimHostFromInstance(fakeSim(), { clock, timer: timer.services })
  host.start()

  timer.fire()
  expect(host.counters.ticksRun).toBe(1)

  host.pause()
  clock.advance(TICK_MS * 5)
  timer.fire() // disarmed: a no-op
  expect(host.counters.ticksRun).toBe(1)
  expect(host.counters.ticksDropped).toBe(0)

  // The paused interval is invisible to pacing (Deviations: `resume()` resets the resync anchor):
  // resuming runs exactly one tick on the next fire, never a catch-up burst for the 5 intervals
  // that elapsed while paused. There is no per-fire due check left that could trigger one anyway;
  // this only stays true because a resync (every RESYNC_TICKS ticks) never sees the paused span.
  host.resume()
  timer.fire()
  expect(host.counters.ticksRun).toBe(2)
  expect(host.counters.ticksDropped).toBe(0)
})

test('simhost_warmer_respects_budget', () => {
  const clock = manualClock()
  const timer = manualTimer()
  let warmCalls = 0
  const sim = fakeSim({
    simWarmOne: () => {
      warmCalls++
      clock.advance(1) // each generated chunk costs 1 ms of wall time
      return 1 // always more to warm: the budget, not "nothing cold", must stop the loop
    },
  })
  const host = createSimHostFromInstance(sim, { clock, timer: timer.services })
  host.start()

  // The warmer now runs only at a resync (Deviations: amortised the same way the clock read is),
  // so RESYNC_TICKS fires are needed to reach one.
  for (let i = 0; i < RESYNC_TICKS; i++) {
    clock.advance(TICK_MS)
    timer.fire()
  }

  expect(host.counters.chunksWarmed).toBe(WARM_BUDGET_MS)
  expect(warmCalls).toBe(host.counters.chunksWarmed)
})

test('simhost_counts_tick_overrun', () => {
  // docs/plan/13b-tick-timing-allocation.md (ADR amending M13): an overrun is detected once per
  // resync window, not per tick -- every tick in the window runs `OVERRUN_MS` over its own share,
  // and the window's real elapsed time is only checked once, at the resync RESYNC_TICKS ticks in.
  const clock = manualClock()
  const timer = manualTimer()
  const OVERRUN_MS = 7
  const sim = fakeSim({
    simTick: () => {
      clock.advance(OVERRUN_MS)
      return Status.Ok
    },
  })
  const host = createSimHostFromInstance(sim, { clock, timer: timer.services })
  host.start()

  // No advance before the first fire: it sets the resync anchor at wall time 0. Each of the other
  // RESYNC_TICKS - 1 fires advances one full tick period first, same as real pacing would; every
  // fire's own `simTick` adds `OVERRUN_MS` on top. Elapsed over the window is therefore
  // `(RESYNC_TICKS - 1) * TICK_MS + RESYNC_TICKS * OVERRUN_MS` against a budget of
  // `RESYNC_TICKS * TICK_MS` -- over by `RESYNC_TICKS * OVERRUN_MS - TICK_MS` = 8*7 - 50 = 6 ms,
  // less than one whole tick, so this is an overrun with nothing behind by a full tick to drop.
  timer.fire()
  for (let i = 1; i < RESYNC_TICKS; i++) {
    clock.advance(TICK_MS)
    timer.fire()
  }

  expect(host.counters.ticksRun).toBe(RESYNC_TICKS)
  expect(host.counters.tickOverruns).toBe(1)
  expect(host.counters.ticksDropped).toBe(0)
})

test('simhost_seed_decimal_to_hex_u64', () => {
  expect(seedToHexU64('18446744073709551615')).toBe('0xffffffffffffffff')
  expect(seedToHexU64('0')).toBe('0x0')

  for (const bad of ['-1', '+1', '1.5', '0x1', 'abc', '18446744073709551616', ' 1', '1 ', '']) {
    expect(() => seedToHexU64(bad), bad).toThrow()
  }

  // Reaches the instance config as `game.seed` (createSimHost's own conversion point).
  const cfg = buildSimInstanceConfig({
    worldId: 'w',
    buildHash: 'h',
    params: { seed: '18446744073709551615', worldgen: {} },
  })
  expect((cfg.game as { seed: string }).seed).toBe('0xffffffffffffffff')

  expect(() =>
    buildSimInstanceConfig({ worldId: 'w', buildHash: 'h', params: { seed: '-1', worldgen: {} } }),
  ).toThrow()
})
