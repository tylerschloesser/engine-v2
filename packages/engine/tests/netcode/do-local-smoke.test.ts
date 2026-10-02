// `do/local-smoke` (docs/plan/38-hosting-checks.md Scope A, step 1): `games/reference-server-do` under
// `wrangler dev --local` (workerd, local DO storage in a temp dir, no account): a headless client
// joins, acts, reconnects after its socket drops, and, after the whole runtime is killed hard and
// started again on the same storage, the action's effect (`motd` 7) is still there (recovery from the
// part objects).
//
// SKIPPED until the Durable Objects ADR decides (go: change `test.skip` to `test` and the title
// stays; no-go: this file is deleted with the package). It already passed by hand against the
// package: see M38's Deviations. Slow tier (`netcode` runs solo there); needs `wrangler` on PATH.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { systemClock, systemScheduler } from '../../src/clock.js'
import { parseBuildHash32 } from '../../src/host/handshake.js'
import { wsConnection } from '../../src/net/ws-connection.js'
import type { Connection } from '../../src/server.js'
import { createHeadlessClient, type HeadlessClient } from '../../src/test/headless-client.js'
import { fixtureBuildDir, loadFixture } from '../support/fixtures.js'

const pkgDir = fileURLToPath(new URL('../../../../games/reference-server-do', import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let proc: ChildProcess | undefined
let persist: string | undefined

/** `wrangler dev` runs workerd as a child: kill the whole group. */
async function stopRuntime(): Promise<void> {
  if (proc?.pid) {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {}
  }
  proc = undefined
  await sleep(300)
}

afterEach(async () => {
  await stopRuntime()
  if (persist) await rm(persist, { recursive: true, force: true })
  persist = undefined
})

function startRuntime(dir: string): Promise<string> {
  proc = spawn('wrangler', ['dev', '--local', '--port', '0', '--persist-to', dir], {
    cwd: pkgDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (d: Buffer) => {
      buf += d.toString()
      const m = /Ready on http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(buf)
      if (m?.[1]) resolve(`ws://localhost:${m[1]}`)
    }
    proc?.stdout?.on('data', onData)
    proc?.stderr?.on('data', onData)
    proc?.on('exit', (c) => reject(new Error(`wrangler dev exited ${c}: ${buf.slice(-400)}`)))
    setTimeout(() => reject(new Error(`wrangler dev not ready: ${buf.slice(-400)}`)), 60_000)
  })
}

// Skipped until the ADR decides (see the header).
test.skip('do/local-smoke @slow', async () => {
  execFileSync(process.execPath, [join(pkgDir, 'scripts/stage.mjs'), 'puts'], { stdio: 'pipe' })
  expect(fixtureBuildDir('puts')).toContain('puts')
  const { wasm, buildHash } = await loadFixture('puts')
  persist = await mkdtemp(join(tmpdir(), 'reference-server-do-'))
  const base = await startRuntime(persist)

  const conns: Connection[] = []
  const join_ = async (url: string, secretByte: number) => {
    const client = createHeadlessClient({
      wasm,
      dial: () => {
        const c = wsConnection(url)
        conns.push(c)
        return c
      },
      secret: new Uint8Array(16).fill(secretByte),
      buildHash: parseBuildHash32(buildHash),
      clock: systemClock,
      scheduler: systemScheduler,
    })
    client.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await stepUntil(client, () => client.status().live, 20_000)
    return client
  }
  async function stepUntil(client: HeadlessClient, done: () => boolean, ms: number) {
    const until = Date.now() + ms
    while (!done() && Date.now() < until) {
      client.stepFrame(10)
      await sleep(10)
    }
    return done()
  }

  // Join and act.
  const url = `${base}/ws/smoke`
  const client = await join_(url, 0x31)
  expect(client.status().live).toBe(true)
  const seq = client.dispatch({ SetMotd: { n: 7 } })
  expect(await stepUntil(client, () => client.status().ackSeq >= seq, 5_000)).toBe(true)
  await stepUntil(client, () => false, 100)
  const hash = client.replicaHash()

  // Reconnect: the client's socket is closed, `createLink` redials, the replica is unchanged.
  conns.at(-1)?.close(4000)
  expect(
    await stepUntil(client, () => client.status().linkUpCount >= 2 && client.status().live, 15_000),
  ).toBe(true)
  await stepUntil(client, () => false, 200)
  expect(client.replicaHash()).toBe(hash)

  // Recovery: let the log reach storage (sync cadence), kill runtime and clients, start again.
  await stepUntil(client, () => false, 2_500)
  await stopRuntime()
  const base2 = await startRuntime(persist)
  const again = await join_(`${base2}/ws/smoke`, 0x32)
  expect(again.status().live).toBe(true)
  await stepUntil(again, () => (again.ui() as { motd: number } | null)?.motd === 7, 5_000)
  // The `SetMotd` of the first run came back from the part objects (log replay from genesis).
  expect((again.ui() as { motd: number } | null)?.motd).toBe(7)
}, 180_000)
