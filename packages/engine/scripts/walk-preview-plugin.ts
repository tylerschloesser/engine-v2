// `pnpm device:walk` serve-time mount (docs/plan/39f-device-auto-runner.md step 2): when
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
          // Every response, not only pages: `vite preview` answers a revalidation with a bare 304 that
          // lacks COOP/COEP, and WebKit then refuses the worker script of a page it loads a second time
          // ("blocked by Cross-Origin-Embedder-Policy"; found by `walk-auto` on `worldgen-bench.html`).
          // `no-store` means there is nothing to revalidate; the headers go on before the file server runs.
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
