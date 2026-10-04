// `reference_bench_feature_identical @slow` (docs/plan/39f-device-auto-runner.md step 11, "decide by
// measurement"): does cargo feature `bench` leave a *normal* world (no `{ bench }` marker, so
// `RefParams.bench == 0`) bit-identical? If so the bench build (`vite build --mode bench`) can also be
// the reference game's check build (it carries `window.__check`) for `pnpm device:walk`, instead of a
// third build mode. Two legs, both against the release `+bench` module the phone would load:
//   1. the full-game golden (`games/reference/tests/golden/full-game.*`, recorded without the feature)
//      replays to the same hash at every checkpoint;
//   2. `gen_chunk` writes the same bytes for a spread of chunks (worldgen is pure, 0008 §1).
// Never combine with `reference_golden_replay` (the no-feature leg): that test is the control.
import { beforeAll, expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import type { BuildGameResult } from '../../src/build-game.js'
import { instantiate } from '../../src/loader.js'
import { loadGame } from '../../src/server-node.js'
import { seedToHexU64 } from '../../src/sim-config.js'
import { replayLog } from '../../src/test/replay.js'
import { buildBench } from '../support/bench-build.js'
import { gameCrateBuildDir } from '../support/fixtures.js'
import {
  divergenceMessage,
  firstDivergence,
  readFullGame,
  readWorldJson,
} from '../support/reference-golden.js'

let bench: BuildGameResult
// A real cargo build of the feature variant (cold on CI): bounded explicitly, like every such hook.
beforeAll(async () => {
  bench = await buildBench('release')
}, 240_000)

test('reference_bench_feature_identical: the golden replays to the same hashes on the bench module @slow', async () => {
  const { meta, frames } = readFullGame()
  const { wasm } = await loadGame(bench.dir)
  const got = await replayLog({
    wasm,
    params: { seed: meta.seed, worldgen: meta.worldgen },
    frames,
    checkpoints: meta.checkpoints.map((c) => c.tick),
  })
  expect(meta.checkpoints.length).toBeGreaterThan(10)
  expect(divergenceMessage(firstDivergence(got, meta.checkpoints))).toBeNull()
}, 120_000)

test('reference_bench_feature_identical: gen_chunk bytes equal the no-feature module for a spread of chunks @slow', async () => {
  const world = readWorldJson()
  const genBytes = async (dir: string): Promise<Uint8Array[]> => {
    const { wasm } = await loadGame(dir)
    const inst = instantiate(
      wasm,
      Role.Gen,
      { arenaBytes: 8 << 20, game: { seed: seedToHexU64(world.seed), params: world.worldgen } },
      { onLog() {} },
    )
    const region = inst.region(RegionId.GenOut)
    if (!region) throw new Error('the reference game has no GenOut region')
    const out: Uint8Array[] = []
    for (const [x, y] of [
      [0, 0],
      [-1, 0],
      [3, -5],
      [-12, 7],
      [40, 40],
      [-100, 63],
    ] as const) {
      expect(inst.call2(inst.x.gen_chunk, x, y)).toBe(Status.Ok)
      out.push(region.u8.slice())
    }
    return out
  }
  const plain = await genBytes(gameCrateBuildDir('reference'))
  const withBench = await genBytes(bench.dir)
  expect(plain.some((c) => c.some((b) => b !== 0))).toBe(true)
  expect(withBench).toEqual(plain)
}, 120_000)
