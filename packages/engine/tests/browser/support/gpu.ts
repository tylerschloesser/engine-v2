// Every GPU test's own rule (docs/decisions/0020-testing-strategy.md §6): record `adapter.info` and
// fail -- never skip -- on a null adapter, and fail on any `uncapturederror`. `expectAdapter`'s name
// matters beyond this file: M10 finds every GPU test by grepping `expectAdapter|readback`
// (docs/plan/09-renderer-terrain.md Consumes).
import { expect, type TestInfo } from '@playwright/test'

export type AdapterInfo = {
  vendor: string
  architecture: string
  device: string
  description: string
  isFallbackAdapter: boolean | null
}

/** Records `info` as a `adapter.info` annotation (so it shows up in the JSON report even on a pass)
 * and fails the test, never skips it, when `info` is `null`. */
export function expectAdapter(testInfo: TestInfo, info: AdapterInfo | null): void {
  testInfo.annotations.push({ type: 'adapter.info', description: JSON.stringify(info) })
  expect(info, 'requestAdapter() returned null').not.toBeNull()
}

/** `errors` is `RendererDevice.errors()` read back from the page: every `uncapturederror` message
 * seen since the device was created. */
export function expectNoGpuErrors(errors: readonly string[]): void {
  expect(errors, 'uncapturederror (0020 §6)').toEqual([])
}
