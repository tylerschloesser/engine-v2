// `accept-before-ready` (docs/plan/38-hosting-checks.md Deviations, found on the second spawn of
// `reference-server/sigterm-snapshots`): a connection accepted before `ready` keeps what it sends. The
// `Hello` of a client that dials while the world is still loading (a woken Fly machine, a Durable
// Object) used to be dropped -- `accept` only queued the connection and left `onMessage` unset, so an
// adapter's `conn.onMessage?.(bytes)` did nothing -- and the client waited out its 3 s link timeout.
// No wall clock: the tick timer is manual and the `Hello` is delivered before `ready` can resolve.
import { expect, test } from 'vitest'
import { hexDecode } from '../../src/host/sessions.js'
import {
  type Connection,
  createWorldServer,
  type MsgClass,
  serverInternals,
  type WorldConfig,
} from '../../src/server.js'
import { memoryStorage } from '../../src/storage/memory.js'
import { buildHelloBytes, fixedSecret, putsFixture } from './support.js'

test('accept-before-ready: a Hello delivered before ready is answered with a Welcome', async () => {
  const { wasm, buildHash } = await putsFixture()
  const cfg: WorldConfig = {
    worldId: 'w-accept-before-ready',
    buildHash,
    params: { seed: '79', worldgen: null },
  }
  let tick: (() => void) | null = null
  const server = createWorldServer(cfg, {
    wasm,
    storage: memoryStorage(),
    clock: { now: () => 0 },
    timer: {
      every: (_ms: number, cb: () => void) => {
        tick = cb
        return () => {
          tick = null
        }
      },
    },
  })
  const sent: Uint8Array[] = []
  let closedWith: number | null = null
  const conn: Connection = {
    datagrams: false,
    onMessage: null,
    onClose: null,
    send: (_cls: MsgClass, bytes: Uint8Array, len?: number) => {
      sent.push(bytes.slice(0, len))
    },
    close: (code: number) => {
      closedWith = code
    },
  }
  // `ready` cannot have resolved: `Persistence.open` is asynchronous and nothing has been awaited.
  server.accept(conn)
  const hello = buildHelloBytes(wasm, {
    secret: fixedSecret(0x79),
    joinKey: '',
    buildHash: hexDecode(buildHash),
  })
  conn.onMessage?.(hello)

  await server.ready
  await serverInternals(server).handshakesSettled()
  ;(tick as (() => void) | null)?.()
  await serverInternals(server).handshakesSettled()
  ;(tick as (() => void) | null)?.()

  expect(closedWith).toBeNull()
  expect(sent.length).toBeGreaterThanOrEqual(1)
  expect(sent[0]?.[0], 'first message is a Welcome (MsgType 0x03)').toBe(0x03)
  await server.stop()
})
