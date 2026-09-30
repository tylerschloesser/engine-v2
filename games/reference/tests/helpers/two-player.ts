// The two-player full game of M34c step 1, shared by `two-players`, the counters and the `ws` run:
// A mines, crafts, places; B picks the empty furnace up and places it again; A deposits and takes.
import { expect } from 'vitest'
import { type RefHarness, uiOf } from '../helpers/net.js'
import { FURNACE_A, FURNACE_B, runScript, script, type Tile } from '../helpers/script.js'

const standBy = (o: Tile): Tile => ({ x: o.x - 5, y: o.y })
const inv = (
  stone: number,
  iron: number,
  wood: number,
  coal: number,
  furnace: number,
  ingot: number,
) => [stone, iron, wood, coal, furnace, ingot]
/** `kind` 0 records are the furnace sprites (real, or a ghost when `flags & 4`). */
const furnaces = (c: { draws(): Array<{ kind: number; flags: number }> }) =>
  c.draws().filter((d) => d.kind === 0)

/** Plays it on `r` (two clients, joined) and asserts what the game promises; `seed` is for messages. */
export async function playTwoPlayerGame(r: RefHarness, seed: number): Promise<void> {
  const { h } = r
  const [a, b] = r.drivers as [(typeof r.drivers)[0], (typeof r.drivers)[0]]
  const [ca, cb] = h.clients as [(typeof h.clients)[0], (typeof h.clients)[0]]

  // A: mine, craft, place, open the panel.
  await runScript(
    script()
      .expectUi({
        roster: [
          { id: 1, online: true, me: true },
          { id: 2, online: true, me: false },
        ],
      })
      .collect('stone', 5)
      .craft(0)
      .expectUi({ inventory: inv(0, 0, 0, 0, 1, 0) })
      .panTo(standBy(FURNACE_A))
      .place(FURNACE_A)
      .openFurnace(FURNACE_A)
      .expectUi({ inventory: inv(0, 0, 0, 0, 0, 0) }),
    a,
  )
  // B stands beside it and sees the real furnace (not a ghost).
  await b.panTo(standBy(FURNACE_A))
  await h.advanceTicks(5)
  expect(
    furnaces(cb).map((d) => d.flags & 4),
    `seed ${seed}: B sees A's furnace`,
  ).toEqual([0])
  expect(furnaces(ca).map((d) => d.flags & 4)).toEqual([0])

  // B picks A's still-empty furnace up: any player may. A's frame loses the entity, B holds the item.
  await b.pickUp(FURNACE_A, false)
  await h.advanceTicks(5)
  expect(furnaces(ca), `seed ${seed}: A's frame carries EntityGone`).toEqual([])
  expect(uiOf(h, 1).inventory).toEqual(inv(0, 0, 0, 0, 1, 0))
  expect(uiOf(h, 0).furnace, 'A has no open panel on a gone furnace').toBeNull()

  // B places it again, two tiles over.
  await b.place(FURNACE_B)
  await h.advanceTicks(5)
  expect(uiOf(h, 1).inventory).toEqual(inv(0, 0, 0, 0, 0, 0))

  // A deposits into and takes from the furnace B placed.
  await runScript(
    script()
      .collect('iron', 1)
      .collect('coal', 1)
      .expectUi({ inventory: inv(0, 1, 0, 1, 0, 0) })
      .panTo(standBy(FURNACE_B))
      .openFurnace(FURNACE_B)
      .deposit(FURNACE_B, 'iron', 1)
      .deposit(FURNACE_B, 'coal', 1)
      .expectUi({ inventory: inv(0, 0, 0, 0, 0, 0) })
      .waitTicks(110)
      .takeAll(FURNACE_B)
      .expectUi({ inventory: inv(0, 0, 0, 0, 0, 1) }),
    a,
  )

  await h.settle()
  h.assertConverged()
  // Both `Ui`s agree with the host: same roster (ids, colours, both online), each own inventory.
  const [ua, ub] = [uiOf(h, 0), uiOf(h, 1)]
  const strip = (u: typeof ua) => u.roster.map((e) => [e.id, e.online, e.colour])
  expect(strip(ua), `seed ${seed}`).toEqual(strip(ub))
  expect(ua.roster.map((e) => e.online)).toEqual([true, true])
  expect(ua.roster.map((e) => e.me)).toEqual([true, false])
  expect(ub.roster.map((e) => e.me)).toEqual([false, true])
  expect(ua.inventory).toEqual(inv(0, 0, 0, 0, 0, 1))
  expect(ub.inventory).toEqual(inv(0, 0, 0, 0, 0, 0))
  // B's camera is still on both furnace chunks: it sees B's furnace, emptied by A, as a real sprite.
  expect(furnaces(cb).map((d) => d.flags & 4)).toEqual([0])
}
