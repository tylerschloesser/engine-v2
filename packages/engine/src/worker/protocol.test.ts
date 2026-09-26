// docs/plan/23-persistence-opfs-and-lifecycle.md, "Open gate failures" 2 (gate fix round): 0015 §2
// fixes what `postMessage` may carry after setup ("fatal errors and lifecycle"), but nothing checked
// it -- `worker/protocol.ts` used to just say M23's own new types were covered by "M06b's grep
// criterion", "in prose". This scans every worker source for a `type: '<literal>'` string (a message
// object under construction, wherever in the file it appears -- a `testCall`-style handler in
// `worker/sim.ts`/`test-call.ts` returns one that only reaches `postMessage` one call later, in
// `worker.ts`'s own dispatcher, so anchoring strictly on `postMessage(`/`.post(` call sites would miss
// it) and checks each one against the two allowlists `protocol.ts` now exports by name.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { POST_SETUP_MESSAGE_TYPES, SETUP_PHASE_MESSAGE_TYPES } from './protocol.js'

const workerDir = dirname(fileURLToPath(import.meta.url)) // src/worker
const srcDir = join(workerDir, '..') // src

/** Every worker source file this scan checks: everything in `src/worker/` but its own type
 * declarations (`protocol.ts` names both `ToWorker` and `FromWorker` literals -- e.g. `'setup'`,
 * `'sim-pause'` -- and mixing those into a `FromWorker`-only allowlist would fail on messages this
 * worker only ever *receives*) and its own tests, plus `worker.ts` itself (the delegation prompt's
 * own "src/worker/**, worker.ts"). */
function workerSourceFiles(): string[] {
  const files: string[] = []
  for (const name of readdirSync(workerDir)) {
    if (!name.endsWith('.ts')) continue
    if (name === 'protocol.ts' || name.endsWith('.test.ts')) continue
    files.push(join(workerDir, name))
  }
  files.push(join(srcDir, 'worker.ts'))
  return files
}

const TYPE_LITERAL = /type:\s*(['"])([a-zA-Z0-9_-]+)\1/g

/** Every file here has doc comments naming a message shape in prose (`` `{ type: 'resume' }` handler
 * `` etc.) -- real code, not comments, is what this scan needs, so line comments and block comments
 * are blanked out first (kept the same length/line count, so this stays a dumb, line-oriented scan
 * with no risk of merging two real statements together). Good enough for this repo's own style (no
 * `//`/`/*` sequence appears inside a real string literal in these files). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '')
}

function findTypeLiterals(source: string): string[] {
  const out: string[] = []
  for (const m of stripComments(source).matchAll(TYPE_LITERAL)) {
    const lit = m[2]
    if (lit) out.push(lit)
  }
  return out
}

test('postmessage_type_literals_are_allowlisted', () => {
  const allowed = new Set<string>([...SETUP_PHASE_MESSAGE_TYPES, ...POST_SETUP_MESSAGE_TYPES])
  const offenders: string[] = []
  for (const file of workerSourceFiles()) {
    const source = readFileSync(file, 'utf8')
    for (const lit of findTypeLiterals(source)) {
      if (!allowed.has(lit)) offenders.push(`${file}: '${lit}'`)
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `posted message type(s) not in the postMessage allowlist: ${offenders.join(', ')}`,
    )
  }
  expect(offenders).toEqual([])
})

test('postmessage_allowlists_have_no_overlap_or_duplicates', () => {
  const setup = SETUP_PHASE_MESSAGE_TYPES
  const postSetup = POST_SETUP_MESSAGE_TYPES
  expect(new Set(setup).size).toBe(setup.length)
  expect(new Set(postSetup).size).toBe(postSetup.length)
  for (const t of setup) expect(postSetup).not.toContain(t)
})
