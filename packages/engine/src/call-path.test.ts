// docs/plan/24-recovery-and-migration.md step 1 (Scope: "audit that every sim-host export call
// goes through call0/1/2"; Order of work: "one grep-style test: no `inst.x.` use outside
// `loader.ts`"): `.claude/rules/hot-paths.md`'s own rule ("Exports are called through call0/call1/
// call2 of EngineInstance ... and nothing else") is about *invoking* a raw export directly (with
// parens), not about naming `inst.x.<export>` as a bare function value -- every real call site in
// this codebase already passes that value into `call0`/`call1`/`call2` (`inst.call0(inst.x.
// sim_tick)`), never calls it itself (`inst.x.sim_tick()`). This scans every production and
// test-support `.ts` file except `loader.ts` (the one file allowed to construct `RawExports` and
// touch it directly) for a direct-call pattern (`.x.<name>(`) and fails if one exists: that would
// mean an export ran with no dead check, no trap capture and no post-call detach check (0014 §4).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))

/** Every `.ts` file under `src/` (this directory), recursively, except `loader.ts` itself and
 * `*.test.ts` (a test file may legitimately build a fake `RawExports`-shaped object whose own
 * property happens to match `\.x\.\w+\(`, e.g. a mock's own method call unrelated to this rule). */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (!name.endsWith('.ts')) continue
    if (name.endsWith('.test.ts')) continue
    if (full === join(SRC, 'loader.ts')) continue
    out.push(full)
  }
  return out
}

/** A real call, `.x.<identifier>(` -- comments are blanked first (this repo's own doc comments
 * freely write `inst.x.sim_tick` in prose), the same way `worker/protocol.test.ts`'s own source
 * scan does it. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '')
}

const RAW_CALL = /\.x\.[a-zA-Z_][a-zA-Z0-9_]*\s*\(/

test('call_path: every export call goes through call0/call1/call2, never inst.x.<export>()', () => {
  const offenders: string[] = []
  for (const file of sourceFiles(SRC)) {
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const [i, line] of text.split('\n').entries()) {
      if (RAW_CALL.test(line)) {
        offenders.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()}`)
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(`raw export call(s) bypassing call0/call1/call2: ${offenders.join('; ')}`)
  }
  expect(offenders).toEqual([])
})
