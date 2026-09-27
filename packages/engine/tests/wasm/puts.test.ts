// The WASM-under-Node leg of `fx-puts`'s idle-100 golden (docs/plan/13-sim-host-tick-loop.md step
// 3): the `.wasm` run's hash after 100 idle ticks (no actions -- Actions are M16, Non-scope) equals
// `golden/golden.json`, which `pnpm golden puts` writes from this very run (0002, 0020 §5) and which
// the native leg (`fixtures/puts/tests/puts_scenarios.rs`'s `puts_idle_100_golden`, driving
// `Sim<Puts>` directly) is compared against too -- so this and the native test prove `.wasm` matches
// native transitively, through the one shared golden file.
//
// docs/plan/27-server-entrypoint-and-netcode-harness.md, Order of work 1 ("move the wasm suite
// onto [createWorldServer]"): these three golden tests (idle, connected, script-a) are the ones
// that actually drive a real `Game` (`fx-puts`, `Host<G>`-based) through the sim role -- unlike
// `determinism.test.ts`/`worldgen.test.ts` (`fx-hash`/`fx-worldgen`, low-level `export_instance!`
// fixtures with no `Host<G>`, hence no `sim_seal_frame` support: `wrapEngineInstance.simSealFrame`
// throws on their default `Status::Unsupported`), so those two stay on the raw `instantiate` path.
// Each test now ticks through `createWorldServer` with `memoryStorage()` (0020 §3: "the built
// game+engine `.wasm` through the server entrypoint"), then reads the checkpoint hash back by
// reloading the same storage through `Persistence.open` -- a real round trip through the log/
// snapshot machinery `createWorldServer` builds on, not merely a `sim_hash()` call on the ticked
// instance (`WorldServer`'s own `{ ready, accept, stop }` shape exposes neither). Every golden value
// is unchanged (Deviations): `sim_seal_frame`/`sim_dirty` calls do not touch `Sim::state_hash()`
// (`crates/engine/src/host/mod.rs`'s own `sim_hash`/`sim_tick`), and replay reconstructs identical
// state by construction (0005) -- proven here by these same three hashes matching the values this
// milestone's base commit already checked in.
import { expect, test } from 'vitest'
import { RegionId, Role } from '../../src/abi.js'
import { Persistence } from '../../src/host/persistence.js'
import { instantiate } from '../../src/loader.js'
import { RingConnection } from '../../src/ring-connection.js'
import { createRing, RingConsumer } from '../../src/sab/ring.js'
import {
  buildSimInstanceConfig,
  type Connection,
  createSimHostFromInstance,
  createWorldServer,
  MAX_CATCHUP_TICKS,
  type MsgClass,
  RESYNC_TICKS,
  type WorldConfig,
  wrapEngineInstance,
} from '../../src/server.js'
import { memoryStorage } from '../../src/storage/memory.js'
import { loadFixture, readGolden } from '../support/fixtures.js'
import type { Golden, HashScenario, ScriptScenario } from '../support/scenario.js'

/** `fixtures/puts/golden/scenario*.json`'s own `config`, reconstructed as a `WorldConfig`
 * (`buildSimInstanceConfig`'s inverse): `seed: "0x1"` decimal is `"1"`, and every other field is
 * already the scenario's own default -- `buildSimInstanceConfig(WORLD_CFG)` reproduces the exact
 * `InstanceConfig` the scenario files carry, plus one harmless addition (`game.buildHash`, absent
 * from the checked-in scenario JSON: `Sim::state_hash()` never reads it, only `Persistence`'s own
 * identity bookkeeping does). */
const WORLD_CFG: WorldConfig = {
  worldId: 'w-puts-golden',
  buildHash: 'ab'.repeat(32),
  params: {
    seed: '1',
    worldgen: null,
    maxEntities: 262144,
    maxModifiedTiles: 1048576,
    maxActionGrowth: 4096,
  },
  cacheChunks: 1024,
  arenaBytes: 100663296,
}

function fakeConnection(): Connection {
  return { datagrams: false, onMessage: null, onClose: null, send: () => {}, close: () => {} }
}

/** Ticks `worldCfg` through a real `createWorldServer` for `ticks` ticks (`connectAtStart`: accept
 * one connection before the first tick, `puts_idle_100`/`_connected`'s own "once, before the loop"
 * shape), then stops it and reads the checkpoint hash back by reopening the same storage through
 * `Persistence.open` -- the only way to read a state hash once ticking happened behind
 * `WorldServer`'s own `{ ready, accept, stop }` surface. */
async function tickPutsThroughServer(
  wasm: WebAssembly.Module,
  worldCfg: WorldConfig,
  ticks: number,
  connectAtStart: boolean,
): Promise<{ hash: string; memGrows: number }> {
  const storage = memoryStorage()
  const timer = manualTimer()
  const server = createWorldServer(worldCfg, {
    wasm,
    storage,
    clock: { now: () => 0 },
    timer: timer.services,
  })
  await server.ready
  if (connectAtStart) server.accept(fakeConnection())
  for (let i = 0; i < ticks; i++) timer.fire()
  await server.stop()

  const newInstance = () => instantiate(wasm, Role.Sim, buildSimInstanceConfig(worldCfg))
  const reopened = await Persistence.open(storage, worldCfg, newInstance)
  return { hash: wrapEngineInstance(reopened.sim).simHash(), memGrows: reopened.sim.memGrows() }
}

