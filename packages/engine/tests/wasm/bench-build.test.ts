// `bench-build @slow` (docs/plan/36-slow-tier-and-benchmarks.md step 3): the reference game's `bench`
// feature, built through `buildGame({ features: ['bench'] })`. A separate directory and build hash;
// a shipped build ignores the marker (the same world with or without `{ bench }`); the bench build
// reaches `genesis` through the worldgen marker, builds the save at 1/8 scale inside the default
// arena (the full save needs ~1 GiB at genesis today: the change log, see M36 Deviations), is
// deterministic across instances and carries no `test-hooks`. Native counts: `large_save.rs`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { Role } from '../../src/abi.js'
import type { BuildGameResult, GameJson } from '../../src/build-game.js'
import { instantiate } from '../../src/loader.js'
import { wrapEngineInstance } from '../../src/server.js'
import { loadGame } from '../../src/server-node.js'
import { buildSimInstanceConfig, type WorldConfig } from '../../src/sim-config.js'
import { benchWorldConfig, buildBench } from '../support/bench-build.js'
import { gameCrateBuildDir } from '../support/fixtures.js'

let bench: BuildGameResult
// A real cargo build of the feature variant (cold on CI): bounded explicitly, like every such hook.
beforeAll(async () => {
  bench = await buildBench('dev')
}, 240_000)

const json = (dir: string) => JSON.parse(readFileSync(join(dir, 'game.json'), 'utf8')) as GameJson

async function worldHash(dir: string, cfg: WorldConfig, ticks: number): Promise<string> {
  const { wasm } = await loadGame(dir)
  const inst = instantiate(wasm, Role.Sim, buildSimInstanceConfig(cfg), { onLog() {} })
  expect(inst.call0(inst.x.sim_genesis)).toBe(0)
  for (let i = 0; i < ticks; i++) expect(inst.call0(inst.x.sim_tick)).toBe(0)
  expect(inst.memGrows(), 'the save fits the arena').toBe(0)
  return wrapEngineInstance(inst).simHash()
}

test('bench-build @slow', async () => {
  const plain = gameCrateBuildDir('reference')
  expect(bench.dir).not.toBe(plain)
  expect(bench.dir.endsWith('dev+bench')).toBe(true)
  expect(json(bench.dir).features).toEqual(['bench'])
  expect(bench.buildHash).not.toBe(json(plain).buildHash)
  expect(readFileSync(bench.wasmPath).includes('test-hooks: poison')).toBe(false)

  // The marker builds the save: same world twice, same hash, after genesis and after 120 ticks
  // (every furnace has completed a smelt by then); another scale is another world.
  const cfg = benchWorldConfig(bench.buildHash, 8)
  const a0 = await worldHash(bench.dir, cfg, 0)
  expect(await worldHash(bench.dir, cfg, 0)).toBe(a0)
  const a120 = await worldHash(bench.dir, cfg, 120)
  expect(a120).not.toBe(a0)
  expect(await worldHash(bench.dir, cfg, 120)).toBe(a120)
  expect(await worldHash(bench.dir, benchWorldConfig(bench.buildHash, 16), 0)).not.toBe(a0)

  // A shipped build has no marker field: the same world with and without it hashes equal.
  const shipped = json(plain).buildHash
  const withMarker = await worldHash(plain, benchWorldConfig(shipped, 8), 0)
  const without = await worldHash(
    plain,
    {
      ...benchWorldConfig(shipped, 8),
      params: { ...benchWorldConfig(shipped, 8).params, worldgen: {} },
    },
    0,
  )
  expect(withMarker).toBe(without)
}, 120_000)
