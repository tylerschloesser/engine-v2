// `engine/server/deno`: the Deno adapter (docs/decisions/0009 "Targets": "Deno: adapter only,
// best-effort"; M35b. The twin of `server-bun.ts`:
// `denoHandler(server)` is the `(req) => Response` a game passes to `Deno.serve`, built on
// `Deno.upgradeWebSocket`, which is declared below structurally so a consumer's `tsc` needs no Deno
// lib types.
import { CloseCode } from './host/handshake.js'
import type { Connection, MsgClass, WorldServer } from './server.js'
import { hostServices } from './server-host-services.js'

export { fsStorage, loadGame } from './server-node.js'

/** `createWorldServer`'s `HostServices` for a Deno process (0009): the same body as
 * `nodeHostServices` (`server-host-services.ts`). */
export const denoHostServices = hostServices

/** The standard `WebSocket` Deno's upgrade returns, as far as this file uses it. */
interface DenoSocketLike {
  binaryType: string
  readonly bufferedAmount: number
  send(data: Uint8Array): void
  close(code?: number): void
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number }) => void) | null
  onopen: (() => void) | null
  onerror: (() => void) | null
}

declare const Deno: {
  upgradeWebSocket(req: Request): { socket: DenoSocketLike; response: Response }
}

function closeCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000
}

function socketConnection(ws: DenoSocketLike): Connection {
  const conn: Connection = {
    datagrams: false,
    onMessage: null,
    onClose: null,
    get bufferedAmount(): number {
      return ws.bufferedAmount
    },
    send(_cls: MsgClass, bytes: Uint8Array, len?: number) {
      ws.send(len === undefined ? bytes : bytes.subarray(0, len))
    },
    close(code: number) {
      ws.close(closeCode(code))
    },
  }
  ws.onmessage = (ev) => {
    const data = ev.data
    if (data instanceof ArrayBuffer) conn.onMessage?.(new Uint8Array(data))
    else if (data instanceof Uint8Array) conn.onMessage?.(data)
  }
  ws.onclose = (ev) => {
    conn.onClose?.(ev.code)
  }
  ws.onerror = () => {
    // A `close` always follows; that is what the session machinery acts on.
  }
  return conn
}

/**
 * `denoHandler(server)`: a `(req: Request) => Response` for `Deno.serve`. A request that is not a
 * WebSocket upgrade gets `426`; every other one becomes a `Connection` for `server.accept`, with
 * `binaryType` `arraybuffer` (Deno's server does not compress, 0009).
 */
export function denoHandler(server: WorldServer): (req: Request) => Response {
  return (req) => {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 })
    }
    const { socket, response } = Deno.upgradeWebSocket(req)
    socket.binaryType = 'arraybuffer'
    const conn = socketConnection(socket)
    try {
      server.accept(conn)
    } catch {
      socket.onopen = () => socket.close(CloseCode.Full)
    }
    return response
  }
}
