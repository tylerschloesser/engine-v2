// `SimHost` unit coverage (docs/plan/13-sim-host-tick-loop.md Tests added, step 2): pacing, the
// catch-up cap, seal-before-tick ordering, pause/resume and the warmer budget, all against a fake
// [`SimInstance`] (not a hand-rolled `EngineInstance`: `server.ts`'s own doc comment on
// `SimInstance` explains why) and a manual clock/timer double -- no real `.wasm` here (step 3
// drives the real fixture).
import { expect, test, vi } from 'vitest'
import { Status } from './abi.js'
import {
  buildSimInstanceConfig,
  type Connection,
  createSimHostFromInstance,
  createWorldServer,
  type HostServices,
  MAX_CATCHUP_TICKS,
  RESYNC_TICKS,
  type SimInstance,
  seedToHexU64,
  WARM_BUDGET_MS,
  type WorldConfig,
  type WorldServer,
} from './server.js'

/** `Game::TICK_RATE`'s own default (`TickRate::HZ_20`) and `server.ts`'s own hardcoded rate
 * (Deviations): 20 Hz, 50 ms per tick. */
const TICK_MS = 50

type SimHostLike = ReturnType<typeof createSimHostFromInstance>

function manualClock(startMs = 0) {
  let now = startMs
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}

/** docs/plan/28b-reconnect-and-lifecycle.md step 4: `HostServices.scheduler`'s own test double for
 * every test here that doesn't itself exercise grace/idle timers -- never fires anything, the same
 * shape `test/headless-client.ts`'s own `noopScheduler` already uses. */
const noopScheduler: HostServices['scheduler'] = {
  setTimer: () => -1,
  clearTimer: () => {},
  requestFrame: () => -1,
  cancelFrame: () => {},
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
    simRegionHash: () => '0000000000000000',
    simWarmOne: () => 0,
    tickHz: () => 20,
    simConnect: () => Status.Ok,
    simReattach: () => Status.Ok,
    simFaultAck: () => Status.Ok,
    simDisconnect: () => Status.Ok,
    simLogDisconnected: () => Status.Ok,
    simAdmit: () => Status.Ok,
    simBuildFrame: () => ({ len: 0 }),
    rxBytes: () => 0,
    txBytes: () => 0,
    simAttach: () => ({ len: 0 }),
    simResync: () => ({ len: 0 }),
    simDetach: () => Status.Ok,
    simHasPlayer: () => 0,
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
  const host = createSimHostFromInstance(fakeSim(), {
    clock,
    timer: timer.services,
    scheduler: noopScheduler,
  })
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
    scheduler: noopScheduler,
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
  const host = createSimHostFromInstance(fakeSim(), {
    clock,
    timer: timer.services,
    scheduler: noopScheduler,
  })
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
    simRegionHash: () => '0000000000000000',
    simWarmOne: () => 0,
    tickHz: () => 20,
    simConnect: () => Status.Ok,
    simReattach: () => Status.Ok,
    simFaultAck: () => Status.Ok,
    simDisconnect: () => Status.Ok,
    simLogDisconnected: () => Status.Ok,
    simAdmit: () => Status.Ok,
    simBuildFrame: () => ({ len: 0 }),
    rxBytes: () => 0,
    txBytes: () => 0,
    simAttach: () => ({ len: 0 }),
    simResync: () => ({ len: 0 }),
    simDetach: () => Status.Ok,
    simHasPlayer: () => 0,
  }
  const logSpy = vi.fn((bytes: Uint8Array) => order.push(`log:${bytes.length}`))
  const host = createSimHostFromInstance(sim, {
    clock,
    timer: timer.services,
    scheduler: noopScheduler,
  })
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
  const host = createSimHostFromInstance(fakeSim(), {
    clock,
    timer: timer.services,
    scheduler: noopScheduler,
  })
  host.logSink = logSpy
  host.stepTick(3)
  expect(logSpy).not.toHaveBeenCalled()
  expect(host.counters.ticksRun).toBe(3)
})

