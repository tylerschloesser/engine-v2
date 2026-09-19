import type { FromWorker, ToWorker } from './protocol.js'

interface Abi {
  memory: WebAssembly.Memory
  engine_abi_version(): number
  engine_init(seed: number): number
  engine_tick(): void
  engine_state_hash(): number
  engine_add(a: number, b: number): number
}

/** Worker entry. Pattern B: `import { run } from 'fake-engine/worker'; run()`. */
export function run(): void {
  const scope = self as unknown as {
    postMessage(m: FromWorker): void
    onmessage: ((ev: MessageEvent<ToWorker>) => void) | null
  }
  const post = (m: FromWorker) => scope.postMessage(m)
  const dec = new TextDecoder()
  let abi: Abi | undefined

  const str = (ptr: number, len: number) => dec.decode(new Uint8Array(abi!.memory.buffer, ptr, len))
  const importObject: WebAssembly.Imports = {
    engine: {
      panic: (ptr: number, len: number) => post({ type: 'panic', msg: str(ptr, len) }),
      log: (level: number, ptr: number, len: number) => post({ type: 'log', level, msg: str(ptr, len) }),
    },
  }

  scope.onmessage = async (ev) => {
    const m = ev.data
    try {
      if (m.type === 'init') {
        let instance: WebAssembly.Instance
        let how: 'module' | 'streaming'
        if (m.module) {
          instance = await WebAssembly.instantiate(m.module, importObject)
          how = 'module'
        } else {
          instance = (await WebAssembly.instantiateStreaming(fetch(m.wasmUrl!), importObject)).instance
          how = 'streaming'
        }
        abi = instance.exports as unknown as Abi
        const abiVersion = abi.engine_abi_version()
        abi.engine_init(m.seed)
        post({ type: 'ready', abiVersion, exports: Object.keys(instance.exports).sort(), how })
      } else if (m.type === 'add') {
        post({ type: 'result', id: m.id, value: abi!.engine_add(m.a, m.b) })
      } else if (m.type === 'tick') {
        for (let i = 0; i < m.n; i++) abi!.engine_tick()
        post({ type: 'result', id: m.id, value: abi!.engine_state_hash() >>> 0 })
      }
    } catch (e) {
      post({ type: 'error', msg: String(e) })
    }
  }
}
