// docs/plan/09-renderer-terrain.md, Tests added: "device.requests_compatibility_defaults" -- purely
// static, no GPU needed: `ADAPTER_REQUEST`/`DEVICE_REQUEST` are module-level constants (0018 §7).
import { expect, test } from 'vitest'
import { ADAPTER_REQUEST, DEVICE_REQUEST } from './device.js'

test('device: requests compatibility defaults', () => {
  expect(ADAPTER_REQUEST.featureLevel).toBe('compatibility')
  expect(DEVICE_REQUEST.requiredLimits).toBeUndefined()
  expect(DEVICE_REQUEST.requiredFeatures).toBeUndefined()
})
