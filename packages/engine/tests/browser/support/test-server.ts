// `startTestServer` (docs/plan/29-net-worker-and-reference-server.md Scope, Seams: "test helper
// `startTestServer({ fixture, manualTimer }): { url, stepTick(), stop() }` for Playwright"): a real
// `createWorldServer` + real `ws.WebSocketServer` (`attachWebSocketServer`) on a real loopback
// port, so a real browser page's real `WebSocket` (`mp.html`) can dial it -- the same production
// pieces `games/reference-server` composes, not a second, test-only server implementation.
// `manualTimer: true` (every `mp/*` spec's own choice) disarms the real pacing timer
// (`HostServices.timer.every`, a no-op here) so `stepTick()` drives ticks synchronously and in
// lockstep with whatever the page under test just did -- `net-harness.ts`'s own `VirtualClock`
// cannot be reused here (a real socket's own handshake is genuine event-loop I/O, `ws-transport.
// test.ts`'s own Deviations), so the clock stays real (`systemClock`) and only the tick *cadence*
// is taken away from the wall clock.
import { systemClock, systemScheduler } from '../../../src/clock.js'
import {
  createWorldServer,
  type HostServices,
  type WorldConfig,
  worldServerTestHandle,
} from '../../../src/server.js'
import { attachWebSocketServer, loadGame } from '../../../src/server-node.js'
import { memoryStorage } from '../../../src/storage/memory.js'

export interface TestServer {
  /** `ws://127.0.0.1:<port>` -- the real, OS-assigned port (never a fixed one: two specs' servers
   * must never collide under Playwright's own parallel workers). */
  url: string
  /** `SimHost.stepTick(n)` (bypasses the pacing timer entirely, same as `engine/test`'s own
   * `stepTick`): throws if this server was not started with `manualTimer: true`. */
  stepTick(n?: number): void
  /** Not one of this brief's own pinned `startTestServer` fields (Seams: `{ url, stepTick, stop }`
   * only) -- additive, for `mp/reconnect`'s own "server-side socket kill" (Tests added): `.
   * terminate()`s every currently-open server-side `ws` socket, the abrupt-close counterpart to a
   * player's own `Bye{Leave}` (no close frame, so the browser's real `WebSocket` sees an ordinary
   * network close, `net/link.ts`'s own `'close'` `DownReason`). */
  killClients(): void
  stop(): Promise<void>
}

export interface StartTestServerOptions {
  /** A resolved `{ wasm, buildHash }` (`loadFixture`'s own return shape) or a `buildGame()`
   * directory path (`fixtureBuildDir`/`gameCrateBuildDir`) -- `net-harness.ts`'s own
   * `NetHarnessOptions.fixture` union, mirrored here. */
  fixture: string | { wasm: WebAssembly.Module; buildHash: string }
  /** `true`: `stepTick()` drives every tick, real pacing never arms. `false`: real, wall-clock
   * pacing (`nodeHostServices`'s own `everyViaSetTimer`) -- `stepTick()` then throws, since nothing
   * needs it. Every named `mp/*` browser test uses `true` (Scope: "stepped in lockstep with the
   * pages"). */
  manualTimer: boolean
  worldId?: string
  joinKey?: string
}

async function resolveFixture(
  fixture: StartTestServerOptions['fixture'],
): Promise<{ wasm: WebAssembly.Module; buildHash: string }> {
  return typeof fixture === 'string' ? loadGame(fixture) : fixture
}

export async function startTestServer(opts: StartTestServerOptions): Promise<TestServer> {
  const { wasm, buildHash } = await resolveFixture(opts.fixture)
  const worldCfg: WorldConfig = {
    worldId: opts.worldId ?? 'mp-test',
    buildHash,
    params: { seed: '1', worldgen: null },
    ...(opts.joinKey !== undefined ? { joinKey: opts.joinKey } : {}),
  }
  const host: HostServices = {
    wasm,
    storage: memoryStorage(),
    clock: systemClock,
    // Manual mode's own pacing stub: `SimHost.start()` still arms it (`arm()` runs regardless),
    // but a timer that never calls back never fires `runOneTick` on its own.
    timer: opts.manualTimer ? { every: () => () => {} } : { every: everyRealMs },
    scheduler: systemScheduler,
  }
  const server = createWorldServer(worldCfg, host)
  await server.ready

  const { WebSocketServer } = await import('ws')
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  attachWebSocketServer(wss, server)
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })
  const address = wss.address()
  if (typeof address === 'string' || address === null) {
    throw new Error('startTestServer: WebSocketServer.address() returned no port')
  }
  const url = `ws://127.0.0.1:${address.port}`
  const simHost = worldServerTestHandle(server)

  return {
    url,
    stepTick(n = 1) {
      if (!opts.manualTimer) {
        throw new Error('startTestServer: stepTick() requires manualTimer: true')
      }
      simHost.stepTick(n)
    },
    killClients() {
      for (const socket of wss.clients) socket.terminate()
    },
    async stop() {
      // `ws-transport.test.ts`'s own Deviations (net-harness.ts's `dispose()`): Node's HTTP server
      // `close()` never fires its callback while any socket it ever accepted is still open, and a
      // real browser page's own `WebSocket` is never explicitly closed by this helper -- without
      // this, `stop()` hangs forever whenever a spec tears down with a page still connected.
      for (const socket of wss.clients) socket.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await server.stop()
    },
  }
}

// `manualTimer: false`'s own real-pacing leg (not used by any `mp/*` spec today, kept only so this
// helper's own type accepts the option honestly rather than silently ignoring `false`):
// `HostServices.timer.every`'s exact shape, a plain repeating `setTimeout` chain -- `server-node.
// ts`'s own `everyViaSetTimer` is not exported, so this is a small, local mirror.
function everyRealMs(ms: number, fn: () => void): () => void {
  const id = setInterval(fn, ms)
  return () => clearInterval(id)
}
