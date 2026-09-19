import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'node:path'

// Spike knobs (env), so the test scripts can flip modes without editing this file:
//   COEP=require-corp (default) | credentialless | none
//   HEADER_SCOPE=all (default) | html-only   (html-only = deliberately omit headers on JS/worker responses)
export default defineConfig(() => {
  const coep = process.env.COEP ?? 'require-corp'
  const scope = process.env.HEADER_SCOPE ?? 'all'
  const headers: Record<string, string> =
    coep === 'none'
      ? {}
      : {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': coep,
        }

  // Only used for the negative test "what if only the HTML document carries the headers?"
  const htmlOnly: Plugin = {
    name: 'spike-coi-html-only',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (path.endsWith('/') || path.endsWith('.html'))
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (path.endsWith('/') || path.endsWith('.html'))
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
        next()
      })
    },
  }

  return {
    // THE MINIMAL CONFIG IS JUST THESE TWO LINES (scope === 'all'):
    server: { headers: scope === 'all' ? headers : {} },
    preview: { headers: scope === 'all' ? headers : {} },
    plugins: scope === 'html-only' ? [htmlOnly] : [],
    worker: { format: 'es' as const },
    build: {
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, 'index.html'),
          bench: resolve(import.meta.dirname, 'bench.html'),
        },
      },
    },
  }
})
