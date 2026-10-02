// `createWorldServer` (docs/plan/27-server-entrypoint-and-netcode-harness.md): the three
// `server/*` tests named in its own Tests added list, driven against the real `fx-puts` `.wasm`
// under Node.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Role } from '../../src/abi.js'
import { Persistence, WorldLoadError } from '../../src/host/persistence.js'
import { instantiate } from '../../src/loader.js'
import {
  type Connection,
  createWorldServer,
  type HostServices,
  type WorldConfig,
  wrapEngineInstance,
} from '../../src/server.js'
import { fsStorage, nodeHostServices } from '../../src/server-node.js'
import { buildSimInstanceConfig } from '../../src/sim-config.js'
import { memoryStorage } from '../../src/storage/memory.js'
import { worldKeys } from '../../src/storage/types.js'
import { loadFixture } from '../support/fixtures.js'

/** A `HostServices.timer` double, `server.test.ts`'s own `manualTimer()` shape: `every()` records
 * the one callback `SimHost.start()` registers and returns a disarm function; `fire()` invokes it. */
function timerDouble() {
  let fn: (() => void) | null = null
  return {
    every: (_ms: number, cb: () => void) => {
      fn = cb
      return () => {
        fn = null
      }
    },
    fire() {
      fn?.()
    },
  }
}

const CFG: WorldConfig = {
  worldId: 'w-server-test',
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

const tmpDirs: string[] = []
afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop() as string
    await rm(dir, { recursive: true, force: true })
  }
})

test('server/load-or-create', async () => {
  const { wasm } = await loadFixture('puts')
  const dir = await mkdtemp(join(tmpdir(), 'm27-server-'))
  tmpDirs.push(dir)
  const newInstance = () => instantiate(wasm, Role.Sim, buildSimInstanceConfig(CFG))

  const timer1 = timerDouble()
  const server1 = createWorldServer(CFG, {
    wasm,
    storage: fsStorage(dir),
    clock: { now: () => 0 },
    timer: timer1,
  })
  await server1.ready
  const conn: Connection = {
    datagrams: false,
    onMessage: null,
    onClose: null,
    send: () => {},
    close: () => {},
  }
  server1.accept(conn)
  for (let i = 0; i < 10; i++) timer1.fire()
  await server1.stop()

  const expectedHash = wrapEngineInstance(
    (await Persistence.open(fsStorage(dir), CFG, newInstance)).sim,
  ).simHash()
  expect(expectedHash).not.toBe('0000000000000000')

  // Reopen on the same directory: `createWorldServer` must load, not create, so ticking zero more
  // times still lands on exactly the same state.
  const timer2 = timerDouble()
  const server2 = createWorldServer(CFG, {
    wasm,
    storage: fsStorage(dir),
    clock: { now: () => 0 },
    timer: timer2,
  })
  await server2.ready
  await server2.stop()

  const actualHash = wrapEngineInstance(
    (await Persistence.open(fsStorage(dir), CFG, newInstance)).sim,
  ).simHash()
  expect(actualHash).toBe(expectedHash)
})

test('server/ready-rejects-on-corrupt-world', async () => {
  const { wasm } = await loadFixture('puts')
  const storage = memoryStorage()
  const keys = worldKeys(CFG.worldId)
  const encoder = new TextEncoder()

  // A manifest that parses fine, naming a segment 0 whose own log bytes are garbage -- no snapshot
  // exists to fall back to, so `Persistence.loadLatest`'s own "no candidate verified" branch
  // compares segment 0's stored identity directly and finds it undecodable
  // (`compareStoredIdentity` -> `Status.Decode` -> `WorldLoadError('corrupt', ...)`).
  const dummyIdentity = {
    buildHash: CFG.buildHash,
    engineVersion: '0.0.0',
    gameVersion: '0.0.0',
    schemaVersion: 0,
    tickRateHz: 20,
    worldgen: { version: 0, fingerprint: '0' },
  }
  const manifest = {
    v: 1,
    worldId: CFG.worldId,
    epoch: 0,
    params: CFG.params,
    created: dummyIdentity,
    segments: [
      { index: 0, identity: dummyIdentity, base: 'genesis', sealed: false, tailReexecuted: false },
    ],
  }
  await storage.write(keys.manifest, encoder.encode(JSON.stringify(manifest)))
  await storage.append(keys.log(0), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))

  const server = createWorldServer(CFG, {
    wasm,
    storage,
    clock: { now: () => 0 },
    timer: timerDouble(),
  })

  await expect(server.ready).rejects.toBeInstanceOf(WorldLoadError)
  await expect(server.ready).rejects.toMatchObject({ kind: 'corrupt' })
  // `stop()` must still resolve cleanly on a world that never finished loading.
  await server.stop()
})

