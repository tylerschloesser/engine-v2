// The boundary's guard (docs/decisions/0014 §3, 0002 §3, 0015 §5), run against every fixture.
import { describe, expect, test } from 'vitest'
import { ABI_EXPORTS } from '../../src/abi.js'
import { fixtureBytes, fixtureNames, gameCrateBytes, gameCrateNames } from '../support/fixtures.js'
import { allowedTargetFeatures, readSections, targetFeatures } from '../support/wasm-sections.js'

const ALLOWED_IMPORTS = ['engine.panic', 'engine.log']

// The default feature set and the one variant-only exception (`simd128`, `feature-matrix @slow`'s
// case (c)) live in `support/wasm-sections.ts`; a module built by `pnpm test` never has the exception.
const BANNED_FEATURES = ['simd128', 'relaxed-simd', 'atomics']

const WASM_BINDGEN =
  "a crate pulled in wasm-bindgen (getrandom's JS backend, instant, web-time, chrono's wasmbind)"
const CULPRITS: Record<string, string> = {
  __wbindgen_placeholder__: WASM_BINDGEN,
  __wbindgen_externref_xform__: WASM_BINDGEN,
  wbg: WASM_BINDGEN,
  env: 'an unresolved C symbol',
  wasi_snapshot_preview1: 'wrong target: build for wasm32-unknown-unknown',
}

/** The two checks below, shared by every fixture and every in-repo game's `sim/` crate (docs/plan/
 * 20-reference-game-v0.md, orchestrator ruling): identical assertions, `label` only changes what a
 * failure names. */
function checkAllowlist(label: string, bytes: Uint8Array<ArrayBuffer>): void {
  const module = new WebAssembly.Module(bytes)

  test('import allowlist', () => {
    const offenders = WebAssembly.Module.imports(module).filter(
      (i) => i.kind !== 'function' || !ALLOWED_IMPORTS.includes(`${i.module}.${i.name}`),
    )
    // One line per import module, in the message: Vitest elides a long array, and the names are
    // the point.
    const lines = [...new Set(offenders.map((i) => i.module))].map((from) => {
      const names = offenders.filter((i) => i.module === from).map((i) => i.name)
      const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '')
      return `  ${from} (${names.length}: ${shown}): ${CULPRITS[from] ?? 'not in 0014 §3'}`
    })
    const listed = `${label} imports outside the allowlist:\n${lines.join('\n')}`
    expect(offenders.length, listed).toBe(0)

    const exported = WebAssembly.Module.exports(module)
    expect(exported).toContainEqual({ name: 'memory', kind: 'memory' })
    const names = exported.map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(Object.keys(ABI_EXPORTS)))

    // Memory is exported, never imported, and may grow: no declared maximum (0015 §5).
    const sections = readSections(bytes)
    expect(sections.imports.filter((i) => i.kind === 'memory')).toEqual([])
    expect(sections.memories).toHaveLength(1)
    expect(sections.memories[0]?.max).toBeUndefined()
  })

  test('target features', () => {
    const features = targetFeatures(module)
    expect(features.length, 'dev-profile modules keep the target_features section').toBeGreaterThan(
      0,
    )
    for (const banned of BANNED_FEATURES) {
      expect(features, `${banned} is off for ${label} (0002 §2)`).not.toContain(banned)
    }
    const unknown = features.filter((f) => !allowedTargetFeatures().includes(f))
    expect(unknown, 'features beyond the default target set (0002 §3)').toEqual([])
  })
}

describe.each(fixtureNames())('fixture %s', (name) => {
  checkAllowlist(`fx-${name}`, fixtureBytes(name))
})

// Widened per M20 (orchestrator ruling): "the M02 import-allowlist
// test and clippy bans run against reference-sim". `gameCrateNames()` returns `[]` (no `describe`
// bodies at all) in a checkout with no `games/` yet, same as `fixtureNames()` would for an empty
// `fixtures/`.
describe.each(gameCrateNames())('game %s/sim', (name) => {
  checkAllowlist(`games/${name}/sim`, gameCrateBytes(name))
})
