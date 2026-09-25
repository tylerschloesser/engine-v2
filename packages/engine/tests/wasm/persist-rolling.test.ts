// docs/plan/22b-persistence-load-and-fs.md, Order of work step 3: segment rolling, snapshot
// pruning, and recovering from a crash between a roll's own log/snapshot writes and its manifest
// rewrite -- driven through the real pipeline (a real `SimHost` + `Persistence` over the built
// `.wasm`), the `segmentRollBytes` test option lowering `SEGMENT_ROLL_BYTES` so a roll costs a
// handful of connects, not 4 MiB of log.
import { describe, expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import { Persistence } from '../../src/host/persistence.js'
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

/** Small enough that a handful of `sim_connect` frames rolls the segment, without needing to
 * actually write anywhere near the real `SEGMENT_ROLL_BYTES` (4 MiB) to exercise the logic. */
const TINY_ROLL_BYTES = 64

let wasmModule: WebAssembly.Module | undefined
async function wasm(): Promise<WebAssembly.Module> {
  if (!wasmModule) wasmModule = (await loadFixture('persist')).wasm
  return wasmModule
}

async function freshInstance(): Promise<EngineInstance> {
  return instantiate(await wasm(), Role.Sim, buildSimInstanceConfig(CFG))
}

async function makeNewInstance(): Promise<() => EngineInstance> {
  const mod = await wasm()
  return () => instantiate(mod, Role.Sim, buildSimInstanceConfig(CFG))
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

const textDecoder = new TextDecoder()

describe('segment rolling and pruning (fx-persist)', () => {
  test('segment_rolls_at_snapshot_over_limit', async () => {
    const storage = memoryStorage()
    const inst = await freshInstance()
    const persistence = Persistence.create(storage, CFG, inst, {
      segmentRollBytes: TINY_ROLL_BYTES,
    })
    const timer = manualTimer()
    const host = createSimHostFromInstance(
      wrapEngineInstance(inst),
      { clock: { now: () => 0 }, timer: timer.services },
      persistence,
    )
    const keys = worldKeys(CFG.worldId)

    // Grow segment 0's log past the tiny threshold: each connect logs a real Joined+Connected
    // frame.
    for (let i = 0; i < 6; i++) {
      expect(inst.call1(inst.x.sim_connect, i)).toBe(Status.Ok)
      host.stepTick(1)
    }
    const seg0Before = await storage.read(keys.log(0))
    if (!seg0Before) throw new Error('expected segment 0 to exist')
    expect(seg0Before.length).toBeGreaterThan(TINY_ROLL_BYTES)
    expect(await storage.read(keys.log(1))).toBeNull() // no roll yet -- only a snapshot triggers one

    const rollTick = host.counters.ticksRun
    persistence.snapshotNow()

    // Segment 0 is unchanged (sealed, not rewritten); segment 1 now exists with a real header.
    expect(await storage.read(keys.log(0))).toEqual(seg0Before)
    const seg1 = await storage.read(keys.log(1))
    expect(seg1).not.toBeNull()
    expect(seg1?.length).toBeGreaterThan(0)

    const manifest = JSON.parse(
      textDecoder.decode((await storage.read(keys.manifest)) ?? undefined),
    )
    expect(manifest.segments).toHaveLength(2)
    expect(manifest.segments[0].sealed).toBe(true)
    expect(manifest.segments[1].sealed).toBe(false)
    expect(manifest.segments[1].base).toBe(rollTick)

    // The snapshot just taken is segment 1's own base: loading must land there, not segment 0.
    const ni = await makeNewInstance()
    const { outcome, tick, sim } = await Persistence.open(storage, CFG, ni, {
      segmentRollBytes: TINY_ROLL_BYTES,
    })
    expect(outcome).toBe('loaded')
    expect(tick).toBe(rollTick)
    expect(sim.call0(sim.x.sim_hash)).toBe(Status.Ok)
    expect(sim.readU64Hex(RegionId.Result, 0)).toBe(host.hash())
  })

  test('prune_keeps_bases_and_latest_two', async () => {
    const storage = memoryStorage()
    const inst = await freshInstance()
    const persistence = Persistence.create(storage, CFG, inst, {
      segmentRollBytes: TINY_ROLL_BYTES,
    })
    const timer = manualTimer()
    const host = createSimHostFromInstance(
      wrapEngineInstance(inst),
      { clock: { now: () => 0 }, timer: timer.services },
      persistence,
    )
    const keys = worldKeys(CFG.worldId)

    // A snapshot in segment 0 (not a base: segment 0's own base is 'genesis').
    expect(inst.call1(inst.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1)
    persistence.snapshotNow()

    // Grow segment 0 past the roll threshold, then snapshot again -- this one rolls to segment 1
    // and becomes *its* base (never pruned, Planning decisions 3).
    for (let i = 1; i < 6; i++) {
      expect(inst.call1(inst.x.sim_connect, i)).toBe(Status.Ok)
      host.stepTick(1)
    }
    persistence.snapshotNow()
    const baseTick = host.counters.ticksRun
    const baseKey = keys.snap(baseTick)

    // Two more ordinary snapshots in segment 1.
    expect(inst.call1(inst.x.sim_connect, 6)).toBe(Status.Ok)
    host.stepTick(1)
    persistence.snapshotNow()
    expect(inst.call1(inst.x.sim_connect, 7)).toBe(Status.Ok)
    host.stepTick(1)
    persistence.snapshotNow()

    const prefix = `worlds/${CFG.worldId}/snap/`
    const before = (await storage.list(prefix)).sort()
    expect(before).toHaveLength(4) // nothing pruned yet -- pruning runs only at a clean boundary/load
    expect(before).toContain(baseKey)

    await persistence.pruneSnapshots()
    const after = new Set(await storage.list(prefix))
    const expected = new Set([baseKey, ...before.slice(-2)])
    expect(after).toEqual(expected)
  })

  test('crash_before_manifest_rewrite_on_roll', async () => {
    const storage = memoryStorage()
    const inst = await freshInstance()
    const persistence = Persistence.create(storage, CFG, inst, {
      segmentRollBytes: TINY_ROLL_BYTES,
    })
    const timer = manualTimer()
    const host = createSimHostFromInstance(
      wrapEngineInstance(inst),
      { clock: { now: () => 0 }, timer: timer.services },
      persistence,
    )
    const keys = worldKeys(CFG.worldId)

    for (let i = 0; i < 6; i++) {
      expect(inst.call1(inst.x.sim_connect, i)).toBe(Status.Ok)
      host.stepTick(1)
    }

    // Intercept the manifest rewrite the upcoming roll makes (`Persistence.create`'s own initial
    // write already happened, so this is unambiguously the roll's) and simulate a crash exactly
    // before it lands: snapshot storage first, then drop the write. The new segment's own header
    // and base snapshot are written *before* the manifest, in that order (`snapshotNow`'s own doc
    // comment), so both are already durable in the clone.
    let crashed: MemoryStorage | undefined
    const originalWrite = storage.write.bind(storage)
    storage.write = (key, bytes) => {
      if (key === keys.manifest && crashed === undefined) {
        crashed = storage.crashClone()
        return
      }
      return originalWrite(key, bytes)
    }

    persistence.snapshotNow()
    if (!crashed) throw new Error('expected the roll to attempt a manifest rewrite')

    const staleManifest = JSON.parse(
      textDecoder.decode((await crashed.read(keys.manifest)) ?? undefined),
    )
    expect(staleManifest.segments).toHaveLength(1) // the crash really did lose the manifest rewrite
    expect(await crashed.read(keys.log(1))).not.toBeNull() // but segment 1's own data survived

    const wantHash = host.hash()
    const wantTick = host.counters.ticksRun
    const ni = await makeNewInstance()
    const { outcome, tick, sim } = await Persistence.open(crashed, CFG, ni, {
      segmentRollBytes: TINY_ROLL_BYTES,
    })
    expect(outcome).toBe('loaded') // segment 1's own data was never actually lost, only the manifest
    expect(tick).toBe(wantTick)
    expect(sim.call0(sim.x.sim_hash)).toBe(Status.Ok)
    expect(sim.readU64Hex(RegionId.Result, 0)).toBe(wantHash)

    // The manifest is healed after the load (`loadLatest` never trusted it in the first place).
    const healed = JSON.parse(textDecoder.decode((await crashed.read(keys.manifest)) ?? undefined))
    expect(healed.segments).toHaveLength(2)
    expect(healed.segments[0].sealed).toBe(true)
    expect(healed.segments[1].sealed).toBe(false)
  })
})
