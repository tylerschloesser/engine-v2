// The Node leg of the worldgen determinism golden (docs/decisions/0020 §5). Native leg:
// `fixtures/worldgen/tests/scenario.rs`; Bun leg: `bun-leg.mjs`; browsers: `determinism.html`.
import { expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import { instantiate } from '../../src/loader.js'
import { loadFixture, readGolden } from '../support/fixtures.js'
import { type Golden, type HashScenario, roleOf, runHashScenario } from '../support/scenario.js'

test('determinism: worldgen node matches golden', async () => {
  const scenario = readGolden<HashScenario>('worldgen', 'scenario.json')
  const golden = readGolden<Golden>('worldgen', 'golden.json')
  const { wasm } = await loadFixture('worldgen')
  const inst = instantiate(wasm, roleOf(scenario), scenario.config, { onLog() {} })

  const checkpoints = runHashScenario(inst, scenario)

  expect(checkpoints.length).toBeGreaterThanOrEqual(1)
  expect(checkpoints).toEqual(golden.checkpoints)
  // One growth at init, none after (0015 §5).
  expect(inst.memGrows()).toBe(0)
})

test('gen: gen_chunk fills GenOut', async () => {
  const { wasm } = await loadFixture('worldgen')
  const inst = instantiate(
    wasm,
    Role.Gen,
    { arenaBytes: 1 << 20, game: { seed: '0x00c0ffee5eed1234', params: {} } },
    { onLog() {} },
  )
  const region = inst.region(RegionId.GenOut)
  if (!region) throw new Error('worldgen fixture has no GenOut region')
  expect(region.len).toBeGreaterThan(0)

  expect(inst.call2(inst.x.gen_chunk, 3, -5)).toBe(Status.Ok)
  const first = region.u8.slice()
  expect(first.some((b) => b !== 0)).toBe(true)

  // Repeating the same chunk gives the same bytes (0008 §1: a pure function of (seed, params,
  // chunk)).
  expect(inst.call2(inst.x.gen_chunk, 3, -5)).toBe(Status.Ok)
  expect(region.u8).toEqual(first)
})

test('gen: sim role returns WrongRole', async () => {
  const { wasm } = await loadFixture('hash')
  const inst = instantiate(
    wasm,
    Role.Sim,
    { arenaBytes: 1 << 20, game: { seed: '0x2a', entities: 1 } },
    { onLog() {} },
  )
  expect(inst.call2(inst.x.gen_chunk, 0, 0)).toBe(Status.WrongRole)
})
