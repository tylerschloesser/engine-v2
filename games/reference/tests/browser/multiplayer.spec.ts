// M34 (docs/plan/34-reference-multiplayer.md Tests added): two pages on one reference server. Each
// page is its own browser context (the identity secret is per origin `localStorage`), stepped
// frames and server ticks only: the server has a manual timer and the pages a manual clock.
import { type Browser, expect, type Page, test } from '@playwright/test'
import {
  craftFurnace,
  draws,
  ITEM,
  KIND,
  openGame,
  PLACE,
  panTo,
  placeFurnace,
  RESOURCE_TILE,
  type RefUiState,
  readUi,
} from '../helpers/game.js'
import { type ReferenceServer, startReferenceServer, untilConfigured } from '../helpers/server.js'

async function join(
  browser: Browser,
  server: ReferenceServer,
  n: number,
): Promise<{ pages: Page[]; close: () => Promise<void> }> {
  const contexts = await Promise.all(Array.from({ length: n }, () => browser.newContext()))
  const pages = await Promise.all(contexts.map((c) => c.newPage()))
  await Promise.all(pages.map((p) => openGame(p, { invite: { server } })))
  await untilConfigured(server, pages)
  return { pages, close: () => Promise.all(contexts.map((c) => c.close())).then(() => undefined) }
}

const rgb = (c: { color: number }): number => c.color & 0xffffff
const packed = ([r, g, b]: [number, number, number]): number => r | (g << 8) | (b << 16)

test('reference_two_players_see_each_other', async ({ browser }) => {
  const server = await startReferenceServer({ manualTimer: true })
  const { pages, close } = await join(browser, server, 2)
  try {
    const [a, b] = pages as [Page, Page]
    await Promise.all(pages.map((p) => readUi(p)))
    // B stands three tiles from A, so the remote circle is not hidden under the own one.
    const at = (await a.evaluate(() => window.__cameraState?.())) as { x: number; y: number }
    await b.evaluate(([x, y]) => window.__setCamera?.(x + 3, y, 20), [at.x, at.y] as const)

    // The server ticks, both pages step frames: presence goes up, is relayed, interpolated, drawn.
    for (let i = 0; i < 200; i++) {
      await a.evaluate(() => window.__stepTick?.(1))
      await Promise.all(pages.map((p) => p.evaluate(() => window.__stepFrame?.(50))))
      const seen = await Promise.all(pages.map((p) => p.evaluate(() => window.__circles?.() ?? [])))
      if (seen.every((c) => c.length === 2)) break
    }
    const uis: RefUiState[] = await Promise.all(pages.map((p) => readUi(p)))
    for (const [i, p] of pages.entries()) {
      const circles = await p.evaluate(() => window.__circles?.() ?? [])
      expect(circles, `page ${i}: two circles`).toHaveLength(2)
      const colours = circles.map(rgb)
      expect(new Set(colours).size, `page ${i}: distinct colours`).toBe(2)
      const ui = uis[i] as RefUiState
      expect(ui.roster).toHaveLength(2)
      expect(ui.roster.map((r) => packed(r.colour)).sort()).toEqual([...colours].sort())
      expect(ui.roster.filter((r) => r.me)).toHaveLength(1)
      await expect(p.locator('.roster .roster-dot')).toHaveCount(2)
      await expect(p.locator('.roster .roster-dot[data-online="true"]')).toHaveCount(2)
    }
  } finally {
    await close()
    await server.stop()
  }
})

type Rgba = { r: number; g: number; b: number; a: number }
declare global {
  interface Window {
    __probeTile?: (x: number, y: number) => Promise<Rgba>
    __pixelAt?: (
      x: number,
      y: number,
    ) => Promise<{ on: [number, number, number, number]; off: [number, number, number, number] }>
  }
}

