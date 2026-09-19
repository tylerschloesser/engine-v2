// The boundary's guard (docs/decisions/0014 §3, 0002 §3, 0015 §5), run against every fixture.
import { describe, expect, test } from 'vitest'
import { ABI_EXPORTS } from '../../src/abi.js'
import { fixtureBytes, fixtureNames } from '../support/fixtures.js'
import { readSections } from '../support/wasm-sections.js'

const ALLOWED_IMPORTS = ['engine.panic', 'engine.log']

// What the pinned toolchain (0017 §10) turns on for wasm32-unknown-unknown by default, captured
// from its output. `buildGame` never passes target-feature flags; whether `simd128` may ever be
// enabled is measured by M36b. A toolchain bump that changes this list re-checks the goldens.
const DEFAULT_FEATURES = [
  'bulk-memory',
  'bulk-memory-opt',
  'call-indirect-overlong',
  'multivalue',
  'mutable-globals',
  'nontrapping-fptoint',
  'reference-types',
  'sign-ext',
]
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

/** `+name` entries of the `target_features` custom section. */
function targetFeatures(module: WebAssembly.Module): string[] {
  const [section] = WebAssembly.Module.customSections(module, 'target_features')
  if (!section) return []
  const bytes = new Uint8Array(section)
  const features: string[] = []
  // A count, then (prefix byte, name length, name) each; all lengths here fit one LEB128 byte.
  for (let at = 1; at < bytes.length; ) {
    const prefix = String.fromCharCode(bytes[at] as number)
    const len = bytes[at + 1] as number
    const name = new TextDecoder().decode(bytes.subarray(at + 2, at + 2 + len))
    if (prefix === '+') features.push(name)
    at += 2 + len
  }
  return features.sort()
}

describe.each(fixtureNames())('fixture %s', (name) => {
  const bytes = fixtureBytes(name)
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
    const listed = `fx-${name} imports outside the allowlist:\n${lines.join('\n')}`
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
      expect(features, `${banned} is off for the sim module (0002 §2)`).not.toContain(banned)
    }
    const unknown = features.filter((f) => !DEFAULT_FEATURES.includes(f))
    expect(unknown, 'features beyond the default target set (0002 §3)').toEqual([])
  })
})
