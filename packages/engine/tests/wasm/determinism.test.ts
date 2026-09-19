// The Node leg of the cross-runtime golden (docs/decisions/0020 §5). Native leg:
// `fixtures/hash/tests/scenario.rs`; Bun leg: `bun-leg.mjs`; browsers: M03.
import { expect, test } from 'vitest'
import { Role } from '../../src/abi.js'
import { instantiate } from '../../src/loader.js'
import { loadFixture, readGolden } from '../support/fixtures.js'
import { type Golden, type HashScenario, runHashScenario } from '../support/scenario.js'

test('determinism: node matches golden', async () => {
  const scenario = readGolden<HashScenario>('hash', 'scenario.json')
  const golden = readGolden<Golden>('hash', 'golden.json')
  const { wasm } = await loadFixture('hash')
  const inst = instantiate(wasm, Role.Sim, scenario.config, { onLog() {} })

  const checkpoints = runHashScenario(inst, scenario)

  expect(checkpoints.length).toBeGreaterThanOrEqual(10)
  expect(checkpoints).toEqual(golden.checkpoints)
  // One growth at init, none after (0015 §5).
  expect(inst.memGrows()).toBe(0)
})
