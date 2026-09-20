// docs/plan/06b-workers-and-spawn.md, Tests added: `support.report_shape`.
import { expect, test } from 'vitest'
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
  const codes = report.failures.map((f) => f.code).sort()
  expect(codes).toEqual(['no-module-worker', 'no-webgpu', 'not-isolated'].sort())
})
