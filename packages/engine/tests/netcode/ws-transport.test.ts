// `ws` (docs/plan/29-net-worker-and-reference-server.md steps 1-2, Tests added): the loopback
// subset -- `createNetHarness({ transport: 'ws' })` puts `conditionLink` around real sockets on
// `127.0.0.1:0` (`wsConnection`/`wsSocketConnection`) instead of `memoryConnectionPair()`, so every
// scenario below is byte-for-byte the same protocol traffic `join-converges`/`reconnect.test.ts`
// already prove over the `memory` transport -- only the wire underneath changes. `attachWebSocketServer`
// (`ws/deflate-refused`) is exercised directly, not through the harness (Deviations, `net-harness.ts`'s
// own doc comment: the harness needs to condition a socket before `WorldServer.accept`, so it builds
// on the lower-level `wsSocketConnection` instead of this function).
//
// `ws/reconnect-resume` and `ws/trace-identical` are `@slow` (Deviations: `docs/decisions/
// 0020-testing-strategy.md` §4's demotion rule, named explicitly by this milestone's own "Budgets"
// section -- "apply the demotion rule ... to `ws` repeats first" -- for exactly this case: a
// real-socket repeat of an in-memory netcode scenario). Measured: this file alone added ~10 s to
// the fast `netcode` suite (real per-tick `setTimeout` yields, `docs/plan/29...md` Deviations on
// `net-harness.ts`'s own `advanceTicks`), pushing the whole suite over its 10 s budget; demoting
// these two (the most expensive, and the ones whose own ground -- reconnect, determinism across
// runs -- `ws/join-converges` and the slow-tier `ws/spike-c` already also cover, `spike-c` at a
// larger scale) brought it back under. `ws/join-converges`, `ws/deflate-refused` and `ws/
// version-mismatch` stay fast tier: each is the only fast-tier test covering its own feature
// (convergence, the deflate refusal, the close-code mapping).
import { expect, test } from 'vitest'
import { CloseCode } from '../../src/host/handshake.js'
import { MsgClass, type WorldServer } from '../../src/server.js'
import { attachWebSocketServer } from '../../src/server-node.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { buildHelloBytes, fixedSecret, putsFixture, square } from './support.js'

test('ws/join-converges', async () => {
  const seed = 20001
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed,
    clients: 4,
    transport: 'ws',
  })
  try {
    harness.clients.forEach((c, i) => {
      c.setCamera(square(i))
    })
    // 20, not 10 (Deviations, measured): a real loopback socket handshake competes for the event
    // loop with `pnpm test`'s own concurrently-running suites (`scripts/test.mjs`'s "run every
    // selected suite in parallel"), and 10 ticks' worth of real-time headroom flaked under that
    // load in a way 20 did not.
    await harness.advanceTicks(20)

    harness.clients[0]?.dispatch({ Paint: { pos: { x: 2, y: 2 }, base: 1, resource: 0 } })
    harness.clients[1]?.dispatch({ Spawn: { at: { x: -3, y: 8 }, kind: 1 } })
    harness.clients[2]?.dispatch({ SetMotd: { n: 99 } })
    harness.clients[3]?.dispatch('Roll')

    await harness.settle()

    for (let i = 1; i < harness.clients.length; i++) {
      expect(harness.clients[i]?.ui()).toEqual(harness.clients[0]?.ui())
    }
    expect((harness.clients[0]?.ui() as { motd: number } | null)?.motd).toBe(99)

    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})

// docs/plan/29-net-worker-and-reference-server.md Tests added: "the negotiated `extensions` of each
// socket are empty" -- checked directly against a throwaway `attachWebSocketServer`/`WebSocket`
// pair (not through `createNetHarness`, which has no seam exposing its own internal port or raw
// sockets): 0009 "no `permessage-deflate`" means neither end should ever negotiate any extension.
test('ws/join-converges: negotiated extensions are empty', async () => {
  const { WebSocketServer } = await import('ws')
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })
  const fakeServer: WorldServer = {
    ready: Promise.resolve(),
    accept: () => {},
    stop: async () => {},
  }
  attachWebSocketServer(wss, fakeServer)
  const address = wss.address()
  if (typeof address === 'string' || address === null) throw new Error('unexpected address')
  const serverExtensions = new Promise<string>((resolve) => {
    wss.once('connection', (socket) => resolve(socket.extensions))
  })
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
  await new Promise<void>((resolve, reject) => {
    client.onopen = () => resolve()
    client.onerror = () => reject(new Error('client failed to open'))
  })
  expect(client.extensions).toBe('')
  expect(await serverExtensions).toBe('')
  client.close(1000)
  await new Promise<void>((resolve) => wss.close(() => resolve()))
})

