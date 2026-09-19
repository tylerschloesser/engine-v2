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
  res.end(readFileSync(path))
}

export function fixturesPlugin(): Plugin {
  return {
    name: 'engine:fixtures',
    configureServer(server) {
      server.middlewares.use(serve)
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
