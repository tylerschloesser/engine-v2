// The WASM-under-Node leg of `fx-puts`'s idle-100 golden (docs/plan/13-sim-host-tick-loop.md step
// 3): the `.wasm` run's hash after 100 idle ticks (no actions -- Actions are M16, Non-scope) equals
// `golden/golden.json`, which `pnpm golden puts` writes from this very run (0002, 0020 §5) and which
// the native leg (`fixtures/puts/tests/puts_scenarios.rs`'s `puts_idle_100_golden`, driving
// `Sim<Puts>` directly) is compared against too -- so this and the native test prove `.wasm` matches
// native transitively, through the one shared golden file.
import { expect, test } from 'vitest'
import { Role } from '../../src/abi.js'
import { instantiate } from '../../src/loader.js'
import {
  createSimHostFromInstance,
  MAX_CATCHUP_TICKS,
  RESYNC_TICKS,
  wrapEngineInstance,
} from '../../src/server.js'
import { loadFixture, readGolden } from '../support/fixtures.js'
import { type Golden, type HashScenario, runHashScenario } from '../support/scenario.js'

test('wasm_idle_100_matches_native', async () => {
  const scenario = readGolden<HashScenario>('puts', 'scenario.json')
  const golden = readGolden<Golden>('puts', 'golden.json')
  const { wasm } = await loadFixture('puts')
  const inst = instantiate(wasm, Role.Sim, scenario.config, { onLog() {} })

  const checkpoints = runHashScenario(inst, scenario)

  expect(checkpoints).toHaveLength(1)
  expect(checkpoints).toEqual(golden.checkpoints)
  // One growth at init, none after (0015 §5).
  expect(inst.memGrows()).toBe(0)
})

// `fx-puts`'s own `TICK_RATE` is the trait default (`TickRate::HZ_20`, `server.ts`'s "20 Hz is
// hardcoded" note): 50 ms/tick.
const TICK_MS = 50

/** A `HostServices.timer` double, same shape `server.test.ts`'s own `manualTimer()` uses: `every()`
 * records the one callback `SimHost.start()` registers, `fire()` invokes it. */
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

/**
 * docs/plan/13b-tick-timing-allocation.md (Tests added: "a real overrun increments tickOverruns and
 * a real drop increments ticksDropped ... they must be real here" -- M13 shipped these exercised
 * only against a fake `SimInstance`, `server.test.ts`'s own `simhost_resync_*` tests). This drives
 * the same resync-window scenario against `wrapEngineInstance` over the real `fx-puts` `.wasm`:
 * `sim_genesis`/`sim_tick`/`sim_seal_frame`/`tick_hz` are all real ABI calls, only the clock and
 * timer are test doubles (as every `SimHost` caller supplies them). If `tickOverruns`/`ticksDropped`
 * were ever wired to a constant (0, or any other fixed value), the exact counts asserted below
 * would not match: this is the failure mode the brief calls out by name.
 */
test('real overrun and drop increment tickOverruns/ticksDropped, driving the real .wasm', async () => {
  const scenario = readGolden<HashScenario>('puts', 'scenario.json')
  const { wasm } = await loadFixture('puts')
  const inst = instantiate(wasm, Role.Sim, scenario.config, { onLog() {} })
  const sim = wrapEngineInstance(inst)

  let now = 0
  const clock = { now: () => now }
  const timer = manualTimer()
  const host = createSimHostFromInstance(sim, { clock, timer: timer.services })
  host.start()

  // Exactly `server.test.ts`'s own `simhost_resync_catches_up_and_drops_within_cap` scenario: wall
  // time advances 10x each tick's own budget, so the resync this triggers finds the window far
  // behind schedule. The first fire's own advance becomes the resync anchor (`ensureSyncBase`
  // reads "now" at the first tick), so elapsed only counts the other RESYNC_TICKS - 1 advances.
  for (let i = 0; i < RESYNC_TICKS; i++) {
    now += TICK_MS * 10
    timer.fire()
  }
  const behindTicks = (RESYNC_TICKS - 1) * 10 - RESYNC_TICKS

  expect(host.counters.ticksRun).toBe(RESYNC_TICKS + MAX_CATCHUP_TICKS)
  expect(host.counters.tickOverruns).toBe(1)
  expect(host.counters.ticksDropped).toBe(behindTicks - MAX_CATCHUP_TICKS)

  // Live, not a constant: a second host over the same real instance, paced exactly on schedule,
  // reads both counters as zero.
  const onScheduleInst = instantiate(wasm, Role.Sim, scenario.config, { onLog() {} })
  let now2 = 0
  const clock2 = { now: () => now2 }
  const timer2 = manualTimer()
  const onScheduleHost = createSimHostFromInstance(wrapEngineInstance(onScheduleInst), {
    clock: clock2,
    timer: timer2.services,
  })
  onScheduleHost.start()
  for (let i = 0; i < RESYNC_TICKS; i++) {
    now2 += TICK_MS
    timer2.fire()
  }
  expect(onScheduleHost.counters.tickOverruns).toBe(0)
  expect(onScheduleHost.counters.ticksDropped).toBe(0)
})
