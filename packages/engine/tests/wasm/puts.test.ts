// The WASM-under-Node leg of `fx-puts`'s idle-100 golden (docs/plan/13-sim-host-tick-loop.md step
// 3): the `.wasm` run's hash after 100 idle ticks (no actions -- Actions are M16, Non-scope) equals
// `golden/golden.json`, which `pnpm golden puts` writes from this very run (0002, 0020 §5) and which
// the native leg (`fixtures/puts/tests/puts_scenarios.rs`'s `puts_idle_100_golden`, driving
// `Sim<Puts>` directly) is compared against too -- so this and the native test prove `.wasm` matches
// native transitively, through the one shared golden file.
import { expect, test } from 'vitest'
import { Role } from '../../src/abi.js'
import { instantiate } from '../../src/loader.js'
import { RingConnection } from '../../src/ring-connection.js'
import { createRing, RingConsumer } from '../../src/sab/ring.js'
import {
  type Connection,
  createSimHostFromInstance,
  MAX_CATCHUP_TICKS,
  type MsgClass,
  RESYNC_TICKS,
  wrapEngineInstance,
} from '../../src/server.js'
import { loadFixture, readGolden } from '../support/fixtures.js'
import {
  type Golden,
  type HashScenario,
  runHashScenario,
  runScriptScenario,
  type ScriptScenario,
} from '../support/scenario.js'

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

// docs/plan/15b-ring-connection-and-replica-rendering.md, Orchestrator ruling 1: `puts_idle_100`
// stays the zero-connection golden above; a connection changes `sim_hash()` from the very first
// tick (`Host::connect`'s own queued `Record::Player{Joined, Connected}`, which `fx-puts`'s
// `on_player` turns into a real state write), so it gets its own scenario/golden pair
// (`scenario-connected.json`/`golden-connected.json`, `pnpm golden puts`) rather than a re-blessed
// `golden.json`.
test('wasm_connected_100_matches_its_own_golden', async () => {
  const scenario = readGolden<HashScenario>('puts', 'scenario-connected.json')
  const golden = readGolden<Golden>('puts', 'golden-connected.json')
  const { wasm } = await loadFixture('puts')
  const inst = instantiate(wasm, Role.Sim, scenario.config, { onLog() {} })

  const checkpoints = runHashScenario(inst, scenario)

  expect(checkpoints).toHaveLength(1)
  expect(checkpoints).toEqual(golden.checkpoints)
  // Different from the zero-connection golden (the whole point of a separate scenario/golden
  // pair): a real assertion, not a tautology, since both fixtures share the same seed/config.
  const idleGolden = readGolden<Golden>('puts', 'golden.json')
  expect(checkpoints[0]).not.toBe(idleGolden.checkpoints[0])
})

/**
 * docs/plan/16-action-round-trip.md step 5: the WASM-under-Node leg of `puts_script_a`'s golden,
 * `puts_scenarios.rs`'s `puts_script_a_golden` native leg's own counterpart -- both compare
 * against `golden/golden-script-a.json`, so this and the native test prove `.wasm` matches native
 * transitively (`wasm_idle_100_matches_native`'s own precedent, above). `runScriptScenario`'s own
 * doc comment has the two-instance ("sim" + "encoder") shape this drives; the value must not move
 * (`d5fd55ce8f13a67e` since M21, when `entity_at` became real and the script's `Bump`/`Remove` began
 * finding their entity; `7bdddfc9c749b1fb` before, unchanged from when this golden was native-only).
 */
