// Slow-tier benchmark (docs/decisions/0008-chunk-generation.md §6; Planning decisions 6 of
// docs/plan/08-worldgen-and-gen-worker.md): `fx-worldgen` on the release profile, the warm-up +
// timed loop of `tests/support/bench-worldgen.ts` in a `gen`-role instance under Node, median
// ms/chunk printed, the same golden `worldgen-bench.html` checks, and a runner `warn` line (never
// a failure) above `worldgenMsPerChunkWarn`. `pnpm test:slow wasm -t worldgen-bench`.
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { RegionId, Role } from '../../src/abi.js'
import { buildGame } from '../../src/build-game.js'
import type { InstanceConfig } from '../../src/loader.js'
import { instantiate } from '../../src/loader.js'
import { loadGame } from '../../src/server-node.js'
import { runWorldgenBench } from '../support/bench-worldgen.js'
import { budget } from '../support/budgets.js'
import { fixtureDir } from '../support/fixtures.js'

type BenchGolden = { config: InstanceConfig; hash: string }

test('worldgen-bench @slow', async () => {
  const golden = JSON.parse(
    readFileSync(`${fixtureDir('worldgen')}/golden/bench.json`, 'utf8'),
  ) as BenchGolden

  const built = await buildGame({ crate: fixtureDir('worldgen'), profile: 'release' })
  const { wasm } = await loadGame(built.dir)
  const inst = instantiate(wasm, Role.Gen, golden.config, { onLog() {} })
  const region = inst.region(RegionId.GenOut)
  if (!region) throw new Error('worldgen fixture has no GenOut region')

  const { medianMs, hash } = runWorldgenBench(inst, region, () => performance.now())
  console.log(`worldgen-bench: median ${medianMs.toFixed(4)} ms/chunk (release, Node)`)

  expect(hash).toBe(golden.hash)

  const warnAt = budget('worldgenMsPerChunkWarn')
  if (medianMs > warnAt) {
    console.warn(
      `warn: worldgen-bench median ${medianMs.toFixed(4)} ms/chunk exceeds ${warnAt} ms/chunk (0008 §6)`,
    )
  }
}, 120_000)
