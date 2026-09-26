// docs/plan/23-persistence-opfs-and-lifecycle.md, "Open gate failures" 5 (gate fix round): the
// exports-map test (`test.test.ts`) only checks *import* reachability -- production code never
// reaches `src/test/**` through an `import`. It says nothing about a production file writing straight
// onto the global object itself (`window.__foo = ...`), which would leak a debug hook into every real
// page without ever importing anything test-only. This scans the same production-reachable file set
// (the walk is duplicated here, not imported: `test.test.ts` exports nothing, and this file only needs
// its two small helpers) for a literal `window.__`/`globalThis.__` assignment.
//
// The codebase's own real debug hooks already avoid this shape on purpose, through a renamed local
// alias instead of the bare global identifier (`worker.ts`'s `dbg.__engineWorkerKind`, `worker/sim.ts`'s
// `leakSinkHolder.__engineSimLeakSink`) -- both test-gated, neither matching this scan's pattern. A new
// hook that writes `window.__x = ...`/`globalThis.__x = ...` directly, ungated, is exactly what this
// catches.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))

/** Same starting set `test.test.ts`'s own `exports_map` test uses (0017 §2's exports-map subpaths
 * plus `loader.ts`/`abi.ts`). */
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

function resolveRelative(fromRel: string, spec: string): string | null {
  if (!spec.endsWith('.js') && !spec.endsWith('.ts')) return null
  const fromDir = fromRel.includes('/') ? `${fromRel.slice(0, fromRel.lastIndexOf('/'))}/` : ''
  const base = new URL(fromDir, 'file:///root/')
  const specTs = spec.replace(/\.js$/, '.ts')
  const resolved = new URL(specTs, base)
  if (!resolved.pathname.startsWith('/root/')) return null
  return resolved.pathname.slice('/root/'.length)
}

/** Every `.ts` file transitively reachable from `startRel` through relative imports -- the same walk
 * `test.test.ts`'s `reachableFiles` does (duplicated, not imported: that file exports nothing, and
 * this is a dozen lines). */
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

/** A direct assignment onto the global object under a `__`-prefixed name. Real code only: comments
 * are blanked first, the same way `worker/protocol.test.ts`'s own source scan does it (this repo's
 * doc comments freely mention `window.__foo` in prose). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '')
}

const GLOBAL_WRITE = /\b(?:window|globalThis)\s*\.\s*__[A-Za-z0-9_]*\s*=(?!=)/

test('window_globals: production sources never write window.__/globalThis.__', () => {
  const files = new Set<string>()
  for (const entry of PRODUCTION_ENTRYPOINTS) {
    for (const rel of reachableFiles(entry)) files.add(rel)
  }

  const offenders: string[] = []
  for (const rel of files) {
    if (rel.endsWith('.test.ts')) continue
    const text = stripComments(readFileSync(`${SRC}${rel}`, 'utf8'))
    for (const line of text.split('\n')) {
      if (GLOBAL_WRITE.test(line)) offenders.push(`${rel}: ${line.trim()}`)
    }
  }
  if (offenders.length > 0) {
    throw new Error(`production sources write window.__/globalThis.__: ${offenders.join('; ')}`)
  }
  expect(offenders).toEqual([])
})
