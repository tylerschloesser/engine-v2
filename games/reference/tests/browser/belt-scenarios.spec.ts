// M56 (Browser): the 4x4 balancer (`LAYOUTS.balancer`, `tests/helpers/layout.ts`; its hash pinned by
// `tests/unit/layout.test.ts`) built on the real reference page through the test hooks
// (`placeBelt`, `setSpawner`), its four spawners saturated (iron, coal, wood, stone), 200 ticks of
// flow, then the items the page draws at 10 tiles across (30 px a tile on the 300 px test canvas,
// above the items' 20) at two camera stops, the top four rows and the bottom three. Stepped ticks
// and frames only (0020 §4). In every sampled frame: items on exactly the layout's tiles in view
// (every belt, curve, splitter half of both stages, spawner, despawner and visible underground half
// carries some at saturation, and nothing else does), and none over the undergrounds' hidden
// stretches (the replica holds no hidden line). Positions are DrawList records relative to a pivot
// sprite of known tile (a sprite's pivot is its tile's top-left corner).
import { expect, type Page, test } from '@playwright/test'
import {
  BELT,
  beltDraws,
  beltSprite,
  type DrawRec,
  frame,
  ITEM,
  ITEM_SPRITE_FIRST,
  itemDraws,
  openGame,
  panTo,
  placeBelt,
  SPAWN_RATE,
  setSpawner,
  uiState,
} from '../helpers/game.js'
import { footprint, LAYOUTS, parseLayout, tilesOf } from '../helpers/layout.js'

/** The balancer's top-left, as in the netcode scenarios (free land at `world.json`'s seed). */
const AT = { x: -4, y: -13 }
const FEED = [ITEM.iron, ITEM.coal, ITEM.wood, ITEM.stone]
const EPS = 1e-3
/** Lane centres across a belt (`topology::LANE_INSET`, 68/256 from the tile's edges). */
const LANE = [68 / 256, 1 - 68 / 256] as const

/** Every frame's items at a camera stop: `[tile x, tile y, item]` relative to `AT`, from `n`
 * tick-and-frame steps. The pivot is the westmost sprite `pivot` (layout tile `at`). */
async function sample(
  page: Page,
  centreY: number,
  pivot: number,
  at: { x: number; y: number },
  n: number,
): Promise<Array<Array<{ x: number; y: number; item: number }>>> {
  await page.evaluate(([x, y, t]) => window.__setCamera?.(x, y, t), [
    AT.x + 3,
    AT.y + centreY,
    10,
  ] as const)
  await frame(page)
  const frames = []
  for (let f = 0; f < n; f++) {
    await page.evaluate((k) => window.__stepTick?.(k), 1)
    await frame(page)
    const placed = (await beltDraws(page)).placed.filter((r: DrawRec) => r.spriteId === pivot)
    const piv = placed.reduce((m, r) => (r.x < m.x ? r : m))
    const items = await itemDraws(page)
    frames.push(
      items.map((r) => ({
        x: r.x - piv.x + at.x,
        y: r.y - piv.y + at.y,
        item: r.spriteId - ITEM_SPRITE_FIRST,
      })),
    )
  }
  return frames
}

test('reference_balancer_draws_items @slow', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  await uiState(page)
  await panTo(page, { x: AT.x + 3, y: AT.y + 3 })
  // 20 tiles across while building: every placed record in view.
  await page.evaluate(([x, y, t]) => window.__setCamera?.(x, y, t), [
    AT.x + 3,
    AT.y + 3.5,
    20,
  ] as const)
  await frame(page)
  const layout = parseLayout(LAYOUTS.balancer)
  for (const p of layout.placements) {
    await placeBelt(page, { x: AT.x + p.x, y: AT.y + p.y }, p.dir, p.kind)
  }
  expect((await beltDraws(page)).placed.length, 'one record per placement').toBe(27)
  for (const [i, s] of tilesOf(layout, AT, 'Spawner').entries()) {
    for (const lane of [0, 1]) {
      await setSpawner(page, s, lane, FEED[i] as number, SPAWN_RATE.saturation)
    }
  }
  await page.evaluate((k) => window.__stepTick?.(k), 200)

  // The layout's tiles (a splitter's two), relative to `AT`.
  const tiles = new Set<string>()
  for (const p of layout.placements) for (const t of footprint(p)) tiles.add(`${t.x},${t.y}`)
  const want = (rows: number[]) =>
    [...tiles].filter((t) => rows.includes(Number(t.split(',')[1]))).sort()
  const north = (family: number) => beltSprite(family, 'North').spriteId
  const top = await sample(page, 2, north(BELT.despawner), { x: 1, y: 0 }, 5)
  const bottom = await sample(page, 5, north(BELT.spawner), { x: 0, y: 6 }, 5)
  const onTiles = (items: Array<{ x: number; y: number }>, rows: number[]) =>
    [
      ...new Set(
        items
          .filter((r) => rows.includes(Math.floor(r.y)))
          .map((r) => `${Math.floor(r.x)},${Math.floor(r.y)}`),
      ),
    ].sort()
  for (const [f, items] of top.entries()) {
    expect(onTiles(items, [0, 1, 2, 3]), `top frame ${f}: tiles with items`).toEqual(
      want([0, 1, 2, 3]),
    )
    // The hidden-stretch checks are invariants, not separately injectable: a replica never holds a
    // hidden line (it has no segments, 0079 §22), so it cannot draw an item there; the inject that
    // reds this spec (no `draw_items` call) empties the tile sets above instead.
    // The east pair (entrance (1, 3), exit (4, 3), its hidden stretch from the entrance's
    // midline to the exit's, x 1.5 to 4.5) carries a's left output, iron and coal; the two surface
    // belts over its gap carry b's outputs, wood and stone. So no iron or coal on row 3 there.
    const overEast = items.filter(
      (r) =>
        (r.item === ITEM.iron || r.item === ITEM.coal) &&
        r.y >= 3 &&
        r.y < 4 &&
        r.x > 1.5 + EPS &&
        r.x < 4.5 - EPS,
    )
    expect(overEast, `top frame ${f}: an item over the east pair's hidden stretch`).toEqual([])
    // The north pair (entrance (1, 4), exit (1, 2), hidden from y 4.5 up to 2.5 under the east
    // entrance): in column 1 between those midlines only the east entrance's own items, on its
    // lanes and its visible back half.
    const overNorth = items.filter(
      (r) =>
        r.x >= 1 &&
        r.x < 2 &&
        r.y > 2.5 + EPS &&
        r.y < 4.5 - EPS &&
        !(r.x <= 1.5 + EPS && LANE.some((d) => Math.abs(r.y - 3 - d) < EPS)),
    )
    expect(overNorth, `top frame ${f}: an item over the north pair's hidden stretch`).toEqual([])
  }
  for (const [f, items] of bottom.entries()) {
    expect(onTiles(items, [4, 5, 6]), `bottom frame ${f}: tiles with items`).toEqual(
      want([4, 5, 6]),
    )
  }
})
