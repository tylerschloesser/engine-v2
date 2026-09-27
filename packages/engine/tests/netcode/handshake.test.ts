// `handshake` (docs/plan/28-sessions-and-reconnect.md, Tests added): the scenarios step 1-2 did
// not already cover -- `Superseded`, `Bye{Leave}`, `Full`, `BadKey`, `VersionMismatch`, garbage
// before `Hello`, the 5 s no-`Hello` timeout, a storage crash between the session-table write and
// the log record it precedes, same-secret reconnect, and reveal-after-visible-chunks. Every raw
// scenario drives `harness.connectRaw()` byte for byte (Seams); nothing here mocks the transport
// or the clock (0020 §7).
import { describe, expect, test } from 'vitest'
import { ByeReason, CloseCode } from '../../src/host/handshake.js'
import { hashSecretHex, hexDecode, type SessionEntry } from '../../src/host/sessions.js'
import {
  type Connection,
  createWorldServer,
  MsgClass,
  serverInternals,
  type WorldConfig,
} from '../../src/server.js'
import { memoryStorage } from '../../src/storage/memory.js'
import { worldKeys } from '../../src/storage/types.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { buildHelloBytes, DEFAULT_SEED, fixedSecret, putsFixture, square } from './support.js'

/** `session::MsgType::Welcome` (0x03), the wire's own first byte -- `Welcome = MsgType::Welcome ·
 * player_id varint · ...` (`session/mod.rs`'s own layout doc comment). No TS `Welcome` decoder
 * exists yet (only `client_on_welcome`, WASM-side): these scenarios only ever need the one leading
 * field, so a tiny local LEB128 reader (mirrors `host/handshake.ts`'s own private `readVarint`)
 * is simpler than adding one.
 */
function parseWelcomePlayerId(bytes: Uint8Array): number {
  if (bytes[0] !== 0x03) {
    throw new Error(`parseWelcomePlayerId: not a Welcome (msg_type ${bytes[0]})`)
  }
  let value = 0
  let shift = 0
  let pos = 1
  for (;;) {
    const b = bytes[pos]
    if (b === undefined) throw new Error('parseWelcomePlayerId: truncated varint')
    pos++
    value |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return value >>> 0
    shift += 7
  }
}

