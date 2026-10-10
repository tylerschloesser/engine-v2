// M34c step 2 (docs/plan/34c-reference-scripted-multiplayer.md Scope, "Races"): the three rejection
// races `0003` Consequences leaves to scripted tests, each at 0, 60 and 250 ms one-way latency and in
// both arrival orders. The order is made by the virtual clock, not by sleeping: the player who should
// lose gets a link 100 ms slower, so the host hears the other one first (swap the two links and the
// winner swaps).
import { expect, test } from 'vitest'
import {
  advanceProbed,
  PREDICTED,
  type RefHarness,
  refHarness,
  startCollect,
  tornStateProbe,
  uiOf,
} from '../helpers/net.js'
import { FURNACE_A, LANDMARKS, runScript, script, type Tile } from '../helpers/script.js'

const standBy = (o: Tile): Tile => ({ x: o.x - 5, y: o.y })
const LATENCIES = [0, 60, 250] as const
/** Jitter of the default conditions (20 ms), kept below a third of the latency. */
const jitterFor = (latencyMs: number): number => Math.min(20, Math.floor(latencyMs / 3))
const SLOWER_BY_MS = 100
const FURNACE = 4

/** Gives player `loser` a link `SLOWER_BY_MS` slower than the other's. */
function slowDown(r: RefHarness, loser: 0 | 1, latencyMs: number): void {
  r.h.link(loser).set({ latencyMs: latencyMs + SLOWER_BY_MS })
}

/** Both players mine five stone and craft a furnace, one after the other (10 units on the tile). */
async function bothCraftAFurnace(r: RefHarness): Promise<void> {
  const [a, b] = r.drivers as [(typeof r.drivers)[0], (typeof r.drivers)[0]]
  for (const d of [a, b]) {
    await runScript(script().collect('stone', 5).craft(0), d)
  }
}

// One test per (latency, arrival order) pair (M36b step 4b): the body is the former double loop's,
// unchanged; ids were `reference_race_same_spot`, now `reference_race_same_spot <ms> ms, winner <n>`.
test.each(LATENCIES.flatMap((l) => ([0, 1] as const).map((w) => [l, w] as const)))(
  'reference_race_same_spot %i ms, winner %i',
  async (latency, winner) => {
    {
      const loser = (1 - winner) as 0 | 1
      const seed = 3420 + latency + winner
      const tag = `seed ${seed}, ${latency} ms, winner client ${winner}`
      const r = await refHarness({
        clients: 2,
        seed,
        conditions: { latencyMs: latency, jitterMs: jitterFor(latency) },
      })
      try {
        const { h } = r
        await bothCraftAFurnace(r)
        // Overlapping footprints: (-4,1) covers rows 1-2, (-4,2) rows 2-3.
        const origins: [Tile, Tile] = [FURNACE_A, { x: FURNACE_A.x, y: FURNACE_A.y + 1 }]
        for (const d of r.drivers) await d.panTo(standBy(FURNACE_A))
        await h.settle()
        slowDown(r, loser, latency)
        const probes = [0, 1].map((i) => tornStateProbe(h.clients[i]!))
        const all: Array<[number, unknown]> = []
        for (const i of [0, 1]) h.clients[i]!.onActionResult((s, res) => all.push([i, res]))
        const seqs = [0, 1].map((i) => {
          const s = h.clients[i]!.dispatch({ PlaceFurnace: { origin: origins[i]! } })
          probes[i]!.trackPlace(s)
          return s
        })
        await advanceProbed(h, probes, Math.ceil((latency + SLOWER_BY_MS) / 50) * 2 + 8)

        const wSeq = seqs[winner]!
        const lSeq = seqs[loser]!
        expect(probes[winner]!.verdicts.get(wSeq), tag).toBe('Confirmed')
        expect(probes[loser]!.verdicts.get(lSeq), tag).toEqual({
          Rejected: { Game: 'NotBuildable' },
        })
        // The loser predicted it (no `NotPredictable` at dispatch) and showed its ghost while waiting.
        expect(
          all.filter(([i, res]) => i === loser && res === 'NotPredictable'),
          tag,
        ).toEqual([])
        expect(
          probes[loser]!.ghostFrames,
          `${tag}: the loser's ghost was on screen`,
        ).toBeGreaterThan(0)
        expect(probes[0]!.frames, tag).toBeGreaterThan(8)
        // Final host state: one furnace, the winner's; the loser holds its item again.
        await h.settle()
        h.assertConverged()
        expect(uiOf(h, winner).inventory[FURNACE], tag).toBe(0)
        expect(uiOf(h, loser).inventory[FURNACE], `${tag}: the item is back`).toBe(1)
        expect(uiOf(h, loser).can_build, tag).toBe(true)
        for (const i of [0, 1]) {
          const sprites = h.clients[i]!.draws().filter((d) => d.kind === 0)
          expect(
            sprites.map((d) => [d.flags & PREDICTED, d.pos[1]]),
            `${tag}: client ${i} sees exactly the winner's furnace`,
          ).toEqual([[0, origins[winner]!.y]])
        }
      } finally {
        await r.dispose()
      }
    }
  },
  60_000,
)

