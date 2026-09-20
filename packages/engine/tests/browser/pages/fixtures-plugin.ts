// Test-only plugin, not published: serves every `packages/engine/fixtures/<name>/`'s prebuilt
// dev-profile output (`pnpm test`'s `fixtures` build step has already run `buildGame()` on each) at
// `/fixtures/<name>/{game.wasm,game.json}`, in dev (read live from disk) and in the built output
// (copied in as an asset, so `vite preview` serves it statically). Pages for any fixture other than
// `hash` load through this (`src/fixture-wasm.ts`); `wiring.html` uses the real virtual module.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Connect, Plugin } from 'vite'

const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/', import.meta.url))
const PREFIX = '/fixtures/'

// `start.not_isolated_error`/`start.worker_blocked_error` (docs/plan/06b-workers-and-spawn.md,
// Tests added; 0015 §3): both need a page served without the isolation headers this app's normal
// routes always carry (`vite.config.ts`'s `preview.headers`), which only a route terminating its
// own response before Vite's own header middleware can produce (the same trick as `serve` above,
// M02b Deviations). Both read the already-built `vite build` output (`dist/`), so they work under
// `vite preview`, which is what the browser suite runs.
const DIST_DIR = fileURLToPath(new URL('./dist/', import.meta.url))
const NO_ISOLATION_PREFIX = '/__no-isolation__/'
const NO_COEP_WORKER_PATH = '/__no-coep-worker__.js'

function contentTypeFor(path: string): string {
  if (path.endsWith('.html')) return 'text/html'
  if (path.endsWith('.js')) return 'application/javascript'
  if (path.endsWith('.wasm')) return 'application/wasm'
  return 'application/octet-stream'
}

/** `/__no-isolation__/<built file>`: the exact built bytes, no `Cross-Origin-Opener-Policy`/
 * `Cross-Origin-Embedder-Policy` at all -- `start.not_isolated_error` navigates here and expects
 * `crossOriginIsolated` to read `false`. Sub-resources (`/assets/*.js`, the wasm) are unaffected:
 * they are requested through the normal route and keep the app's usual headers, which does not
 * change `crossOriginIsolated` (that is decided by the top document's own response alone). */
const serveNoIsolation: Connect.NextHandleFunction = (req, res, next) => {
  const url = req.url?.split('?')[0] ?? ''
  if (!url.startsWith(NO_ISOLATION_PREFIX)) return next()
  const path = `${DIST_DIR}${url.slice(NO_ISOLATION_PREFIX.length)}`
  if (!existsSync(path)) return next()
  res.setHeader('Content-Type', contentTypeFor(path))
  res.end(readFileSync(path))
}

/** The hashed `worker-auto-*.js` chunk `vite build` emitted under `dist/assets/`: pattern A's
 * bundled worker script, the same one every other page's `createClient()` spawns by default. */
function findWorkerAutoChunk(): string | undefined {
  const assetsDir = `${DIST_DIR}assets/`
  if (!existsSync(assetsDir)) return undefined
  const match = readdirSync(assetsDir).find((f) => /^worker-auto-.*\.js$/.test(f))
  return match ? `${assetsDir}${match}` : undefined
}

/** `/__no-coep-worker__.js`: the same built worker script, served with `Cross-Origin-Opener-Policy`
 * but no `Cross-Origin-Embedder-Policy` -- `start.worker_blocked_error` points `ClientOptions.
 * createWorker` (pattern B) at this URL from an otherwise normally-isolated page, so only the worker
 * script's own response lacks COEP (0015 §3: "the worker script response itself needs COEP"). */
const serveNoCoepWorker: Connect.NextHandleFunction = (req, res, next) => {
  const url = req.url?.split('?')[0] ?? ''
  if (url !== NO_COEP_WORKER_PATH) return next()
  const path = findWorkerAutoChunk()
  if (!path) return next()
  res.setHeader('Content-Type', 'application/javascript')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.end(readFileSync(path))
}

// Terminating a request here skips Vite's own header middleware, so this route sets the pair
// itself (0015 §3: every response of the game's origin needs both, the engine plugin's own wasm
// route included).
const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

type FixtureFile = 'game.wasm' | 'game.json'

function fixtureOutputPath(name: string, file: FixtureFile): string {
  return `${FIXTURES_DIR}${name}/target/engine/dev/${file}`
}

function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

const serve: Connect.NextHandleFunction = (req, res, next) => {
  const url = req.url?.split('?')[0] ?? ''
  if (!url.startsWith(PREFIX)) return next()
  const rest = url.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return next()
  const name = rest.slice(0, slash)
  const file = rest.slice(slash + 1)
  if (file !== 'game.wasm' && file !== 'game.json') return next()
  const path = fixtureOutputPath(name, file)
  if (!existsSync(path)) return next()
  res.setHeader('Content-Type', file === 'game.wasm' ? 'application/wasm' : 'application/json')
  for (const [key, value] of Object.entries(COI_HEADERS)) res.setHeader(key, value)
  res.end(readFileSync(path))
}

export function fixturesPlugin(): Plugin {
  return {
    name: 'engine:fixtures',
    configureServer(server) {
      server.middlewares.use(serve)
    },
    // The browser suite navigates against `vite preview` (`vite.config.ts`'s own comment), which
    // Vite dispatches through a *different* plugin hook than `vite dev` (`configurePreviewServer`,
    // not `configureServer`): the no-isolation/no-COEP-worker routes read the already-built `dist/`
    // output regardless, so they work the same way under both.
    configurePreviewServer(server) {
      server.middlewares.use(serveNoIsolation)
      server.middlewares.use(serveNoCoepWorker)
    },
    generateBundle() {
      for (const name of fixtureNames()) {
        for (const file of ['game.wasm', 'game.json'] as const) {
          const path = fixtureOutputPath(name, file)
          if (!existsSync(path)) continue
          this.emitFile({
            type: 'asset',
            fileName: `fixtures/${name}/${file}`,
            source: readFileSync(path),
          })
        }
      }
    },
  }
}
