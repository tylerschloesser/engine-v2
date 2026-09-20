// docs/plan/06b-workers-and-spawn.md, Tests added: `arena.sum_rule`. A pure check (no `Worker`,
// `fetch` or cross-origin isolation needed): `checkArenaBudget` throws only when the chosen
// topology's arenas sum past `arenaBudgetBytes()` (0015 §5).
import { expect, test } from 'vitest'
import { arenaBudgetBytes, checkArenaBudget, EngineStartError, totalArenaBytes } from './client.js'

test('arena.sum_rule', () => {
  const budget = arenaBudgetBytes()
  expect(budget).toBeGreaterThan(0)

  // Defaults (0015 §5: sim 96 MiB, client 48 MiB, gen 4 MiB) with one gen worker, hosted locally:
  // well under the whole-tab budget.
  const defaults = { sim: 96 * 1024 * 1024, client: 48 * 1024 * 1024, gen: 4 * 1024 * 1024 }
  expect(() => checkArenaBudget(defaults, 'local', 1)).not.toThrow()
  expect(totalArenaBytes(defaults, 'local', 1)).toBe(defaults.sim + defaults.client + defaults.gen)

  // A remote topology never reserves a sim arena.
  expect(totalArenaBytes(defaults, 'remote', 1)).toBe(defaults.client + defaults.gen)
  expect(() => checkArenaBudget(defaults, 'remote', 2)).not.toThrow()

  // Over budget: rejected with the documented code, whatever pushes it over (a big single arena,
  // or enough gen workers).
  const over = { sim: budget, client: budget, gen: 1 }
  let error: unknown
  try {
    checkArenaBudget(over, 'local', 1)
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(EngineStartError)
  expect((error as EngineStartError).code).toBe('arena-config')

  const tinyGen = { sim: 0, client: 0, gen: Math.ceil(budget / 4) }
  expect(() => checkArenaBudget(tinyGen, 'remote', 4)).not.toThrow()
  expect(() => checkArenaBudget(tinyGen, 'remote', 5)).toThrow(EngineStartError)
})
