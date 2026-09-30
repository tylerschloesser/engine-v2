// M34d (docs/plan/34d-straddling-entity-chunk-versions.md): a reference furnace whose 2x2 footprint
// straddles a chunk boundary (origin (-4, -1): rows -1 and 0 are chunks cy -1 and 0) converges
// after `settle()`. Before the fix the replica bumped only the anchor chunk's version, so its
// region hash differed from the host's (M34b Deviations, finding 1).
import { expect, test } from 'vitest'
import { createNetHarness } from '../../src/test/net-harness.js'
import { gameCrateBuildDir } from '../support/fixtures.js'
import { readLandmarks, readWorldJson } from '../support/reference-golden.js'

type Ui = {
  inventory: number[]
  in_range: Array<{ tile: { x: number; y: number }; from: { x: number; y: number } }>
}
const STONE = 0
const FURNACE = 4

test('reference_straddling_furnace_converges', async () => {
  const seed = 3406
  const world = readWorldJson()
  const h = await createNetHarness({
    fixture: gameCrateBuildDir('reference'),
    seed, // the link conditioner only
    worldSeed: world.seed,
    clients: 1,
    world: { params: { worldgen: world.worldgen } },
  })
  try {
    const client = h.clients[0]
    if (!client) throw new Error('no client')
    const ui = (): Ui => {
      const u = client.ui() as Ui | null
      if (!u) throw new Error('no Ui yet')
      return u
    }
    const until = async (what: string, done: () => boolean): Promise<void> => {
      for (let i = 0; i < 300 && !done(); i++) await h.advanceTicks(1)
      if (!done()) throw new Error(`seed ${seed}: ${what} did not happen in 300 ticks`)
    }
    const verdicts = new Map<number, unknown>()
    client.onActionResult((s, r) => {
      if (r !== 'NotPredictable') verdicts.set(s, r)
    })
    const act = async (action: unknown): Promise<unknown> => {
      const s = client.dispatch(action)
      await until(`verdict of ${JSON.stringify(action)}`, () => verdicts.has(s))
      return verdicts.get(s)
    }

    // Five stone, one furnace.
    const tile = readLandmarks().resources.stone
    client.setCamera({ x: tile.x, y: tile.y, tilesAcross: 20 })
    await h.advanceTicks(25)
    for (let i = 0; i < 5; i++) {
      const entry = () => ui().in_range.find((e) => e.tile.x === tile.x && e.tile.y === tile.y)
      await until('stone tile in range', () => entry() !== undefined)
      const before = ui().inventory[STONE] ?? 0
      client.dispatch({ StartCollect: { tile: { x: tile.x, y: tile.y }, from: entry()?.from } })
      await until('stone collected', () => (ui().inventory[STONE] ?? 0) > before)
    }
    expect(await act({ StartCraft: { recipe: 0 } })).toBe('Confirmed')
    await until('furnace crafted', () => (ui().inventory[FURNACE] ?? 0) === 1)

    // Stand beside the straddling origin so the camera holds both chunks, and place across the
    // boundary.
    client.setCamera({ x: -9, y: -1, tilesAcross: 20 })
    await h.advanceTicks(25)
    expect(await act({ PlaceFurnace: { origin: { x: -4, y: -1 } } }), `seed ${seed}`).toBe(
      'Confirmed',
    )
    await until('furnace spent', () => (ui().inventory[FURNACE] ?? 1) === 0)
    await h.settle()
    h.assertConverged()
  } finally {
    await h.dispose()
  }
})
