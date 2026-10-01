import { expect, test } from 'vitest'
import { decide, fingerprint, TOLERANCE } from './bench-gate.mjs'

const fp = { cpu: 'Apple M3 Max', arch: 'arm64' }
const baseline = {
  fingerprint: fp,
  gated: ['medianMs'],
  limits: { medianMs: 3 },
  metrics: { medianMs: 2, p99Ms: 4 },
}

test('bench-gate: threshold and fingerprint', () => {
  expect(TOLERANCE).toBe(0.25)
  expect(fingerprint()).toEqual({ cpu: expect.any(String), arch: expect.any(String) })
  const run = (sample, over = {}) => decide({ baseline, sample, fp, ...over })
  // Same machine: 30 % over fails the gated metric, 20 % over does not, an ungated one only warns.
  expect(run({ medianMs: 2.6 }).failures).toHaveLength(1)
  expect(run({ medianMs: 2.4 }).failures).toEqual([])
  expect(run({ medianMs: 2, p99Ms: 6 })).toMatchObject({
    failures: [],
    warnings: [expect.any(String)],
  })
  // 0047: an absolute floor (`minDeltaMs`) must be cleared as well as the 25 %.
  expect(
    decide({ baseline: { ...baseline, minDeltaMs: 1 }, sample: { medianMs: 2.6 }, fp }).failures,
  ).toEqual([])
  // The absolute proxy fails even inside 25 % of a baseline already over it.
  expect(
    decide({ baseline: { ...baseline, metrics: { medianMs: 2.9 } }, sample: { medianMs: 3.2 }, fp })
      .failures,
  ).toHaveLength(1)
  // warn-only turns the failure into a warning.
  expect(run({ medianMs: 2.6 }, { warnOnly: true })).toMatchObject({
    failures: [],
    warnings: [expect.any(String)],
  })
  // Another machine (cpu or arch): recorded, never failing, however slow.
  for (const other of [
    { ...fp, cpu: 'GitHub runner' },
    { ...fp, arch: 'x64' },
  ]) {
    expect(run({ medianMs: 20 }, { fp: other })).toEqual({
      matched: false,
      failures: [],
      warnings: [],
    })
  }
  // No baseline yet: records only.
  expect(decide({ baseline: null, sample: { medianMs: 99 }, fp }).failures).toEqual([])
})
