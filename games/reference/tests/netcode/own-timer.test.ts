// ADR 0064 §2 (own timers stretch over `duration + lead`), found unwired on desktop Chrome on 2026-10-10:
// `Ui.collecting`/`Ui.crafting` came from the raw replica, so over a 300 ms link the collect bar started
// one round trip after the tap. They now come from the predicted player: the collect shows on the first
// frames after the dispatch, its `done_at` on the predicted clock (ahead of the host's).
import { expect, test } from 'vitest'
import landmarks from '../fixtures/landmarks.json' with { type: 'json' }
import { refHarness, startCollect, uiOf } from '../helpers/net.js'

const COLLECT_TICKS = 40 // `content::COLLECT`

test('reference_own_collect_shows_before_the_host_acks', async () => {
  const seed = 3490
  const r = await refHarness({ clients: 1, seed, conditions: { latencyMs: 300 } })
  try {
    const { h } = r
    const stone = landmarks.resources.stone
    h.clients[0]!.setCamera({ x: stone.x + 0.5, y: stone.y + 0.5, tilesAcross: 12 })
    await h.advanceTicks(20)
    // One collect to the end first: the lead estimator learns the round trip from its ack.
    startCollect(r, 0, stone)
    await h.advanceTicks(COLLECT_TICKS + 30)
    expect(uiOf(h, 0).collecting, 'the warm-up collect is over').toBeNull()
    const hostAtTap = h.hostTick()
    startCollect(r, 0, stone)
    // Two ticks: far less than the 600 ms (12-tick) round trip, so nothing from the host can be back.
    await h.advanceTicks(2)
    const c = uiOf(h, 0).collecting
    expect(c, 'the predicted collect is in Ui before any host frame could carry it').not.toBeNull()
    // Predicted = the replica's tick (6 behind the host) + lead (the 12-tick round trip), so the action
    // lands at or after the host's own tick at the tap; with no lead it would be 6 ticks before it.
    expect(c!.done_at - hostAtTap, 'done_at on the predicted clock').toBeGreaterThanOrEqual(
      COLLECT_TICKS,
    )
  } finally {
    await r.dispose()
  }
}, 30_000)
