// docs/plan/27-server-entrypoint-and-netcode-harness.md, Exit criterion 3: "No `node:` import
// outside `src/server-node.ts` and M22b's fs storage (grep test)". A source scan, not a parser
// (the same technique `no-wasm-instantiate.test.ts` uses), over every non-test `.ts` file in `src/`.
// `vite.ts` (the Vite plugin) and `build-game.ts` (`buildGame()`, the cargo-driving build pipeline,
// docs/decisions/0017-packaging-and-build.md §5) are dev-only build tooling, not the server core
// this criterion is about (0017 Alternatives rejected: "`node:`/`Bun.`/`Deno.` appear only in
// adapters"), and are exempted the same way they already were before this milestone.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const SRC = dirname(fileURLToPath(import.meta.url))

const ALLOWED = new Set(['server-node.ts', 'storage/fs.ts', 'vite.ts', 'build-game.ts'])

function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
  return out
}

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

test('no node: import outside src/server-node.ts and the fs Storage adapter', () => {
  const offenders: string[] = []
  for (const file of listTsFiles(SRC)) {
    const rel = relative(SRC, file).replaceAll('\\', '/')
    if (ALLOWED.has(rel)) continue
    const text = stripComments(readFileSync(file, 'utf8'))
    if (/\bfrom\s+['"]node:[^'"]+['"]/.test(text) || /\brequire\(\s*['"]node:/.test(text)) {
      offenders.push(rel)
    }
  }
  expect(offenders).toEqual([])
})
