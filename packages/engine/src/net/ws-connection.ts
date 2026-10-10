// `wsConnection(url)` (M29 Scope/Seams; docs/decisions/
// 0009-transport-and-hosting.md §"WebSocket (`wss`, binary) now": "`binaryType = 'arraybuffer'`, no
// `permessage-deflate`, one socket per client, owned by the net worker"): the browser `WebSocket`
// wrapped as a client-side `Connection` (0009). The exact same function also runs under Node 22's
// own global `WebSocket` (no import, no polyfill -- Node has shipped a spec-following client since
// 22.4), which is why the loopback `ws` netcode tests (`createNetHarness({ transport: 'ws' })`) can
// exercise this exact production wrapper instead of a second, Node-only stand-in.
//
// `net/link.ts`'s own `dial(): Connection` contract: "already open (or open-enough to send/receive)
// the instant it is returned, so there is no separate connecting phase for this file to model." A
// fresh `WebSocket` starts in `CONNECTING`, where a native `.send()` throws -- so this wrapper is
// itself what makes it "open-enough": every `send()` call made before the real `open` event queues
// its bytes (a copy: 0009's own "engine-owned buffer, valid only during the call") and flushes them,
// in order, the instant the socket actually opens. A caller (`createLink`, or a netcode test calling
// this directly) never has to know the difference.
import type { Connection, MsgClass } from '../server.js'

/** `Connection.close(code)`'s own `code` is a plain `number` (0009); this module's own callers
 * sometimes pass `0` as "no particular code" (`net/link.ts`'s `stop()`: `currentConn?.close(0)`,
 * `HeadlessClient.leave()`, M28b Deviations). A real `WebSocket.close(code)` throws
 * `InvalidAccessError` for any code other than `1000` or `3000..4999` (WHATWG "close" algorithm) --
 * `0` was never a meaningful *application* code to begin with (no `CloseCode`, M28, is ever `0`), so
 * it is mapped to `1000` (Normal Closure) here rather than letting the native call throw. */
function normalizeCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000
}

/** `WebSocket.send`'s own TS type only accepts an `ArrayBuffer`-backed view (never a
 * `SharedArrayBuffer`-backed one, TS 7's stricter `ArrayBufferView<TArrayBuffer>` generic) --
 * every `Uint8Array` this module ever hands it is already a plain, non-shared copy (`.slice()`, or
 * a caller's own scratch buffer, never a SAB view), so this is a type-level cast, not a runtime
 * behaviour change. */
function sendBytes(ws: WebSocket, bytes: Uint8Array): void {
  ws.send(bytes as Uint8Array<ArrayBuffer>)
}

export function wsConnection(url: string): Connection {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  let open = false
  let closed = false
  // FIFO of whole messages sent before `open` fires (Deviations: rare in practice -- a caller only
  // ever sends before this dial has proven itself once, `Hello`, and reconnect Hello resend is a
  // later cut's concern -- but never dropped: 0009's `Connection` contract makes no "silently lost"
  // allowance for a reliable-ordered send).
  const pending: Uint8Array[] = []

  const conn: Connection = {
    datagrams: false,
    onMessage: null,
    onClose: null,
    get bufferedAmount(): number {
      return ws.bufferedAmount
    },
    send(_cls: MsgClass, bytes: Uint8Array, len?: number) {
      if (closed) return
      const view = len === undefined ? bytes : bytes.subarray(0, len)
      if (open) {
        sendBytes(ws, view)
      } else {
        pending.push(view.slice())
      }
    },
    close(code: number) {
      if (closed) return
      closed = true
      ws.close(normalizeCloseCode(code))
    },
  }

  ws.onopen = () => {
    open = true
    for (let i = 0; i < pending.length; i++) sendBytes(ws, pending[i] as Uint8Array)
    pending.length = 0
  }
  ws.onmessage = (ev: MessageEvent) => {
    conn.onMessage?.(new Uint8Array(ev.data as ArrayBuffer))
  }
  ws.onclose = (ev: CloseEvent) => {
    closed = true
    conn.onClose?.(ev.code)
  }
  // No `onerror` handling beyond the default (no-op): a `WebSocket` "error" event carries no code or
  // reason (spec, deliberately vague for security) and is always followed by a real `close` event,
  // which is the one this wrapper (and `net/link.ts`'s own dead-timer/close-reason bookkeeping) acts
  // on -- `host/handshake.ts`'s own doc comment: "the close code, not the message body" (and, by the
  // same reasoning, not a second, redundant "error" signal either).

  return conn
}
