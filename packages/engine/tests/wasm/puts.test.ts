// The WASM-under-Node leg of `fx-puts`'s idle-100 golden (docs/plan/13-sim-host-tick-loop.md step
// 3): the `.wasm` run's hash after 100 idle ticks (no actions -- Actions are M16, Non-scope) equals
// `golden/golden.json`, which `pnpm golden puts` writes from this very run (0002, 0020 §5) and which
// the native leg (`fixtures/puts/tests/puts_scenarios.rs`'s `puts_idle_100_golden`, driving
// `Sim<Puts>` directly) is compared against too -- so this and the native test prove `.wasm` matches
// native transitively, through the one shared golden file.
import { expect, test } from 'vitest'
import { Role } from '../../src/abi.js'
import { instantiate } from '../../src/loader.js'
import { loadFixture, readGolden } from '../support/fixtures.js'
import { type Golden, type HashScenario, runHashScenario } from '../support/scenario.js'

test('wasm_idle_100_matches_native', async () => {
  const scenario = readGolden<HashScenario>('puts', 'scenario.json')
  const golden = readGolden<Golden>('puts', 'golden.json')
  const { wasm } = await loadFixture('puts')
  const inst = instantiate(wasm, Role.Sim, scenario.config, { onLog() {} })

  const checkpoints = runHashScenario(inst, scenario)

  expect(checkpoints).toHaveLength(1)
  expect(checkpoints).toEqual(golden.checkpoints)
  // One growth at init, none after (0015 §5).
  expect(inst.memGrows()).toBe(0)
})
