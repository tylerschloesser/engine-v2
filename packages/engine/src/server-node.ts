// `engine/server/node`: the Node adapter (docs/decisions/0017 §2). M27 extends this file (`node
// Host Services`, docs/plan/27-server-entrypoint-and-netcode-harness.md Scope); M35b adds the Bun
// and Deno files.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameJson } from './build-game.js'
import { systemClock, systemScheduler } from './clock.js'
import type { Connection, HostServices, MsgClass, WorldServer } from './server.js'
import type { Storage } from './storage/types.js'

export { fsStorage } from './storage/fs.js'

/** Read one `buildGame()` output directory (0017 §4). */
export async function loadGame(
  dir: string,
): Promise<{ wasm: WebAssembly.Module; buildHash: string }> {
  const [bytes, json] = await Promise.all([
    readFile(join(dir, 'game.wasm')),
    readFile(join(dir, 'game.json'), 'utf8'),
  ])
  const { buildHash } = JSON.parse(json) as GameJson
  return { wasm: await WebAssembly.compile(bytes), buildHash }
}

/** `HostServices.timer.every` (0009) over `systemScheduler.setTimer`/`clearTimer` only -- never
 * `requestFrame`/`cancelFrame` (`systemScheduler`'s own other half, backed by `requestAnimationFrame`,
 * which does not exist under Node): a repeating `setTimeout` chain, stopped by calling the returned
 * function. */
function everyViaSetTimer(ms: number, fn: () => void): () => void {
  let stopped = false
  let id: number
  function tick(): void {
    if (stopped) return
    fn()
    id = systemScheduler.setTimer(tick, ms)
  }
  id = systemScheduler.setTimer(tick, ms)
  return () => {
    stopped = true
    systemScheduler.clearTimer(id)
  }
}

/**
 * `nodeHostServices({ wasm, storage, onIdle?, onFatal? })` (docs/plan/
 * 27-server-entrypoint-and-netcode-harness.md, Scope): `createWorldServer`'s `HostServices`
 * (0009), `clock`/`timer` supplied from `systemClock`/`systemScheduler` (M03) -- the real, wall-
 * clock-paced counterpart `engine/test`'s `VirtualClock`-backed harness never uses. The `ws`
 * attachment (a real socket `Connection` adapter) is M29; this only builds the object
 * `createWorldServer` itself takes.
 */
export function nodeHostServices(opts: {
  wasm: WebAssembly.Module
  storage: Storage
  onIdle?: () => void
  onFatal?: (f: { tick: number; message: string }) => void
}): HostServices {
  return {
    wasm: opts.wasm,
    storage: opts.storage,
    clock: systemClock,
    timer: { every: everyViaSetTimer },
    scheduler: systemScheduler,
    ...(opts.onIdle !== undefined ? { onIdle: opts.onIdle } : {}),
    ...(opts.onFatal !== undefined ? { onFatal: opts.onFatal } : {}),
  }
}

// docs/plan/29-net-worker-and-reference-server.md steps 1-2 (Scope: "`attachWebSocketServer(wss,
// server)` in `engine/server/node`, structurally typed (0009 Node)"): 0009 §"Node" verbatim --
// "the game's server package installs `ws`, constructs the `WebSocketServer`, and passes it to the
// engine's Node adapter, which is typed structurally (`{ on('connection', cb) }`, socket `{ send,
// close, on, bufferedAmount }`) so the engine imports nothing. The engine contains no RFC 6455
// code." `WsSocketLike`/`WsServerLike` below are that structural shape, matched by the real `ws`
// package's own `WebSocket`/`WebSocketServer` classes (and by `games/reference-server`'s own
// runtime instances) without this file ever importing `'ws'` itself -- `net-harness.ts`'s own `ws`
// transport is the one place in this repo that constructs a real `WebSocketServer` to hand in here,
// via a dynamic `import('ws')` (Deviations: not a static one, for the same "engine imports nothing"
// reason -- `engine/test` is published, and a consumer who never asks for `transport: 'ws'` must
// never need `ws` installed at all).

/** The one server-side socket shape this file needs (0009 §"Node"): matches the real `ws` package's
 * `WebSocket` instance (server-accepted, not the browser/Node-global client class `wsConnection`
 * wraps) closely enough to compile against it with no import. `send`'s `cb` and `close`'s `reason`
 * are accepted-but-unused parameters of the real `ws` API, included only so a real `ws.WebSocket`
 * satisfies this type with no adapter shim. */
export interface WsSocketLike {
  send(data: Uint8Array, cb?: (err?: Error) => void): void
  close(code?: number, reason?: string): void
  on(event: 'message', cb: (data: unknown, isBinary?: boolean) => void): void
  on(event: 'close', cb: (code: number) => void): void
  on(event: 'error', cb: (err: unknown) => void): void
  readonly bufferedAmount: number
}

