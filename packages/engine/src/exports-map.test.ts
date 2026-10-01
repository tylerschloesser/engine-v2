// M35 step 1: the final exports map (0017 §2 plus the one subpath a later ADR added, 0034's
// `./render`), checked against `dist` and the packed tarball. Extends `test.test.ts`'s `exports_map:`
// tests (those walk `src/`; these walk the built `dist/` and `pnpm pack --json`). Needs a built
// `dist` (`pnpm test`'s first step builds it).
//
// Ruling on 0034 (M35 step 1): `./render` stays its own subpath. Five files of `games/reference`
// (`game.ts`, `ui/collect.ts`, and the `gc`/`test` entries) assemble the render loop from these
// pieces and under different clocks (real rAF, a stepped `ClientOptions.test` clock), so
// `createClient` cannot own the assembly without taking a clock and a drain policy it deliberately
// does not know (0018 §1). The map below pins it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(`${PKG}package.json`, 'utf8')) as {
  files: string[]
  dependencies: Record<string, string>
  exports: Record<string, string | { types?: string; default?: string }>
}

/** 0017 §2, with `./render` (0034, kept by M35). Order is the file's, not significant. */
const SUBPATHS = [
  '.',
  './worker',
  './server',
  './server/node',
  './server/bun',
  './server/deno',
  './vite',
  './render',
  './virtual',
  './test',
  './package.json',
]

test('exports-map: the subpath list is exactly 0017 §2 plus ./render', () => {
  expect(Object.keys(pkg.exports).sort()).toEqual([...SUBPATHS].sort())
})

test('exports-map: every subpath has types and default under dist (virtual: types only)', () => {
  const missing: string[] = []
  for (const [sub, target] of Object.entries(pkg.exports)) {
    if (typeof target === 'string') {
      if (!existsSync(join(PKG, target))) missing.push(`${sub} -> ${target}`)
      continue
    }
    if (!target.types) missing.push(`${sub}: no types`)
    else if (!existsSync(join(PKG, target.types))) missing.push(`${sub} types ${target.types}`)
    if (sub === './virtual') {
      if (target.default !== undefined) missing.push(`${sub}: declares default`)
    } else if (!target.default) missing.push(`${sub}: no default`)
    else if (!existsSync(join(PKG, target.default)))
      missing.push(`${sub} default ${target.default}`)
  }
  expect(missing).toEqual([])
})

test('exports-map: dependencies is empty and files is exactly dist + crates', () => {
  expect(pkg.dependencies).toEqual({})
  expect(pkg.files).toEqual(['dist', 'crates'])
})

const IMPORT_SPEC = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every dist file reachable from `entry` by relative specifiers; bare specifiers and dynamic
 * `import(` are collected as `problems` (a `node:` built-in is a bare specifier too). */
function walkDist(entry: string): { files: Set<string>; bare: string[]; dynamic: string[] } {
  const files = new Set<string>()
  const bare: string[] = []
  const dynamic: string[] = []
  const stack = [entry]
  while (stack.length > 0) {
    const rel = stack.pop()
    if (!rel || files.has(rel)) continue
    files.add(rel)
    const text = stripComments(readFileSync(join(PKG, rel), 'utf8'))
    if (/\bimport\s*\(/.test(text)) dynamic.push(rel)
    for (const m of text.matchAll(IMPORT_SPEC)) {
      const spec = m[1] as string
      if (!spec.startsWith('.')) bare.push(`${rel}: ${spec}`)
      else if (spec.endsWith('.js')) {
        stack.push(new URL(spec, `file:///${rel}`).pathname.slice(1))
      }
    }
  }
  return { files, bare, dynamic }
}

test('exports-map: dist/worker.js (and everything it imports) has no bare specifier and no import()', () => {
  const { files, bare, dynamic } = walkDist('dist/worker.js')
  expect(files.size).toBeGreaterThan(5)
  expect(bare).toEqual([])
  expect(dynamic).toEqual([])
})

test('exports-map: no production entry reaches dist/test.js', () => {
  const offenders: string[] = []
  for (const [sub, target] of Object.entries(pkg.exports)) {
    if (sub === './test' || typeof target === 'string' || !target.default) continue
    const entry = target.default.replace(/^\.\//, '')
    for (const f of walkDist(entry).files) {
      if (f === 'dist/test.js' || f.startsWith('dist/test/')) offenders.push(`${sub} -> ${f}`)
    }
  }
  expect(offenders).toEqual([])
})

test('exports-map: pnpm pack lists only dist/**, crates/** and package.json', () => {
  const dest = mkdtempSync(join(tmpdir(), 'engine-pack-'))
  try {
    const out = execFileSync('pnpm', ['pack', '--json', '--pack-destination', dest], {
      cwd: PKG,
      encoding: 'utf8',
    })
    const files = (JSON.parse(out) as { files: { path: string }[] }).files.map((f) => f.path)
    expect(files.length).toBeGreaterThan(100)
    const stray = files.filter(
      (p) => p !== 'package.json' && !p.startsWith('dist/') && !p.startsWith('crates/'),
    )
    expect(stray).toEqual([])
    // The names 0017 §2 keeps out of the tarball, at the package root (the crate's own `tests/` ships).
    const unpublished = files.filter(
      (p) => /^(tests|fixtures|baselines)\//.test(p) || p === 'budgets.json',
    )
    expect(unpublished).toEqual([])
    expect(files).toContain('crates/engine/Cargo.toml')
    expect(files).toContain('dist/client.js')
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

const ROOT_CARGO = fileURLToPath(new URL('../../../Cargo.toml', import.meta.url))

/** The `key = value` lines of one TOML table (flat, which is all these two manifests use there). */
function tomlTable(text: string, table: string): Record<string, string> {
  const out: Record<string, string> = {}
  let inside = false
  for (const line of text.split('\n')) {
    const header = /^\[([^\]]+)\]\s*$/.exec(line)
    if (header) inside = header[1] === table
    else if (inside) {
      const kv = /^([\w.-]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line)
      if (kv) out[kv[1] as string] = kv[2] as string
    }
  }
  return out
}

test('exports-map: the shipped crate manifest has no workspace inheritance and tracks the root', () => {
  const crate = readFileSync(`${PKG}crates/engine/Cargo.toml`, 'utf8')
  const root = readFileSync(ROOT_CARGO, 'utf8')
  // No workspace root exists inside `node_modules` (0017 §8): `x.workspace = true`, `workspace = true`.
  const inheriting = crate.split('\n').filter((l) => /\bworkspace\s*=\s*true\b/.test(l))
  expect(inheriting).toEqual([])
  const pick = (t: Record<string, string>, keys: string[]) => keys.map((k) => t[k])
  expect(pick(tomlTable(crate, 'package'), ['version', 'edition', 'publish'])).toEqual(
    pick(tomlTable(root, 'workspace.package'), ['version', 'edition', 'publish']),
  )
  expect(tomlTable(crate, 'lints.clippy')).toEqual(tomlTable(root, 'workspace.lints.clippy'))
})

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  )
}

test('exports-map: every file in dist has a source file (build cleans dist)', () => {
  const orphans = filesUnder(`${PKG}dist`).filter((f) => {
    const stem = f.replace(/\.(d\.ts|js\.map|d\.ts\.map|js)$/, '')
    return !existsSync(`${PKG}src/${stem}.ts`) && !existsSync(`${PKG}src/${f}`)
  })
  expect(orphans).toEqual([])
})
