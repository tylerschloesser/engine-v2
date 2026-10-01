// A LEB128 walk over the sections the boundary tests need. The JS API exposes neither function
// signatures nor memory limits, and the project takes no dependency for it.

export type ValType = 'i32' | 'i64' | 'f32' | 'f64' | 'v128' | 'funcref' | 'externref'
export type FuncType = { params: ValType[]; results: ValType[] }
export type Limits = { min: number; max: number | undefined }
export type Import = {
  module: string
  name: string
  kind: 'function' | 'table' | 'memory' | 'global' | 'tag'
  /** Index into `types`; functions only. */
  type: number | undefined
}
export type Export = { name: string; kind: Import['kind']; index: number }
export type Sections = {
  types: FuncType[]
  imports: Import[]
  /** Type index of each function the module defines (imported functions come first). */
  funcs: number[]
  exports: Export[]
  memories: Limits[]
}

const VAL_TYPES = new Map<number, ValType>([
  [0x7f, 'i32'],
  [0x7e, 'i64'],
  [0x7d, 'f32'],
  [0x7c, 'f64'],
  [0x7b, 'v128'],
  [0x70, 'funcref'],
  [0x6f, 'externref'],
])
const KINDS = ['function', 'table', 'memory', 'global', 'tag'] as const

export function readSections(bytes: Uint8Array): Sections {
  let at = 8 // magic + version
  const byte = () => bytes[at++] as number
  const u32 = () => {
    let value = 0
    for (let shift = 0; ; shift += 7) {
      const b = byte()
      value += (b & 0x7f) * 2 ** shift
      if (b < 0x80) return value
    }
  }
  const name = () => {
    const len = u32()
    at += len
    return new TextDecoder().decode(bytes.subarray(at - len, at))
  }
  const list = <T>(item: () => T) => Array.from({ length: u32() }, item)
  const valType = () => {
    const b = byte()
    const type = VAL_TYPES.get(b)
    if (!type) throw new Error(`wasm-sections: value type 0x${b.toString(16)}`)
    return type
  }
  const kind = () => KINDS[byte()] as Import['kind']
  const limits = (): Limits => {
    const flags = byte()
    return { min: u32(), max: flags & 1 ? u32() : undefined }
  }

  const out: Sections = { types: [], imports: [], funcs: [], exports: [], memories: [] }
  while (at < bytes.length) {
    const id = byte()
    const end = u32() + at
    if (id === 1) {
      out.types = list(() => {
        if (byte() !== 0x60) throw new Error('wasm-sections: not a function type')
        return { params: list(valType), results: list(valType) }
      })
    } else if (id === 2) {
      out.imports = list(() => {
        const entry: Import = { module: name(), name: name(), kind: kind(), type: undefined }
        if (entry.kind === 'function') entry.type = u32()
        else if (entry.kind === 'memory') limits()
        else if (entry.kind === 'global')
          at += 2 // value type, mutability
        else {
          byte() // table: reference type, then limits; tag: attribute, then type index
          if (entry.kind === 'table') limits()
          else u32()
        }
        return entry
      })
    } else if (id === 3) out.funcs = list(u32)
    else if (id === 5) out.memories = list(limits)
    else if (id === 7) out.exports = list(() => ({ name: name(), kind: kind(), index: u32() }))
    at = end
  }
  return out
}

/** Signature of function `index` in the module's function index space. */
export function funcType(sections: Sections, index: number): FuncType {
  const imported = sections.imports.filter((i) => i.kind === 'function')
  const type =
    index < imported.length ? imported[index]?.type : sections.funcs[index - imported.length]
  const found = type === undefined ? undefined : sections.types[type]
  if (!found) throw new Error(`wasm-sections: no type for function ${index}`)
  return found
}

/** What the pinned toolchain (0017 §10) turns on for wasm32-unknown-unknown by default, captured
 * from its output. `buildGame` never passes target-feature flags; a toolchain bump that changes
 * this list re-checks the goldens. */
export const DEFAULT_TARGET_FEATURES = [
  'bulk-memory',
  'bulk-memory-opt',
  'call-indirect-overlong',
  'multivalue',
  'mutable-globals',
  'nontrapping-fptoint',
  'reference-types',
  'sign-ext',
]

/**
 * The target features a module may carry (0002 §2-§3): the defaults, and `simd128` for the one
 * measurement variant that asks for it (`feature-matrix @slow`, M36b, case (c)). Never anything a
 * shipped module has: every other caller passes no variant.
 */
export function allowedTargetFeatures(variant: 'default' | 'simd128' = 'default'): string[] {
  return variant === 'simd128' ? [...DEFAULT_TARGET_FEATURES, 'simd128'] : DEFAULT_TARGET_FEATURES
}

/** `+name` entries of the `target_features` custom section, sorted. */
export function targetFeatures(module: WebAssembly.Module): string[] {
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