type Ui = ReturnType<typeof uiOf>
const STONE = 0
const INGOT = 5

/** Every verdict client `i` is told, `'NotPredictable'` included, in order. */
function recordResults(r: RefHarness, i: number): unknown[] {
  const seen: unknown[] = []
  r.h.clients[i]!.onActionResult((_s, res) => seen.push(res))
  return seen
}

// One test per (latency, order) pair, as `reference_race_same_spot` (M36b step 4b): the body is the
// former double loop's, unchanged; ids were `reference_race_last_unit`, now
// `reference_race_last_unit <ms> ms, first <n>`.
test.each(LATENCIES.flatMap((l) => ([0, 1] as const).map((w) => [l, w] as const)))(
  'reference_race_last_unit %i ms, first %i',
  async (latency, first) => {
    {
      const second = (1 - first) as 0 | 1
      const seed = 3430 + latency + first
      const tag = `seed ${seed}, ${latency} ms, client ${first} takes the last unit`
      const r = await refHarness({
        clients: 2,
        seed,
        conditions: { latencyMs: latency, jitterMs: jitterFor(latency) },
      })
      try {
        const { h } = r
        const tile = LANDMARKS.resources.stone
        // `first` mines nine of the tile's ten units, then both stand on it.
        await r.drivers[first]!.collect('stone', tile, 9)
        await r.drivers[second]!.panTo(tile)
        await h.settle()
        expect(uiOf(h, first).inventory[STONE], tag).toBe(9)
        expect(
          uiOf(h, second).in_range.map((e) => e.tile),
          `${tag}: the last unit is there`,
        ).toContainEqual(tile)

        // Nothing for the loser's `Ui` to show but its own inventory and timer: never the unit.
        const invariant = (who: 0 | 1) => (ui: Ui) => {
          if (who === second && (ui.inventory[STONE] !== 0 || ui.collecting !== null)) {
            throw new Error(
              `${tag}: the loser's Ui shows ${JSON.stringify(ui.collecting)} / ${ui.inventory}`,
            )
          }
          if (who === first && ![9, 10].includes(ui.inventory[STONE] ?? -1)) {
            throw new Error(`${tag}: the winner's stone is ${ui.inventory[STONE]}`)
          }
        }
        const probes = [0, 1].map((i) => tornStateProbe(h.clients[i]!, invariant(i as 0 | 1)))
        const seen = recordResults(r, second)
        // The winner starts; once its timer shows, the loser dispatches on the tick before the
        // host finishes it: the loser's replica still has the unit, the host will not.
        const w = startCollect(r, first, tile)
        let done = -1
        for (let i = 0; i < 60 && done < 0; i++) {
          await advanceProbed(h, probes, 1)
          done = uiOf(h, first).collecting?.done_at ?? -1
        }
        expect(done, `${tag}: the winner's collect began`).toBeGreaterThan(0)
        while (h.hostTick() < done - 1) await advanceProbed(h, probes, 1)
        expect(h.hostTick(), tag).toBe(done - 1)
        const l = startCollect(r, second, tile)
        await advanceProbed(h, probes, Math.ceil((2 * latency) / 50) + 8)

        expect(probes[first]!.verdicts.get(w), tag).toBe('Confirmed')
        // Predicted locally (no `NotPredictable`), refused by the host.
        expect(seen, tag).toEqual([{ Rejected: { Game: 'NoResource' } }])
        expect(probes[second]!.verdicts.get(l), tag).toEqual({ Rejected: { Game: 'NoResource' } })
        await h.settle()
        h.assertConverged()
        expect(uiOf(h, first).inventory[STONE], `${tag}: the winner got the unit`).toBe(10)
        expect(uiOf(h, second).inventory[STONE], `${tag}: the loser got nothing`).toBe(0)
        for (const i of [0, 1]) {
          expect(
            uiOf(h, i).in_range.map((e) => e.tile),
            `${tag}: client ${i} sees the tile depleted`,
          ).not.toContainEqual(tile)
        }
        expect(probes[0]!.frames, tag).toBeGreaterThan(40)
      } finally {
        await r.dispose()
      }
    }
  },
  60_000,
)