/** The one server shape this file needs: `on('connection', ...)` (0009 §"Node") plus `options`,
 * which the real `ws.WebSocketServer` always carries (its own resolved constructor options) --
 * `attachWebSocketServer`'s own `perMessageDeflate` check reads it synchronously, before wiring any
 * connection handler at all. */
export interface WsServerLike {
  options?: { perMessageDeflate?: boolean | object | undefined }
  on(event: 'connection', cb: (socket: WsSocketLike) => void): void
}

/** A `ws` `message` event's own `data` (`ws/deflate-refused`'s sibling scenarios only ever exercise
 * the plain, non-fragmented case: a `Buffer` -- a `Uint8Array` subclass, handed straight through
 * with no copy, matching `Connection.onMessage`'s own "valid only during the call" convention every
 * other adapter in this file already follows for its inbound side). `ws` can also fragment a large
 * message into a `Buffer[]` (`fragmentOutgoingMessages`/`maxPayload` interaction) or, with
 * `skipUTF8Validation`/binary framing edge cases, hand back a plain `ArrayBuffer`; both are covered
 * defensively even though this repo's own traffic (`0011`'s bounded wire format) never produces
 * either from a real client. */
function wsMessageBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) {
    const parts = data as Uint8Array[]
    let total = 0
    for (const part of parts) total += part.length
    const out = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }
  throw new Error('attachWebSocketServer: unexpected message data (expected binary)')
}

/**
 * One accepted `ws` socket as a server-side `Connection` (0009): the shared wiring
 * `attachWebSocketServer` uses for every connection it auto-accepts, and also what
 * `net-harness.ts`'s own `ws` transport builds on (Deviations: it needs to condition a socket
 * *before* handing it to `WorldServer.accept`, so it cannot use `attachWebSocketServer` itself,
 * which does both in one step) -- factored out once rather than duplicated. Not one of this
 * milestone's own pinned Seam names.
 */
export function wsSocketConnection(socket: WsSocketLike): Connection {
  const conn: Connection = {
    datagrams: false,
    onMessage: null,
    onClose: null,
    get bufferedAmount(): number {
      return socket.bufferedAmount
    },
    send(_cls: MsgClass, bytes: Uint8Array, len?: number) {
      socket.send(len === undefined ? bytes : bytes.subarray(0, len))
    },
    close(code: number) {
      // Real close codes only (the same `1000 | 3000..4999` range `ws-connection.ts`'s own
      // `normalizeCloseCode` enforces client-side): every `CloseCode` (M28) this file's own
      // callers ever pass is already inside that range, so this is a defensive mirror, not a
      // behaviour this repo's own server code is expected to exercise the `0` branch of.
      socket.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000)
    },
  }
  socket.on('message', (data) => {
    conn.onMessage?.(wsMessageBytes(data))
  })
  socket.on('close', (code) => {
    conn.onClose?.(code)
  })
  socket.on('error', () => {
    // No behaviour beyond swallowing (`ws-connection.ts`'s own doc comment: a real `close` always
    // follows and is what this repo's own reconnect logic acts on).
  })
  return conn
}

/**
 * `attachWebSocketServer(wss, server)` (Seams: "maps each socket to a `Connection`, close codes
 * passed through, and must check `perMessageDeflate` is off with a readable thrown error"). Throws
 * synchronously, before wiring any `'connection'` listener, when `wss`'s own resolved options do not
 * read exactly `perMessageDeflate: false` (0009 §"WebSocket (`wss`, binary) now": "no
 * `permessage-deflate`") -- an explicit `perMessageDeflate: true` fails this check, and so, more
 * defensively, does anything other than the literal `false` (a truthy config object, `undefined`
 * from an unresolved/structurally-typed `wss`): only a `ws.WebSocketServer` this milestone's own
 * caller built with `perMessageDeflate: false` passes (`games/reference-server` and `net-harness.
 * ts`'s own `ws` transport both do; `ws/deflate-refused`'s own scenario passes `true` to prove the
 * throw side, since this repo's pinned `ws` version's own *default* already resolves to `false`).
 */
export function attachWebSocketServer(wss: WsServerLike, server: WorldServer): void {
  if (wss.options?.perMessageDeflate !== false) {
    throw new Error(
      "ws/deflate-refused: attachWebSocketServer requires the WebSocketServer's own " +
        '`perMessageDeflate: false` (docs/decisions/0009-transport-and-hosting.md: ' +
        '"no `permessage-deflate`")',
    )
  }
  wss.on('connection', (socket) => {
    server.accept(wsSocketConnection(socket))
  })
}