test('wasm_idle_100_matches_native', async () => {
  const golden = readGolden<Golden>('puts', 'golden.json')
  const { wasm } = await loadFixture('puts')

  const { hash, memGrows } = await tickPutsThroughServer(wasm, WORLD_CFG, 100, false)

  expect(hash).toBe(golden.checkpoints[0])
  // The reload's own instance: one growth at init, none after (0015 §5) -- `createWorldServer`'s
  // own ticking instance is not directly observable through `WorldServer`'s public surface.
  expect(memGrows).toBe(0)
})

// docs/plan/15b-ring-connection-and-replica-rendering.md, Orchestrator ruling 1: `puts_idle_100`
// stays the zero-connection golden above; a connection changes `sim_hash()` from the very first
// tick (`Host::connect`'s own queued `Record::Player{Joined, Connected}`, which `fx-puts`'s
// `on_player` turns into a real state write), so it gets its own scenario/golden pair
// (`scenario-connected.json`/`golden-connected.json`, `pnpm golden puts`) rather than a re-blessed
// `golden.json`.
test('wasm_connected_100_matches_its_own_golden', async () => {
  const golden = readGolden<Golden>('puts', 'golden-connected.json')
  const { wasm } = await loadFixture('puts')

  const { hash } = await tickPutsThroughServer(wasm, WORLD_CFG, 100, true)

  expect(hash).toBe(golden.checkpoints[0])
  // Different from the zero-connection golden (the whole point of a separate scenario/golden
  // pair): a real assertion, not a tautology, since both runs share the same config/seed.
  const idleGolden = readGolden<Golden>('puts', 'golden.json')
  expect(hash).not.toBe(idleGolden.checkpoints[0])
})

/**
 * docs/plan/16-action-round-trip.md step 5: the WASM-under-Node leg of `puts_script_a`'s golden,
 * `puts_scenarios.rs`'s `puts_script_a_golden` native leg's own counterpart -- both compare against
 * `golden/golden-script-a.json`, so this and the native test prove `.wasm` matches native
 * transitively (`wasm_idle_100_matches_native`'s own precedent, above). The value must not move
 * (`0a7cc2623a83a03e` since M21b added timer/wake/active sections to `Store::encode`;
 * `d5fd55ce8f13a67e` at M21, when `entity_at` became real and the script's `Bump`/`Remove` began
 * finding their entity; `7bdddfc9c749b1fb` before, unchanged from when this golden was native-only).
 * A second, `Role.Client` instance (`encoderConfig`) still turns each scripted action's JSON into
 * real wire bytes (`on_action` + `client_poll_uplink`, `runScriptScenario`'s own two-instance
 * shape) -- only the *delivery* moved, from a direct `sim_admit` call onto the accepted
 * connection's own `onMessage`, exactly the path a real `Connection` implementation drives.
 */
test('wasm_script_a_matches_native', async () => {
  const scenario = readGolden<ScriptScenario>('puts', 'scenario-script-a.json')
  const golden = readGolden<Golden>('puts', 'golden-script-a.json')
  const { wasm } = await loadFixture('puts')
  const encoder = instantiate(wasm, Role.Client, scenario.encoderConfig, { onLog() {} })
  const scriptEncoder = new TextEncoder()

  const storage = memoryStorage()
  const timer = manualTimer()
  const server = createWorldServer(WORLD_CFG, {
    wasm,
    storage,
    clock: { now: () => 0 },
    timer: timer.services,
  })
  await server.ready
  const conn = fakeConnection()

  let tick = 0
  for (const entry of scenario.script) {
    while (tick + 1 < entry.tick) {
      timer.fire()
      tick += 1
    }
    if (entry.connect) server.accept(conn)
    for (const { seq, action } of entry.actions ?? []) {
      const json = scriptEncoder.encode(JSON.stringify(action))
      const record = new Uint8Array(8 + json.length)
      const view = new DataView(record.buffer)
      view.setUint32(0, seq, true)
      view.setUint32(4, json.length, true)
      record.set(json, 8)
      const encoderRx = encoder.region(RegionId.Rx)
      if (!encoderRx) throw new Error('encoder Rx region is missing')
      encoderRx.u8.set(record)
      encoder.call1(encoder.x.on_action, record.length)
      const len = encoder.call1(encoder.x.client_poll_uplink, 0)
      const encoderTx = encoder.region(RegionId.Tx)
      if (!encoderTx) throw new Error('encoder Tx region is missing')
      // Delivered through the accepted connection's own wired `onMessage` (Seams: `SimHost.accept`
      // sets it), exactly like a real transport handing this connection a message -- not a direct
      // `sim.simAdmit` call.
      conn.onMessage?.(encoderTx.u8.slice(0, len))
    }
    timer.fire()
    tick = entry.tick
  }
  while (tick < scenario.checkpointAt) {
    timer.fire()
    tick += 1
  }

  await server.stop()
  const newInstance = () => instantiate(wasm, Role.Sim, buildSimInstanceConfig(WORLD_CFG))
  const reopened = await Persistence.open(storage, WORLD_CFG, newInstance)
  const hash = wrapEngineInstance(reopened.sim).simHash()

  expect(hash).toBe(golden.checkpoints[0])
  expect(hash).toBe('0a7cc2623a83a03e')
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
