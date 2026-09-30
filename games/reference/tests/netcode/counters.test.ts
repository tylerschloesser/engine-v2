// M34c step 5 (docs/plan/34c-reference-scripted-multiplayer.md Scope, "Counters"): what the two-player
// full game costs each client on the wire, against `budgets.json`.
import { assertBudget } from 'engine/test'
import { expect, test } from 'vitest'
import { budget } from '../../../../packages/engine/tests/support/budgets.js'
import { refHarness } from '../helpers/net.js'
import { playTwoPlayerGame } from '../helpers/two-player.js'

const TICKS_PER_HOUR = 20 * 3600

test('reference_bytes_and_mispredictions_in_budget', async () => {
  const seed = 3480
  // Production hash cadence: hash-all is a dev and test mode and exempt (`budgets.json`'s
  // `hashesBytesPerS` row); this measures what a player pays.
  const r = await refHarness({
    clients: 2,
    seed,
    conditions: { latencyMs: 60, jitterMs: 20 },
    hashAll: false,
  })
  try {
    const { h } = r
    const refused: unknown[][] = [[], []]
    h.clients.forEach((c, i) => {
      c.onActionResult((_s, res) => {
        if (res !== 'NotPredictable' && res !== 'Confirmed') refused[i]!.push(res)
      })
    })
    await playTwoPlayerGame(r, seed)
    const ticks = h.hostTick()
    // The hard ceiling (0010: soft cap 16 KB/s + 48 KB/s chunk refill) in bytes per second, and per
    // tick at 20 Hz.
    const perSecond = budget('counters.net.hardCeilingBytesPerS.ceiling')
    for (const i of [0, 1]) {
      const c = h.counters(i)
      const tag = `seed ${seed}, client ${i}`
      expect(
        Math.max(...c.perTick.map((t) => t.bytesDown)),
        `${tag}: bytes down in one tick`,
      ).toBeLessThanOrEqual(perSecond / 20)
      expect(c.worstSecondBytesDown, `${tag}: worst second`).toBeLessThanOrEqual(perSecond)
      expect(c.rateLimited, `${tag}: no action was rate limited`).toBe(0)
      // A misprediction is a verdict the host refused: none in a play without races.
      expect(refused[i], `${tag}: mispredictions`).toEqual([])
    }
    // One hour of play at this rate (PRE-PLAN section 7: 10 to 20 MB per hour, owner 0010); the
    // busier client's downlink, scaled from the ticks the game took.
    const worst = Math.max(...[0, 1].map((i) => h.counters(i).bytesDown))
    const perHour = Math.round((worst / ticks) * TICKS_PER_HOUR)
    assertBudget({ bytesDownPerHour: perHour }, 'net.bytesPerHour')
  } finally {
    await r.dispose()
  }
}, 30_000)
