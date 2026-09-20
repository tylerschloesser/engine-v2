import { expect, test } from 'vitest'
import { budget, expectWithinBudget, gcPage, gcPageIds } from './budgets.ts'

test('budgets: every gc page lists main', () => {
  const ids = gcPageIds()
  expect(ids.length).toBeGreaterThan(0)
  for (const id of ids) {
    expect(gcPage(id).isolates, `${id} isolates`).toHaveProperty('main')
  }
})

test('budgets: budget() resolves a dotted path, gcPage() throws naming a missing page', () => {
  expect(budget('version')).toBe(1)
  expect(() => gcPage('does-not-exist')).toThrow(/does-not-exist/)
  expect(() => budget('gc.pages')).toThrow() // not a number
})

test('budgets: expectWithinBudget throws only when the budget is exceeded', () => {
  expect(() => expectWithinBudget('version', 1)).not.toThrow()
  expect(() => expectWithinBudget('version', 2)).toThrow(/exceeds budget/)
})