// Same split (M36b step 4b); ids were `reference_race_same_ingots`, now
// `reference_race_same_ingots <ms> ms, winner <n>`.
test.each(LATENCIES.flatMap((l) => ([0, 1] as const).map((w) => [l, w] as const)))(
  'reference_race_same_ingots %i ms, winner %i',
  async (latency, winner) => {
    {
      const loser = (1 - winner) as 0 | 1
      const seed = 3440 + latency + winner
      const tag = `seed ${seed}, ${latency} ms, client ${winner} takes first`
      const r = await refHarness({
        clients: 2,
        seed,
        conditions: { latencyMs: latency, jitterMs: jitterFor(latency) },
      })
      try {
        const { h } = r
        const a = r.drivers[0]!
        // A smelts two ingots in a furnace of its own; B stands beside it.
        await runScript(
          script()
            .collect('stone', 5)
            .craft(0)
            .panTo(standBy(FURNACE_A))
            .place(FURNACE_A)
            .collect('iron', 2)
            .collect('coal', 1)
            .panTo(standBy(FURNACE_A))
            .deposit(FURNACE_A, 'iron', 'all')
            .deposit(FURNACE_A, 'coal', 1)
            .waitTicks(2 * 100 + 15),
          a,
        )
        await r.drivers[1]!.panTo(standBy(FURNACE_A))
        await h.settle()
        if (uiOf(h, 0).inventory[INGOT] !== 0) throw new Error(`${tag}: A took early`)

        slowDown(r, loser, latency)
        // Never a partial take on any frame (`Ui` is the confirmed replica, so the predicted take
        // shows only as a PREDICTED sprite; R2: a take is predicted like every other action).
        const invariant =
          (who: 0 | 1) => (ui: Ui, draws: Array<{ kind: number; flags: number }>) => {
            const n = ui.inventory[INGOT] ?? -1
            if (![0, 2].includes(n)) throw new Error(`${tag}: client ${who} holds ${n} ingots`)
            if (who === loser && n !== 0) throw new Error(`${tag}: the loser holds ${n} ingots`)
          }
        const probes = [0, 1].map((i) => tornStateProbe(h.clients[i]!, invariant(i as 0 | 1)))
        const seen = [0, 1].map((i) => recordResults(r, i))
        const seqs = [0, 1].map((i) =>
          h.clients[i]!.dispatch({ FurnaceTake: { at: { x: FURNACE_A.x, y: FURNACE_A.y } } }),
        )
        await advanceProbed(h, probes, Math.ceil((latency + SLOWER_BY_MS) / 50) * 2 + 8)

        expect(probes[winner]!.verdicts.get(seqs[winner]!), tag).toBe('Confirmed')
        expect(probes[loser]!.verdicts.get(seqs[loser]!), tag).toEqual({
          Rejected: { Game: 'NothingToTake' },
        })
        // Both predicted the take at dispatch (no `NotPredictable`, R2), then got the verdict.
        expect(seen[winner], tag).toEqual(['Confirmed'])
        expect(seen[loser], tag).toEqual([{ Rejected: { Game: 'NothingToTake' } }])
        await h.settle()
        h.assertConverged()
        expect(uiOf(h, winner).inventory[INGOT], `${tag}: the winner has both ingots`).toBe(2)
        expect(uiOf(h, loser).inventory[INGOT], tag).toBe(0)
        // The host's furnace is empty of ingots: a third take is refused.
        const third = h.clients[winner]!.dispatch({
          FurnaceTake: { at: { x: FURNACE_A.x, y: FURNACE_A.y } },
        })
        await advanceProbed(h, probes, Math.ceil((2 * latency) / 50) + 6)
        expect(probes[winner]!.verdicts.get(third), tag).toEqual({
          Rejected: { Game: 'NothingToTake' },
        })
        expect(probes[0]!.frames, tag).toBeGreaterThan(8)
      } finally {
        await r.dispose()
      }
    }
  },
  60_000,
)
