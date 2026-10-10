// `heavy-n1 all logs @slow` (M36; docs/decisions/0002 "Heavy
// mode", 0020 §5): `runHeavy` at N = 1 (snapshot and restore into a fresh instance after every
// tick, compare with the uninterrupted run) over every recorded log, as `.wasm` under Node: the
// `fx-persist` fixture log (also `heavy_wasm_n1`, in `replay-world.test.ts`), its ABI-parity log, and
// the reference game's `full-game.log`. Native twins: `slow_heavy_mode_fixture_n1` and
// `slow_heavy_full_game_n1`.
import { expect, test } from 'vitest'
import { loadGame } from '../../src/server-node.js'
import { runHeavy } from '../../src/test/replay.js'
import { gameCrateBuildDir, loadFixture } from '../support/fixtures.js'
import { frameLogStorage, LOG_WORLD_ID } from '../support/log-storage.js'
import { readFullGame } from '../support/reference-golden.js'
import { PERSIST_PARAMS, readPersistLog } from '../support/release-golden.js'

test('heavy-n1 all logs @slow', async () => {
  const persist = (await loadFixture('persist')).wasm
  const logs: {
    name: string
    wasm: WebAssembly.Module
    params: { seed: string; worldgen: unknown }
    frames: Uint8Array
  }[] = [
    {
      name: 'fx-persist fixture log',
      wasm: persist,
      params: PERSIST_PARAMS,
      frames: readPersistLog('persist_fixture_log'),
    },
    {
      name: 'fx-persist ABI parity log',
      wasm: persist,
      params: PERSIST_PARAMS,
      frames: readPersistLog('persist_abi_log_parity'),
    },
  ]
  const { meta, frames } = readFullGame()
  logs.push({
    name: 'reference full-game log',
    wasm: (await loadGame(gameCrateBuildDir('reference'))).wasm,
    params: { seed: meta.seed, worldgen: meta.worldgen },
    frames,
  })

  for (const log of logs) {
    expect(log.frames.length, `${log.name} is empty`).toBeGreaterThan(0)
    const storage = await frameLogStorage(log.wasm, log.params, log.frames)
    const result = await runHeavy({
      wasm: log.wasm,
      storage,
      worldId: LOG_WORLD_ID,
      everyN: 1,
    })
    expect(result.firstDivergentTick, `${log.name}: first divergent tick`).toBeNull()
  }
}, 600_000)
