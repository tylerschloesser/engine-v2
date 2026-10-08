// The phone API (M39f, docs/plan/39f-device-auto-runner.md step 1): the listener the agent on the phone
// talks to, on its own loopback port, never the Mac UI's. `device-serve --walk <port>` proxies `/__walk`
// on every served origin (the tunnels included) to it.
//
//   GET  /__walk/agent.js     the agent (public code, no secret in it; the pages carry no token, so
//                             the injected <script> tag cannot either)
//   GET  /__walk/driver.js    the round driver the agent loads on a walk step (public code, same reason),
//        /__walk/collect-life.js, collect-touch.js and collect-ref.js: the collectors the driver loads on demand
//   GET  /__walk/runner.html  the QR target                                   (run token)
//   WS   /__walk/ws           the live channel                                (run token + Origin)
//   POST /__walk/msg          the same messages when the socket is not up      (run token + Origin)
//
// Everything is Host-checked (the loopback, a registered tunnel or preview host); the rest needs the
// random run token (query `walk=`), and the socket and the POST need an Origin in the same set. The
// API can append readings and answer the step protocol, nothing else: it never reads the log back to
// the phone, serves repo files or moves the Mac UI's cursor.
//
// Envelope `{run, tab, seq, t, type, ...}`. Sequenced types are logged once: the service acks `seq`,
// ignores `seq <= lastSeq[tab]` (an idempotent resend) and stores `src: {tab, seq}` on the event it
// appends, so the dedupe table is rebuilt from the log on restart. `hello`, `ping` and `step?` carry no
// `seq`, are never logged, and are answered with `welcome`, `pong` and `step`.
import { timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { appendEvent, readEvents } from './rounds.mjs'

/** Event types the agent may append (a `result` row from the agent is `by: auto|human|mixed`). */
export const SEQUENCED = new Set([
  'env',
  'visibility',
  'gpu',
  'error',
  'selftest',
  'wake',
  'redo',
  'pause',
  'series',
  'attempt',
  'prompt',
  'answer',
  'result',
  'reading',
  'walk',
  'window',
])
const RESERVED = new Set(['run', 'tab', 'seq', 't', 'type', 'src'])
// A 10 minute window's series (600 one-second readings, M16-coexist) is about 250 KB, a 5 minute one more of the
// same: the first limit (200 KB) closed the phone's socket on it and the round hung (M39j, found by a driven round).
const MAX_BODY = 10_000_000
const TAB = /^[\w-]{1,40}$/
const NAME = /^[\w.-]{1,80}$/

const here = (f) => new URL(f, import.meta.url)

export function createPhoneApi({
  file,
  round,
  token,
  seriesDir,
  now,
  clock = Date.now,
  stepFor = () => ({}),
  react = () => [],
  observe = () => {},
  onRefusal = () => {},
  agentPath = here('./agent/agent.js'),
  driverPath = here('./agent/driver.js'),
  lifePath = here('./agent/collect-life.js'),
  touchPath = here('./agent/collect-touch.js'),
  refPath = here('./agent/collect-ref.js'),
  macPath = here('./agent/collect-mac.js'),
  runnerPath = here('./runner.html'),
}) {
  const allowed = new Set()
  const lastSeq = new Map()
  const sockets = new Set()
  const seen = { at: 0, tab: null, count: 0 }
  const seenMac = { at: 0, tab: null, count: 0 } // the Mac browsers' tabs (`mac-...`), apart from the phone's
  let cut = { from: 0, until: 0 }
  let listener = null
  // M39ad: what the phone's requests came to. A refusal names its reason, the Host header and the first 8
  // characters of the token it carried (never more), so a phone that never arrives is not silent.
  const counts = { served: 0, warm: 0, refused: {}, last: null }
  const refused = (request, url, reason) => {
    counts.refused[reason] = (counts.refused[reason] ?? 0) + 1
    const info = {
      reason,
      host: String(request.headers.host ?? ''),
      token: (url.searchParams.get('walk') ?? '').slice(0, 8),
      path: url.pathname,
      at: clock(),
    }
    counts.last = info
    onRefusal(info, counts.refused[reason] === 1)
  }

  const rebuild = () => {
    for (const e of readEvents(file))
      if (e.src && TAB.test(e.src.tab ?? '') && e.src.seq > (lastSeq.get(e.src.tab) ?? 0))
        lastSeq.set(e.src.tab, e.src.seq)
  }
  rebuild()

  const hostOf = (v) => {
    const s = String(v ?? '').trim()
    if (!s) return ''
    try {
      return (s.includes('://') ? new URL(s).host : s).toLowerCase()
    } catch {
      return ''
    }
  }
  const allowHost = (v) => {
    const h = hostOf(v)
    if (h) allowed.add(h)
  }
  const hostOk = (req) => allowed.has(hostOf(req.headers.host))
  const originOk = (req) => allowed.has(hostOf(req.headers.origin))
  const tokenOk = (url) => {
    const a = Buffer.from(url.searchParams.get('walk') ?? '')
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  const windowFns = new Set() // `onWindow` subscribers (the drive loop's quiet wait ends on the end marker)
  const isCut = () => clock() < cut.until

  // `tab`: the asking page's tab id, so one round can tell a phone's tab from a Mac browser's (`mac-...`).
  const step = (tab) => stepFor(readEvents(file), now ? Date.parse(now()) : clock(), tab)
  const append = (event) => appendEvent(file, event, now)

  function stepFields(extra, tab) {
    return { ...extra, step: step(tab) }
  }

  /** Handle one parsed message; returns the reply message (or null). */
  function process(msg, via) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string')
      return { type: 'error', error: 'envelope' }
    if (typeof msg.tab !== 'string' || !TAB.test(msg.tab)) return { type: 'error', error: 'tab' }
    const { tab, type } = msg
    const rec = tab.startsWith('mac') ? seenMac : seen
    rec.at = clock()
    rec.tab = tab
    rec.count++
    observe(msg, rec.at, api)
    if (type === 'ping') return { type: 'pong', now: clock() }
    if (type === 'hello' || type === 'step?')
      return stepFields(
        {
          type: type === 'hello' ? 'welcome' : 'step',
          lastSeq: lastSeq.get(tab) ?? 0,
          now: clock(),
        },
        tab,
      )
    if (!SEQUENCED.has(type)) return { type: 'error', error: 'type' }
    if (msg.run !== round) return { type: 'error', error: 'run' }
    const seq = msg.seq
    if (!Number.isInteger(seq) || seq < 1) return { type: 'error', error: 'seq' }
    if (seq <= (lastSeq.get(tab) ?? 0)) return stepFields({ type: 'ack', seq, dup: true }, tab)
    const body = Object.fromEntries(Object.entries(msg).filter(([k]) => !RESERVED.has(k)))
    const event = { type, ...(typeof msg.t === 'number' ? { pt: msg.t } : {}), src: { tab, seq } }
    if (type === 'series') {
      if (!NAME.test(body.id ?? '') || !Number.isInteger(body.n))
        return { type: 'error', error: 'series' }
      const rel = `${body.id}-${body.n}.json`
      const path = join(seriesDir ?? dirname(file), rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(body.data ?? null))
      Object.assign(event, { id: body.id, n: body.n, path })
    } else Object.assign(event, body)
    const logged = append(event)
    lastSeq.set(tab, seq)
    if (type === 'window') for (const fn of windowFns) fn(logged)
    for (const extra of react(logged, { api, via, events: readEvents(file) })) append(extra)
    return stepFields({ type: 'ack', seq }, tab)
  }

  // Public repo code, no secret (the injected <script> tag cannot carry one): the agent, the round driver
  // and the two files of collectors it loads on demand.
  const publicCode = {
    '/__walk/agent.js': agentPath,
    '/__walk/driver.js': driverPath,
    '/__walk/collect-life.js': lifePath,
    '/__walk/collect-touch.js': touchPath,
    '/__walk/collect-ref.js': refPath,
    '/__walk/collect-mac.js': macPath,
  }

  const asset = (res, path, type) => {
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return send(res, 500, { error: 'asset missing' })
    }
    send(res, 200, text, type)
  }

  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }

  const deny = (req, res, url, code, reason) => {
    refused(req, url, reason)
    return send(res, code, { error: reason })
  }

  function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!url.pathname.startsWith('/__walk/')) return send(res, 404, { error: 'not found' })
    if (!hostOk(req)) return deny(req, res, url, 403, 'host')
    if (isCut()) return deny(req, res, url, 503, 'cut')
    const code = req.method === 'GET' ? publicCode[url.pathname] : undefined
    if (code) return asset(res, code, 'text/javascript; charset=utf-8')
    if (!tokenOk(url)) return deny(req, res, url, 403, 'token')
    if (req.method === 'GET' && url.pathname === '/__walk/runner.html') {
      // `warm=1` is the Mac warming the tunnel (M39ad): not the phone arriving.
      counts[url.searchParams.get('warm') ? 'warm' : 'served']++
      return asset(res, runnerPath, 'text/html; charset=utf-8')
    }
    if (req.method === 'POST' && url.pathname === '/__walk/msg') {
      if (!originOk(req)) return deny(req, res, url, 403, 'origin')
      let body = ''
      let big = false
      req.on('data', (d) => {
        body += d
        if (body.length > MAX_BODY) {
          big = true
          req.destroy()
        }
      })
      req.on('end', () => {
        if (big) return
        try {
          const parsed = JSON.parse(body)
          const replies = (Array.isArray(parsed) ? parsed : [parsed]).map((m) => process(m, 'post'))
          send(res, 200, { replies })
        } catch {
          send(res, 400, { error: 'json' })
        }
      })
      return
    }
    send(res, 404, { error: 'not found' })
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY })
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('close', () => sockets.delete(ws))
    ws.on('error', () => {})
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return ws.send(JSON.stringify({ type: 'error', error: 'json' }))
      }
      const reply = process(msg, 'ws')
      if (reply && ws.readyState === 1) ws.send(JSON.stringify(reply))
    })
  })

  function upgrade(req, socket, head) {
    const url = new URL(req.url ?? '/', 'http://x')
    const refuse = (code, why, reason) => {
      if (reason) refused(req, url, reason)
      socket.write(`HTTP/1.1 ${code} ${why}\r\nconnection: close\r\n\r\n`)
      socket.destroy()
    }
    if (url.pathname !== '/__walk/ws') return refuse(404, 'Not Found')
    if (!hostOk(req)) return refuse(403, 'Forbidden', 'host')
    if (isCut()) return refuse(503, 'Service Unavailable', 'cut')
    if (!tokenOk(url)) return refuse(403, 'Forbidden', 'token')
    if (!originOk(req)) return refuse(403, 'Forbidden', 'origin')
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }

  const server = createServer(handler)
  server.on('upgrade', upgrade)

  const api = {
    server,
    handler,
    upgrade,
    allowHost,
    append,
    process,
    lastSeq: (tab) => lastSeq.get(tab) ?? 0,
    seen: () => ({ ...seen }),
    /** `{ served, warm, refused: { <reason>: n }, last }` (M39ad). */
    requests: () => ({ ...counts, refused: { ...counts.refused } }),
    seenMac: () => ({ ...seenMac }),
    /** `fn(event)` for every `window` marker the phone logs; returns the unsubscribe. */
    onWindow: (fn) => {
      windowFns.add(fn)
      return () => windowFns.delete(fn)
    },
    /** Refuse every request and socket for `ms` (the self-test's "tunnel drop"); open sockets are closed. */
    cut(ms) {
      cut = { from: clock(), until: clock() + ms }
      setTimeout(() => {
        for (const ws of sockets) ws.terminate()
      }, 25)
      return cut
    },
    cutWindow: () => ({ ...cut }),
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolve)
      })
      listener = server.address().port
      allowHost(`127.0.0.1:${listener}`)
      allowHost(`localhost:${listener}`)
      return listener
    },
    port: () => listener,
    async close() {
      for (const ws of sockets) ws.terminate()
      wss.close()
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
  return api
}
