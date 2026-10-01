// docs/plan/06b-workers-and-spawn.md, Tests added: `support.report_shape`.
import { afterEach, expect, test, vi } from 'vitest'
import { checkSupport } from './support.js'

test('support.report_shape', async () => {
  const report = await checkSupport()
  expect(typeof report.ok).toBe('boolean')
  expect(Array.isArray(report.failures)).toBe(true)
  expect(report.ok).toBe(report.failures.length === 0)
  for (const failure of report.failures) {
    expect(typeof failure.code).toBe('string')
    expect(typeof failure.message).toBe('string')
    expect(failure.message.length).toBeGreaterThan(0)
  }
  // Under Node (`WebAssembly`/`SharedArrayBuffer` are real globals; `Worker`/`navigator.gpu` and
  // `crossOriginIsolated` are not): a stable, known-wrong-for-Node shape.
  const found = report.failures.map((f) => f.code).sort()
  expect(found).toEqual(['no-module-worker', 'no-webgpu', 'not-isolated'].sort())
})

afterEach(() => vi.unstubAllGlobals())

const codes = (r: { failures: { code: string }[] }) => r.failures.map((f) => f.code)

/** A browser-shaped environment where every probe passes; each test below breaks one global. */
function healthy(over: { adapter?: unknown; navigator?: Record<string, unknown> } = {}): void {
  vi.stubGlobal('crossOriginIsolated', true)
  vi.stubGlobal(
    'Worker',
    class {
      terminate(): void {}
    },
  )
  const adapter =
    over.adapter === undefined
      ? { limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256 } }
      : over.adapter
  vi.stubGlobal('navigator', {
    gpu: { requestAdapter: async () => adapter },
    storage: { getDirectory: () => {} },
    locks: {},
    ...over.navigator,
  })
}

test('checkSupport: ok on a healthy environment, no warnings', async () => {
  healthy()
  expect(await checkSupport()).toEqual({ ok: true, failures: [], warnings: [] })
})

test('checkSupport: not-isolated', async () => {
  healthy()
  vi.stubGlobal('crossOriginIsolated', false)
  expect(codes(await checkSupport())).toEqual(['not-isolated'])
})

test('checkSupport: no-sab', async () => {
  healthy()
  vi.stubGlobal('SharedArrayBuffer', undefined)
  expect(codes(await checkSupport())).toEqual(['no-sab'])
})

test('checkSupport: no-wasm', async () => {
  healthy()
  vi.stubGlobal('WebAssembly', undefined)
  expect(codes(await checkSupport())).toEqual(['no-wasm'])
})

test('checkSupport: no-module-worker (a Worker that throws on type module)', async () => {
  healthy()
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new TypeError('module workers unsupported')
      }
    },
  )
  expect(codes(await checkSupport())).toEqual(['no-module-worker'])
})

test('checkSupport: no-webgpu', async () => {
  healthy({ navigator: { gpu: undefined } })
  expect(codes(await checkSupport())).toEqual(['no-webgpu'])
})

test('checkSupport: no-adapter', async () => {
  healthy({ adapter: null })
  expect(codes(await checkSupport())).toEqual(['no-adapter'])
})

test('checkSupport: limits-too-low names the limit', async () => {
  healthy({ adapter: { limits: { maxTextureDimension2D: 2048, maxTextureArrayLayers: 256 } } })
  const report = await checkSupport()
  expect(codes(report)).toEqual(['limits-too-low'])
  expect(report.failures[0]?.message).toContain('maxTextureDimension2D')
  expect(report.ok).toBe(false)
})

test('checkSupport: warnings no-opfs and no-web-locks leave ok true', async () => {
  healthy({ navigator: { storage: undefined, locks: undefined } })
  const report = await checkSupport()
  expect(report.ok).toBe(true)
  expect(report.warnings.map((w) => w.code)).toEqual(['no-opfs', 'no-web-locks'])
})
