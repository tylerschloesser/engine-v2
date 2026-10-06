// A tunnel's first load of a page is where the driven rounds lost M34-two-devices (M39n, Finding 4b): the
// phone's first load of the bench page came back as `{ready:false}` after two minutes, a second load of the
// same origin joined in 1.9 s, and a first load once logged "worker script blocked: is COEP set on every
// path?". So before an attempt opens, the Mac loads the page, its scripts and the `.wasm` through the tunnel
// until every one of them carries COOP and COEP (a cold quick tunnel's name warms up late), and before a bot
// starts, the server must answer a websocket handshake on the origin the bot uses.
import { readdirSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

const COOP = 'same-origin'
const COEP = 'require-corp'

/** `/` and every `.js` and `.wasm` under `<dist>/assets` (the page, its workers, the module); just `/` without a build. */
export function pagePaths(distDir, ls = readdirSync) {
  const out = ['/']
  try {
    for (const f of ls(join(distDir, 'assets')).sort())
      if (/\.(js|wasm)$/.test(f)) out.push(`/assets/${f}`)
  } catch {
    // no build output here: the page alone
  }
  return out
}

/**
 * Fetch each path of `origin` until all answer with COOP and COEP, bounded by `timeoutMs`. Never throws and
 * never fails the round: it returns what it saw, for the log and for a later reading of why a load failed.
 * @param {{ origin: string, paths: string[], fetch?: typeof fetch, timeoutMs?: number, pollMs?: number,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>, log?: (s: string) => void }} o
 * @returns {Promise<{ ok: boolean, waitedMs: number, rounds: number, missing: { path: string, status: number | null, coop: string | null, coep: string | null }[] }>}
 */
export async function warmTunnel({
  origin,
  paths,
  fetch: get = globalThis.fetch,
  timeoutMs = 90_000,
  pollMs = 2000,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
}) {
  const t0 = now()
  let rounds = 0
  let missing = paths.map((path) => ({ path, status: null, coop: null, coep: null }))
  while (true) {
    rounds++
    const next = []
    for (const path of paths) {
      let seen = { path, status: null, coop: null, coep: null }
      try {
        const res = await get(`${origin}${path}`, { signal: AbortSignal.timeout(15_000) })
        await res.arrayBuffer?.().catch(() => {}) // the body is what the edge caches: read it through
        seen = {
          path,
          status: res.status,
          coop: res.headers.get('cross-origin-opener-policy'),
          coep: res.headers.get('cross-origin-embedder-policy'),
        }
      } catch {
        // the name is not up yet
      }
      if (!(seen.status === 200 && seen.coop === COOP && seen.coep === COEP)) next.push(seen)
    }
    missing = next
    if (!missing.length || now() - t0 + pollMs > timeoutMs) break
    await sleep(pollMs)
  }
  const waitedMs = now() - t0
  const ok = missing.length === 0
  log(
    ok
      ? `tunnel warm: ${paths.length} path(s) carry COOP/COEP after ${rounds} round(s), ${waitedMs} ms`
      : `tunnel NOT warm after ${waitedMs} ms: ${missing.map((m) => `${m.path} (${m.status ?? 'no answer'}, coep ${m.coep})`).join(', ')}`,
  )
  return { ok, waitedMs, rounds, missing }
}

/**
 * Does the server answer a websocket handshake at `<origin><path>`? (`101 Switching Protocols`; the socket is
 * dropped at once.) `origin` is the loopback origin the bot joins on, so the check goes through the same
 * `/ws` proxy the page's own socket takes.
 */
export function wsHandshake({ origin, path = '/ws', timeoutMs = 5000, open = request }) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v, req) => {
      if (done) return
      done = true
      req?.destroy()
      resolve(v)
    }
    const u = new URL(origin)
    const req = open({
      host: u.hostname,
      port: u.port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('m39n-preflight!!').toString('base64'),
      },
    })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      finish(true, req)
    })
    req.on('response', () => finish(false, req))
    req.on('error', () => finish(false, req))
    req.setTimeout(timeoutMs, () => finish(false, req))
    req.end()
  })
}
