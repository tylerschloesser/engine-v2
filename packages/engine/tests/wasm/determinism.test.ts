// The Node leg of the cross-runtime goldens (docs/decisions/0020 §5): `fx-hash`'s scenario with its
// own extra checks, then every other fixture's `golden/scenario*.json`, discovered (M42b). Native
// legs: each fixture's own golden tests (`fixtures/hash/tests/scenario.rs`, `fixtures/belts/tests/
// golden_scenarios.rs`, ...); Bun leg: `bun-leg.mjs` (`runScenarioLegs`); browsers: M03.
import { expect, test } from 'vitest'
import { Role } from '../../src/abi.js'
import { instantiate } from '../../src/loader.js'
import { goldenScenarios, loadFixture, readGolden } from '../support/fixtures.js'
import {
  diffCheckpoints,
  type Golden,
  type HashScenario,
  REPLAYED_BY_NAME,
  runGoldenScenario,
  runHashScenario,
} from '../support/scenario.js'

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

// M42b: every fixture's `golden/scenario*.json` (discovered, like `pnpm golden`), replayed from the
// `.wasm` under Node against its `golden*.json`, one test per (fixture, scenario). `pnpm golden`
// writes these hashes on this same path, so a red here is a sim that changed since. Pairs a named
// test already replays under Node are skipped (`REPLAYED_BY_NAME.node`, `scenario.ts`).
const modules = new Map<string, Promise<{ wasm: WebAssembly.Module }>>()
for (const { fixture, scenario, golden } of goldenScenarios()) {
  if (REPLAYED_BY_NAME.node.has(`${fixture}/${scenario}`)) continue
  test(`determinism: node matches golden ${fixture}/${scenario}`, async () => {
    if (!modules.has(fixture)) modules.set(fixture, loadFixture(fixture))
    const { wasm } = await (modules.get(fixture) as Promise<{ wasm: WebAssembly.Module }>)
    const sc = readGolden<HashScenario>(fixture, scenario)
    const want = readGolden<Golden>(fixture, golden)
    const message = diffCheckpoints(runGoldenScenario(instantiate, wasm, sc), want.checkpoints)
    if (message !== null) throw new Error(`${fixture}/${golden}: ${message}`)
  })
}