test('server/accept-before-ready-waits', async () => {
  const { wasm } = await loadFixture('puts')
  const manifestResolver: { resolve: ((v: Uint8Array | null) => void) | null } = { resolve: null }
  const manifestRead = new Promise<Uint8Array | null>((resolve) => {
    manifestResolver.resolve = resolve
  })
  const keys = worldKeys(CFG.worldId)
  const storage: HostServices['storage'] = {
    onError: null,
    append() {},
    sync() {},
    write() {},
    delete() {},
    async flush() {},
    read(key) {
      return key === keys.manifest ? manifestRead : Promise.resolve(null)
    },
    async list() {
      return []
    },
  }

  const server = createWorldServer(CFG, {
    wasm,
    storage,
    clock: { now: () => 0 },
    timer: timerDouble(),
  })

  let sends = 0
  const conn: Connection = {
    datagrams: false,
    onMessage: null,
    onClose: null,
    send: () => {
      sends++
    },
    close: () => {},
  }
  server.accept(conn)

  // Give the microtask queue several turns: `ready` is still pending (blocked on `manifestRead`),
  // so `accept` must not have wired this connection into a real `SimHost` yet. Since M38 the
  // queued connection holds a buffering handler (it keeps an early `Hello`), never the host's:
  // nothing is answered before `ready`, and the host's own handler replaces it after.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  const buffering = conn.onMessage
  expect(sends).toBe(0)

  manifestResolver.resolve?.(null) // no stored manifest: `Persistence.open` creates a fresh world
  await server.ready
  expect(conn.onMessage).not.toBeNull()
  expect(conn.onMessage).not.toBe(buffering)

  await server.stop()
})

// `nodeHostServices` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Scope): the real,
// wall-clock-paced counterpart to every other test in this file's own `timerDouble()` -- `clock`/
// `timer` from `systemClock`/`systemScheduler`, ticking for real over a real `setTimeout` chain
// against real `fsStorage`. `fx-puts` ticks at 20 Hz (50 ms/tick); waiting a few real ticks and
// stopping keeps this fast-tier test well under a second.
test('nodeHostServices: a real server ticks over real fs storage and reopens to the same hash', async () => {
  const { wasm } = await loadFixture('puts')
  const dir = await mkdtemp(join(tmpdir(), 'm27-node-host-'))
  tmpDirs.push(dir)

  const server1 = createWorldServer(CFG, nodeHostServices({ wasm, storage: fsStorage(dir) }))
  await server1.ready
  // A few real ticks (fx-puts's own `tick` rule paints one tile per simulated second, `crates/
  // engine/fixtures/puts/src/lib.rs`'s own module doc comment) -- enough for `sim_hash()` to move
  // off the pristine genesis value without this test waiting a full second.
  await new Promise((resolve) => setTimeout(resolve, 120))
  await server1.stop()

  const newInstance = () => instantiate(wasm, Role.Sim, buildSimInstanceConfig(CFG))
  const expectedHash = wrapEngineInstance(
    (await Persistence.open(fsStorage(dir), CFG, newInstance)).sim,
  ).simHash()
  expect(expectedHash).not.toBe('0000000000000000')

  // Reopen on the same directory through a second, independent `nodeHostServices` -- real load,
  // not create (`server/load-or-create`'s own assertion, this time over the real timer/clock).
  const server2 = createWorldServer(CFG, nodeHostServices({ wasm, storage: fsStorage(dir) }))
  await server2.ready
  await server2.stop()

  const actualHash = wrapEngineInstance(
    (await Persistence.open(fsStorage(dir), CFG, newInstance)).sim,
  ).simHash()
  expect(actualHash).toBe(expectedHash)
})

test('server/stop-closes-connections', async () => {
  // ADR 0017 §2: `engine/server` is a public subpath (it was missing from the exports map until
  // M27's gate). Asserted on `package.json` itself: CI typechecks before `dist/` is built.
  const pkg = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { exports: Record<string, unknown> }
  expect(pkg.exports['./server']).toEqual({
    types: './dist/server.d.ts',
    default: './dist/server.js',
  })
  const { wasm } = await loadFixture('puts')
  const server = createWorldServer(CFG, {
    wasm,
    storage: memoryStorage(),
    clock: { now: () => 0 },
    timer: timerDouble(),
  })
  const closed: string[] = []
  const conn = (name: string): Connection => ({
    datagrams: false,
    onMessage: null,
    onClose: null,
    send: () => {},
    close: () => {
      closed.push(name)
    },
  })
  server.accept(conn('before-ready'))
  await server.ready
  server.accept(conn('after-ready'))
  expect(closed).toEqual([])
  await server.stop()
  expect(closed.sort()).toEqual(['after-ready', 'before-ready'])
})