test('simhost_pause_stops_ticks', () => {
  const clock = manualClock()
  const timer = manualTimer()
  const host = createSimHostFromInstance(fakeSim(), {
    clock,
    timer: timer.services,
    scheduler: noopScheduler,
  })
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
  const host = createSimHostFromInstance(sim, {
    clock,
    timer: timer.services,
    scheduler: noopScheduler,
  })
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
  const host = createSimHostFromInstance(sim, {
    clock,
    timer: timer.services,
    scheduler: noopScheduler,
  })
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

/**
 * docs/plan/27-server-entrypoint-and-netcode-harness.md, Exit criterion 4: `createWorldServer`'s
 * return type and `HostServices.onFatal?` match 0024 §5 (docs/decisions/0024-planning-amendments.md
 * §5) exactly: `createWorldServer(cfg, host): { ready: Promise<void>; accept(c: Connection): void;
 * stop(): Promise<void> }`, `HostServices.onFatal?: (f: { tick: number; message: string }) => void`.
 * Type-level: every assignment below is checked by `tsc` (`pnpm lint`), not by a runtime assertion
 * -- a shape drift here fails the *typecheck*, which is the point (Seams: "a renamed seam under
 * Provides" is an escalation, not a silent adaptation).
 */
test('createWorldServer / HostServices.onFatal? match 0024 §5', () => {
  const fn: (cfg: WorldConfig, host: HostServices) => WorldServer = createWorldServer
  expect(typeof fn).toBe('function')

  // `WorldServer`'s exact three fields, no more, no fewer (0024 §5 verbatim).
  const worldServerShape: {
    ready: Promise<void>
    accept: (c: Connection) => void
    stop: () => Promise<void>
  } = {} as WorldServer
  void worldServerShape
  const _onlyThoseThree: WorldServer = {} as {
    ready: Promise<void>
    accept: (c: Connection) => void
    stop: () => Promise<void>
  }
  void _onlyThoseThree

  // `onFatal?` is optional and exactly this shape; every other `HostServices` field (`wasm`,
  // `storage`, `clock`, `timer`, `onIdle?`) is 0009's own, untouched by 0024 §5.
  const onFatalShape: ((f: { tick: number; message: string }) => void) | undefined =
    {} as HostServices['onFatal']
  void onFatalShape
})

// 0030 §2: `stepTick(n)` shares `runPacedTick`, hence the resync accounting, with the timer's
// `onFire`. The same overrun scenario, driven once by timer fires and once by `stepTick`, must end
// in identical counters, and those counters must show a resync happened (catch-up and drops).
test('simhost_stepTick_shares_the_resync_accounting_with_onFire', () => {
  const scenario = (drive: (host: SimHostLike, n: () => void) => void) => {
    const clock = manualClock()
    const timer = manualTimer()
    const host = createSimHostFromInstance(fakeSim(), {
      clock,
      timer: timer.services,
      scheduler: noopScheduler,
    })
    host.start()
    for (let i = 0; i < RESYNC_TICKS; i++) {
      clock.advance(TICK_MS * 10)
      drive(host, () => timer.fire())
    }
    return { ...host.counters }
  }
  const viaTimer = scenario((_host, fire) => fire())
  const viaStep = scenario((host) => host.stepTick())
  const behindTicks = (RESYNC_TICKS - 1) * 10 - RESYNC_TICKS
  expect(viaStep.ticksRun).toBe(RESYNC_TICKS + MAX_CATCHUP_TICKS)
  expect(viaStep.ticksDropped).toBe(behindTicks - MAX_CATCHUP_TICKS)
  expect(viaStep.tickOverruns).toBe(1)
  expect(viaStep).toEqual(viaTimer)
})

// 0030 §5 and 0032 Amendment (round 3) b share a scenario: `start()` and `resume()` reset the resync
// anchor (`syncInitialized`, `ticksSinceSync`), so a stopped or paused span is invisible to pacing.
// Four ticks, a long interruption, a restart, then eight ticks on schedule: with the anchor reset
// the window never looks behind (no overrun, no catch-up, no drops), and the first resync comes
// eight ticks after the restart, not four (the warmer, which runs only at a resync, is the witness).
for (const [name, interrupt, restart] of [
  ['pause then resume', (h: SimHostLike) => h.pause(), (h: SimHostLike) => h.resume()],
  ['stop then start', (h: SimHostLike) => h.stop(), (h: SimHostLike) => h.start()],
] as const) {
  test(`simhost_${name.replaceAll(' ', '_')}_resets_the_resync_anchor`, async () => {
    const clock = manualClock()
    const timer = manualTimer()
    let warmCalls = 0
    const host = createSimHostFromInstance(
      fakeSim({
        simWarmOne: () => {
          warmCalls++
          clock.advance(WARM_BUDGET_MS) // one chunk uses the whole budget: the loop ends after it
          return 1
        },
      }),
      { clock, timer: timer.services, scheduler: noopScheduler },
    )
    host.start()
    for (let i = 0; i < RESYNC_TICKS / 2; i++) {
      clock.advance(TICK_MS)
      timer.fire()
    }
    await interrupt(host)
    clock.advance(TICK_MS * 100) // the interrupted span: 100 tick periods
    restart(host)

    for (let i = 0; i < RESYNC_TICKS / 2; i++) {
      clock.advance(TICK_MS)
      timer.fire()
    }
    expect(warmCalls, 'a resync only eight ticks after the restart').toBe(0)
    for (let i = 0; i < RESYNC_TICKS / 2; i++) {
      clock.advance(TICK_MS)
      timer.fire()
    }
    expect(warmCalls).toBe(1) // the first resync after the restart, on schedule: it warmed
    expect(host.counters.tickOverruns).toBe(0)
    expect(host.counters.ticksDropped).toBe(0)
    expect(host.counters.ticksRun).toBe(RESYNC_TICKS * 1.5)
  })
}

// 0032 Amendment (round 3) b: a resync window that had to catch up skips the warmer.
test('simhost_catch_up_window_skips_warming', () => {
  const clock = manualClock()
  const timer = manualTimer()
  let warmCalls = 0
  const host = createSimHostFromInstance(
    fakeSim({
      simWarmOne: () => {
        warmCalls++
        return 0
      },
    }),
    { clock, timer: timer.services, scheduler: noopScheduler },
  )
  host.start()
  for (let i = 0; i < RESYNC_TICKS; i++) {
    clock.advance(TICK_MS * 10) // far behind schedule at the resync
    timer.fire()
  }
  expect(host.counters.ticksRun).toBeGreaterThan(RESYNC_TICKS) // it caught up
  expect(warmCalls).toBe(0)
  // Control: the next window, on schedule, does warm.
  for (let i = 0; i < RESYNC_TICKS; i++) {
    clock.advance(TICK_MS)
    timer.fire()
  }
  expect(warmCalls).toBe(1)
})
