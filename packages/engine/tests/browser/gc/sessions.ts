// CDP session plumbing behind one interface, two implementations (docs/plan/04-zero-gc-harness.md,
// Planning decisions "CDP transport: both, behind one interface"; 0024 §12). `tunnel` (this file) is
// the default: Playwright's own `CDPSession` for the page (`main`) plus the deprecated but proven
// `Target.sendMessageToTarget` tunnel for every auto-attached worker (0016 §3 step 2, ~970 spike
// runs). `cdp-flat.ts` is the flattened-session replacement, proven only by a parity test.
import type { CDPSession, Page } from '@playwright/test'

/** One CDP-addressable isolate. `name` is filled in by the caller once naming resolves (Planning
 * decisions "Naming isolates"): a session is usable before that, just not yet attributable. */
export interface IsolateSession {
  name: string
  // biome-ignore lint/suspicious/noExplicitAny: CDP responses are heterogeneous by method.
  send(method: string, params?: Record<string, unknown>): Promise<any>
}

class MainSession implements IsolateSession {
  name = 'main'
  #cdp: CDPSession
  constructor(cdp: CDPSession) {
    this.#cdp = cdp
  }
  // biome-ignore lint/suspicious/noExplicitAny: see IsolateSession.
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    // biome-ignore lint/suspicious/noExplicitAny: passthrough to the strictly-typed CDP send.
    return (this.#cdp.send as any)(method, params)
  }
}

/**
 * The non-flattened tunnel (0016 §3 step 2): every message to/from a worker travels as a JSON
 * string inside `Target.sendMessageToTarget`/`Target.receivedMessageFromTarget` on the page's own
 * `CDPSession`, because Playwright's `CDPSession` cannot address a flattened child session.
 */
export class TunnelSession implements IsolateSession {
  name: string
  #parent: CDPSession
  #sessionId: string
  #nextId = 1
  #pending = new Map<
    number,
    // biome-ignore lint/suspicious/noExplicitAny: CDP result shape depends on the method.
    { resolve: (v: any) => void; reject: (e: Error) => void; method: string }
  >()

  constructor(name: string, parent: CDPSession, sessionId: string) {
    this.name = name
    this.#parent = parent
    this.#sessionId = sessionId
    parent.on('Target.receivedMessageFromTarget', (ev) => {
      if (ev.sessionId !== sessionId) return
      const msg = JSON.parse(ev.message)
      const pending = this.#pending.get(msg.id)
      if (!pending) return
      this.#pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`))
      else pending.resolve(msg.result)
    })
  }

  // biome-ignore lint/suspicious/noExplicitAny: see IsolateSession.
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.#nextId++
    const done = new Promise((resolve, reject) =>
      this.#pending.set(id, { resolve, reject, method }),
    )
    this.#parent
      .send('Target.sendMessageToTarget', {
        sessionId: this.#sessionId,
        message: JSON.stringify({ id, method, params }),
      })
      .catch(() => {
        // The rejection surfaces through `done` instead (this call's own promise is not awaited).
      })
    return done
  }
}

export type AttachedSessions = {
  main: IsolateSession
  workers: TunnelSession[]
  /** `cdp-flat.ts`'s attachment owns a raw WebSocket and needs this; the tunnel rides Playwright's
   * own `CDPSession`, which closes with the page. */
  close?: () => void
}

/**
 * `main` plus one `TunnelSession` per auto-attached worker target, in attachment order (stable for
 * one worker; M06b+ pages with several workers get whatever order Chromium attaches them in, which
 * `instrument.ts` resolves to names before it matters). Waits for exactly `expectedWorkers` workers.
 */
export async function attachTunnelSessions(
  page: Page,
  expectedWorkers: number,
): Promise<AttachedSessions> {
  const pageSession = await page.context().newCDPSession(page)
  const workers: TunnelSession[] = []
  const waiters: Array<() => void> = []
  pageSession.on('Target.attachedToTarget', (ev) => {
    if (ev.targetInfo.type !== 'worker') return
    workers.push(new TunnelSession(`worker#${workers.length}`, pageSession, ev.sessionId))
    waiters.shift()?.()
  })
  await pageSession.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  })
  while (workers.length < expectedWorkers) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  return { main: new MainSession(pageSession), workers }
}
