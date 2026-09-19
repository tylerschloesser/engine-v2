// Same .wasm, same loader shape, outside the browser. Run with `node` and with `bun`.
import { readFileSync } from 'node:fs'
const bytes = readFileSync(new URL('../sim/target/wasm32-unknown-unknown/release/sim.wasm', import.meta.url))
const mod = new WebAssembly.Module(bytes)
let memory
const str = (p, l) => new TextDecoder().decode(new Uint8Array(memory.buffer, p, l))
const { exports: x } = new WebAssembly.Instance(mod, { engine: { panic: (p, l) => { throw new Error(str(p, l)) }, log: () => {} } })
memory = x.memory
x.engine_init(1)
for (let i = 0; i < 1000; i++) x.engine_tick()
const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`
console.log(runtime, 'abi', x.engine_abi_version(), 'add', x.engine_add(40, 2), 'hash', x.engine_state_hash() >>> 0,
  'imports', WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`).join(','))
