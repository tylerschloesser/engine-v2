// `engine/virtual`: ambient declaration for `virtual:engine/wasm` (docs/decisions/0017 §2, §4). A
// game's tsconfig adds `"types": ["engine/virtual"]` to see it (0017 §6). Types only: this subpath
// has no `default` condition in the exports map, so it backs no runtime import.
//
// No top-level `import`/`export` here: that would make this file itself a module, and `declare
// module` inside a module only *augments* an existing module rather than creating this one.

declare module 'virtual:engine/wasm' {
  /** What `import wasm from 'virtual:engine/wasm'` yields; passed whole to `createClient({ wasm })`
   * (M06b) and to `engine/test` (M03). Also importable as a type: `import type { EngineWasm } from
   * 'virtual:engine/wasm'`. */
  export type EngineWasm = { url: string; buildHash: string }
  const wasm: EngineWasm
  export default wasm
}
