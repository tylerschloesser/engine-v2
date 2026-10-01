// The server leg of the tarball test (0017 §8), run inside the scratch app by `node` and by `bun`:
//   <runtime> server-leg.mjs <node|bun> <game dir>
// Everything is imported by package subpath, from the installed tarball. One in-process join over a
// memory connection, then a `Ping`; the last stdout line is one JSON object.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldServer, worldServerTestHandle } from 'engine/server'
import { createHeadlessClient, memoryConnectionPair } from 'engine/test'

const [runtime, gameDir] = process.argv.slice(2)
const adapter = await import(runtime === 'bun' ? 'engine/server/bun' : 'engine/server/node')
const hostServices = runtime === 'bun' ? adapter.bunHostServices : adapter.nodeHostServices

const { wasm, buildHash } = await adapter.loadGame(gameDir)
const dataDir = await mkdtemp(join(tmpdir(), 'engine-server-leg-'))
const server = createWorldServer(
  { worldId: 'scratch', buildHash, params: { seed: '1', worldgen: null } },
  hostServices({ wasm, storage: adapter.fsStorage(dataDir) }),
)
await server.ready

const [clientEnd, serverEnd] = memoryConnectionPair()
const client = createHeadlessClient({
  wasm,
  dial: () => clientEnd,
  secret: new Uint8Array(16).fill(7),
  buildHash: Uint8Array.from(buildHash.match(/../g).map((h) => Number.parseInt(h, 16))),
})
server.accept(serverEnd)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, cond, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

await until('the client to be live', () => {
  client.pump()
  return client.status().live
})
client.setCamera({ x: 0, y: 0, tilesAcross: 20 })
client.dispatch('Ping')
const host = worldServerTestHandle(server)
await until('replica hash to equal host hash', () => {
  client.stepFrame(20)
  return client.replicaHash() === host.regionHash(0)
})
const hostHash = host.regionHash(0)
const replicaHash = client.replicaHash()
client.leave()
await server.stop()
await rm(dataDir, { recursive: true, force: true })
console.log(
  JSON.stringify({
    runtime: runtime === 'bun' ? `bun ${globalThis.Bun?.version}` : `node ${process.versions.node}`,
    buildHash,
    live: true,
    hostHash,
    replicaHash,
  }),
)
process.exit(0)
