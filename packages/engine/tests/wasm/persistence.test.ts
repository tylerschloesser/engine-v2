// docs/plan/22-persistence-log-and-snapshots.md step 6, Tests added (Vitest, WASM under Node): the
// `Persistence` write side wired into a real `SimHost` over `fx-persist`'s built `.wasm`, driving
// the real ABI (`sim_seal_frame`/`sim_dirty`/`sim_segment_header`/`sim_snapshot_begin`/
// `sim_snapshot_next`). `storage_conformance_memory` (step 5, no fixture needed) lives beside its
// source instead: `../../src/storage/conformance.test.ts`.
import { describe, expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import { Persistence } from '../../src/host/persistence.js'
import type { EngineInstance } from '../../src/loader.js'
import { instantiate } from '../../src/loader.js'
import {
  buildSimInstanceConfig,
  createSimHostFromInstance,
  type SimHost,
  wrapEngineInstance,
} from '../../src/server.js'
import { memoryStorage } from '../../src/storage/memory.js'
import type { Storage } from '../../src/storage/types.js'
import { expectWithinBudget } from '../support/budgets.js'
import { loadFixture } from '../support/fixtures.js'

const CFG = {
  worldId: 'w1',
  buildHash: 'ab'.repeat(32),
  params: { seed: '7', worldgen: null },
}

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

/** A fresh `EngineInstance` over `fx-persist`'s real `.wasm` (built once per `pnpm test` run, this
 * package's own `fixtures` build step). Genesis has *not* run yet: `Persistence.create` (like
 * `createSimHost`'s own real order) must build segment 0's header before the world exists. */
async function freshInstance(): Promise<EngineInstance> {
  const { wasm } = await loadFixture('persist')
  return instantiate(wasm, Role.Sim, buildSimInstanceConfig(CFG))
}

function setup(
  inst: EngineInstance,
  storage: Storage,
): { host: SimHost; persistence: Persistence; timer: ReturnType<typeof manualTimer> } {
  const persistence = Persistence.create(storage, CFG, inst)
  const timer = manualTimer()
  const host = createSimHostFromInstance(
    wrapEngineInstance(inst),
    { clock: { now: () => 0 }, timer: timer.services },
    persistence,
  )
  return { host, persistence, timer }
}

describe('Persistence wired into a real SimHost (fx-persist)', () => {
  test('write_ahead_order', async () => {
    const inst = await freshInstance()
    const storage = memoryStorage()
    const persistence = Persistence.create(storage, CFG, inst)

    // Queue a connection event (`Record::Player{Joined}`) *before* genesis, so it is already
    // pending for the very first tick `host.stepTick(1)` below runs -- `Host::connect` never
    // touches `self.sim`, so this is safe even before `sim_genesis`.
    const connectStatus = inst.call1(inst.x.sim_connect, 0)
    expect(connectStatus).toBe(Status.Ok)

    const calls: string[] = []
    const originalAppend = storage.append.bind(storage)
    storage.append = (key, bytes) => {
      calls.push('append')
      return originalAppend(key, bytes)
    }
    // `RawExports` properties (`inst.x.*`) are the WASM module's own exports object, non-writable
    // by spec: the spy has to wrap `SimInstance.simTick` (`wrapEngineInstance`'s own plain object
    // literal, freely reassignable) instead of the raw export.
    const simInstance = wrapEngineInstance(inst)
    const originalTick = simInstance.simTick.bind(simInstance)
    simInstance.simTick = () => {
      calls.push('tick')
      return originalTick()
    }
    const timer = manualTimer()
    const host = createSimHostFromInstance(
      simInstance,
      { clock: { now: () => 0 }, timer: timer.services },
      persistence,
    )

    host.stepTick(1)

    expect(calls).toEqual(['append', 'tick'])
  })

  test('sync_at_most_once_per_second', async () => {
    const inst = await freshInstance()
    const storage = memoryStorage()
    const { host, persistence } = setup(inst, storage)
    const syncCalls: string[] = []
    const originalSync = storage.sync.bind(storage)
    storage.sync = (key) => {
      syncCalls.push(key)
      return originalSync(key)
    }

    inst.call1(inst.x.sim_connect, 0) // one dirtying write (Joined -> put_player) before tick 1
    host.stepTick(1)
    expect(persistence.counters.syncs).toBe(0) // 20 Hz: 1 tick is nowhere near a full second

    host.stepTick(18) // ticks 2..19: still short of the 20-tick (1 s) cadence
    expect(persistence.counters.syncs).toBe(0)

    host.stepTick(1) // tick 20: exactly one second's worth of ticks since the append
    expect(persistence.counters.syncs).toBe(1)
    expect(syncCalls).toHaveLength(1)

    // Nothing new was appended since that sync: the barrier must not fire again just because more
    // ticks pass (the "when dirty" half of "at most once per second when dirty").
    host.stepTick(40)
    expect(persistence.counters.syncs).toBe(1)
  })

  test('snapshot_every_1200_ticks_if_dirty', async () => {
    const inst = await freshInstance()
    const storage = memoryStorage()
    const { host, persistence } = setup(inst, storage)

    inst.call1(inst.x.sim_connect, 0) // dirties the world (Joined -> put_player) before tick 1
    host.stepTick(1200)
    expect(persistence.counters.snapshots).toBe(1)
    expect(persistence.counters.lastSnapshotBytes).toBeGreaterThan(0)

    const snapKeys = await storage.list(`worlds/${CFG.worldId}/snap/`)
    expect(snapKeys).toHaveLength(1)

    // Dirty again, well before the next 1,200-tick boundary: the *next* boundary must snapshot
    // too, not just the first one ever.
    const conn2 = inst.call1(inst.x.sim_connect, 1)
    expect(conn2).toBe(Status.Ok)
    host.stepTick(1200) // ticks 1201..2400
    expect(persistence.counters.snapshots).toBe(2)
  })

  test('no_snapshot_when_clean', async () => {
    const inst = await freshInstance()
    const storage = memoryStorage()
    const { host, persistence } = setup(inst, storage)

    // No connection, no action: genesis's own writes (`put_global`/`set_tile`) still dirty the
    // world once, so the *first* 1,200-tick boundary snapshots -- this is what makes the second
    // boundary below a real assertion instead of "nothing was ever dirty in the first place".
    host.stepTick(1200)
    expect(persistence.counters.snapshots).toBe(1)

    // Purely idle ticks from here (no records, no timers pending): must not snapshot again.
    host.stepTick(1200)
    expect(persistence.counters.snapshots).toBe(1)
  })

  test('tick_path_never_awaits', async () => {
    const inst = await freshInstance()
    const storage = memoryStorage()
    // Every write-side method returns a promise that never settles: if anything on the tick path
    // awaited it, `stepTick` below would not finish within this same synchronous call.
    storage.append = () => new Promise<void>(() => {})
    storage.sync = () => new Promise<void>(() => {})
    storage.write = () => new Promise<void>(() => {})
    const { host, persistence } = setup(inst, storage)
    inst.call1(inst.x.sim_connect, 0)

    // Enough ticks to exercise append, sync and snapshot cadences all at once (1,200+ crosses a
    // snapshot boundary; every one of the 20-tick windows in between crosses a sync boundary).
    host.stepTick(1300)

    // Reached synchronously: if `afterTick`/`appendFrame`/`snapshotNow` had ever awaited one of the
    // hung promises above, execution would have yielded before `stepTick` returned, and this line
    // would not have run inside the same microtask turn as the call above.
    expect(host.counters.ticksRun).toBe(1300)
    // The stronger half: `ticksRun` alone would still reach 1,300 even if `appendFrame` were made
    // `async` and awaited a hung `storage.append` internally (nothing in `runOneTick` awaits
    // `logSink`'s own return value either way) -- only the counters `appendFrame`/`snapshotNow`
    // update *after* their own storage call prove that call actually completed synchronously.
    expect(persistence.counters.frames).toBeGreaterThan(0)
    expect(persistence.counters.snapshots).toBeGreaterThan(0)
    expect(persistence.counters.syncs).toBeGreaterThan(0)
  })

  test('storage_onError_is_fatal', async () => {
    const inst = await freshInstance()
    const storage = memoryStorage()
    const { host } = setup(inst, storage)
    inst.call1(inst.x.sim_connect, 0)
    host.stepTick(1) // proves the world was healthy before the injected error

    expect(storage.onError).not.toBeNull()
    storage.onError?.(new Error('simulated adapter failure'))

    expect(() => host.stepTick(1)).toThrow(/fatal/i)
  })

  test('bytes_per_logged_action (counter vs budgets file)', async () => {
    const inst = await freshInstance()
    const storage = memoryStorage()
    const { host, persistence } = setup(inst, storage)

    inst.call1(inst.x.sim_connect, 0)
    host.stepTick(1) // the Joined connection frame; not what this test measures

    // A real action-carrying frame, driven through the real admit pipeline the same way
    // `tests/support/scenario.ts`'s `runScriptScenario` does: a second, client-role instance of
    // the same `.wasm` turns the action into real wire bytes (`on_action` + `client_poll_uplink`),
    // copied into the sim instance's own `Rx` region for `sim_admit` -- no hand-encoded postcard.
    const { wasm } = await loadFixture('persist')
    const encoder = instantiate(wasm, Role.Client, buildSimInstanceConfig(CFG))
    const encoderRx = encoder.region(RegionId.Rx)
    const encoderTx = encoder.region(RegionId.Tx)
    const simRx = inst.region(RegionId.Rx)
    if (!encoderRx || !encoderTx || !simRx) throw new Error('Rx/Tx region missing')
    const json = new TextEncoder().encode(JSON.stringify('Roll'))
    const record = new Uint8Array(8 + json.length)
    const view = new DataView(record.buffer)
    view.setUint32(0, 1, true) // seq
    view.setUint32(4, json.length, true)
    record.set(json, 8)
    encoderRx.u8.set(record)
    expect(encoder.call1(encoder.x.on_action, record.length)).toBe(Status.Ok)
    const uplinkLen = encoder.call1(encoder.x.client_poll_uplink, 0)
    expect(uplinkLen).toBeGreaterThan(0)
    simRx.u8.set(encoderTx.u8.subarray(0, uplinkLen))
    expect(inst.call2(inst.x.sim_admit, 0, uplinkLen)).toBe(Status.Ok)

    const framesBefore = persistence.counters.frames
    const bytesBefore = persistence.counters.logBytes
    host.stepTick(1) // applies the Roll action, sealing one real action-carrying frame

    const frameBytes = persistence.counters.logBytes - bytesBefore
    expect(persistence.counters.frames).toBe(framesBefore + 1)
    expect(frameBytes).toBeGreaterThan(0)
    expectWithinBudget('counters.action.logBytesPerAction', frameBytes)
  })

  test('snapshot_buffer_high_water_is_tracked', async () => {
    const inst = await freshInstance()
    const storage = memoryStorage()
    const { host, persistence } = setup(inst, storage)
    inst.call1(inst.x.sim_connect, 0)
    host.stepTick(1200)
    expect(persistence.counters.snapshots).toBe(1)
    expect(persistence.snapshotBufferHighWaterBytes).toBeGreaterThan(0)
    expect(persistence.snapshotBufferHighWaterBytes).toBeGreaterThanOrEqual(
      persistence.counters.lastSnapshotBytes,
    )
  })
})
