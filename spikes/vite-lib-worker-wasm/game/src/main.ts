import { createClient } from 'fake-engine'
import virtualWasmUrl from 'virtual:engine/wasm-url'
// Game-side `?url` import. Note the path bakes in the cargo profile.
import urlWasmUrl from '../sim/target/wasm32-unknown-unknown/release/sim.wasm?url'

const q = new URLSearchParams(location.search)
const pattern = q.get('pattern') ?? 'A'
const wasmSource = q.get('wasm') ?? 'virtual'
const compileIn = (q.get('compile') ?? 'main') as 'main' | 'worker'
const wasmUrl = wasmSource === 'url' ? urlWasmUrl : virtualWasmUrl

const out = document.getElementById('out')!
try {
  const client = await createClient({
    wasmUrl,
    compileIn,
    createWorker:
      pattern === 'B'
        ? () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
        : undefined,
  })
  const sum = await client.add(40, 2)
  const hash = await client.tick(1000)
  let panic: string | null = null
  if (q.has('panic')) {
    try {
      await client.add(-2147483648, 0)
    } catch (e) {
      panic = String(e)
    }
  }
  const result = { ok: true, pattern, wasmSource, wasmUrl, compileIn, sum, hash, panic, crossOriginIsolated, ...client.info }
  ;(window as any).__result = result
  out.textContent = JSON.stringify(result, null, 2)
} catch (e) {
  const result = { ok: false, pattern, wasmSource, wasmUrl, compileIn, error: String(e) }
  ;(window as any).__result = result
  out.textContent = JSON.stringify(result, null, 2)
}
