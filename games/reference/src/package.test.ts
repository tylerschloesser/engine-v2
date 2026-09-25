// `reference_package_depends_only_on_engine` and `reference_bindings_have_no_bigint` (docs/plan/
// 20-reference-game-v0.md Tests added).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))

test('reference_package_depends_only_on_engine', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  expect(pkg.private, 'package.json must be "private": true (0017 §1)').toBe(true)
  expect(Object.keys(pkg.dependencies ?? {})).toEqual(['engine'])
  expect(pkg.dependencies.engine, 'engine must be workspace:* (0017 §1)').toBe('workspace:*')

  // `sim/Cargo.toml` depends on the engine crate by a relative `path`, never through
  // `node_modules` (0017 §1): the exact seam `add-action-type`/M20b build on.
  const cargoToml = readFileSync(join(PACKAGE_ROOT, 'sim/Cargo.toml'), 'utf8')
  const engineLine = cargoToml.split('\n').find((l) => l.trimStart().startsWith('engine ='))
  expect(engineLine, 'sim/Cargo.toml must declare an engine dependency').toBeDefined()
  expect(engineLine).toContain('path =')
  expect(engineLine).not.toContain('node_modules')
})

describe('reference_bindings_have_no_bigint', () => {
  const bindingsDir = join(PACKAGE_ROOT, 'src/bindings')
  const files = readdirSync(bindingsDir).filter((f) => f.endsWith('.ts'))
  expect(files.length, 'no generated bindings found').toBeGreaterThan(0)
  for (const file of files) {
    test(file, () => {
      const text = readFileSync(join(bindingsDir, file), 'utf8')
      expect(text, `${file} must not use bigint (0003: TS-facing types)`).not.toMatch(/\bbigint\b/)
    })
  }
})
