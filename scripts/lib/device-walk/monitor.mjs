// The Mac UI of an auto round (M39f step 13): the live monitor. A small loopback-only HTTP app (never the
// phone API's port): the state word, the phone's last-seen time, the open prompt, every check turning green
// as its reading arrives, and the person's corrections (redo, back, a changed result). Every correction is an
// event appended to the round log first, like M39e's UI; the page is only a view.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { qrSvg } from './qr.mjs'

const PAGE = readFileSync(new URL('./monitor.html', import.meta.url), 'utf8')
const RESULTS = ['pass', 'fail', 'skip']

/**
 * @param {{ status: () => object, event: (e: object) => void, qrText?: () => string|null }} o
 *   `status()`: the same object `--status --json` prints (plus the live `state`); `event(e)` applies a
 *   correction (`{type: 'redo', id}` or `{type: 'result', id, result, notes}`) and throws on a bad one.
 */
export function createMonitor({ status, event }) {
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? ''))
      return json(res, 403, { error: 'host' })
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      return res.end(PAGE)
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, status())
    if (req.method === 'GET' && url.pathname === '/api/qr') {
      try {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' })
        return res.end(qrSvg(url.searchParams.get('text') ?? ''))
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
          const e = JSON.parse(body)
          if (e.type === 'result' && !RESULTS.includes(e.result)) throw new Error('bad result')
          event(e)
          json(res, 200, status())
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
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolve)
      })
      return server.address().port
    },
    close: () => new Promise((r) => server.close(r)),
  }
}
