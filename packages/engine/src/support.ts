// `checkSupport()` (docs/plan/06b-workers-and-spawn.md, Planning decisions "`checkSupport` minimum"):
// synchronous facts plus a module-worker probe, plus (docs/plan/09-renderer-terrain.md) an async
// `requestAdapter()` probe for `no-adapter`. The final list and the capability-screen contract are
// M35's.
import { ADAPTER_REQUEST } from './render/device.js'

export type SupportFailureCode =
  | 'not-isolated'
  | 'no-sab'
  | 'no-wasm'
  | 'no-module-worker'
  | 'no-webgpu'
  | 'no-adapter'

export type SupportFailure = { code: SupportFailureCode; message: string }
export type SupportReport = { ok: boolean; failures: SupportFailure[] }

function moduleWorkerSupported(): boolean {
  let worker: Worker | undefined
  try {
    const url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }))
    try {
      worker = new Worker(url, { type: 'module' })
    } finally {
      URL.revokeObjectURL(url)
    }
    return true
  } catch {
    return false
  } finally {
    worker?.terminate()
  }
}

export async function checkSupport(): Promise<SupportReport> {
  const failures: SupportFailure[] = []
  if (!globalThis.crossOriginIsolated) {
    failures.push({
      code: 'not-isolated',
      message:
        'crossOriginIsolated is false: COOP/COEP headers are required on every path (0015 §3)',
    })
  }
  if (typeof SharedArrayBuffer === 'undefined') {
    failures.push({ code: 'no-sab', message: 'SharedArrayBuffer is not available' })
  }
  if (typeof WebAssembly === 'undefined') {
    failures.push({ code: 'no-wasm', message: 'WebAssembly is not available' })
  }
  if (typeof Worker === 'undefined' || !moduleWorkerSupported()) {
    failures.push({
      code: 'no-module-worker',
      message: 'new Worker(url, { type: "module" }) is not supported',
    })
  }
  const gpu = (typeof navigator === 'undefined' ? undefined : navigator) as
    | { gpu?: GPU }
    | undefined
  if (!gpu?.gpu) {
    failures.push({ code: 'no-webgpu', message: 'navigator.gpu is not present' })
  } else {
    // `no-adapter` (docs/plan/09-renderer-terrain.md, Scope: "fills in `checkSupport`'s
    // `no-adapter`"): the same `ADAPTER_REQUEST` `initDevice()` uses, so this reports exactly what a
    // real `initDevice()` call would hit.
    const adapter = await gpu.gpu.requestAdapter(ADAPTER_REQUEST)
    if (!adapter) {
      failures.push({
        code: 'no-adapter',
        message: 'navigator.gpu.requestAdapter() returned null: no compatible GPU adapter',
      })
    }
  }
  return { ok: failures.length === 0, failures }
}
