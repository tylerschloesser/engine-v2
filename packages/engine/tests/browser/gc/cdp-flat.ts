// The flattened-session CDP transport (docs/plan/04-zero-gc-harness.md, Planning decisions "CDP
// transport: both, behind one interface"; 0024 §12; PRE-PLAN.md risk 11). Node's own CDP WebSocket
// against Chromium's `--remote-debugging-port`, `Target.attachToTarget` + `Target.setAutoAttach
// {flatten: true}`, routed by `sessionId` on one connection -- the replacement named in 0016's
// Consequences for the day the tunnel's `Target.sendMessageToTarget` is removed. Proven only by
// `gc: flat transport parity` (tests/browser/gc-loop.spec.ts): flipping the day that happens is
// changing `instrument.ts`'s default transport, not writing this file under a red suite.
import type { IsolateSession } from './sessions.ts'

/** `ENGINE_CDP_PORT`: base port; a worker adds its own `parallelIndex` so two suites (or two
 * worktrees) never collide (docs/plan/04-zero-gc-harness.md notes). */
export const ENGINE_CDP_PORT_BASE = Number(process.env.ENGINE_CDP_PORT ?? 9333)

type Pending = {
  // biome-ignore lint/suspicious/noExplicitAny: CDP result shape depends on the method.
  resolve: (v: any) => void
  reject: (e: Error) => void
  method: string
}

/** One flattened CDP WebSocket, shared by every session attached over it: `id` is a single counter
 * for the whole connection (CDP flattened-mode requirement), routed back by `id`; events route by
 * `sessionId` (root session: `undefined`). */
class FlatConnection {
  #ws: WebSocket
  #nextId = 1
  #pending = new Map<number, Pending>()
  // biome-ignore lint/suspicious/noExplicitAny: event payload shape depends on the CDP method.
  #onAttached: ((ev: any) => void) | undefined

  private constructor(ws: WebSocket) {
    this.#ws = ws
    ws.addEventListener('message', (ev) => this.#onMessage(JSON.parse(String(ev.data))))
  }

  static async connect(webSocketDebuggerUrl: string): Promise<FlatConnection> {
    const ws = new WebSocket(webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener(
        'error',
        () => reject(new Error(`cdp-flat: could not open ${webSocketDebuggerUrl}`)),
        {
          once: true,
        },
      )
    })
    return new FlatConnection(ws)
  }

  // biome-ignore lint/suspicious/noExplicitAny: see FlatConnection.
  #onMessage(msg: any): void {
    if (msg.id !== undefined) {
      const pending = this.#pending.get(msg.id)
      if (!pending) return
      this.#pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`))
      else pending.resolve(msg.result)
      return
    }
    if (msg.method === 'Target.attachedToTarget') this.#onAttached?.(msg.params)
  }

  send(
    sessionId: string | undefined,
    method: string,
    params: Record<string, unknown> = {},
    // biome-ignore lint/suspicious/noExplicitAny: see FlatConnection.
  ): Promise<any> {
    const id = this.#nextId++
    const done = new Promise((resolve, reject) =>
      this.#pending.set(id, { resolve, reject, method }),
    )
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.#ws.send(JSON.stringify(payload))
    return done
  }

  // biome-ignore lint/suspicious/noExplicitAny: see FlatConnection.
  onAttached(handler: (ev: any) => void): void {
    this.#onAttached = handler
  }

  close(): void {
    this.#ws.close()
  }
}

class FlatSession implements IsolateSession {
  name: string
  #connection: FlatConnection
  #sessionId: string | undefined
  constructor(name: string, connection: FlatConnection, sessionId: string | undefined) {
    this.name = name
    this.#connection = connection
    this.#sessionId = sessionId
  }
  // biome-ignore lint/suspicious/noExplicitAny: see sessions.ts's IsolateSession.
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.#connection.send(this.#sessionId, method, params)
  }
}

export type FlatAttachment = { main: IsolateSession; workers: FlatSession[]; close(): void }

/**
 * Attaches to `pageUrlToken` (a value the page's own URL is expected to contain, since several
 * pages can be open on one browser) over the browser's own flattened CDP WebSocket, then to every
 * worker of that page target as it attaches. Waits for exactly `expectedWorkers` workers.
 */
export async function attachFlatSessions(
  port: number,
  pageUrlToken: string,
  expectedWorkers: number,
): Promise<FlatAttachment> {
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
    webSocketDebuggerUrl: string
  }
  const connection = await FlatConnection.connect(version.webSocketDebuggerUrl)

  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
    id: string
    type: string
    url: string
  }>
  const target = list.find((t) => t.type === 'page' && t.url.includes(pageUrlToken))
  if (!target)
    throw new Error(`cdp-flat: no page target with token '${pageUrlToken}' in /json/list`)

  const { sessionId: pageSessionId } = await connection.send(undefined, 'Target.attachToTarget', {
    targetId: target.id,
    flatten: true,
  })

  const workers: FlatSession[] = []
  const waiters: Array<() => void> = []
  connection.onAttached((ev) => {
    if (ev.targetInfo.type !== 'worker') return
    workers.push(new FlatSession(`worker#${workers.length}`, connection, ev.sessionId))
    waiters.shift()?.()
  })
  await connection.send(pageSessionId, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  })
  while (workers.length < expectedWorkers) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }

  return {
    main: new FlatSession('main', connection, pageSessionId),
    workers,
    close: () => connection.close(),
  }
}
