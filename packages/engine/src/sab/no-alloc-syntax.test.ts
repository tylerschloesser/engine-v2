// `sab.no_alloc_syntax` (docs/plan/06-sab-primitives-and-workers.md, Exit criteria): a source scan,
// not a parser, over `src/sab/**` and `src/camera/block.ts` (production files only: `*.test.ts` is
// exempt, matching `no-ambient-random.test.ts` and `hot-paths.md`'s own test-file exemption).
//
// "Outside a constructor" is read as: a real class `constructor(...) { ... }` body, or a top-level
// `function create*(...) { ... }`/`export function create*(...) { ... }` body — both are one-time
// setup (docs/decisions/0015 §2 "created at setup"; `.claude/rules/hot-paths.md`'s "one-time setup"
// carve-out), unlike everything else in these files, which runs per frame, tick or message. Those
// bodies are stripped before scanning; a top-level `const`/`type`/`interface` at module scope (not
// inside any function) is not "a function" either and is left alone.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url)) // packages/engine/src/

function stripCommentsAndStrings(text: string): string {
  // Order matters: block comments, line comments, template/string literals, each replaced with
  // same-length blanks so reported line numbers would still line up if this scan ever needs them.
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
  out = out.replace(/`(?:\\.|[^`\\])*`/g, (m) => ' '.repeat(m.length))
  out = out.replace(/'(?:\\.|[^'\\])*'/g, (m) => ' '.repeat(m.length))
  out = out.replace(/"(?:\\.|[^"\\])*"/g, (m) => ' '.repeat(m.length))
  return out
}

/** Removes every `constructor(...) { <body> }` and `[export] function create<Name>(...) { <body> }`
 * span (balanced braces, optional return-type annotation before the body), replacing each with
 * blanks of the same length. Also blanks top-level `const NAME = <literal>` and `type NAME =
 * <object type>` right-hand sides: module top level runs once at load, outside any function, so it
 * is not "a function [that] contains" a literal either way; this only keeps enum-style `as const`
 * tables and object-shaped type aliases (`RingStats`, `SabSet`, …) from tripping the literal check
 * below. */
function stripExemptBodies(text: string): string {
  // The const/type alternative is anchored at column 0 (`^`, multiline): a genuinely top-level
  // declaration in this codebase's 2-space-indented style, never a statement nested in a method.
  const starts =
    /\bconstructor\s*\([^)]*\)\s*(?::[^{]*)?\{|\bfunction\s+create[A-Z]\w*\s*\([^)]*\)\s*(?::[^{]*)?\{|^(?:export\s+)?(?:const|type)\s+[A-Za-z_$][\w$]*(?:<[^=]*>)?\s*=\s*[{[]/gm
  let out = ''
  let last = 0
  for (;;) {
    const m = starts.exec(text)
    if (!m) break
    const openChar = m[0][m[0].length - 1] as string
    const closeChar = openChar === '{' ? '}' : ']'
    const bodyOpen = m.index + m[0].length - 1 // index of the opening brace/bracket
    let depth = 1
    let i = bodyOpen + 1
    while (i < text.length && depth > 0) {
      if (text[i] === openChar) depth++
      else if (text[i] === closeChar) depth--
      i++
    }
    out += text.slice(last, m.index) + ' '.repeat(i - m.index)
    last = i
    starts.lastIndex = i
  }
  out += text.slice(last)
  return out
}

const FILES: string[] = []
for (const entry of readdirSync(join(SRC, 'sab'), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
    FILES.push(join('sab', entry.name))
  }
}
FILES.push(join('camera', 'block.ts'))

const CHECKS: Array<[RegExp, string]> = [
  [/\bnew\b/, 'new'],
  [/=>/, 'a closure (=>)'],
  [/\.subarray\(/, 'subarray('],
  [/[=(,]\s*\{(?!\s*\})/, 'an object literal'],
  [/\breturn\s*\{(?!\s*\})/, 'an object literal'],
  [/[=(,]\s*\[/, 'an array literal'],
  [/\breturn\s*\[/, 'an array literal'],
]

test('sab.no_alloc_syntax', () => {
  const problems: string[] = []
  for (const rel of FILES) {
    const raw = readFileSync(join(SRC, rel), 'utf8')
    const stripped = stripExemptBodies(stripCommentsAndStrings(raw))
    for (const [pattern, label] of CHECKS) {
      if (pattern.test(stripped)) problems.push(`${rel}: contains ${label} outside a constructor`)
    }
  }
  expect(problems, problems.join('\n')).toEqual([])
})

test('sab.no_wait_async', () => {
  // "waitAsync anywhere under packages/engine/src/" (docs/plan/06-sab-primitives-and-workers.md,
  // Exit criteria): the whole tree, not just src/sab/.
  const problems: string[] = []
  for (const path of walk(SRC)) {
    const text = readFileSync(path, 'utf8')
    if (/waitAsync/.test(text)) problems.push(path.slice(SRC.length))
  }
  expect(problems, problems.join('\n')).toEqual([])
})

test('sab.wait_for_wake_shape', () => {
  // `worker/shell.ts`'s own header rule: "`Atomics.wait` itself lives only in
  // `ControlBlock.waitForWake`; this file blocks only through that." This pins that method's body
  // to exactly the one `Atomics.wait(...)` statement -- no load, no return, nothing else on the
  // path every worker blocks on. Written for docs/decisions/0027 (which excluded this frame's own
  // bytes from the zero-GC byte total and needed the body to stay trivial); kept after
  // docs/decisions/0028-zero-gc-two-measured-windows.md superseded that exclusion, now purely as
  // hot-path discipline on the one blocking primitive in `src/`.
  const raw = readFileSync(join(SRC, 'sab', 'control.ts'), 'utf8')
  const stripped = stripCommentsAndStrings(raw)
  const m = /waitForWake\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n {2}\}/.exec(stripped)
  expect(m, 'waitForWake(...): void { ... } not found in sab/control.ts').not.toBeNull()
  const body = (m?.[1] ?? '').trim()
  expect(body).toBe('Atomics.wait(this.words, workerWord(index, W_WAKE), last, timeoutMs)')
})

test('sab.atomics_wait_confined', () => {
  // "Atomics.wait( outside sab/control.ts (waitForWake) and src/test/**"
  const problems: string[] = []
  for (const path of walk(SRC)) {
    const rel = path.slice(SRC.length).replaceAll('\\', '/')
    if (rel === 'sab/control.ts' || rel.startsWith('test/')) continue
    const text = readFileSync(path, 'utf8')
    if (/Atomics\.wait\(/.test(text)) problems.push(rel)
  }
  expect(problems, problems.join('\n')).toEqual([])
})

/** `*.test.ts` is skipped (matching `no-ambient-random.test.ts`'s own walk): test files, including
 * this one, legitimately name `waitAsync`/`Atomics.wait(` in comments and regexes without using
 * them. */
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) yield path
  }
}
