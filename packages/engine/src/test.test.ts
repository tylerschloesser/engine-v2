// docs/plan/22b-persistence-load-and-fs.md, Order of work step 5 (Exit criteria): "`engine/test`
// exports `replayWorld` and `runHeavy`; production entrypoints do not import them (exports-map test
// from M02/M35 pattern)." No such test exists yet (M35's own `exports-map` test is not built), so
// this is the first one: a direct-import source scan (the same files the docs/plan/03-browser-
// harness.md orchestrator gate once grepped `dist/` for by hand: "`dist/{loader,clock,vite,server-
// node}.js` contain no `import`/`export`/`require` of `test/`") plus a positive check that the two
// new names really are exported from `engine/test`.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { replayWorld, runHeavy } from './test.js'

const SRC = fileURLToPath(new URL('.', import.meta.url))

/** Every exports-map subpath's own backing file (`package.json`, 0017 §2) plus `loader.ts`/`abi.ts`,
 * the two internal modules every one of them shares -- `test.ts`'s own header comment names the
 * same set. */
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

const IMPORT_TEST_MODULE = /from\s+['"]\.{1,2}\/(?:test\.js|test\/[^'"]*)['"]/

test('exports_map: production entrypoints never import engine/test', () => {
  const offenders: string[] = []
  for (const rel of PRODUCTION_ENTRYPOINTS) {
    const text = readFileSync(`${SRC}${rel}`, 'utf8')
    if (IMPORT_TEST_MODULE.test(text)) offenders.push(rel)
  }
  if (offenders.length > 0) {
    throw new Error(`production entrypoints importing engine/test: ${offenders.join(', ')}`)
  }
  expect(offenders).toEqual([])
})

test('exports_map: engine/test exports replayWorld and runHeavy', () => {
  expect(typeof replayWorld).toBe('function')
  expect(typeof runHeavy).toBe('function')
})
