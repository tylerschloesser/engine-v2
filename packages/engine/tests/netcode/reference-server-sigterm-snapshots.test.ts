// `reference-server/sigterm-snapshots` (docs/plan/38-hosting-checks.md, Tests added; 0005 Cadence:
// snapshot on the server shutdown signal). A real `games/reference-server --data <dir>` process, a
// headless client over a real socket acts, `SIGTERM`: the process exits 0, and a second process on the
// same directory comes back at the snapshot's tick with the same replica hash and no log tail to replay
// (a tail would put the resumed tick past the snapshot's).
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { systemClock, systemScheduler } from '../../src/clock.js'
import { parseBuildHash32 } from '../../src/host/handshake.js'
import { wsConnection } from '../../src/net/ws-connection.js'
import { createHeadlessClient, type HeadlessClient } from '../../src/test/headless-client.js'
import { fixtureBuildDir, loadFixture } from '../support/fixtures.js'
import { type RunningServer, spawnReferenceServer } from '../support/reference-server.js'

let server: RunningServer | undefined
let dataDir: string | undefined

afterEach(async () => {
  server?.proc.kill('SIGKILL')
  await server?.exited
  server = undefined
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  dataDir = undefined
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('reference-server/sigterm-snapshots', async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'reference-server-sigterm-'))
  const { wasm, buildHash } = await loadFixture('puts')
  const args = ['--game', fixtureBuildDir('puts'), '--data', dataDir]

  async function join_(port: number, secretByte = 0x22) {
    const client = createHeadlessClient({
      wasm,
      dial: () => wsConnection(`ws://127.0.0.1:${port}`),
      secret: new Uint8Array(16).fill(secretByte),
      buildHash: parseBuildHash32(buildHash),
      clock: systemClock,
      scheduler: systemScheduler,
    })
    const t0 = Date.now()
    client.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    const deadline = Date.now() + 5_000
    while (!client.status().live) {
      if (Date.now() > deadline) throw new Error('client never went live')
      client.stepFrame(10)
      await sleep(10)
    }
    return { client, ms: Date.now() - t0, tick: client.status().tick }
  }
  /** Steps frames every 10 ms until `done()` or `ms` have passed. */
  async function stepUntil(client: HeadlessClient, done: () => boolean, ms: number) {
    const until = Date.now() + ms
    while (!done() && Date.now() < until) {
      client.stepFrame(10)
      await sleep(10)
    }
  }

  server = await spawnReferenceServer(args)
  const { client: first } = await join_(server.port)
  const seq = first.dispatch({ SetMotd: { n: 7 } })
  await stepUntil(first, () => first.status().ackSeq >= seq, 3_000)
  expect(first.status().ackSeq).toBeGreaterThanOrEqual(seq)
  await stepUntil(first, () => false, 40)
  const hashBefore = first.replicaHash()

  server.proc.kill('SIGTERM')
  expect(await server.exited).toBe(0)
  server = undefined

  const snaps = (await readdir(join(dataDir, 'worlds', 'world', 'snap'))).sort()
  const snapTick = Number(snaps[snaps.length - 1])
  expect(snapTick).toBeGreaterThan(0)

  const spawnedAt = Date.now()
  server = await spawnReferenceServer(args)
  const second = await join_(server.port)
  // A resumed world ticks from the snapshot's tick at 20 Hz from the moment the process is up, so what
  // `Welcome` reports is the snapshot tick plus the ticks that elapsed since the spawn; a log tail to
  // replay would show as more than that.
  await stepUntil(second.client, () => second.client.replicaHash() === hashBefore, 3_000)
  const elapsedTicks = Math.ceil(((Date.now() - spawnedAt) / 1000) * 20)
  // Dialling at once, while the world is still loading, must not cost a link timeout (the upgrade
  // waits for `ready`).
  expect(second.ms).toBeLessThan(1500)
  const resumedTick = second.client.status().tick
  expect(resumedTick).toBeGreaterThanOrEqual(snapTick)
  expect(resumedTick - snapTick).toBeLessThanOrEqual(elapsedTicks + 2)
  expect(second.client.replicaHash()).toBe(hashBefore)
}, 30_000)
