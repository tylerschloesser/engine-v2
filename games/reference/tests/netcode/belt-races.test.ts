// M51 (Tests added): two players place a belt on the same tile at once. The host hears the winner
// first (the loser's link is 100 ms slower, as `races.test.ts`); the loser's prediction shows its own
// belt until the host's `NotBuildable` arrives, then the winner's. At every client frame each client
// draws exactly one belt on the tile (never none, never two), and none is still predicted after
// its verdict: the torn-state check for a free placement, which has no inventory to watch.
import { expect, test } from 'vitest'
import { advanceProbed, PREDICTED, refHarness, tornStateProbe } from '../helpers/net.js'
import { FURNACE_A, type Tile } from '../helpers/script.js'

const LATENCY_MS = 60
const SLOWER_BY_MS = 100
/** `content::SPRITE_BELT_STRAIGHT` (east, south, north) and the despawner family. */
const SPRITE_BELT_STRAIGHT = 1
const SPRITE_BELT_DESPAWNER = 13
const isBelt = (id: number): boolean => id >= 1 && id <= 15

test.each([0, 1] as const)(
  'reference_belt_same_tile_race winner %i',
  async (winner) => {
    const loser = (1 - winner) as 0 | 1
    const seed = 5100 + winner
    const tag = `seed ${seed}, winner client ${winner}`
    const r = await refHarness({
      clients: 2,
      seed,
      conditions: { latencyMs: LATENCY_MS, jitterMs: 20 },
    })
    try {
      const { h } = r
      const at: Tile = FURNACE_A
      for (const d of r.drivers) await d.panTo({ x: at.x - 5, y: at.y })
      await h.settle()
      r.h.link(loser).set({ latencyMs: LATENCY_MS + SLOWER_BY_MS })

      // Per client: the belt sprites each frame (the only belt in the world is on `at`; a draw's `pos`
      // is relative to the window origin, so the tile is checked by row at the end), and when its own verdict arrived.
      const verdicts = new Map<number, unknown>()
      const verdictFrame = [null, null] as Array<number | null>
      const seqs: number[] = []
      const frames = [0, 0]
      let loserGhostFrames = 0
      const probes = [0, 1].map((i) =>
        tornStateProbe(h.clients[i]!, (_ui, draws) => {
          frames[i]!++
          const here = draws.filter((d) => d.kind === 0 && isBelt(d.spriteId))
          expect(here.length, `${tag}: client ${i} frame ${frames[i]}: one belt drawn`).toBe(1)
          if (
            i === loser &&
            here[0]!.spriteId === SPRITE_BELT_DESPAWNER + 2 &&
            (here[0]!.flags & PREDICTED) !== 0
          ) {
            loserGhostFrames++
          }
          const done = verdictFrame[i]
          if (done !== null && done !== undefined && frames[i]! > done + 1) {
            expect(
              here[0]!.flags & PREDICTED,
              `${tag}: client ${i} frame ${frames[i]}: no prediction after the verdict`,
            ).toBe(0)
          }
        }),
      )
      for (const i of [0, 1]) {
        h.clients[i]!.onActionResult((s, res) => {
          if (s !== seqs[i]) return
          verdicts.set(i, res)
          verdictFrame[i] = frames[i]!
        })
      }
      // The winner places a plain belt facing east, the loser a despawner facing north.
      seqs[winner] = h.clients[winner]!.dispatch({
        PlaceBelt: { at, dir: 'East', kind: 'Belt' },
      })
      seqs[loser] = h.clients[loser]!.dispatch({
        PlaceBelt: { at, dir: 'North', kind: 'Despawner' },
      })
      await advanceProbed(h, probes, Math.ceil((LATENCY_MS + SLOWER_BY_MS) / 50) * 2 + 8)

      expect(verdicts.get(winner), tag).toBe('Confirmed')
      expect(verdicts.get(loser), tag).toEqual({ Rejected: { Game: 'NotBuildable' } })
      // The loser predicted it (its own north despawner, dimmed) while waiting.
      // Exact on the virtual clock (both cases): the loser's ghost is on screen 7 frames of the 16 probed.
      expect(loserGhostFrames, `${tag}: the loser's ghost was on screen`).toBe(7)
      expect(frames[loser], tag).toBe(16)
      await h.settle()
      h.assertConverged()
      for (const i of [0, 1]) {
        const here = h.clients[i]!.draws().filter((d) => d.kind === 0 && isBelt(d.spriteId))
        expect(
          here.map((d) => [d.spriteId, d.flags & PREDICTED, d.pos[1]]),
          `${tag}: client ${i} sees the winner's east belt`,
        ).toEqual([[SPRITE_BELT_STRAIGHT, 0, at.y]])
      }
    } finally {
      await r.dispose()
    }
  },
  60_000,
)
