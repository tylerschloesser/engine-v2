// `sabBytesTotal()` against `counters["sab.totalBytes"]` (M06,
// Budgets). Lives here, not beside sab/layout.ts, because `budgets.ts` cannot be imported from a
// file under src/ (tsc's rootDir for packages/engine/tsconfig.json is src/ itself).
import { expect, test } from 'vitest'
import { sabBytesTotal } from '../../src/sab/layout.js'
import { expectWithinBudget } from './budgets.js'

test('layout.sab_total_under_budget', () => {
  const total = sabBytesTotal()
  expect(total).toBeGreaterThan(0)
  expectWithinBudget('counters.sab.totalBytes', total)
})
