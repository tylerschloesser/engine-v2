// Serve-time headers for `vite preview` of the repo's two apps (the fixture pages and the reference game);
// repo-only, not part of `engine/vite`. No build hooks: a built bundle is untouched.
import type { Plugin } from 'vite'

/**
 * Every `vite preview` of either app: the config's `preview.headers` (COOP/COEP) and `Cache-Control:
 * no-store` on **every** response, set before the file server runs. `vite preview` answers a revalidation
 * with a bare 304 that lacks COOP/COEP, and WebKit then refuses the worker script of a page it loads a
 * second time ("Worker load was blocked by Cross-Origin-Embedder-Policy"; reproduced by a plain
 * `page.reload()`, ADR 0067 §2). iOS Safari likely does the same on a plain `pnpm device:serve`.
 * `no-store` means a browser has nothing to revalidate; the headers on the response also cover a 304 a
 * client asks for anyway.
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
