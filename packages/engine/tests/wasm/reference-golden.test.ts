// `reference_golden_replay` (M34b Tests added): the
// full-game golden log of the reference game (`games/reference/tests/golden/full-game.log`, recorded
// by `pnpm --filter reference golden:record`) replayed as `.wasm` under Node; every checkpoint hash
// must match, and a mismatch names the first divergent tick. Native leg: `reference-sim`'s
// `golden_replay`; Bun leg: `bun-leg.mjs`; browsers: `determinism.html`. Also asserts
// `logBytesPerPlayerHour` (PRE-PLAN.md section 7, "Action rate / log").
import { expect, test } from 'vitest'
import { loadGame } from '../../src/server-node.js'
import { replayLog } from '../../src/test/replay.js'
import { budget } from '../support/budgets.js'
import { gameCrateBuildDir } from '../support/fixtures.js'
import {
  type Checkpoint,
  divergenceMessage,
  firstDivergence,
  logBytesPerPlayerHour,
  readFullGame,
  readWorldJson,
} from '../support/reference-golden.js'

async function replayGolden(want: Checkpoint[], frames: Uint8Array): Promise<Checkpoint[]> {
  const { meta } = readFullGame()
  const { wasm } = await loadGame(gameCrateBuildDir('reference'))
  return replayLog({
    wasm,
    params: { seed: meta.seed, worldgen: meta.worldgen },
    frames,
    checkpoints: want.map((c) => c.tick),
  })
}

test('reference_golden_replay', async () => {
  const { meta, frames } = readFullGame()
  // The golden is the declared world's (`world.json`), not some other seed's.
  expect({ seed: meta.seed, worldgen: meta.worldgen }).toEqual(readWorldJson())
  expect(meta.checkpoints.length).toBeGreaterThan(10)

  const got = await replayGolden(meta.checkpoints, frames)
  expect(divergenceMessage(firstDivergence(got, meta.checkpoints))).toBeNull()

  // Action rate / log: the script's log bytes over its scripted player-ticks, scaled to one hour.
  const perHour = logBytesPerPlayerHour(frames.length, meta.players, meta.ticks)
  expect(perHour, 'log bytes per active player-hour').toBeLessThanOrEqual(
    budget('counters.action.logBytesPerPlayerHour.ceiling'),
  )
})

test('reference_golden_replay reports the first divergent tick', async () => {
  const { meta, frames } = readFullGame()
  const got = await replayGolden(meta.checkpoints, frames)
  // One expected hash moved: the report names that checkpoint's tick, not a later one.
  const k = Math.floor(meta.checkpoints.length / 2)
  const moved = meta.checkpoints.map((c, i) => (i >= k ? { ...c, hash: 'f'.repeat(16) } : c))
  const d = firstDivergence(got, moved)
  expect(d?.tick).toBe(meta.checkpoints[k]?.tick)
  expect(divergenceMessage(d)).toContain(`first divergent tick ${meta.checkpoints[k]?.tick}`)
})
