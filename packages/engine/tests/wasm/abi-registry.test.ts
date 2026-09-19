// `registry.rs` owns the ABI and `abi.ts` mirrors it: this test is what keeps them equal, and what
// holds every built module to "numbers only" (docs/decisions/0014 §2).
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import * as abi from '../../src/abi.js'
import { fixtureBytes, fixtureNames } from '../support/fixtures.js'
import { funcType, readSections } from '../support/wasm-sections.js'

const registry = readFileSync(
  new URL('../../crates/engine/src/abi/registry.rs', import.meta.url),
  'utf8',
)

/** The `Name = N,` lines of `enum <name>`. */
function rustEnum(name: string): Record<string, number> {
  const body = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(registry)?.[1]
  if (body === undefined) throw new Error(`registry.rs has no enum ${name}`)
  return Object.fromEntries(
    [...body.matchAll(/^\s*(\w+) = (\d+),$/gm)].map((m) => [m[1], Number(m[2])]),
  )
}

/** Every `pub const NAME: u32 = N;`. */
function rustConsts(): Record<string, number> {
  return Object.fromEntries(
    [...registry.matchAll(/^pub const (\w+): u32 = (\d+);$/gm)].map((m) => [m[1], Number(m[2])]),
  )
}

describe('abi registry', () => {
  test('abi registry: enums match registry.rs', () => {
    const { Role, Status, RegionId, LogLevel } = abi
    for (const [name, mirror] of Object.entries({ Role, Status, RegionId, LogLevel })) {
      expect(mirror, name).toEqual(rustEnum(name))
    }
  })

  test('abi registry: constants match registry.rs', () => {
    const { ABI_VERSION, BOOT_BYTES, BOOT_TEXT_BYTES, RESULT_BYTES } = abi
    expect({ ABI_VERSION, BOOT_BYTES, BOOT_TEXT_BYTES, RESULT_BYTES }).toEqual(rustConsts())
  })

  test('abi registry: every extern in export_instance! has a row', () => {
    const externs = [...registry.matchAll(/pub extern "C" fn (\w+)\(/g)].map((m) => m[1])
    expect(externs.sort()).toEqual(Object.keys(abi.ABI_EXPORTS).sort())
  })

  test.each(fixtureNames())('abi registry: fx-%s exports and signatures', (name) => {
    const sections = readSections(fixtureBytes(name))
    const linkerSymbols = ['__data_end', '__heap_base']
    const functions = sections.exports.filter((e) => e.kind === 'function')
    const others = sections.exports.filter((e) => e.kind !== 'function').map((e) => e.name)
    expect(functions.map((e) => e.name).sort()).toEqual(Object.keys(abi.ABI_EXPORTS).sort())
    expect(others.filter((n) => !linkerSymbols.includes(n))).toEqual(['memory'])

    const numbers = ['i32', 'f32', 'f64']
    const crossing = [
      ...functions.map((e) => ({ name: e.name, type: funcType(sections, e.index) })),
      // Imported functions come first in the function index space, in import order.
      ...sections.imports
        .filter((i) => i.kind === 'function')
        .map((i, index) => ({ name: `${i.module}.${i.name}`, type: funcType(sections, index) })),
    ]
    for (const { name: fn, type } of crossing) {
      const all = [...type.params, ...type.results]
      expect(
        all.filter((t) => !numbers.includes(t)),
        `${fn}: i64/externref crossing`,
      ).toEqual([])
      expect(type.results.length, `${fn}: more than one result`).toBeLessThanOrEqual(1)
    }
    for (const [fn, spec] of Object.entries<abi.ExportSpec>(abi.ABI_EXPORTS)) {
      const type = crossing.find((c) => c.name === fn)?.type
      expect(type?.params.length, `${fn}: parameter count`).toBe(spec.params)
      expect(type?.results.length, `${fn}: result count`).toBe(spec.result === 'void' ? 0 : 1)
    }
  })
})