describe('handshake', () => {
  test('join-then-return-same-player', async () => {
    const secret = fixedSecret(0x11)
    const harness = await createNetHarness({
      fixture: await putsFixture(),
      seed: DEFAULT_SEED,
      clients: 0,
    })
    try {
      const first = harness.addClient(secret)
      first.setCamera(square(0))
      await harness.settle()
      const playerId1 = first.status().ownPlayerId
      expect(playerId1).toBeGreaterThan(0)

      // A real disconnect (0013: "any close" logs `Disconnected` at once until M28b's grace) --
      // not a `Superseded` scenario: the first connection is fully gone before the second exists.
      harness.link(0).disconnect()
      await harness.advanceTicks(2)

      const second = harness.addClient(secret)
      second.setCamera(square(0))
      await harness.settle()

      // Same secret -> same `PlayerId` (0013 Planning decisions: table entry, not a fresh one).
      expect(second.status().ownPlayerId).toBe(playerId1)
    } finally {
      await harness.dispose()
    }
  })

  test('version-mismatch', async () => {
    const { wasm } = await putsFixture()
    const harness = await createNetHarness({ fixture: await putsFixture(), seed: 9001, clients: 0 })
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
      await harness.advanceTicks(3)
      expect(closeCode).toBe(CloseCode.VersionMismatch)
    } finally {
      await harness.dispose()
    }
  })

  test('bad-key', async () => {
    const { wasm, buildHash } = await putsFixture()
    const harness = await createNetHarness({
      fixture: { wasm, buildHash },
      seed: 9002,
      clients: 0,
      world: { joinKey: 'right-key' },
    })
    try {
      const conn = harness.connectRaw()
      let closeCode: number | undefined
      conn.onClose = (code) => {
        closeCode = code
      }
      const hello = buildHelloBytes(wasm, {
        secret: fixedSecret(0x23),
        joinKey: 'wrong-key',
        buildHash: hexDecode(buildHash),
      })
      conn.send(MsgClass.ReliableOrdered, hello)
      await harness.advanceTicks(3)
      expect(closeCode).toBe(CloseCode.BadKey)
    } finally {
      await harness.dispose()
    }
  })

  test('full', async () => {
    const { wasm, buildHash } = await putsFixture()
    const harness = await createNetHarness({
      fixture: { wasm, buildHash },
      seed: 9003,
      clients: 1,
      world: { maxPlayers: 1 },
    })
    try {
      await harness.settle()
      const conn = harness.connectRaw()
      let closeCode: number | undefined
      conn.onClose = (code) => {
        closeCode = code
      }
      const hello = buildHelloBytes(wasm, {
        secret: fixedSecret(0x24), // never-seen: a known secret is refused too (0013), but this
        // proves the simpler case first.
        joinKey: '',
        buildHash: hexDecode(buildHash),
      })
      conn.send(MsgClass.ReliableOrdered, hello)
      await harness.advanceTicks(3)
      expect(closeCode).toBe(CloseCode.Full)
    } finally {
      await harness.dispose()
    }
  })

  test('superseded', async () => {
    const { wasm, buildHash } = await putsFixture()
    const harness = await createNetHarness({ fixture: { wasm, buildHash }, seed: 9004, clients: 0 })
    try {
      const secret = fixedSecret(0x25)
      const hello = buildHelloBytes(wasm, { secret, joinKey: '', buildHash: hexDecode(buildHash) })

      const conn1 = harness.connectRaw()
      const conn1Messages: Uint8Array[] = []
      let conn1CloseCode: number | undefined
      // `events` orders message/close arrivals against each other (Constraints: the orchestrator's
      // own conditionLink fix -- a message queued before `close()` must still be delivered first,
      // same as a real reliable-ordered connection/WebSocket).
      const events: ('message' | 'close')[] = []
      conn1.onMessage = (bytes) => {
        conn1Messages.push(bytes.slice())
        events.push('message')
      }
      conn1.onClose = (code) => {
        conn1CloseCode = code
        events.push('close')
      }
      conn1.send(MsgClass.ReliableOrdered, hello)
      await harness.advanceTicks(1) // deliver Hello to the host
      await serverInternals(harness.server).handshakesSettled() // digest + table write
      await harness.advanceTicks(1) // pumpHandshakes: sim_attach, Welcome to conn1
      // The tick that completes the attach also runs its own per-connection frame pass
      // afterward (`runOneTick`), so `Welcome` and this connection's first real `Frame` can land
      // in the same tick bucket (`counters-exact.test.ts`'s own precedent) -- `Welcome` is always
      // first (`pumpHandshakes` runs before the frame loop).
      expect(conn1Messages.length).toBeGreaterThanOrEqual(1)
      const player1 = parseWelcomePlayerId(conn1Messages[0] as Uint8Array)

      const conn2 = harness.connectRaw()
      const conn2Messages: Uint8Array[] = []
      conn2.onMessage = (bytes) => conn2Messages.push(bytes.slice())
      conn2.send(MsgClass.ReliableOrdered, hello) // the *same* secret
      await harness.advanceTicks(1) // deliver
      await serverInternals(harness.server).handshakesSettled()
      await harness.advanceTicks(1) // pumpHandshakes: supersedes conn1, Welcome to conn2

      // 0013: "the old socket gets `Bye{Superseded}` and must not auto-reconnect" -- Constraints:
      // asserts `4001` on the old end. `conditioner.ts`'s `scheduleClose` orders the close after
      // every already-scheduled send on the same direction (0009: a reliable-ordered connection,
      // and a real WebSocket, deliver queued application data ahead of their own close), so the
      // `Bye` the host sent immediately before closing must still arrive first.
      expect(conn1CloseCode).toBe(CloseCode.Superseded)
      const byeMessage = conn1Messages[conn1Messages.length - 1] as Uint8Array
      expect(Array.from(byeMessage)).toEqual([0x05, ByeReason.Superseded])
      expect(events[events.length - 1]).toBe('close')
      expect(events[events.length - 2]).toBe('message') // the Bye, right before the close

      expect(conn2Messages.length).toBeGreaterThanOrEqual(1)
      const player2 = parseWelcomePlayerId(conn2Messages[0] as Uint8Array)
      // Same secret -> same `PlayerId`, not a fresh allocation (proves no duplicate id was minted
      // by the supersede path).
      expect(player2).toBe(player1)
    } finally {
      await harness.dispose()
    }
  })

  test('garbage-before-hello', async () => {
    const harness = await createNetHarness({ fixture: await putsFixture(), seed: 9005, clients: 0 })
    try {
      const conn = harness.connectRaw()
      let closeCode: number | undefined
      conn.onClose = (code) => {
        closeCode = code
      }
      const garbage = new Uint8Array([1, 2, 3]) // too short to be a frozen `Hello` prefix
      for (let i = 0; i < 8; i++) {
        conn.send(MsgClass.ReliableOrdered, garbage)
        await harness.advanceTicks(1)
      }
      // At most 8 tolerated (Scope): still open.
      expect(closeCode).toBeUndefined()
      conn.send(MsgClass.ReliableOrdered, garbage) // the 9th
      await harness.advanceTicks(1)
      expect(closeCode).toBe(CloseCode.ProtocolError)
    } finally {
      await harness.dispose()
    }
  })

  test('no-hello-timeout', async () => {
    const harness = await createNetHarness({ fixture: await putsFixture(), seed: 9006, clients: 0 })
    try {
      const conn = harness.connectRaw()
      let closeCode: number | undefined
      conn.onClose = (code) => {
        closeCode = code
      }
      // fx-puts ticks at 20 Hz (50 ms/tick): 101 ticks clears the 5,000 ms `HELLO_TIMEOUT_MS`.
      await harness.advanceTicks(101)
      expect(closeCode).toBe(CloseCode.ProtocolError)
    } finally {
      await harness.dispose()
    }
  })

  test('crash-between-table-and-log', async () => {
    const { wasm, buildHash } = await putsFixture()
    const cfg: WorldConfig = {
      worldId: 'w-crash-between-table-and-log',
      buildHash,
      params: { seed: '77', worldgen: null },
    }
    const keys = worldKeys(cfg.worldId)
    const secret = fixedSecret(0x7a)
    const hashHex = await hashSecretHex(secret)

    async function sessionEntries(storage: {
      read(key: string): Promise<Uint8Array | null>
    }): Promise<Record<string, SessionEntry>> {
      const raw = await storage.read(keys.sessions)
      return raw ? (JSON.parse(new TextDecoder().decode(raw)) as Record<string, SessionEntry>) : {}
    }

    function fakeConnection(): Connection {
      return { datagrams: false, onMessage: null, onClose: null, send: () => {}, close: () => {} }
    }

    function manualTimer() {
      let fn: (() => void) | null = null
      return {
        services: {
          every: (_ms: number, cb: () => void) => {
            fn = cb
            return () => {
              fn = null
            }
          },
        },
        fire() {
          fn?.()
        },
      }
    }

    const backing = new Map<string, Uint8Array>()
    const storage = memoryStorage(backing)
    const timer = manualTimer()
    const server = createWorldServer(cfg, {
      wasm,
      storage,
      clock: { now: () => 0 },
      timer: timer.services,
    })
    await server.ready

    const conn1 = fakeConnection()
    server.accept(conn1)
    conn1.onMessage?.(
      buildHelloBytes(wasm, { secret, joinKey: '', buildHash: hexDecode(buildHash) }),
    )
    // Digest + session-table write: durable *before* the record is ever appended (Planning
    // decisions), the exact ordering this test injects a fault into.
    await serverInternals(server).handshakesSettled()

    const beforeCrash = await sessionEntries(storage)
    expect(beforeCrash[hashHex]?.playerId).toBe(1)
    expect(Object.keys(beforeCrash)).toHaveLength(1)

    // Inject: the very next log write fails (the write-ahead frame that would carry this attach's
    // own `Joined`/`Connected` records, `pumpHandshakes` -> `sim_seal_frame` -> `logSink` ->
    // `Persistence.appendFrame` -> `storage.append`). Proven to matter: the tick throws only while
    // armed (inject-fail-revert), and never throws once reverted below.
    const realAppend = storage.append.bind(storage)
    let armed = true
    storage.append = (key, bytes) => {
      if (armed) {
        armed = false
        throw new Error('injected: storage.append failure (crash-between-table-and-log)')
      }
      return realAppend(key, bytes)
    }
    expect(() => timer.fire()).toThrow(/injected/)
    storage.append = realAppend // revert: Constraints "one inject-fail-revert"

    // The "crash": this in-memory server/instance is never trusted or ticked again (0005: "a
    // failed or lost write is fatal to the world"). A fresh process, over the same durable bytes.
    const restartedTimer = manualTimer()
    const restarted = createWorldServer(cfg, {
      wasm,
      storage: memoryStorage(backing),
      clock: { now: () => 0 },
      timer: restartedTimer.services,
    })
    await restarted.ready

    const afterCrash = await sessionEntries(memoryStorage(backing))
    // Not orphaned: the table survived (durable before the fault was ever armed). Not duplicated:
    // still the only entry this world's table has ever held -- `sessions.lookup` finds it, so the
    // "next id" allocator (`highestPlayerId() + 1`) is never even consulted for this secret again.
    expect(afterCrash[hashHex]?.playerId).toBe(1)
    expect(Object.keys(afterCrash)).toHaveLength(1)

    const conn2 = fakeConnection()
    const conn2Messages: Uint8Array[] = []
    conn2.send = (_cls, bytes) => conn2Messages.push(bytes.slice())
    restarted.accept(conn2)
    conn2.onMessage?.(
      buildHelloBytes(wasm, { secret, joinKey: '', buildHash: hexDecode(buildHash) }),
    )
    await serverInternals(restarted).handshakesSettled()
    restartedTimer.fire() // real attach this time: Joined actually reaches the log

    expect(conn2Messages.length).toBeGreaterThanOrEqual(1)
    expect(parseWelcomePlayerId(conn2Messages[0] as Uint8Array)).toBe(1)

    const finalEntries = await sessionEntries(memoryStorage(backing))
    expect(Object.keys(finalEntries)).toHaveLength(1)
    expect(finalEntries[hashHex]?.playerId).toBe(1)

    await server.stop()
    await restarted.stop()
  })

  test('reveal-after-visible-chunks', async () => {
    const harness = await createNetHarness({ fixture: await putsFixture(), seed: 4242, clients: 1 })
    try {
      const client = harness.clients[0]
      if (!client) throw new Error('reveal-after-visible-chunks: no client 0')
      client.setCamera(square(0))
      // `Welcome` applies quickly, but the visible rectangle's chunks are neither held by the
      // replica nor locally generated yet.
      await harness.advanceTicks(2)
      expect(client.status().live).toBe(true)
      expect(client.status().revealed).toBe(false)
      // `settle()` drives enough ticks for every visible chunk to be both subscribed, generated
      // and applied (`join-converges`/`late-join`'s own precedent for "after quiescence").
      await harness.settle()
      expect(client.status().revealed).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})
