// docs/plan/22b-persistence-load-and-fs.md, Order of work step 5 (Exit criteria): "`engine/test`
// exports `replayWorld` and `runHeavy`; production entrypoints do not import them (exports-map test
// from M02/M35 pattern)." No such test exists yet (M35's own `exports-map` test is not built), so
// this is the first one.
//
// M22b fix round 1 (review agent): a direct-import-only scan of each production entrypoint's own
// source (this file's first version) passes a production module importing a *helper* that itself
// re-exports `replayWorld` from `test/replay.js` -- the leak is one hop away, never in the
// entrypoint's own text. This walks the whole relative-import graph from every production
// entrypoint (recursively resolving `.js` specifiers back to their `.ts` source), failing if any
// reachable module is under `src/test/` or is `src/test.ts` itself.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { replayWorld, runHeavy } from './test.js'

const SRC = fileURLToPath(new URL('.', import.meta.url))

/** Every exports-map subpath's own backing file (`package.json`, 0017 §2) plus `loader.ts`/`abi.ts`,
 * the two internal modules every one of them shares -- `test.ts`'s own header comment names the
 * same set. Each is a starting point for the transitive walk below, not the whole check on its own. */
const PRODUCTION_ENTRYPOINTS = [
  'client.ts',
  'worker.ts',
  'server-node.ts',
  'vite.ts',
  'render.ts',
  'build-game.ts',
  'loader.ts',
  'abi.ts',
]

const IMPORT_SPEC = /(?:from|import)\s+['"](\.[^'"]*)['"]/g

/** A relative import specifier (`./foo.js`, `../bar/baz.js`) resolved against the importing file's
 * own directory, back to its `.ts` source path relative to `SRC` -- `URL` does the `../` collapsing
 * so this never has to hand-roll path arithmetic. `null` for anything that isn't plausibly one of
 * this package's own `.ts` files (a `.json`/`.wasm`/virtual specifier, `.mjs` worker script, etc.). */
function resolveRelative(fromRel: string, spec: string): string | null {
  if (!spec.endsWith('.js') && !spec.endsWith('.ts')) return null
  const fromDir = fromRel.includes('/') ? `${fromRel.slice(0, fromRel.lastIndexOf('/'))}/` : ''
  const base = new URL(fromDir, 'file:///root/')
  const specTs = spec.replace(/\.js$/, '.ts')
  const resolved = new URL(specTs, base)
  if (!resolved.pathname.startsWith('/root/')) return null // escaped src/ entirely
  return resolved.pathname.slice('/root/'.length)
}

/** Every `.ts` file transitively reachable from `startRel` through relative imports/`export ...
 * from` specifiers (type-only included: this is a static reachability check, not a runtime-shape
 * one, and a type-only re-export of a value from `src/test/` would be exactly as much of a leak in
 * spirit). Files that don't exist as `.ts` (a `.json`, a worker `.mjs`, `virtual:engine/wasm`, a
 * `.d.ts`-only path) are skipped, not errors: this graph only needs to find `src/test/**` leaks, not
 * fully resolve every import in the package. */
function reachableFiles(startRel: string): Set<string> {
  const seen = new Set<string>()
  const stack = [startRel]
  while (stack.length > 0) {
    const rel = stack.pop()
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    let text: string
    try {
      text = readFileSync(`${SRC}${rel}`, 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(IMPORT_SPEC)) {
      const spec = m[1]
      if (!spec) continue
      const next = resolveRelative(rel, spec)
      if (next && !seen.has(next)) stack.push(next)
    }
  }
  return seen
}

function isTestLeak(rel: string): boolean {
  return rel === 'test.ts' || rel.startsWith('test/')
}

test('exports_map: production entrypoints never reach engine/test', () => {
  const offenders: string[] = []
  for (const entry of PRODUCTION_ENTRYPOINTS) {
    for (const rel of reachableFiles(entry)) {
      if (isTestLeak(rel)) offenders.push(`${entry} -> ${rel}`)
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `production entrypoints transitively reaching engine/test: ${offenders.join(', ')}`,
    )
  }
  expect(offenders).toEqual([])
})

test('exports_map: engine/test exports replayWorld and runHeavy', () => {
  expect(typeof replayWorld).toBe('function')
  expect(typeof runHeavy).toBe('function')
})
