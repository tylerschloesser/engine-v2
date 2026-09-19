// The engine crate's dependency policy as a test (docs/decisions/0017 §7). M35 consumes this test
// and adds no second one.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { toolEnv } from './env.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const cargo = (...args) =>
  execFileSync('cargo', args, { cwd: root, env: toolEnv(), encoding: 'utf8', stdio: 'pipe' })

// Owner of this list: docs/decisions/0017 §7. A new name arrives with its ADR (`write-adr` skill).
const ALLOWED = ['serde', 'postcard', 'serde_json', 'ts-rs', 'libm']

const metadata = JSON.parse(cargo('metadata', '--format-version', '1'))
const members = metadata.packages.filter((p) => metadata.workspace_members.includes(p.id))
const engine = members.find((p) => p.name === 'engine')
const normal = engine.dependencies.filter((d) => d.kind === null)

describe('crate-policy', () => {
  test('crate-policy: engine dependencies are a subset of the 0017 §7 list', () => {
    const extra = normal.map((d) => d.name).filter((name) => !ALLOWED.includes(name))
    expect(extra, 'engine crate dependencies outside docs/decisions/0017 §7').toEqual([])
  })

  test('crate-policy: postcard and serde_json are alloc-only', () => {
    for (const dep of normal.filter((d) => ['postcard', 'serde_json'].includes(d.name))) {
      expect(dep.uses_default_features, `${dep.name}: default-features = false`).toBe(false)
      expect(dep.features, `${dep.name}: features`).toEqual(['alloc'])
    }
    // Feature unification could still turn `std` on from elsewhere in the graph (0003).
    const tree = cargo(
      ...['tree', '-p', 'engine', '--target', 'wasm32-unknown-unknown'],
      ...['-e', 'normal,features', '--prefix', 'none'],
    )
    const std = tree.split('\n').filter((line) => /^serde_json feature "(std|default)"/.test(line))
    expect(std, 'serde_json must stay no-std in the .wasm').toEqual([])
  })

  test('crate-policy: libm is pinned with = in every workspace manifest', () => {
    const loose = members.flatMap((p) =>
      p.dependencies
        .filter((d) => d.name === 'libm' && !d.req.startsWith('='))
        .map((d) => `${p.name}: libm ${d.req}`),
    )
    expect(loose, 'libm must be pinned exactly (0002 §2)').toEqual([])
  })
})
