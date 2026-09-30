// The one scenario behind both `bun-adapter loopback` (an extra leg of `bun-leg.mjs`, fast tier)
// and `deno-adapter @slow` (`deno-adapter.mjs`, run by `deno-adapter.test.ts`): a world server built
// from a runtime's own adapter (`engine/server/bun` or `/deno`, from `dist/`) on `127.0.0.1:0`, two
// `HeadlessClient`s dialling it over `wsConnection` on the runtime's global `WebSocket`, a short
// scripted log, then three checks -- replica hash equals host hash equals `EXPECTED_HASH`; a clean
// `stop()`; a `Storage` write failure reaching `onError` (docs/plan/35b-bun-and-deno-adapters.md,
// Tests added). Plain JS and no `Bun.`/`Deno.` names: the caller supplies `serve`.
import { systemClock, systemScheduler } from '../../dist/clock.js'
import { parseBuildHash32 } from '../../dist/host/handshake.js'
import { wsConnection } from '../../dist/net/ws-connection.js'
import { createWorldServer, worldServerTestHandle } from '../../dist/server.js'
import { worldKeys } from '../../dist/storage/types.js'
import { createHeadlessClient } from '../../dist/test/headless-client.js'

/** The painted chunk, as both replicas hold it: `fx-puts` terrain plus the two `Paint`s below,
 * far from the tile its own `tick` walks (so the value does not depend on how many ticks ran). A
 * golden for this scenario only; changing the script or the fixture changes it. */
export const EXPECTED_CHUNK_HASH = '935e9b3e2178c2d6'
export const CHUNK = { cx: 3, cy: 3 }

/** `inner` with `append` held back until `flush()`: a log frame reaches the directory only if the
 * caller awaited a flush, so a `stop()` that resolved early leaves the log empty on disk. */
function holdAppendsUntilFlush(inner) {
  const held = []
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'append') return (key, bytes) => void held.push([key, bytes.slice()])
      if (prop === 'sync') return () => undefined
      if (prop === 'flush') {
        return async () => {
          for (const [key, bytes] of held.splice(0)) target.append(key, bytes)
          await target.flush()
        }
      }
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    },
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(what, cond, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

/**
 * @param {{ adapter: { loadGame: Function, fsStorage: Function }, hostServices: Function,
 *   serve: (server: object) => Promise<{ port: number, close: () => Promise<void> }>,
 *   gameDir: string, dataDir: string, blockedDir: string }} o
 * `dataDir`: a fresh, empty, writable directory; `blockedDir`: one that does not exist yet.
 * Returns `null` when everything held, else throws.
 */
export async function adapterLoopback(o) {
  const { wasm, buildHash } = await o.adapter.loadGame(o.gameDir)
  const storage = holdAppendsUntilFlush(o.adapter.fsStorage(o.dataDir))
  const cfg = { worldId: 'w', buildHash, params: { seed: '1', worldgen: null } }
  const server = createWorldServer(cfg, o.hostServices({ wasm, storage }))
  const listener = await o.serve(server)
  await server.ready

  const clients = [1, 2].map((i) =>
    createHeadlessClient({
      wasm,
      dial: () => wsConnection(`ws://127.0.0.1:${listener.port}`),
      secret: new Uint8Array(16).fill(i),
      buildHash: parseBuildHash32(buildHash),
      clock: systemClock,
      scheduler: systemScheduler,
    }),
  )
  const probe = new WebSocket(`ws://127.0.0.1:${listener.port}`)
  let probeClose = null
  probe.onclose = (ev) => {
    probeClose = ev.code
  }
  const step = () => {
    for (const c of clients) c.stepFrame(20)
  }
  await until('both clients live', () => {
    for (const c of clients) c.pump()
    return clients.every((c) => c.status().live)
  })
  for (const c of clients) c.setCamera({ x: 100, y: 100, tilesAcross: 20 })
  for (let i = 0; i < 10; i++) {
    step()
    await sleep(20)
  }
  clients[0].dispatch({ Paint: { pos: { x: 100, y: 100 }, base: 2, resource: 3 } })
  clients[1].dispatch({ Paint: { pos: { x: 101, y: 100 }, base: 3, resource: 1 } })
  const host = worldServerTestHandle(server)
  const chunks = () => clients.map((c) => c.chunkHash(CHUNK.cx, CHUNK.cy))
  await until(
    'both replicas to hold the painted chunk',
    () => {
      step()
      return chunks().every((h) => h === EXPECTED_CHUNK_HASH)
    },
    5_000,
  ).catch(() => {
    throw new Error(`chunk hash mismatch: replicas=${chunks()} expected=${EXPECTED_CHUNK_HASH}`)
  })
  // Replica hash equals host hash, sampled in one synchronous block (the world keeps ticking, so
  // the value itself moves; a replica one frame behind is retried).
  let last = ''
  await until(
    'replica hash to equal host hash',
    () => {
      step()
      const replicas = clients.map((c) => c.replicaHash())
      const hosts = [0, 1].map((conn) => host.regionHash(conn))
      last = `replicas=${replicas} host=${hosts}`
      return replicas.every((h, i) => h === hosts[i])
    },
    5_000,
  ).catch(() => {
    throw new Error(`hash mismatch: ${last}`)
  })

  // Clean stop: `stop()` flushes before it resolves (the manifest is readable through a second
  // storage on the same directory at once) and closes every socket it accepted, `probe` (connected
  // and silent, so accepted and never handshaken) included.
  await server.stop()
  const reopened = o.adapter.fsStorage(o.dataDir)
  const manifest = await reopened.read(worldKeys('w').manifest)
  const log = await reopened.read(worldKeys('w').log(0))
  if (!manifest || manifest.length === 0 || !log || log.length === 0) {
    throw new Error('stop() returned before the flush landed')
  }
  await until('the probe socket to be closed by stop()', () => probeClose !== null, 2_000)
  if (probeClose !== 1000) throw new Error(`stop() closed a socket with code ${probeClose}`)
  for (const c of clients) c.leave()
  await listener.close()

  // A Storage write failure reaches `onError`: an `append` whose parent is a regular file.
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(o.blockedDir, { recursive: true })
  await writeFile(`${o.blockedDir}/file`, 'x')
  const failing = o.adapter.fsStorage(o.blockedDir)
  let reported = null
  failing.onError = (err) => {
    reported = err
  }
  failing.append('file/child', new Uint8Array([1])) // the log path: failures go to `onError`
  await failing.flush()
  if (reported === null) throw new Error('a failed Storage write did not reach onError')
  return null
}
