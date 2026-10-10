// `--static <dir>` (M38, Scope B): a file handler for the `node:http`
// server the `ws` server is attached to. A convenience of the reference server, not an engine
// feature (`engine/server/node` stays free of HTTP, 0009). Both cross-origin isolation headers are
// set on every response, 404s and refusals included, with the exact values of 0015 section 3.
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
}

export function staticHandler(dir) {
  const root = resolve(dir)
  function reply(res, status, body, extra = {}) {
    res.writeHead(status, { ...ISOLATION_HEADERS, 'Content-Type': 'text/plain', ...extra })
    res.end(body)
  }
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'method not allowed')
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    } catch {
      return reply(res, 400, 'bad request')
    }
    if (pathname.includes('\0')) return reply(res, 400, 'bad request')
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = resolve(root, `.${pathname}`)
    if (file !== root && !file.startsWith(root + sep)) return reply(res, 403, 'forbidden')
    let info
    try {
      info = await stat(file)
    } catch {
      return reply(res, 404, 'not found')
    }
    if (!info.isFile()) return reply(res, 404, 'not found')
    const dot = file.lastIndexOf('.')
    res.writeHead(200, {
      ...ISOLATION_HEADERS,
      'Content-Type': TYPES[dot < 0 ? '' : file.slice(dot)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    })
    if (req.method === 'HEAD') return res.end()
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res)
  }
}
