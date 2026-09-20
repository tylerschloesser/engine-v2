// `checkSupport()` (docs/plan/06b-workers-and-spawn.md, Planning decisions "`checkSupport` minimum"):
// synchronous facts plus a module-worker probe. `no-adapter` is filled in by M09 (needs an async
// `requestAdapter()` this milestone does not make); the final list and the capability-screen
// contract are M35's.

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

export function checkSupport(): Promise<SupportReport> {
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
  if (typeof navigator === 'undefined' || !(navigator as { gpu?: unknown }).gpu) {
    failures.push({ code: 'no-webgpu', message: 'navigator.gpu is not present' })
  }
  return Promise.resolve({ ok: failures.length === 0, failures })
}