test('wasm_script_a_matches_native', async () => {
  const scenario = readGolden<ScriptScenario>('puts', 'scenario-script-a.json')
  const golden = readGolden<Golden>('puts', 'golden-script-a.json')
  const { wasm } = await loadFixture('puts')
  const sim = instantiate(wasm, Role.Sim, scenario.config, { onLog() {} })
  const encoder = instantiate(wasm, Role.Client, scenario.encoderConfig, { onLog() {} })

  const checkpoints = runScriptScenario(sim, encoder, scenario)

  expect(checkpoints).toHaveLength(1)
  expect(checkpoints).toEqual(golden.checkpoints)
  expect(checkpoints[0]).toBe('d5fd55ce8f13a67e')
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

/**
 * docs/plan/15b-ring-connection-and-replica-rendering.md step 3: `SimHost.accept` over a real, real
 * `.wasm` instance, driven through a real SAB ring pair (`RingConnection`, an in-thread "client"
 * consumer on the other end -- no worker, `createRing`/`RingProducer`/`RingConsumer` directly, same
 * shape `ring-connection.test.ts` already exercises). Compared against a *second* real instance of
 * the same fixture, `accept`-ed with a plain in-memory `Connection` that bypasses the ring entirely
 * (captures every `send()` call's bytes verbatim): with the same config/seed and the same tick
 * count, `Host::connect`'s own queued `Record::Player` events and every subsequent tick are
 * bit-for-bit deterministic (0002), so both instances must reach the same `sim_hash()` and produce
 * byte-identical frames, in order -- proving the ring path neither drops, reorders nor corrupts
 * anything relative to the direct ABI path.
 */
function noopTimer() {
  return { every: () => () => {} }
}

test('host_accepts_ring_connection_and_hashes_match', async () => {
  const scenario = readGolden<HashScenario>('puts', 'scenario.json')
  const { wasm } = await loadFixture('puts')

  // A: the real, in-browser production path -- a real SAB ring pair, `RingConnection` on the sim
  // side, a plain `RingProducer`/`RingConsumer` pair standing in for the client worker's own end.
  const instA = instantiate(wasm, Role.Sim, scenario.config, { onLog() {} })
  const simA = wrapEngineInstance(instA)
  const hostA = createSimHostFromInstance(simA, { clock: { now: () => 0 }, timer: noopTimer() })
  const uplink = createRing(1024, 64)
  const downlink = createRing(1024, 512)
  const clientDownlinkIn = new RingConsumer(downlink)
  const connection = new RingConnection(uplink, downlink, {
    maxUplinkBytes: simA.rxBytes(),
    maxDownlinkBytes: simA.txBytes(),
  })
  const connIdA = hostA.accept(connection)
  expect(connIdA).toBe(0)

  // B: the direct ABI path, no ring at all -- `accept`'s own generic `Connection` contract lets a
  // plain in-memory stub stand in, capturing exactly what `send()` was called with.
  const instB = instantiate(wasm, Role.Sim, scenario.config, { onLog() {} })
  const simB = wrapEngineInstance(instB)
  const hostB = createSimHostFromInstance(simB, { clock: { now: () => 0 }, timer: noopTimer() })
  const framesB: Uint8Array[] = []
  // `send`'s own type carries only 0009's fixed `(cls, bytes)` shape; the real `RingConnection`
  // this fixture's own production path always uses instead reads a third, optional `len` (Deviations
  // -- ruling 2's "whole persistent region view, real length as a separate number" fix), so this
  // stand-in also accepts and respects it, the same way `frameA`'s own capture below does with
  // `simA.txBytes()`/`n` rather than assuming `bytes.length` is the real message length.
  const fakeConnection = {
    datagrams: false,
    onMessage: null,
    onClose: null,
    send: (_cls: MsgClass, bytes: Uint8Array, len?: number) => {
      framesB.push(bytes.slice(0, len ?? bytes.length))
    },
    close: () => {},
  } satisfies Connection
  const connIdB = hostB.accept(fakeConnection)
  expect(connIdB).toBe(0)

  hostA.stepTick(20)
  hostB.stepTick(20)

  expect(hostA.hash()).toBe(hostB.hash())
  expect(hostA.hash()).not.toBe('0000000000000000')

  const dst = new Uint8Array(simA.txBytes())
  const framesA: Uint8Array[] = []
  for (;;) {
    const n = clientDownlinkIn.popInto(dst, 0)
    if (n < 0) break
    framesA.push(dst.slice(0, n))
  }
  expect(framesA.length).toBeGreaterThan(0)
  expect(framesA.length).toBe(framesB.length)
  for (let i = 0; i < framesA.length; i++) {
    expect(Array.from(framesA[i] as Uint8Array)).toEqual(Array.from(framesB[i] as Uint8Array))
  }

  expect(connection.downlinkRetries).toBe(0)
  expect(connection.drops).toBe(0)
})
