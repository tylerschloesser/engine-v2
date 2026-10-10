// The page host for every browser test from M03 on. `engine({ crate: '../../../fixtures/hash' })`
// on the dev profile; adding a page is adding `<name>.html` here plus `src/<name>.ts` (globbed into
// `build.rollupOptions.input`). Port from `ENGINE_TEST_PORT` (default 4517, strictPort), so two
// worktrees can run the browser suite at once.
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { previewHeaders } from '../../../scripts/preview-headers.ts'
import { engine } from '../../../src/vite.ts'
import { fixturesPlugin } from './fixtures-plugin.ts'

const root = import.meta.dirname
const port = Number(process.env.ENGINE_TEST_PORT ?? 4517)

// `/ws` for `device-serve --ws`; empty (no `preview.proxy`) otherwise.
const proxy = {
  ...(process.env.ENGINE_WS_PROXY_PORT
    ? { '/ws': { target: `ws://127.0.0.1:${process.env.ENGINE_WS_PROXY_PORT}`, ws: true } }
    : {}),
}

const input = Object.fromEntries(
  readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => [entry.name.replace(/\.html$/, ''), resolve(root, entry.name)]),
)

export default defineConfig({
  root,
  plugins: [
    engine({ crate: '../../../fixtures/hash', profile: 'dev' }),
    fixturesPlugin(),
    // `vite preview` only: COOP/COEP + no-store on every response (a bare 304 lacks them).
    // Never in `vite build` output.
    ...previewHeaders(),
  ],
  build: {
    target: 'es2022',
    // M04 attributes allocations by function name; minified names would hide them.
    minify: false,
    rollupOptions: { input },
  },
  server: { port, strictPort: true },
  preview: {
    port,
    strictPort: true,
    // `pnpm device:serve --tunnel` (M03, Planning decisions
    // "Determinism on a physical phone"): the Cloudflare quick tunnel's `Host` header is a random
    // `*.trycloudflare.com` subdomain, which Vite's own host check would otherwise refuse.
    ...(process.env.ENGINE_DEVICE === '1' ? { allowedHosts: ['.trycloudflare.com'] } : {}),
    // M29 Scope: `pnpm device:serve --ws` sets this so
    // the tunnel (or a plain LAN origin) carries the socket too -- an `https` page cannot open a
    // plain `ws://`, so `wsUrl(location)` always dials this same origin's `/ws`, proxied by Vite's
    // own dev-server WebSocket proxy to the real `games/reference-server` child `device-serve.mjs`
    // spawns. Unset (every other `pnpm test`/`pnpm device:serve` run), this is a no-op.
    ...(Object.keys(proxy).length ? { proxy } : {}),
  },
})
