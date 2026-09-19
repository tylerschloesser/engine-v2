import { createClient } from 'fake-engine'
import wasmUrl from '../../sim/target/wasm32-unknown-unknown/release/sim.wasm?url'
const pattern = new URLSearchParams(location.search).get('pattern') ?? 'A'
createClient({
  wasmUrl,
  createWorker: pattern === 'B' ? () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) : undefined,
}).then(async (c) => {
  ;(window as any).__result = { ok: true, pattern, wasmUrl, sum: await c.add(40, 2), coi: crossOriginIsolated, ct: c.info.wasmContentType }
}, (e) => ((window as any).__result = { ok: false, pattern, error: String(e) }))
