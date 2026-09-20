// docs/plan/06b-workers-and-spawn.md, Tests added: `main.no_wasm_instantiate` (0015 §1: "Main ...
// none, ever"; §2: "the main thread never blocks"). A source scan, not a parser, over the static
// *runtime* (non-type-only) relative-import closure of `src/client.ts`.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))

function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
  return out
}

/**
 * Runtime relative-import/re-export specifiers of one file's source. A whole `import type { ... }
 * from '...'`/`export type { ... } from '...'` declaration is erased at compile time and creates
 * no runtime edge; a mixed `import { type X, Y } from '...'` still does (`Y` is a real value), so
 * only a declaration whose own `type` keyword covers the *whole* statement is skipped.
 */
function runtimeImportSpecs(text: string): string[] {
  const specs: string[] = []
  const re = /^(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s+['"](\.[^'"]+)['"]/gm
  for (const m of stripComments(text).matchAll(re)) {
    const isTypeOnly = m[1] !== undefined
    const spec = m[2]
    if (!isTypeOnly && spec) specs.push(spec)
  }
  return specs
}

function resolveSpec(fromFile: string, spec: string): string {
  return resolve(dirname(fromFile), spec).replace(/\.js$/, '.ts')
}

/** Every file reachable from `entry` by a real (non-type-only) relative import, `entry` included. */
function closureFrom(entry: string): Map<string, string> {
  const files = new Map<string, string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) continue
    const text = readFileSync(file, 'utf8')
    files.set(file, text)
    for (const spec of runtimeImportSpecs(text)) queue.push(resolveSpec(file, spec))
  }
  return files
}

test('main.no_wasm_instantiate', () => {
  const entry = resolve(SRC, 'client.ts')
  const closure = closureFrom(entry)
  const rel = (p: string): string => p.slice(SRC.length).replaceAll('\\', '/')
  const paths = [...closure.keys()].map(rel)

  // Reached only through `new Worker(new URL(...))` (0017 §3), never a relative import.
  expect(paths).not.toContain('loader.ts')
  expect(paths.some((p) => p === 'worker.ts' || p.startsWith('worker/'))).toBe(false)

  for (const [file, text] of closure) {
    const stripped = stripComments(text)
    const what = rel(file)
    // `WebAssembly.compileStreaming` (client.ts's own use, to post the `Module`) is a distinct
    // name from every pattern here, so it never matches.
    expect(stripped, `${what}: WebAssembly.instantiate`).not.toMatch(/WebAssembly\.instantiate\(/)
    expect(stripped, `${what}: instantiateStreaming`).not.toMatch(/\binstantiateStreaming\(/)
    expect(stripped, `${what}: new WebAssembly.Instance`).not.toMatch(/new WebAssembly\.Instance\(/)
  }

  // Main never blocks (0015 §2): `client.ts`'s own text never calls the worker-side wait
  // primitives, even though it imports `sab/control.ts` for `wake()`/`ControlBlock` (which
  // defines `waitForWake` for a *worker* to call on itself, not for main).
  const clientText = stripComments(closure.get(entry) ?? '')
  expect(clientText).not.toMatch(/waitForWake\(/)
  expect(clientText).not.toMatch(/Atomics\.wait\(/)
})
