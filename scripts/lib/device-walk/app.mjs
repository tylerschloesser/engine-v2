// The walkthrough's local HTTP app (M39e): one static page plus a small JSON API on loopback.
// Every state change is an event appended to the round log first, so the page is only a view.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { qrSvg } from './qr.mjs'
import { appendEvent, firstOpen, RESULTS, readEvents, replay } from './rounds.mjs'
import { pageUrl, servingFor } from './serving.mjs'

const UI = readFileSync(new URL('./ui.html', import.meta.url), 'utf8')
const needsServer = (s) => !s.fly && s.device !== 'none'

export function createApp({ round, items, file, control, overrides, now, tunnel = true }) {
  const withTunnel = (s) => (tunnel ? s : { ...s, tunnel: false })
  const walked = items.filter((i) => !i.android)
  const serving = new Map(walked.map((i) => [i.id, withTunnel(servingFor(i, overrides))]))
  const events = () => readEvents(file)
  const append = (e) => appendEvent(file, e, now)

  function state() {
    const st = replay(events(), walked)
    const server = control.status()
    const cursor = st.cursor ?? firstOpen(walked, st)
    return {
      round,
      total: walked.length,
      position: walked.findIndex((i) => i.id === cursor) + 1,
      cursor,
      device: st.device,
      server,
      items: walked.map((i) => {
        const s = serving.get(i.id)
        const cur = st.items.get(i.id)
        return {
          id: i.id,
          section: i.section,
          heading: i.heading,
          lead: i.lead,
          steps: i.steps,
          pass: i.pass,
          ifFails: i.ifFails,
          serving: s,
          urls: s.pages.map((p) => pageUrl(s, server.urls, p)),
          ...cur,
        }
      }),
    }
  }

  /** Start (or reuse) the server the cursor item needs; never throws, the status carries failures. */
  function serveFor(id) {
    const s = serving.get(id)
    if (s && needsServer(s)) control.ensure(s).catch(() => {})
  }

  function apply(e) {
    const ids = new Set(walked.map((i) => i.id))
    if (e.type === 'cursor' && ids.has(e.id)) {
      append({ type: 'cursor', id: e.id })
      serveFor(e.id)
    } else if (e.type === 'result' && ids.has(e.id) && RESULTS.includes(e.result)) {
      append({
        type: 'result',
        id: e.id,
        result: e.result,
        notes: String(e.notes ?? ''),
        numbers: String(e.numbers ?? ''),
      })
    } else if (e.type === 'redo' && ids.has(e.id)) append({ type: 'redo', id: e.id })
    else if (e.type === 'device') append({ type: 'device', phone: e.phone, ios: e.ios, mac: e.mac })
    else if (e.type === 'restart') {
      const cur = state().cursor
      control.stopAll().then(() => serveFor(cur))
    } else throw new Error('bad event')
  }

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const host = req.headers.host ?? ''
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(res, 403, { error: 'host' })
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      return res.end(UI)
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state())
    if (req.method === 'GET' && url.pathname === '/api/qr') {
      try {
        const svg = qrSvg(url.searchParams.get('text') ?? '')
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' })
        return res.end(svg)
      } catch (e) {
        return json(res, 400, { error: String(e.message) })
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/event') {
      if (!/^application\/json/.test(req.headers['content-type'] ?? ''))
        return json(res, 415, { error: 'json only' })
      let body = ''
      req.on('data', (d) => {
        body += d
        if (body.length > 100_000) req.destroy()
      })
      req.on('end', () => {
        try {
          apply(JSON.parse(body))
          json(res, 200, state())
        } catch (e) {
          json(res, 400, { error: String(e.message) })
        }
      })
      return
    }
    json(res, 404, { error: 'not found' })
  })

  return {
    server,
    state,
    serveFor,
    /** Record the walk's start (the `--only` filter) the first time; later starts keep it. */
    begin(only) {
      const ev = events()
      if (!ev.some((e) => e.type === 'start')) append({ type: 'start', only: only ?? null })
      const cur = state().cursor
      append({ type: 'cursor', id: cur })
      serveFor(cur)
    },
  }
}
