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
    ...overrides,
  }
}

test('simhost_paces_at_tick_rate', () => {
  const clock = manualClock()
  const timer = manualTimer()
  const host = createSimHostFromInstance(fakeSim(), { clock, timer: timer.services })
  host.start()

  clock.advance(TICK_MS)
  timer.fire()
  expect(host.counters.ticksRun).toBe(1)

  clock.advance(TICK_MS)
  timer.fire()
  expect(host.counters.ticksRun).toBe(2)
  expect(host.counters.ticksDropped).toBe(0)

  // A fire before the next deadline runs nothing.
  clock.advance(TICK_MS / 2)
  timer.fire()
  expect(host.counters.ticksRun).toBe(2)
})

test('simhost_caps_catchup_and_drops_time', () => {
  const clock = manualClock()
  const timer = manualTimer()
  const host = createSimHostFromInstance(fakeSim(), { clock, timer: timer.services })
  host.start()

  // A delayed wakeup: 10 ticks' worth of wall time elapse before the timer ever fires.
  clock.advance(TICK_MS * 10)
  timer.fire()
  expect(host.counters.ticksRun).toBe(MAX_CATCHUP_TICKS)
  expect(host.counters.ticksDropped).toBe(10 - MAX_CATCHUP_TICKS)

  // `base` moved forward by the dropped amount: with no further wall-clock advance, nothing is
  // due on the very next fire.
  timer.fire()
  expect(host.counters.ticksRun).toBe(MAX_CATCHUP_TICKS)
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

  clock.advance(TICK_MS)
  timer.fire()
  expect(host.counters.ticksRun).toBe(1)

  host.pause()
  clock.advance(TICK_MS * 5)
  timer.fire() // disarmed: a no-op
  expect(host.counters.ticksRun).toBe(1)
  expect(host.counters.ticksDropped).toBe(0)

  // The paused interval is invisible to pacing: resuming and advancing one more interval runs
  // exactly one tick, not a catch-up burst for the 5 intervals that elapsed while paused.
  host.resume()
  clock.advance(TICK_MS)
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

  clock.advance(TICK_MS)
  timer.fire()

  expect(host.counters.chunksWarmed).toBe(WARM_BUDGET_MS)
  expect(warmCalls).toBe(host.counters.chunksWarmed)
})

test('simhost_counts_tick_overrun', () => {
  const clock = manualClock()
  const timer = manualTimer()
  const OVERRUN_MS = 7
  const sim = fakeSim({
    // The tick itself advances the fake clock past one interval, once.
    simTick: () => {
      clock.advance(TICK_MS + OVERRUN_MS)
      return Status.Ok
    },
  })
  const host = createSimHostFromInstance(sim, { clock, timer: timer.services })
  host.start()
  const startedAt = clock.now()

  clock.advance(TICK_MS)
  timer.fire()

  expect(host.counters.ticksRun).toBe(1)
  expect(host.counters.tickOverruns).toBe(1)
  expect(host.counters.ticksDropped).toBe(0)

  // Sim time (one tick's worth) now falls behind wall time by exactly how long that one overrun
  // tick actually took: `base` is never adjusted by an overrun (only a dropped catch-up tick
  // moves it), so the deficit is `due`'s own formula, self-correcting on the next fire.
  const wallElapsed = clock.now() - startedAt
  const simElapsed = host.counters.ticksRun * TICK_MS
  expect(wallElapsed - simElapsed).toBe(TICK_MS + OVERRUN_MS)
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