test('ws/deflate-refused', async () => {
  const { WebSocketServer } = await import('ws')
  // Explicitly enabled -- never wired to any real port: the check this milestone requires happens
  // synchronously, before `attachWebSocketServer` ever calls `.on('connection', ...)`, so a server
  // that never actually listens still proves it. (This installed `ws` version's own *default* is
  // already `perMessageDeflate: false`, so the meaningful case to cover is an explicit `true`.)
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true })
  const fakeServer: WorldServer = {
    ready: Promise.resolve(),
    accept: () => {},
    stop: async () => {},
  }
  expect(() => attachWebSocketServer(wss, fakeServer)).toThrow(/perMessageDeflate/)
})

// M29b fix round 5 (`mp/version-mismatch-reloads-once` failing live on CI, twice across several
// reruns, with `SimHost.accept: no free connection slot`): `attachWebSocketServer`'s own
// `'connection'` listener now catches that throw and closes the overflow socket with `CloseCode.
// Full` instead of letting an uncaught exception propagate (`server-node.ts`'s own Deviations has
// the full mechanism this proves). A fake `WorldServer.accept` (not the real `SimHost`) keeps this
// deterministic and fast: real `MAX_CONNS` capacity (8) would need eight real sockets just to reach
// the interesting case, and the real cap is already exercised elsewhere -- this test's own job is
// narrower, proving `attachWebSocketServer`'s own catch-and-close behaviour, not `SimHost`'s own
// counting.
test('ws/accept-overflow-closes-gracefully', async () => {
  const { WebSocketServer } = await import('ws')
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })
  const CAPACITY = 2
  let accepted = 0
  const fakeServer: WorldServer = {
    ready: Promise.resolve(),
    accept: () => {
      if (accepted >= CAPACITY) {
        throw new Error(`SimHost.accept: no free connection slot (MAX_CONNS = ${CAPACITY})`)
      }
      accepted++
    },
    stop: async () => {},
  }
  attachWebSocketServer(wss, fakeServer)
  const address = wss.address()
  if (typeof address === 'string' || address === null) throw new Error('unexpected address')
  const url = `ws://127.0.0.1:${address.port}`

  function dialAndAwaitOpen(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.onopen = () => resolve(ws)
      ws.onerror = () => reject(new Error(`${url}: failed to open`))
    })
  }
  function dialAndAwaitClose(): Promise<number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.onclose = (ev) => resolve(ev.code)
      ws.onerror = () => reject(new Error(`${url}: failed before closing`))
    })
  }

  // Sequential, not `Promise.all` (Deviations, `ws/trace-identical`'s own precedent): each dial is
  // awaited to a definite outcome before the next starts, so this proves overflow handling
  // deterministically rather than racing real connection-establishment order.
  const within = [await dialAndAwaitOpen(), await dialAndAwaitOpen()]
  expect(accepted).toBe(CAPACITY)

  // The overflow socket: `accept()` throws inside the real `'connection'` listener; the fix is that
  // this closes gracefully (not an uncaught exception that would otherwise crash this whole test
  // process) with the same `CloseCode.Full` a genuine player-capacity rejection already uses.
  const overflowCode = await dialAndAwaitClose()
  expect(overflowCode).toBe(CloseCode.Full)
  expect(accepted).toBe(CAPACITY) // the overflow attempt never incremented it

  // The two within-capacity sockets are wholly unaffected by the overflow attempt.
  for (const ws of within) expect(ws.readyState).toBe(WebSocket.OPEN)

  for (const ws of within) ws.close(1000)
  await new Promise<void>((resolve) => wss.close(() => resolve()))
})

test('ws/reconnect-resume @slow', async () => {
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed: 20002,
    clients: 1,
    transport: 'ws',
  })
  try {
    harness.clients[0]?.setCamera(square(0))
    await harness.advanceTicks(15) // headroom under `pnpm test`'s own concurrent suites, see above
    harness.clients[0]?.dispatch({ SetMotd: { n: 7 } })
    await harness.settle()

    harness.link(0).disconnect()
    harness.link(0).reconnect()
    await harness.advanceTicks(30)
    await harness.settle()

    expect(harness.clients[0]?.status().live).toBe(true)
    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})

