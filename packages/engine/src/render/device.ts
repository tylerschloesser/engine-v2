// Device init (docs/decisions/0018-renderer.md §1, §7; docs/plan/09-renderer-terrain.md Scope):
// adapter + device requests, the `GPUTexture`-as-view startup probe (0018 §1), and
// `uncapturederror`/`getCompilationInfo()` surfaced as errors instead of silent GPU validation
// failures (docs/decisions/0020-testing-strategy.md §6: "every browser test also fails on
// `uncapturederror`... or a non-empty `getCompilationInfo()`").
//
// `ADAPTER_REQUEST`/`DEVICE_REQUEST` are module-level constants, built once and never per call
// (`device.requests_compatibility_defaults` asserts their exact shape). Compatibility mode's
// `featureLevel` is a `requestAdapter()` option, not `requestDevice()`'s (checked against
// https://webgpufundamentals.org/webgpu/lessons/webgpu-compatibility-mode.html, 2026-09-20; 0018
// §7's prose does not say which call it belongs to). `DEVICE_REQUEST` stays empty: never request
// above-default limits or optional features (0018 §7's "never request above-default limits without
// checking `adapter.limits`" -- this milestone needs none).
export const ADAPTER_REQUEST: GPURequestAdapterOptions = { featureLevel: 'compatibility' }
export const DEVICE_REQUEST: GPUDeviceDescriptor = {}

export type AdapterInfo = {
  vendor: string
  architecture: string
  device: string
  description: string
  isFallbackAdapter: boolean | null
}

/** `checkSupport()`'s `no-adapter` failure (docs/plan/06b-workers-and-spawn.md, `support.ts`'s own
 * "filled in by M09" note) and `initDevice`'s own rejection both throw this. */
export class NoAdapterError extends Error {
  constructor(reason: string) {
    super(`navigator.gpu.requestAdapter() ${reason}: see checkSupport() for what to fix`)
    this.name = 'NoAdapterError'
  }
}

export class ShaderCompilationError extends Error {
  constructor(label: string, messages: readonly GPUCompilationMessage[]) {
    super(
      `shader '${label}': getCompilationInfo() is non-empty:\n` +
        messages.map((m) => `  ${m.type} ${m.lineNum}:${m.linePos}: ${m.message}`).join('\n'),
    )
    this.name = 'ShaderCompilationError'
  }
}

export interface RendererDevice {
  readonly device: GPUDevice
  readonly adapterInfo: AdapterInfo
  /** 0018 §1: `true` once this device accepted a bare `GPUTexture` as a render-pass attachment
   * `view` with no `uncapturederror` (Chrome 140+); `false` when `createView()` is still required.
   * The probe runs inside a `pushErrorScope`, so it never appears in `errors()`. */
  readonly viewProbePasses: boolean
  /** `true` once this device accepts a `SharedArrayBuffer`-backed view as `writeTexture`'s `data`
   * with no `uncapturederror` (Planning decisions "`writeTexture` from a SAB view is unverified");
   * `render/upload.ts` reads this to pick its CHUNK-record fast path or fallback. */
  readonly sabWriteTextureOk: boolean
  /** Every `uncapturederror` message seen since this device was created, in order. Every GPU test
   * asserts this is empty (0020 §6). */
  errors(): string[]
  /** Throws `ShaderCompilationError` if `module.getCompilationInfo()` is non-empty. */
  checkCompilation(label: string, module: GPUShaderModule): Promise<void>
}

function adapterInfoOf(adapter: GPUAdapter): AdapterInfo {
  const info = adapter.info
  return {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    isFallbackAdapter: (info as { isFallbackAdapter?: boolean }).isFallbackAdapter ?? null,
  }
}

/** 0018 §1: inside a validation error scope, encode and submit one render pass whose colour
 * attachment `view` is a bare `GPUTexture` (no `createView()`); `true` iff `popErrorScope()` reports
 * nothing. Runs once at startup, never per frame. */
async function probeViewAsAttachment(device: GPUDevice): Promise<boolean> {
  device.pushErrorScope('validation')
  const probeTex = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  })
  try {
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          // The probe itself: a `GPUTexture`, not a `GPUTextureView` (0018 §1).
          view: probeTex as unknown as GPUTextureView,
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    })
    pass.end()
    device.queue.submit([encoder.finish()])
  } finally {
    probeTex.destroy()
  }
  const error = await device.popErrorScope()
  return error === null
}

/** docs/plan/09-renderer-terrain.md, Planning decisions "`writeTexture` from a SAB view is
 * unverified": inside a validation error scope, `writeTexture` a throwaway `rg16uint` 1x1 texture
 * from a `Uint16Array` view backed by a `SharedArrayBuffer`; `true` iff `popErrorScope()` reports
 * nothing. Runs once at startup, never per frame -- `render/upload.ts` reads the result to choose
 * its CHUNK-record fast path (direct from the ring's own SAB-backed view) or fallback (copy into a
 * preallocated non-shared staging array first); either way it allocates nothing per record. `false`
 * (not `SharedArrayBuffer` unavailable) when the global itself is missing, so a non-isolated
 * caller never throws here. */
async function probeWriteTextureFromSharedView(device: GPUDevice): Promise<boolean> {
  if (typeof SharedArrayBuffer === 'undefined') return false
  device.pushErrorScope('validation')
  const probeTex = device.createTexture({
    size: [1, 1],
    format: 'rg16uint',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  try {
    const sab = new SharedArrayBuffer(4)
    const view = new Uint16Array(sab)
    device.queue.writeTexture(
      { texture: probeTex },
      view,
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    )
  } finally {
    probeTex.destroy()
  }
  const error = await device.popErrorScope()
  return error === null
}

/**
 * Requests an adapter and device (rejects with `NoAdapterError` on a null adapter or missing
 * `navigator.gpu`), wires `uncapturederror` into `errors()`, and runs the `GPUTexture`-as-view probe
 * once. `opts.test.forceViewProbe` (test-only: `device.view_probe_both_paths`) skips the real probe
 * and reports the forced value instead, so both code paths run against one real device.
 */
export async function initDevice(opts?: {
  test?: { forceViewProbe?: boolean }
}): Promise<RendererDevice> {
  const gpu = (globalThis.navigator as { gpu?: GPU } | undefined)?.gpu
  if (!gpu) throw new NoAdapterError('is unavailable: navigator.gpu is not present')
  const adapter = await gpu.requestAdapter(ADAPTER_REQUEST)
  if (!adapter) throw new NoAdapterError('returned null')
  const device = await adapter.requestDevice(DEVICE_REQUEST)
  const errors: string[] = []
  device.addEventListener('uncapturederror', (ev) => {
    errors.push((ev as GPUUncapturedErrorEvent).error.message)
  })
  const viewProbePasses =
    opts?.test?.forceViewProbe !== undefined
      ? opts.test.forceViewProbe
      : await probeViewAsAttachment(device)
  const sabWriteTextureOk = await probeWriteTextureFromSharedView(device)
  return {
    device,
    adapterInfo: adapterInfoOf(adapter),
    viewProbePasses,
    sabWriteTextureOk,
    errors: () => errors.slice(),
    async checkCompilation(label, module) {
      const info = await module.getCompilationInfo()
      if (info.messages.length > 0) throw new ShaderCompilationError(label, info.messages)
    },
  }
}
