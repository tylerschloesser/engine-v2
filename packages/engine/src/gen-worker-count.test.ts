// docs/plan/08b-gen-workers-and-queue.md, Tests added: `genWorkerCount rule` (0008 §2).
import { expect, test } from 'vitest'
import { genWorkerCount } from './client.js'

test('genWorkerCount rule', () => {
  // Default: 1 below 8 logical cores, 2 at or above.
  expect(genWorkerCount(1)).toBe(1)
  expect(genWorkerCount(7)).toBe(1)
  expect(genWorkerCount(8)).toBe(2)
  expect(genWorkerCount(32)).toBe(2)

  // An explicit `requested` overrides hardwareConcurrency entirely.
  expect(genWorkerCount(32, 1)).toBe(1)
  expect(genWorkerCount(1, 2)).toBe(2)

  // Clamped to [1, MAX_GEN_WORKERS]: never 0, never more than the SabSet was sized for.
  expect(genWorkerCount(1, 0)).toBe(1)
  expect(genWorkerCount(1, -5)).toBe(1)
  expect(genWorkerCount(1, 5)).toBe(2)
})
