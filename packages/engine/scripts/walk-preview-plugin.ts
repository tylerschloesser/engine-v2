// `pnpm device:walk` serve-time mount (M39f step 2): when
// `ENGINE_WALK_PORT` is set, `vite preview` answers every HTML page with the agent's `<script>` tag
// added to its `<head>`, and proxies `/__walk` to the phone API on that loopback port (the two Vite
// configs add the proxy beside this plugin). Nothing else. The release bundle is untouched: the plugin
// has no build hooks (`vite build` output never contains the tag), and with the variable unset
// `walkPreview()` returns no plugin at all, so `vite preview` serves the files exactly as built.
import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

/** The tag injected into served pages; `agent.js` is inert without the run token in the URL or tab. */
export const WALK_TAG = '<script src="/__walk/agent.js"></script>'

/** `/__walk` proxy entry for `preview.proxy`, or `{}` when the variable is unset. */
export function walkProxy(port: string | undefined = process.env.ENGINE_WALK_PORT) {
  return port
    ? { '/__walk': { target: `http://127.0.0.1:${port}`, ws: true, changeOrigin: false } }
    : {}
}

export function injectWalkTag(html: string): string {
  const head = /<head[^>]*>/i.exec(html)
  if (!head) return WALK_TAG + html
  const at = head.index + head[0].length
  return html.slice(0, at) + WALK_TAG + html.slice(at)
}

/**
 * Every `vite preview` of either app (with or without `--walk`): the config's `preview.headers`
 * (COOP/COEP) and `Cache-Control: no-store` on **every** response, set before the file server runs.
 * `vite preview` answers a revalidation with a bare 304 that lacks COOP/COEP, and WebKit then refuses the
 * worker script of a page it loads a second time ("Worker load was blocked by Cross-Origin-Embedder-
 * Policy"; found by `walk-auto` on `worldgen-bench.html`, reproduced by a plain `page.reload()`). iOS
 * Safari likely does the same on a plain `pnpm device:serve`. `no-store` means a browser has nothing to
 * revalidate; the headers on the response also cover a 304 a client asks for anyway. Serve time only
 * (`apply: 'serve'`, preview hook): a built bundle is untouched.
 */
export function previewHeaders(): Plugin[] {
  return [
    {
      name: 'engine-preview-headers',
      apply: 'serve',
      configurePreviewServer(server) {
        const headers = server.config.preview.headers ?? {}
        server.middlewares.use((_req, res, next) => {
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v as string)
          res.setHeader('cache-control', 'no-store')
          next()
        })
      },
    },
  ]
}

/** What both Vite configs add: the headers for every serve, plus the walk agent injection under `--walk`. */
export const servePreview = (): Plugin[] => [...previewHeaders(), ...walkPreview()]

export function walkPreview(port: string | undefined = process.env.ENGINE_WALK_PORT): Plugin[] {
  if (!port) return []
  return [
    {
      name: 'engine-walk-preview',
      apply: 'serve',
      configurePreviewServer(server) {
        const outDir = resolve(server.config.root, server.config.build.outDir)
        const headers = server.config.preview.headers ?? {}
        server.middlewares.use((req, res, next) => {
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v as string)
          res.setHeader('cache-control', 'no-store')
          const raw = (req.url ?? '/').split('?')[0] ?? '/'
          let path: string
          try {
            path = decodeURIComponent(raw)
          } catch {
            return next()
          }
          if (path.endsWith('/')) path += 'index.html'
          if (!path.endsWith('.html')) return next()
          const file = resolve(join(outDir, path))
          if (!file.startsWith(outDir + sep)) return next()
          let html: string
          try {
            html = readFileSync(file, 'utf8')
          } catch {
            return next()
          }
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(injectWalkTag(html))
        })
      },
    },
  ]
}
