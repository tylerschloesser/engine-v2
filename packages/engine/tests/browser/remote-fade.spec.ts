// `remote-fade` (M39l step 5): the fade of 0012 "Remote motion" ("fade an
// avatar after 2 s of silence", then a 500 ms ramp) is what a *viewer* sees when its own downlink stalls and
// its clock keeps running. A remote that closes its page is gone at once (0013: `Gone`), so the M34 device
// item tests that separately (`vanished_at_once`); nothing tested that the fade itself happens. Same
// multiplayer page and moving remote as `rebase-on-visible` (`gc-multiplayer-topology.spec.ts`): the host and
// the walker go quiet for 2.6 s of the page's own injected clock (a stalled link, shorter than `net/link.ts`'s
// `DEAD_MS` of 3000 so the link stays up), alpha is read every frame, then the relay comes back.
//
// Inject-fail-revert: `SILENCE_LIMIT_MS` in `crates/engine/src/interp/buffer.rs` made huge: the alpha stays 1
// through the stall and the first assertion fails.
import net from 'node:net'
import { expect, test } from '@playwright/test'
import { fixtureBuildDir } from '../support/fixtures.js'
import { type MovingRemote, startMovingRemote } from './support/moving-remote.js'
import { openPage } from './support/page.js'
import { startTestServer, type TestServer } from './support/test-server.js'

// Below 32768: Linux (CI) hands out ephemeral source ports from 32768-60999 and macOS from 49152, so a
// fixed listen port in those ranges can already be held by an outgoing connection (EADDRINUSE on
// CI runs 37705847137 and 37956458910 at 48282).
const PORT = 28_273 + 2 * Number(process.env.TEST_PARALLEL_INDEX ?? 0)
// The page dials a proxy in front of the server: stalling it is a viewer whose downlink has stopped while
// the host (and the remote) go on.
const PROXY_PORT = PORT + 1
const BASE_PATH = `/gc-multiplayer-topology.html?url=${encodeURIComponent(`ws://127.0.0.1:${PROXY_PORT}`)}`
const STEP_MS = 50
const STALL_MS = 2600

let server: TestServer | undefined
let remote: MovingRemote | undefined
let proxy: Proxy | undefined

type Proxy = { stall(): void; release(): void; close(): void }

/** A TCP pass-through whose server-to-client direction can be held back and then flushed. */
async function startProxy(listen: number, target: number): Promise<Proxy> {
  let stalled = false
  const held: Buffer[] = []
  const clients = new Set<net.Socket>()
  const srv = net.createServer((client) => {
    const up = net.connect(target, '127.0.0.1')
    clients.add(client)
    client.on('data', (d) => up.write(d))
    up.on('data', (d) => {
      if (stalled) held.push(d)
      else client.write(d)
    })
    const end = () => {
      client.destroy()
      up.destroy()
      clients.delete(client)
    }
    client.on('error', end)
    up.on('error', end)
    client.on('close', end)
    up.on('close', end)
    flush = () => {
      for (const d of held.splice(0)) client.write(d)
    }
  })
  let flush = () => {}
  await new Promise<void>((res) => srv.listen(listen, '127.0.0.1', res))
  return {
    stall: () => {
      stalled = true
    },
    release: () => {
      stalled = false
      flush()
    },
    close: () => {
      for (const c of clients) c.destroy()
      srv.close()
    },
  }
}

test.beforeAll(async () => {
  server = await startTestServer({
    fixture: fixtureBuildDir('presence'),
    manualTimer: true,
    port: PORT,
  })
  proxy = await startProxy(PROXY_PORT, PORT)
  remote = await startMovingRemote(server.url, 'presence', () => server?.stepTick())
})

test.afterAll(async () => {
  remote?.leave()
  proxy?.close()
  await server?.stop()
})

test('remote-fade: a remote fades when the viewer hears nothing for 2 s and returns at full alpha @slow', async ({
  page,
}) => {
  // The page's handshake completes across host ticks: tick in real time until it is up, then lockstep.
  const opening = setInterval(() => server?.stepTick(), 50)
  try {
    await openPage(page, BASE_PATH)
  } finally {
    clearInterval(opening)
  }
  let n = 0
  // One page frame of 50 ms with the host one tick on and the remote walking at 10 Hz: the two clocks in
  // lockstep, so a stalled link is the only thing that makes the viewer's clock run ahead of what it hears.
  const frame = async (): Promise<{ alpha: number; n: number }> => {
    if (n++ % 2 === 0) remote?.step()
    server?.stepTick()
    await new Promise((r) => setTimeout(r, 15)) // the socket's real delivery
    return page.evaluate(async (dt) => {
      await window.__step?.(dt)
      const p = (await window.__probe?.()) as { rows: { alpha: number }[] } | undefined
      return { alpha: p?.rows[0]?.alpha ?? 0, n: p?.rows.length ?? 0 }
    }, STEP_MS)
  }

  let solid = 0
  for (let i = 0; i < 400 && solid < 60; i++) {
    const f = await frame()
    solid = f.n === 1 && f.alpha === 1 ? solid + 1 : 0
  }
  if (solid < 60) throw new Error('remote-fade: the moving remote never became solid')

  proxy?.stall()
  const alphas: number[] = []
  for (let t = 0; t < STALL_MS; t += STEP_MS) alphas.push((await frame()).alpha)
  expect(alphas[0], 'solid at the start of the stall').toBe(1)
  expect(Math.min(...alphas), `alpha per frame over the stall: ${alphas.join(' ')}`).toBeLessThan(1)

  proxy?.release()
  let back = false
  for (let i = 0; i < 120 && !back; i++) {
    const f = await frame()
    if (f.n === 1 && f.alpha === 1) back = true
  }
  expect(back, 'the remote returns at full alpha once the host speaks again').toBe(true)
})
