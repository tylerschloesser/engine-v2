// `engine/server/bun`: the Bun adapter (docs/decisions/0009 §"Node"/"Targets", 0017 §2;
// docs/plan/35b-bun-and-deno-adapters.md). It has the names of `server-node.ts`, `bunHandlers`
// taking the place of `attachWebSocketServer`: the game calls `Bun.serve({ port, ...bunHandlers(
// server) })` itself (port, TLS and routing stay with the deployer, 0009 Consequences), and this
// file only upgrades and turns each socket into a `Connection`. `loadGame` and `fsStorage` are the
// one `node:fs` implementation (Bun implements `node:fs`; 0005's adapter table has one row for the
// three runtimes); the `Bun.` global is named nowhere, because `Bun.serve` is the caller's.
import { CloseCode } from './host/handshake.js'
import type { Connection, MsgClass, WorldServer } from './server.js'
import { hostServices } from './server-host-services.js'

export { fsStorage, loadGame } from './server-node.js'

/** `createWorldServer`'s `HostServices` for a Bun process (0009): the same body as
 * `nodeHostServices` (`server-host-services.ts`). */
export const bunHostServices = hostServices

/** The one server-side socket shape this file needs: Bun's `ServerWebSocket`, typed structurally so
 * a consumer's `tsc` needs no `@types/bun`. */
export interface BunSocketLike {
  binaryType: 'arraybuffer' | 'nodebuffer' | 'uint8array'
  data: BunSocketData
  send(data: Uint8Array): number
  close(code?: number, reason?: string): void
  getBufferedAmount(): number
}

/** `ws.data`: the slot `bunHandlers`'s `fetch` hands to the upgrade and `open` fills. */
export interface BunSocketData {
  conn?: Connection
}

/** The `websocket` half of `Bun.serve`'s options. */
export interface BunWebSocketHandlers {
  perMessageDeflate: false
  open(ws: BunSocketLike): void
  message(ws: BunSocketLike, data: string | ArrayBuffer | Uint8Array): void
  close(ws: BunSocketLike, code: number, reason: string): void
}

/** The `Bun.Server` surface `fetch` uses. */
export interface BunServerLike {
  upgrade(req: Request, options: { data: BunSocketData }): boolean
}

/** A real close code only (WHATWG: `1000` or `3000..4999`, anything else throws). */
function closeCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000
}

function socketConnection(ws: BunSocketLike): Connection {
  return {
    datagrams: false,
    onMessage: null,
    onClose: null,
    get bufferedAmount(): number {
      return ws.getBufferedAmount()
    },
    send(_cls: MsgClass, bytes: Uint8Array, len?: number) {
      ws.send(len === undefined ? bytes : bytes.subarray(0, len))
    },
    close(code: number) {
      ws.close(closeCode(code))
    },
  }
}

/**
 * `bunHandlers(server)`: the `{ fetch, websocket }` pair a game spreads into `Bun.serve`. `fetch`
 * upgrades every request (no path filtering, as on Node: the game routes before calling it if it
 * wants to); `websocket` turns each socket into a `Connection` for `server.accept` with
 * `binaryType` `arraybuffer` and no compression (0009).
 */
export function bunHandlers(server: WorldServer): {
  fetch(req: Request, bunServer: BunServerLike): Response | undefined
  websocket: BunWebSocketHandlers
} {
  return {
    fetch(req, bunServer) {
      if (bunServer.upgrade(req, { data: {} })) return undefined
      return new Response('expected a WebSocket upgrade', { status: 426 })
    },
    websocket: {
      perMessageDeflate: false,
      open(ws) {
        ws.binaryType = 'arraybuffer'
        const conn = socketConnection(ws)
        ws.data.conn = conn
        try {
          server.accept(conn)
        } catch {
          // Full (`SimHost.accept` throws): refuse this socket, never take the process down (the
          // same rule `attachWebSocketServer` follows, M29b).
          ws.close(CloseCode.Full)
        }
      },
      message(ws, data) {
        if (typeof data === 'string') return // text frames are not protocol
        ws.data.conn?.onMessage?.(data instanceof Uint8Array ? data : new Uint8Array(data))
      },
      close(ws, code) {
        ws.data.conn?.onClose?.(code)
      },
    },
  }
}
