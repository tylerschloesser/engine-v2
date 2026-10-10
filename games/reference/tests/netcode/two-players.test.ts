// M34c step 1 (M34c: the whole reference game with two
// headless players on the netcode harness, over a conditioned link (60 ms latency, 20 ms jitter).
import { test } from 'vitest'
import { refHarness } from '../helpers/net.js'
import { playTwoPlayerGame } from '../helpers/two-player.js'

test('reference_full_game_two_players', async () => {
  const seed = 3410
  const r = await refHarness({ clients: 2, seed, conditions: { latencyMs: 60, jitterMs: 20 } })
  try {
    await playTwoPlayerGame(r, seed)
  } finally {
    await r.dispose()
  }
}, 30_000)

// Once over real loopback sockets (`transport: 'ws'`): the conditioner wraps them the same way.
// `@slow` (M36b step 2, 0020 §4 rung 2: a real-socket repeat of the in-memory test above; 0.87 s p95).
test('reference_full_game_two_players_ws @slow', async () => {
  const seed = 3411
  const r = await refHarness({
    clients: 2,
    seed,
    transport: 'ws',
    conditions: { latencyMs: 60, jitterMs: 20 },
  })
  try {
    await playTwoPlayerGame(r, seed)
  } finally {
    await r.dispose()
  }
}, 60_000)
