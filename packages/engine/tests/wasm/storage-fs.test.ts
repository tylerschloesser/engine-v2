// docs/plan/22b-persistence-load-and-fs.md, Order of work step 4: `fsStorage` + the same behavioural
// conformance suite `memoryStorage` passes, plus one real-directory crash test (tmpdir, truncate a
// file by hand). `afterEach` cleans up every tmpdir this file creates (`command rm -f`'s own
// discipline: `node:fs`, never a shell operation).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import { Persistence } from '../../src/host/persistence.js'
import type { EngineInstance } from '../../src/loader.js'
import { instantiate } from '../../src/loader.js'
import {
  buildSimInstanceConfig,
  createSimHostFromInstance,
  wrapEngineInstance,
} from '../../src/server.js'
import { runStorageConformance } from '../../src/storage/conformance.js'
import { createFsStorageDebug, FS_BUFFER_BYTES, fsStorage } from '../../src/storage/fs.js'
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

const dirs: string[] = []
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'engine-fs-storage-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('fsStorage', () => {
  test('storage_conformance_fs', async () => {
    const dir = await tmpDir()
    const passed = await runStorageConformance(() => fsStorage(join(dir, 'w')))
    expect(passed.length).toBeGreaterThan(0)
  })

  test('fs_append_allocates_no_buffers', async () => {
    const dir = await tmpDir()
    const debug = createFsStorageDebug()
    const storage = fsStorage(dir, debug)
    const key = 'worlds/w1/log/000000'
    for (let i = 0; i < 20; i++) {
      storage.append(key, new TextEncoder().encode(`frame-${i}`))
    }
    await storage.sync(key)
    await storage.flush()
    expect(debug.fsBufferGrows()).toBe(0)
    const onDisk = await readFile(join(dir, ...key.split('/')))
    expect(onDisk.length).toBeGreaterThan(0)
  })

  /** M22b fix round 1: the steady-state case above never fills a whole 1 MiB buffer, so
   * `fsBufferGrows` never had a chance to move -- removing the increment in `LogAppender.rotate()`'s
   * own both-buffers-in-flight branch still passed. This genuinely holds two flushes in flight
   * (`FsStorageDebug.gate`, a pending promise every real `fs.write` awaits) and forces a third. */
  test('fs_pool_exhaustion_forces_a_grown_buffer', async () => {
    const dir = await tmpDir()
    const debug = createFsStorageDebug()
    let releaseGate: (() => void) | undefined
    debug.gate = new Promise((resolve) => {
      releaseGate = resolve
    })
    const storage = fsStorage(dir, debug)
    const key = 'worlds/w1/log/000000'

    const a = Buffer.alloc(FS_BUFFER_BYTES, 0x41)
    const b = Buffer.alloc(FS_BUFFER_BYTES, 0x42)
    const c = new TextEncoder().encode('tail-c')

    storage.append(key, a) // exactly fills buffer 1; no rotation yet
    storage.append(key, b) // rotates buffer 1 into the (gated, pending) flush chain
    expect(debug.fsBufferGrows()).toBe(0) // both pooled buffers accounted for, nothing grown yet
    storage.append(key, c) // both pooled buffers are now checked out: forces a grown buffer
    expect(debug.fsBufferGrows()).toBe(1)

    releaseGate?.()
    await storage.flush()

    const onDisk = await readFile(join(dir, ...key.split('/')))
    expect(onDisk.equals(Buffer.concat([a, b, c]))).toBe(true) // every byte landed, in order
  })

  test('fs_crash_truncated_file', async () => {
    const dir = await tmpDir()
    const storage = fsStorage(dir)
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
    await storage.flush()

    const keys = worldKeys(CFG.worldId)
    const logPath = join(dir, ...keys.log(0).split('/'))
    const before = await readFile(logPath)
    expect(before.length).toBeGreaterThan(0)
    // Truncate the real on-disk file by hand -- a crash mid-`append`/`fdatasync`, not a simulated
    // clone (`MemoryStorage.crashClone`'s own real-directory counterpart).
    await writeFile(logPath, before.subarray(0, before.length - 1))

    const ni = await makeNewInstance()
    const crashedStorage = fsStorage(dir)
    const { outcome, tick, sim } = await Persistence.open(crashedStorage, CFG, ni)
    expect(outcome).toBe('recovered')
    expect(tick).toBe(0) // the only frame was torn away entirely: falls back to genesis.
    expect(sim.call0(sim.x.sim_hash)).toBe(Status.Ok)
    expect(sim.readU64Hex(RegionId.Result, 0)).not.toBe(hashAtTick1)

    // Planning decisions 1: the torn tail is truncated on disk too (`Storage.write`), not merely
    // skipped in memory -- proven by re-reading the real file, not just trusting `outcome`.
    const onDisk = await readFile(logPath)
    expect(onDisk.length).toBeLessThan(before.length)
  })
})