test('ws/version-mismatch', async () => {
  const { wasm } = await putsFixture()
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed: 20003,
    clients: 0,
    transport: 'ws',
  })
  try {
    const conn = harness.connectRaw()
    let closeCode: number | undefined
    conn.onClose = (code) => {
      closeCode = code
    }
    const hello = buildHelloBytes(wasm, {
      secret: fixedSecret(0x22),
      joinKey: '',
      buildHash: new Uint8Array(32).fill(0xaa), // deliberately wrong
    })
    conn.send(MsgClass.ReliableOrdered, hello)
    await harness.advanceTicks(12) // headroom under `pnpm test`'s own concurrent suites, see above
    expect(closeCode).toBe(CloseCode.VersionMismatch)
  } finally {
    await harness.dispose()
  }
})

// docs/plan/29-net-worker-and-reference-server.md Planning decisions ("Spike C"): the fast-tier
// determinism claim spike C's own slow-tier full run (`ws/spike-c`, `@slow`) scales up -- the same
// scripted (seed, script) run twice over real loopback sockets must produce byte-identical
// `trace()` output, proving the harness's own `VirtualClock`-paced determinism survives a real
// transport underneath (the only place wall-clock reality could leak in).
test('ws/trace-identical @slow', async () => {
  async function run(): Promise<Uint8Array> {
    const harness = await createNetHarness({
      fixture: await putsFixture(),
      seed: 20004,
      clients: 3,
      transport: 'ws',
    })
    try {
      harness.clients.forEach((c, i) => {
        c.setCamera(square(i))
      })
      await harness.advanceTicks(15) // headroom under `pnpm test`'s own concurrent suites, see above
      harness.clients[0]?.dispatch({ Paint: { pos: { x: 1, y: 1 }, base: 1, resource: 0 } })
      harness.clients[1]?.dispatch('Roll')
      await harness.advanceTicks(20)
      harness.link(2).disconnect()
      harness.link(2).reconnect()
      await harness.settle()
      return harness.trace()
    } finally {
      await harness.dispose()
    }
  }
  // Sequential, not `Promise.all`: two independent real `WebSocketServer`s racing on the same
  // event loop would prove nothing extra about determinism and would only add real-timing noise
  // this assertion does not want.
  const a = await run()
  const b = await run()
  expect(Array.from(a)).toEqual(Array.from(b))
})

// docs/plan/29-net-worker-and-reference-server.md Planning decisions ("Spike C (PRE-PLAN §10)"):
// the full spike -- one seed, 3 runs of a 10 s (200-tick, 20 Hz) 4-client session over loopback
// `ws`, identical `trace()`. `@slow`: not required for this cut's own green gate (`pnpm test`
// skips it), run by `pnpm test:slow`.
test('ws/spike-c @slow', async () => {
  async function run(): Promise<Uint8Array> {
    const harness = await createNetHarness({
      fixture: await putsFixture(),
      seed: 30001,
      clients: 4,
      transport: 'ws',
    })
    try {
      harness.clients.forEach((c, i) => {
        c.setCamera(square(i))
      })
      await harness.advanceTicks(20)
      for (let round = 0; round < 4; round++) {
        harness.clients[0]?.dispatch({
          Paint: { pos: { x: round, y: round }, base: 1, resource: 0 },
        })
        harness.clients[1]?.dispatch({ Spawn: { at: { x: -round, y: round }, kind: 1 } })
        harness.clients[2]?.dispatch({ SetMotd: { n: round } })
        harness.clients[3]?.dispatch('Roll')
        await harness.advanceTicks(40)
      }
      harness.link(1).disconnect()
      harness.link(1).reconnect()
      await harness.settle()
      harness.assertConverged()
      return harness.trace()
    } finally {
      await harness.dispose()
    }
  }
  const traces: Uint8Array[] = []
  for (let i = 0; i < 3; i++) traces.push(await run())
  const first = Array.from(traces[0] as Uint8Array)
  for (let i = 1; i < traces.length; i++) {
    expect(Array.from(traces[i] as Uint8Array)).toEqual(first)
  }
  // 3 runs x ~720 ticks x the `ws` transport's own real per-tick yield (`net-harness.ts`'s
  // `advanceTicks`) comfortably exceeds Vitest's 5 s default -- well inside this suite's own
  // `pnpm test:slow` budget regardless (0020 §4's slow tier has no fast-tier time limit).
}, 60_000)
