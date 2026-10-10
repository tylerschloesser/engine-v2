// `checkSupport()` (M06b, Planning decisions "`checkSupport` minimum"):
// synchronous facts plus a module-worker probe, plus (M09 an async
// `requestAdapter()` probe for `no-adapter`. M35 made the list final: `limits-too-low` (a limit the
// renderer needs, named in `message`) and a `warnings` array (`no-opfs`, `no-web-locks`).
//
// Capability-screen contract: a game branches on `code`, never on `message`; `message` is developer
// English. A failure means the game cannot run; a warning means it runs with less (`no-opfs`: a
// world is `durable: false`, 0005 Storage; `no-web-locks`: no cross-tab world lock).
import { ADAPTER_REQUEST } from './render/device.js'

export type SupportFailureCode =
  | 'not-isolated'
  | 'no-sab'
  | 'no-wasm'
  | 'no-module-worker'
  | 'no-webgpu'
  | 'no-adapter'
  | 'limits-too-low'

export type SupportWarningCode = 'no-opfs' | 'no-web-locks'

export type SupportFailure = { code: SupportFailureCode; message: string }
export type SupportWarning = { code: SupportWarningCode; message: string }
export type SupportReport = {
  /** True when `failures` is empty; warnings never make it false. */
  ok: boolean
  failures: SupportFailure[]
  warnings: SupportWarning[]
}

/** The adapter limits the renderer relies on (0018 §7: it requests none above the defaults, so this
 * is checked against `adapter.limits`): the 4096 px atlas edge (`render/atlas.ts`'s `MAX_ATLAS_EDGE`)
 * and 0018 §4's 256 tile layers (`render/art.ts`). */
export const RENDERER_LIMITS = {
  maxTextureDimension2D: 4096,
  maxTextureArrayLayers: 256,
} as const

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
  const warnings: SupportWarning[] = []
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
    // `no-adapter` (M09, Scope: "fills in `checkSupport`'s
    // `no-adapter`"): the same `ADAPTER_REQUEST` `initDevice()` uses, so this reports exactly what a
    // real `initDevice()` call would hit.
    const adapter = await gpu.gpu.requestAdapter(ADAPTER_REQUEST)
    if (!adapter) {
      failures.push({
        code: 'no-adapter',
        message: 'navigator.gpu.requestAdapter() returned null: no compatible GPU adapter',
      })
    } else {
      for (const [name, need] of Object.entries(RENDERER_LIMITS)) {
        const have = (adapter.limits as unknown as Record<string, number | undefined>)[name]
        if (typeof have === 'number' && have < need) {
          failures.push({
            code: 'limits-too-low',
            message: `adapter limit ${name} is ${have}; the renderer needs at least ${need}`,
          })
        }
      }
    }
  }
  const nav = (typeof navigator === 'undefined' ? undefined : navigator) as
    | { storage?: { getDirectory?: unknown }; locks?: unknown }
    | undefined
  if (typeof nav?.storage?.getDirectory !== 'function') {
    warnings.push({
      code: 'no-opfs',
      message: 'navigator.storage.getDirectory is not available: a world will be durable: false',
    })
  }
  if (!nav?.locks) {
    warnings.push({
      code: 'no-web-locks',
      message: 'navigator.locks is not available: no cross-tab lock on a world',
    })
  }
  return { ok: failures.length === 0, failures, warnings }
}