test('reference_shared_world', async ({ browser }) => {
  const server = await startReferenceServer({ manualTimer: true })
  const { pages, close } = await join(browser, server, 2)
  try {
    const [a, b] = pages as [Page, Page]
    await Promise.all(pages.map((p) => readUi(p)))
    const tile = RESOURCE_TILE.stone
    const probe = (p: Page): Promise<Rgba> =>
      p.evaluate(([x, y]) => window.__probeTile?.(x, y) as Promise<Rgba>, [tile.x, tile.y] as const)

    // B watches the area: the stone tile and the furnace site are both inside its view.
    await panTo(b, { x: PLACE.free.x, y: 0 })
    const full = await probe(b)
    expect(await draws(b), 'no furnace yet').toEqual([])

    // A mines five stone (the tile drops a stage), crafts a furnace and places it.
    await craftFurnace(a)
    await placeFurnace(a, PLACE.free)

    // B sees both without touching anything.
    let half: Rgba = full
    let furnaces = await draws(b)
    for (let i = 0; i < 100; i++) {
      await b.evaluate(() => window.__stepTick?.(1))
      await b.evaluate(() => window.__stepFrame?.(16))
      half = await probe(b)
      furnaces = (await draws(b)).filter((r) => r.kind === KIND.sprite)
      if (half.r !== full.r && furnaces.length > 0) break
    }
    expect(half, 'the stone tile is depleted on B').not.toEqual(full)
    expect(furnaces, "B draws A's furnace").toHaveLength(1)
    // DrawList positions are relative to a window origin: the pixels are the proof of *where*.
    const px = await b.evaluate(([x, y]) => window.__pixelAt?.(x, y), [
      PLACE.free.x + 1,
      PLACE.free.y + 1,
    ] as const)
    const change = [0, 1, 2].reduce(
      (sum, i) => sum + Math.abs((px?.on[i] as number) - (px?.off[i] as number)),
      0,
    )
    expect(change, 'the furnace is drawn over its tiles').toBeGreaterThan(40)
    // The world is shared, the inventory is not.
    expect((await readUi(b)).inventory[ITEM.stone]).toBe(0)
  } finally {
    await close()
    await server.stop()
  }
})

test('reference_returning_player_resumes', async ({ browser }) => {
  const server = await startReferenceServer({ manualTimer: true })
  const first = await browser.newContext()
  let second: Awaited<ReturnType<Browser['newContext']>> | undefined
  try {
    const a1 = await first.newPage()
    await openGame(a1, { invite: { server } })
    await untilConfigured(server, [a1])
    const ui1 = await readUi(a1)

    // Walk away from the spawn tile and let the presence reach the host.
    const far = { x: ui1.spawn.x + 25, y: ui1.spawn.y + 15 }
    await a1.evaluate(([x, y]) => window.__setCamera?.(x, y, 20), [far.x, far.y] as const)
    for (let i = 0; i < 30; i++) {
      await a1.evaluate(() => window.__stepFrame?.(50))
    }
    await a1.evaluate(() => window.__stepTick?.(5))
    const left = (await a1.evaluate(() => window.__cameraState?.())) as { x: number; y: number }
    expect(Math.hypot(left.x - far.x, left.y - far.y), 'A1 is where it left').toBeLessThan(1)

    // Same storage (the identity secret), a fresh page: the camera starts where A1 was.
    const state = await first.storageState()
    await first.close()
    second = await browser.newContext({ storageState: state })
    const a2 = await second.newPage()
    await openGame(a2, { invite: { server } })
    await untilConfigured(server, [a2])
    const ui2 = await readUi(a2)
    expect(ui2.me, 'the same player returns').toBe(ui1.me)
    expect(ui2.roster.find((r) => r.me)?.colour, 'with the same colour').toEqual(
      ui1.roster.find((r) => r.me)?.colour,
    )
    const back = (await a2.evaluate(() => window.__cameraState?.())) as { x: number; y: number }
    expect(
      Math.hypot(back.x - left.x, back.y - left.y),
      'camera resumes within a tile',
    ).toBeLessThan(1)
  } finally {
    await first.close().catch(() => undefined)
    await second?.close()
    await server.stop()
  }
})
