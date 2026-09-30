// `reference-server/smoke` (docs/plan/29-net-worker-and-reference-server.md Tests added, Node):
// spawns the real `games/reference-server` process against the `puts` fixture, joins it with a
// real `HeadlessClient` over a real loopback `ws` socket (`wsConnection`, the shipped wrapper --
// not the netcode harness's own in-memory transport, since this is proving the deployable process
// itself, real timers and real sockets included), then proves `--exit-on-idle` actually exits 0
// once the world goes idle (0013 "World lifecycle": 30 s after the last player leaves) -- the one
// exit path this milestone's own Tests added line names. `@slow`: the real 30 s idle wait alone
// exceeds the fast `netcode` suite's 10 s budget.
import type { ChildProcessByStdio } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { systemClock, systemScheduler } from '../../src/clock.js'
import { parseBuildHash32 } from '../../src/host/handshake.js'
import { wsConnection } from '../../src/net/ws-connection.js'
import { createHeadlessClient, type HeadlessClientStatus } from '../../src/test/headless-client.js'
import { fixtureBuildDir, loadFixture } from '../support/fixtures.js'

const referenceServerDir = fileURLToPath(
  new URL('../../../../games/reference-server', import.meta.url),
)

/** `spawn(..., { stdio: ['ignore', 'pipe', 'pipe'] })`'s own real return type -- `stdin: null`, not
 * `ChildProcessWithoutNullStreams`'s writable one (this test never writes to the child). */
type ServerProcess = ChildProcessByStdio<null, Readable, Readable>

let child: ServerProcess | undefined
let dataDir: string | undefined

afterEach(async () => {
  child?.kill()
  child = undefined
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  dataDir = undefined
})

/** Waits for `index.mjs`'s own one `listening: ws://127.0.0.1:<port>` stdout line and returns the
 * real, OS-assigned port (`PORT=0` below, so two suites' parallel runs of this test never
 * collide). */
function waitListening(proc: ServerProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = ''
    proc.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const m = /listening: ws:\/\/127\.0\.0\.1:(\d+)/.exec(buf)
      if (m?.[1]) resolve(Number(m[1]))
    })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      reject(new Error(`games/reference-server exited ${code} before it ever reported listening`))
    })
  })
}

function waitExit(proc: ServerProcess): Promise<number> {
  return new Promise((resolve) => {
    proc.on('exit', (code) => resolve(code ?? -1))
  })
}

/** Real time, real polling (this is a real process over a real socket, not the harness's virtual
 * clock): calls `pump()` every 20 ms until `status().live`, or throws past `timeoutMs`. */
async function waitLive(
  status: () => HeadlessClientStatus,
  pump: () => void,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    pump()
    if (status().live) return
    if (Date.now() > deadline) throw new Error('reference-server/smoke: client never went live')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('reference-server/smoke @slow', async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'reference-server-smoke-'))
  const gameDir = fixtureBuildDir('puts')
  const { wasm, buildHash } = await loadFixture('puts')

  child = spawn(
    process.execPath,
    [referenceServerDir, '--game', gameDir, '--data', dataDir, '--exit-on-idle'],
    { env: { ...process.env, PORT: '0', JOIN_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const exited = waitExit(child)
  const port = await waitListening(child)

  const client = createHeadlessClient({
    wasm,
    dial: () => wsConnection(`ws://127.0.0.1:${port}`),
    secret: new Uint8Array(16).fill(0x11),
    buildHash: parseBuildHash32(buildHash),
    clock: systemClock,
    scheduler: systemScheduler,
  })
  await waitLive(
    () => client.status(),
    () => client.pump(),
    5_000,
  )
  expect(client.status().live).toBe(true)

  // `Bye{Leave}` (0013): skips the 10 s grace, so `Disconnected` logs at once and the world's own
  // 30 s idle timer starts on the very next tick -- the shortest real path to `onIdle`.
  client.leave()

  expect(await exited).toBe(0)
}, 45_000)
