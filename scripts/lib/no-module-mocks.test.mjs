// Spec testing R2: "avoid mocking unless necessary". Module mocking (`vi.mock`, `vi.doMock`,
// `jest.mock`) is the heavy kind, so it is allowlisted by file with the reason; every other test
// uses real modules and hand-written doubles. A source scan in the style of `sab.no_alloc_syntax`
// over every test file under `packages/`, `games/` and `scripts/`.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const SKIP = new Set(['node_modules', 'dist', 'dist-bench', 'target', 'test-results', '.git'])
const TEST_FILE = /\.(test|spec)\.(ts|mjs)$/

/** File -> why a module mock is the necessary tool there. */
const ALLOWED = {
  'packages/engine/src/vite.test.ts':
    'replaces node:fs `watch` so the Vite plugin watcher can be driven without a real file system watcher',
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (TEST_FILE.test(entry.name)) yield path
  }
}

test('no-module-mocks: no test mocks a module outside the allowlist', () => {
  const MOCK = /\b(?:vi|jest)\.(?:mock|doMock)\(/
  const using = []
  for (const top of ['packages', 'games', 'scripts']) {
    for (const path of walk(join(root, top))) {
      const text = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      // This file names the calls in its own regex and comments.
      if (path.endsWith('no-module-mocks.test.mjs')) continue
      if (MOCK.test(text)) using.push(path.slice(root.length))
    }
  }
  expect(
    using.sort(),
    'module mocks outside the allowlist, or an allowlist entry gone stale',
  ).toEqual(Object.keys(ALLOWED).sort())
})
