import type { FromWorker, ToWorker } from './protocol.js'

export const ABI_VERSION = 1

export interface ClientOptions {
  /** URL of the game-built .wasm (the wasm is data, not an import). */
  wasmUrl: string | URL
  /** Pattern B: the game constructs the worker. Omit for pattern A (engine-internal). */
  createWorker?: () => Worker
  /** 'main': compileStreaming on main, postMessage the Module. 'worker': worker does instantiateStreaming. */
  compileIn?: 'main' | 'worker'
  seed?: number
}

export interface Client {
  add(a: number, b: number): Promise<number>
  tick(n: number): Promise<number>
  terminate(): void
  info: {
    pattern: 'A' | 'B'
    how: 'module' | 'streaming'
    abiVersion: number
    imports: { module: string; name: string; kind: string }[]
    exports: string[]
    logs: string[]
    wasmContentType: string | null
  }
}

export async function createClient(opts: ClientOptions): Promise<Client> {
  const worker = opts.createWorker
    ? opts.createWorker()
    : // Pattern A: relies on the bundler detecting this inside node_modules.
      new Worker(new URL('./worker-auto.js', import.meta.url), { type: 'module' })

  const wasmUrl = new URL(opts.wasmUrl, location.href).href
  const logs: string[] = []
  const pending = new Map<number, { resolve: (v: number) => void; reject: (e: Error) => void }>()
  let nextId = 1
  let imports: Client['info']['imports'] = []
  let wasmContentType: string | null = null

  const ready = new Promise<Extract<FromWorker, { type: 'ready' }>>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error('worker error: ' + (e.message || 'unknown')))
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data
      if (m.type === 'ready') resolve(m)
      else if (m.type === 'log') logs.push(`[${m.level}] ${m.msg}`)
      else if (m.type === 'result') pending.get(m.id)?.resolve(m.value), pending.delete(m.id)
      else if (m.type === 'panic' || m.type === 'error') {
        const err = new Error(`${m.type}: ${m.msg}`)
        reject(err)
        for (const p of pending.values()) p.reject(err)
        pending.clear()
      }
    }
  })

  const seed = opts.seed ?? 1
  if ((opts.compileIn ?? 'main') === 'main') {
    const res = await fetch(wasmUrl)
    wasmContentType = res.headers.get('content-type')
    const module = await WebAssembly.compileStreaming(res)
    imports = WebAssembly.Module.imports(module)
    const foreign = imports.filter((i) => i.module !== 'engine')
    if (foreign.length) throw new Error('unexpected wasm imports: ' + JSON.stringify(foreign))
    worker.postMessage({ type: 'init', module, seed } satisfies ToWorker)
  } else {
    worker.postMessage({ type: 'init', wasmUrl, seed } satisfies ToWorker)
  }

  const r = await ready
  if (r.abiVersion !== ABI_VERSION) throw new Error(`ABI mismatch: wasm ${r.abiVersion}, loader ${ABI_VERSION}`)

  const call = (msg: { type: 'add'; a: number; b: number } | { type: 'tick'; n: number }) =>
    new Promise<number>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      worker.postMessage({ ...msg, id } as ToWorker)
    })

  return {
    add: (a, b) => call({ type: 'add', a, b }),
    tick: (n) => call({ type: 'tick', n }),
    terminate: () => worker.terminate(),
    info: {
      pattern: opts.createWorker ? 'B' : 'A',
      how: r.how,
      abiVersion: r.abiVersion,
      imports,
      exports: r.exports,
      logs,
      wasmContentType,
    },
  }
}
