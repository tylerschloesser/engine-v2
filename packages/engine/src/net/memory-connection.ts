// `memoryConnectionPair` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Seams): the
// in-memory `Connection` implementation of docs/decisions/0009-transport-and-hosting.md -- "most
// scenarios" of docs/decisions/0020-testing-strategy.md §7. Two ends of one pair, each a real
// `Connection`: `send` on one copies its bytes and schedules delivery to the other end's
// `onMessage`, **never inside the `send()` call itself** ("never delivers re-entrantly", Seams) --
// a real transport (a socket, a SAB ring) never hands the peer's callback the CPU before its own
// `send()` returns either, and `conditionLink` (`./conditioner.ts`) relies on this: its own
// `run()` callback calls a wrapped end's `send()` from inside a `VirtualClock.advanceTo()` release
// pass, and must not have that reenter the *conditioner's* own delivery bookkeeping.
import type { Connection, MsgClass } from '../server.js'

interface QueuedMessage {
  cls: MsgClass
  bytes: Uint8Array
}

interface EndState {
  peer: EndState
  queue: QueuedMessage[]
  draining: boolean
  closed: boolean
  conn: Connection
}

function scheduleDrain(end: EndState): void {
  if (end.draining) return
  end.draining = true
  queueMicrotask(() => {
    end.draining = false
    // `end.closed` can flip mid-drain (the peer's own `onMessage` handler closes this end): stop
    // delivering the moment it does, rather than finishing a queue nothing wants any more.
    while (end.queue.length > 0 && !end.closed) {
      const msg = end.queue.shift() as QueuedMessage
      end.conn.onMessage?.(msg.bytes)
    }
  })
}

function makeEnd(datagrams: boolean): EndState {
  // `peer` is filled in by `memoryConnectionPair` right after both ends exist; every real access
  // happens later, from `send`/`close`, never during construction.
  const end: EndState = {
    peer: undefined as unknown as EndState,
    queue: [],
    draining: false,
    closed: false,
    conn: undefined as unknown as Connection,
  }
  end.conn = {
    datagrams,
    onMessage: null,
    onClose: null,
    send(cls, bytes, len?: number) {
      if (end.closed) return
      const peer = end.peer
      if (peer.closed) return
      // "engine-owned buffer, valid only during the call" (0009): copy now, not a `subarray` (this
      // is test/support code, not a hot path -- `.claude/rules/hot-paths.md` scopes to `src/**`
      // production paths, and this module is exempt the same way `src/test/**` is, but the 0009
      // contract itself still requires a real copy since the caller may reuse `bytes` right after).
      //
      // `len` (Deviations, found by `HeadlessClient`'s own smoke test, M27 steps 3-4): the same
      // optional third parameter `RingConnection.send`/`server.ts`'s `runOneTick` already carry
      // (Orchestrator ruling 2, this file's own header comment: "a real Connection implementation
      // drives" -- `frame.bytes` there is the *whole* persistent `Tx`/`Persist` region view, with
      // the real message length riding along separately). A generic `Connection` that ignores it
      // and copies `bytes.length` sends the whole region, garbage tail included, and every real
      // caller of `SimHost.accept` -- not only `RingConnection` -- relies on this being honoured:
      // `bytes.slice(0, len)`, not `bytes.slice()`, whenever `len` is given.
      peer.queue.push({ cls, bytes: len === undefined ? bytes.slice() : bytes.slice(0, len) })
      scheduleDrain(peer)
    },
    close(code) {
      if (end.closed) return
      end.closed = true
      end.queue.length = 0
      end.conn.onMessage = null
      const peer = end.peer
      if (!peer.closed) {
        peer.closed = true
        peer.queue.length = 0
        const cb = peer.conn.onClose
        peer.conn.onClose = null
        if (cb) queueMicrotask(() => cb(code ?? 0))
      }
    },
  }
  return end
}

/**
 * `memoryConnectionPair(opts?)` (Seams): two `Connection`s wired to each other. `opts.datagrams`
 * (default `false`) sets both ends' `datagrams` flag, so a `latest-wins` test can exercise the
 * `datagrams: true` path (Planning decisions: "one scenario runs a `datagrams: true` memory pair
 * with latest-wins drops") without a real transport existing yet.
 */
export function memoryConnectionPair(opts?: { datagrams?: boolean }): [Connection, Connection] {
  const datagrams = opts?.datagrams ?? false
  const a = makeEnd(datagrams)
  const b = makeEnd(datagrams)
  a.peer = b
  b.peer = a
  return [a.conn, b.conn]
}
