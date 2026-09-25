// docs/plan/22b-persistence-load-and-fs.md, Order of work step 2: `Persistence.open` happy path
// (create-or-load, resume tick) and the crash matrix, driven through the *real* pipeline (a real
// `SimHost` + `Persistence` over the built `.wasm`, with `Connected` records in the log) per the
// brief's own instruction -- never a hand-built container.
import { describe, expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import { Persistence, WorldLoadError } from '../../src/host/persistence.js'
import type { EngineInstance } from '../../src/loader.js'
import { instantiate } from '../../src/loader.js'
import {
  buildSimInstanceConfig,
  createSimHostFromInstance,
  wrapEngineInstance,
} from '../../src/server.js'
import type { MemoryStorage } from '../../src/storage/memory.js'
import { memoryStorage } from '../../src/storage/memory.js'
import { worldKeys } from '../../src/storage/types.js'
import { loadFixture } from '../support/fixtures.js'

const CFG = {
  worldId: 'w1',
  buildHash: 'ab'.repeat(32),
  params: { seed: '7', worldgen: null },
}

let wasmModule: WebAssembly.Module | undefined
async function wasm(): Promise<WebAssembly.Module> {
  if (!wasmModule) wasmModule = (await loadFixture('persist')).wasm
  return wasmModule
}

async function makeNewInstance(cfg: typeof CFG = CFG): Promise<() => EngineInstance> {
  const mod = await wasm()
  return () => instantiate(mod, Role.Sim, buildSimInstanceConfig(cfg))
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

/** A real admitted action, driven through a second client-role instance of the same `.wasm`
 * exactly as `tests/support/scenario.ts`'s `runScriptScenario` does (`bytes_per_logged_action`'s
 * own precedent in `persistence.test.ts`) -- never a hand-encoded postcard. `Roll` is additive
 * (bumps a global counter by a nonzero amount every call): applying it twice is observably
 * different from applying it once, unlike an idempotent action (M16's lesson, this brief's own
 * "use an additive action, not idempotent" note). */
async function admitRoll(sim: EngineInstance, seq: number): Promise<void> {
  const mod = await wasm()
  const encoder = instantiate(mod, Role.Client, buildSimInstanceConfig(CFG))
  const encoderRx = encoder.region(RegionId.Rx)
  const encoderTx = encoder.region(RegionId.Tx)
  const simRx = sim.region(RegionId.Rx)
  if (!encoderRx || !encoderTx || !simRx) throw new Error('Rx/Tx region missing')
  const json = new TextEncoder().encode(JSON.stringify('Roll'))
  const record = new Uint8Array(8 + json.length)
  const view = new DataView(record.buffer)
  view.setUint32(0, seq, true)
  view.setUint32(4, json.length, true)
  record.set(json, 8)
  encoderRx.u8.set(record)
  const onActionStatus = encoder.call1(encoder.x.on_action, record.length)
  if (onActionStatus !== Status.Ok) throw new Error(`on_action failed: status ${onActionStatus}`)
  const uplinkLen = encoder.call1(encoder.x.client_poll_uplink, 0)
  if (uplinkLen <= 0) throw new Error('encoder produced no uplink batch')
  simRx.u8.set(encoderTx.u8.subarray(0, uplinkLen))
  const admitStatus = sim.call2(sim.x.sim_admit, 0, uplinkLen)
  if (admitStatus !== Status.Ok) throw new Error(`sim_admit failed: status ${admitStatus}`)
}

describe('Persistence.open (fx-persist, real pipeline)', () => {
  test('open_creates_a_fresh_world_when_no_manifest_exists', async () => {
    const storage = memoryStorage()
    const ni = await makeNewInstance()
    const { persistence, sim, outcome, tick, truncatedBytes } = await Persistence.open(
      storage,
      CFG,
      ni,
    )
    expect(outcome).toBe('created')
    expect(tick).toBe(0)
    expect(truncatedBytes).toBe(0)
    expect(persistence).toBeDefined()
    expect(sim.call0(sim.x.sim_genesis)).toBe(Status.Ok) // genesis is deferred, like `SimHost`'s own
  })

  test('open_loads_a_clean_world_exactly_where_it_left_off', async () => {
    const storage = memoryStorage()
    const instA = instantiate(await wasm(), Role.Sim, buildSimInstanceConfig(CFG))
    const persistenceA = Persistence.create(storage, CFG, instA)
    const timer = manualTimer()
    const hostA = createSimHostFromInstance(
      wrapEngineInstance(instA),
      { clock: { now: () => 0 }, timer: timer.services },
      persistenceA,
    )
    expect(instA.call1(instA.x.sim_connect, 0)).toBe(Status.Ok)
    hostA.stepTick(1)
    await admitRoll(instA, 1)
    hostA.stepTick(1)
    const wantHash = hostA.hash()
    const wantTick = hostA.counters.ticksRun

    const ni = await makeNewInstance()
    const { outcome, tick, truncatedBytes, sim } = await Persistence.open(storage, CFG, ni)
    expect(outcome).toBe('loaded')
    expect(truncatedBytes).toBe(0)
    expect(tick).toBe(wantTick)
    expect(sim.call0(sim.x.sim_hash)).toBe(Status.Ok)
    expect(sim.readU64Hex(RegionId.Result, 0)).toBe(wantHash)
  })

  /** 0009 `WorldConfig.params`: "WORLD PARAMS: read only when storage holds no world, then stored
   * with genesis and fixed for the world's life; a stored world ignores this block". Builds a world
   * under one seed (real `Roll` actions, so the seed genuinely drives state through `SimRng` -- a
   * `snapshotNow()` partway through, so the reload restores rather than genesis-replays), reopens
   * with a *different* `cfg.params` and a `newInstance` built from those same different params (a
   * careless caller, not merely a differently-worded but equivalent one), and checks the reload
   * still reproduces the original seed's own history: the restored `Sim`'s `Authority`/`SimRng`
   * always replace whatever `newInstance`'s own fresh genesis would have produced. */
  test('load_ignores_config_params_when_world_exists', async () => {
    const storage = memoryStorage()
    const mod = await wasm()
    const inst = instantiate(mod, Role.Sim, buildSimInstanceConfig(CFG))
    const persistence = Persistence.create(storage, CFG, inst)
    const timer = manualTimer()
    const host = createSimHostFromInstance(
      wrapEngineInstance(inst),
      { clock: { now: () => 0 }, timer: timer.services },
      persistence,
    )
    expect(inst.call1(inst.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1)
    await admitRoll(inst, 1)
    host.stepTick(1)
    persistence.snapshotNow() // a real snapshot exists: reload restores, it does not genesis-replay
    await admitRoll(inst, 2)
    host.stepTick(1)
    const wantHash = host.hash()
    const wantTick = host.counters.ticksRun

    const keys = worldKeys(CFG.worldId)
    const manifestBefore = await storage.read(keys.manifest)
    if (!manifestBefore) throw new Error('expected a manifest to exist')

    const otherCfg = { ...CFG, params: { seed: '999999999', worldgen: null } }
    const ni = () => instantiate(mod, Role.Sim, buildSimInstanceConfig(otherCfg))
    const { outcome, tick, sim } = await Persistence.open(storage, otherCfg, ni)
    expect(outcome).toBe('loaded')
    expect(tick).toBe(wantTick)
    expect(sim.call0(sim.x.sim_hash)).toBe(Status.Ok)
    expect(sim.readU64Hex(RegionId.Result, 0)).toBe(wantHash)

    // Not vacuous: the seed genuinely drives state here -- an independent genesis under the *other*
    // seed, replaying the identical script from scratch, reaches a different hash.
    const altInst = instantiate(mod, Role.Sim, buildSimInstanceConfig(otherCfg))
    const altPersistence = Persistence.create(memoryStorage(), otherCfg, altInst)
    const altTimer = manualTimer()
    const altHost = createSimHostFromInstance(
      wrapEngineInstance(altInst),
      { clock: { now: () => 0 }, timer: altTimer.services },
      altPersistence,
    )
    expect(altInst.call1(altInst.x.sim_connect, 0)).toBe(Status.Ok)
    altHost.stepTick(1)
    await admitRoll(altInst, 1)
    altHost.stepTick(1)
    await admitRoll(altInst, 2)
    altHost.stepTick(1)
    expect(altHost.hash()).not.toBe(wantHash)

    // The manifest's own `params` (and the whole manifest) is unchanged, byte for byte.
    const manifestAfter = await storage.read(keys.manifest)
    expect(manifestAfter).toEqual(manifestBefore)
  })

  /** Builds a world with two real logged frames (tick 1: Joined+Connected; tick 2: an admitted
   * `Roll`), returning the storage plus enough to compute exact cut points on the final frame. */
  async function buildTwoFrameWorld(): Promise<{
    storage: MemoryStorage
    logKeyBeforeLen: number
    logKeyAfterLen: number
    hashAtTick1: string
    hashAtTick2: string
  }> {
    const storage = memoryStorage()
    const inst = instantiate(await wasm(), Role.Sim, buildSimInstanceConfig(CFG))
    const persistence = Persistence.create(storage, CFG, inst)
    const timer = manualTimer()
    const host = createSimHostFromInstance(
      wrapEngineInstance(inst),
      { clock: { now: () => 0 }, timer: timer.services },
      persistence,
    )
    expect(inst.call1(inst.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1)
    const hashAtTick1 = host.hash()
    const keys = worldKeys(CFG.worldId)
    const logBefore = await storage.read(keys.log(0))
    if (!logBefore) throw new Error('expected segment 0 to exist')

    await admitRoll(inst, 1)
    host.stepTick(1)
    const hashAtTick2 = host.hash()
    const logAfter = await storage.read(keys.log(0))
    if (!logAfter) throw new Error('expected segment 0 to still exist')

    return {
      storage,
      logKeyBeforeLen: logBefore.length,
      logKeyAfterLen: logAfter.length,
      hashAtTick1,
      hashAtTick2,
    }
  }

  test('crash_mid_frame_truncates_and_resumes', async () => {
    const { storage, logKeyBeforeLen, logKeyAfterLen, hashAtTick1 } = await buildTwoFrameWorld()
    const keys = worldKeys(CFG.worldId)
    const frameLen = logKeyAfterLen - logKeyBeforeLen
    expect(frameLen).toBeGreaterThan(0)

    // Every byte cut of the final frame (0020 §4: shrink the scenario, not the coverage -- this
    // fixture's own frame is a handful of bytes, so every cut is one fast iteration).
    for (let cut = 1; cut <= frameLen; cut++) {
      const clone = storage.crashClone({ dropTailBytes: { [keys.log(0)]: cut } })
      const ni = await makeNewInstance()
      const { outcome, tick, sim } = await Persistence.open(clone, CFG, ni)
      expect(sim.call0(sim.x.sim_hash)).toBe(Status.Ok)
      expect(sim.readU64Hex(RegionId.Result, 0)).toBe(hashAtTick1)
      expect(tick).toBe(1)
      if (cut < frameLen) {
        // Genuinely torn: some but not all of the frame's bytes survived.
        expect(outcome).toBe('recovered')
        // Planning decisions 1: the torn tail is truncated on *disk*, not just skipped in memory
        // (`Storage.write(logKey, validPrefix)`) -- proven by re-reading the clone's own storage,
        // not merely trusting the returned `outcome`/`tick`.
        const onDisk = await clone.read(keys.log(0))
        expect(onDisk?.length).toBe(logKeyBeforeLen)
      }
      // `cut === frameLen`: the whole in-flight frame is simply absent, not torn -- 0005 Loss
      // windows' own "at most the one in-flight frame" admitted-action loss, indistinguishable
      // from the frame never having been sent at all.
    }
  })

  test('recovered_hash_equals_uninterrupted_replay', async () => {
    const { storage, logKeyBeforeLen, logKeyAfterLen, hashAtTick1 } = await buildTwoFrameWorld()
    const keys = worldKeys(CFG.worldId)
    const frameLen = logKeyAfterLen - logKeyBeforeLen
    const clone = storage.crashClone({ dropTailBytes: { [keys.log(0)]: Math.ceil(frameLen / 2) } })
    const ni = await makeNewInstance()
    const { outcome, sim } = await Persistence.open(clone, CFG, ni)
    expect(outcome).toBe('recovered')
    // An uninterrupted replay to the same (recovered) tick, from a completely independent live
    // run stopped at tick 1, must reach the exact same hash.
    expect(sim.call0(sim.x.sim_hash)).toBe(Status.Ok)
    expect(sim.readU64Hex(RegionId.Result, 0)).toBe(hashAtTick1)
  })

  test('crash_torn_snapshot_uses_previous', async () => {
    const storage = memoryStorage()
    const inst = instantiate(await wasm(), Role.Sim, buildSimInstanceConfig(CFG))
    const persistence = Persistence.create(storage, CFG, inst)
    expect(inst.call0(inst.x.sim_genesis)).toBe(Status.Ok)
    persistence.snapshotNow() // tick 0
    const hashAtTick0 = (() => {
      expect(inst.call0(inst.x.sim_hash)).toBe(Status.Ok)
      return inst.readU64Hex(RegionId.Result, 0)
    })()

    const timer = manualTimer()
    const host = createSimHostFromInstance(
      wrapEngineInstance(inst),
      { clock: { now: () => 0 }, timer: timer.services },
      persistence,
    )
    expect(inst.call1(inst.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1)
    persistence.snapshotNow() // tick 1: a second, newer snapshot -- this one will be torn.

    const keys = worldKeys(CFG.worldId)
    const newestKey = keys.snap(1)
    const newestBytes = await storage.read(newestKey)
    if (!newestBytes) throw new Error('expected a snapshot at tick 1')
    const clone = storage.crashClone({ dropTailBytes: { [newestKey]: 1 } })

    const ni = await makeNewInstance()
    const { outcome, tick, sim } = await Persistence.open(clone, CFG, ni)
    expect(outcome).toBe('recovered')
    // Falls back to the tick-0 snapshot, then replays the tail (tick 1's own real frame) on top
    // of it -- reaching the exact same state a clean load would have, not a stale tick-0 one.
    expect(tick).toBe(1)
    expect(sim.call0(sim.x.sim_hash)).toBe(Status.Ok)
    expect(sim.readU64Hex(RegionId.Result, 0)).not.toBe(hashAtTick0)
  })

  test('crash_snapshot_without_log_tail_is_skipped', async () => {
    const storage = memoryStorage()
    const inst = instantiate(await wasm(), Role.Sim, buildSimInstanceConfig(CFG))
    const persistence = Persistence.create(storage, CFG, inst)
    const timer = manualTimer()
    const host = createSimHostFromInstance(
      wrapEngineInstance(inst),
      { clock: { now: () => 0 }, timer: timer.services },
      persistence,
    )
    expect(inst.call1(inst.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1)
    persistence.snapshotNow() // tick 1, log_offset just past tick 1's own frame.

    // Simulate a crash that lost the *log's own tail* (down to before that log position was ever
    // reached) while the snapshot itself survived intact (Planning decisions 3): the snapshot's
    // own CRC still verifies, but it names a log position beyond what the (truncated) log holds.
    const keys = worldKeys(CFG.worldId)
    const logBytes = await storage.read(keys.log(0))
    if (!logBytes) throw new Error('expected segment 0 to exist')
    const clone = storage.crashClone({ dropTailBytes: { [keys.log(0)]: logBytes.length } })

    const ni = await makeNewInstance()
    const { outcome, tick } = await Persistence.open(clone, CFG, ni)
    expect(outcome).toBe('recovered')
    // No usable snapshot survives (the only one is skipped): falls back to a genesis replay of
    // segment 0's own (also-truncated-to-nothing) log, resuming at tick 0.
    expect(tick).toBe(0)
  })

  test('resend_after_recovery_not_applied_twice', async () => {
    const { storage, logKeyBeforeLen, logKeyAfterLen } = await buildTwoFrameWorld()
    const keys = worldKeys(CFG.worldId)
    const frameLen = logKeyAfterLen - logKeyBeforeLen
    const clone = storage.crashClone({ dropTailBytes: { [keys.log(0)]: Math.ceil(frameLen / 2) } })
    const ni = await makeNewInstance()
    const { outcome, sim, persistence } = await Persistence.open(clone, CFG, ni)
    expect(outcome).toBe('recovered')

    const timer = manualTimer()
    const host = createSimHostFromInstance(
      wrapEngineInstance(sim),
      { clock: { now: () => 0 }, timer: timer.services },
      persistence,
    )
    // Session/connection resume after a load is M27/M28's own territory (Non-scope here): a
    // recovered `Sim` has no live `Host::conns` slot at all (replay only ever calls `Sim::step`,
    // never `Host::connect`), so a real caller reconnects the player first, the same as a fresh
    // join -- `Host::connect`'s own `ever_joined` bookkeeping lives on `Host`, not in replayed
    // state, so this reconnect is indistinguishable from a first join from the sim's own view.
    expect(sim.call1(sim.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1)

    // `Roll` (seq 1) never made it into the recovered world (its frame was torn): resend it, then
    // resend it *again* with the same seq -- an additive action, so a double-apply would be
    // observable as a doubled counter bump, unlike an idempotent one (this brief's own note).
    const hashBeforeResend = host.hash()
    await admitRoll(sim, 1)
    host.stepTick(1)
    const hashAfterFirst = host.hash()
    expect(hashAfterFirst).not.toBe(hashBeforeResend) // the first send really did apply
    await admitRoll(sim, 1) // the exact same seq again
    host.stepTick(1)
    const hashAfterResend = host.hash()
    expect(hashAfterResend).toBe(hashAfterFirst) // the resend must not apply a second time
  })

  test('identity_mismatch_throws_world_load_error_and_writes_nothing', async () => {
    const storage = memoryStorage()
    const inst = instantiate(await wasm(), Role.Sim, buildSimInstanceConfig(CFG))
    const persistence = Persistence.create(storage, CFG, inst)
    expect(inst.call0(inst.x.sim_genesis)).toBe(Status.Ok)
    persistence.snapshotNow()

    // Byte-compare the whole storage before/after (the brief's own instruction), every key.
    const keysBefore = await storage.list('')
    const before = new Map<string, Uint8Array | null>()
    for (const k of keysBefore) before.set(k, await storage.read(k))

    const otherCfg = { ...CFG, buildHash: 'cd'.repeat(32) }
    const ni = await makeNewInstance(otherCfg)
    await expect(Persistence.open(storage, otherCfg, ni)).rejects.toBeInstanceOf(WorldLoadError)
    await expect(Persistence.open(storage, otherCfg, ni)).rejects.toMatchObject({
      kind: 'identity',
    })

    const keysAfter = await storage.list('')
    expect(keysAfter).toEqual(keysBefore)
    for (const k of keysAfter) {
      const b = before.get(k)
      const a = await storage.read(k)
      expect(a).toEqual(b)
    }
  })
})
