// M34c step 4 (docs/plan/34c-reference-scripted-multiplayer.md Scope): late join, the disconnect
// grace, a pending action across a drop, a returning player (session supersede) and the idle pause.

import { serverInternals, worldServerTestHandle } from 'engine/test'
import { expect, test } from 'vitest'
import {
  logRecords,
  PREDICTED,
  type RefHarness,
  refHarness,
  startCollect,
  uiOf,
} from '../helpers/net.js'
import {
  FURNACE_A,
  FURNACE_B,
  fullGame,
  headlessDriver,
  LANDMARKS,
  runScript,
  script,
} from '../helpers/script.js'

const inv = (s: number, i: number, w: number, c: number, f: number, g: number) => [s, i, w, c, f, g]
const secretOf = (fill: number): Uint8Array => new Uint8Array(16).fill(fill)
const STONE = LANDMARKS.resources.stone
const IRON = LANDMARKS.resources.iron
const sprites = (c: { draws(): Array<{ kind: number; flags: number }> }) =>
  c.draws().filter((d) => d.kind === 0)

/** Ticks until `done()`; the message names the seed. */
async function until(r: RefHarness, what: string, done: () => boolean, max = 300): Promise<void> {
  for (let i = 0; i < max && !done(); i++) await r.h.advanceTicks(1)
  if (!done()) throw new Error(`seed ${r.seed}: ${what} did not happen in ${max} ticks`)
}

test('reference_late_join_sees_world', async () => {
  const seed = 3460
  const r = await refHarness({
    clients: 1,
    seed,
    conditions: { latencyMs: 60, jitterMs: 20 },
    cameras: [{ x: STONE.x, y: STONE.y, tilesAcross: 20 }],
  })
  try {
    const { h } = r
    const a = r.drivers[0]!
    // The whole single-player game, then the rest of the stone tile: it ends depleted.
    await runScript(fullGame(), a)
    await runScript(script().collect('stone', 5), a)
    expect(
      uiOf(h, 0).in_range.some((e) => e.resource === 1 && e.tile.x === STONE.x),
      'A',
    ).toBe(false)

    // B and C join afterwards; B beside the furnace and the stone, C on the iron.
    const b = h.addClient()
    const c = h.addClient()
    b.setCamera({ x: -3, y: 2, tilesAcross: 20 })
    c.setCamera({ x: IRON.x, y: IRON.y, tilesAcross: 20 })
    await h.settle()
    h.assertConverged()
    const [ua, ub, uc] = [uiOf(h, 0), uiOf(h, 1), uiOf(h, 2)]
    // The roster and both colours: three players, distinct colours, every client agrees.
    const view = (u: typeof ua) => u.roster.map((e) => [e.id, e.online, e.colour])
    expect(view(ub), `seed ${seed}`).toEqual(view(ua))
    expect(view(uc)).toEqual(view(ua))
    expect(ua.roster).toHaveLength(3)
    expect(ua.roster.every((e) => e.online)).toBe(true)
    expect(new Set(ua.roster.map((e) => e.colour.join())).size, 'three colours').toBe(3)
    expect(uc.roster.filter((e) => e.me).map((e) => e.id)).toEqual([3])
    // Depleted tiles: B stands two tiles from the stone and sees nothing to collect there; C on the
    // iron (nine of ten units left) sees it.
    expect(
      ub.in_range.some((e) => e.tile.x === STONE.x && e.tile.y === STONE.y),
      'B sees the stone gone',
    ).toBe(false)
    expect(
      uc.in_range.some((e) => e.tile.x === IRON.x && e.tile.y === IRON.y),
      'C sees iron',
    ).toBe(true)
    // Furnace contents: B's replica holds A's furnace as a real sprite, and (hash-all) its bytes match
    // the host's, burn left and all, which `assertConverged` just checked.
    expect(
      sprites(b).map((d) => d.flags & PREDICTED),
      'B draws the furnace',
    ).toEqual([0])
    expect(uiOf(h, 1).inventory, 'late joiners start empty').toEqual(inv(0, 0, 0, 0, 0, 0))
    expect(FURNACE_B.x).toBe(-4)
  } finally {
    await r.dispose()
  }
}, 30_000)

test('reference_short_drop_keeps_collect', async () => {
  const seed = 3461
  const r = await refHarness({
    clients: 1,
    seed,
    conditions: { latencyMs: 60, jitterMs: 20 },
    cameras: [{ x: STONE.x, y: STONE.y, tilesAcross: 20 }],
  })
  try {
    const { h } = r
    startCollect(r, 0, STONE)
    await until(r, 'the collect shows', () => uiOf(h, 0).collecting !== null)
    const log = logRecords(h)
    h.link(0).disconnect()
    h.link(0).reconnect()
    await until(r, 'the collect lands', () => (uiOf(h, 0).inventory[0] ?? 0) === 1)
    await h.settle()
    h.assertConverged()
    expect(uiOf(h, 0).collecting, `seed ${seed}`).toBeNull()
    expect(log.n, `seed ${seed}: a drop inside the grace logs nothing`).toBe(0)
    expect(uiOf(h, 0).roster.map((e) => e.online)).toEqual([true])
  } finally {
    await r.dispose()
  }
}, 30_000)

test('reference_long_drop_cancels_collect_keeps_craft', async () => {
  const seed = 3462
  const secret = secretOf(0x41)
  const r = await refHarness({
    clients: 2, // B stays online: an empty world pauses (`reference_idle_world_pauses`)
    seed,
    secrets: [secret],
    cameras: [
      { x: STONE.x, y: STONE.y, tilesAcross: 20 },
      { x: STONE.x, y: STONE.y, tilesAcross: 20 },
    ],
  })
  try {
    const { h } = r
    await runScript(script().collect('stone', 5), r.drivers[0]!)
    // Phase 1, a drop longer than the 10 s grace: `Disconnected` is logged, and both timers (collect
    // 40 ticks, craft 100) finished inside the grace, so nothing is left to cancel: both completed.
    h.clients[0]!.dispatch({ StartCraft: { recipe: 0 } })
    const log = logRecords(h)
    startCollect(r, 0, STONE)
    await until(r, 'craft and collect shown', () => {
      const u = uiOf(h, 0)
      return u.crafting !== null && u.collecting !== null
    })
    h.link(0).disconnect()
    await h.advanceTicks(260)
    const dropTick = h.hostTick()
    expect(log.n, `seed ${seed}: Disconnected logged after the grace`).toBeGreaterThan(0)
    // The player comes back on a fresh connection with the same identity (index 2): a redial of the
    // dead link would wait out its own backoff, which grew while it was down.
    const returned = h.addClient(secret)
    returned.setCamera({ x: STONE.x, y: STONE.y, tilesAcross: 20 })
    await h.settle()
    h.assertNoDesync()
    const after = uiOf(h, 2)
    expect(after.inventory, `seed ${seed}: collect and craft both finished in the grace`).toEqual(
      inv(1, 0, 0, 0, 1, 0),
    )
    expect(after.roster.map((e) => e.online)).toEqual([true, true])

    // Phase 2, a player who leaves (`Bye`, no grace) with both timers running: the collect is
    // cancelled at once, the craft keeps running for the absent player.
    await runScript(
      script().collect('stone', 4),
      headlessDriver(returned, (n) => h.advanceTicks(n)),
    ) // stone 5 again
    expect(uiOf(h, 2).inventory[0]).toBe(5)
    returned.setCamera({ x: IRON.x, y: IRON.y, tilesAcross: 20 })
    await h.advanceTicks(30)
    returned.dispatch({ StartCraft: { recipe: 0 } })
    startCollect(r, 2, IRON)
    await until(r, 'craft and collect shown', () => {
      const u = uiOf(h, 2)
      return u.crafting !== null && u.collecting !== null
    })
    returned.leave()
    await h.advanceTicks(130)
    const back = h.addClient(secret) // client index 3
    back.setCamera({ x: IRON.x, y: IRON.y, tilesAcross: 20 })
    await h.settle()
    const ui = uiOf(h, 3)
    expect(ui.collecting, `seed ${seed}: the collect was cancelled`).toBeNull()
    expect(ui.inventory, `seed ${seed}: no iron; the craft finished while away`).toEqual(
      inv(0, 0, 0, 0, 2, 0),
    )
    expect(ui.roster.map((e) => [e.id, e.online])).toEqual([
      [1, true],
      [2, true],
    ])
  } finally {
    await r.dispose()
  }
}, 30_000)

for (const when of ['before_flush', 'ack_lost'] as const) {
  test(`reference_pending_place_applied_once_after_reconnect (${when})`, async () => {
    const seed = when === 'before_flush' ? 3463 : 3464
    const r = await refHarness({
      clients: 1,
      seed,
      cameras: [{ x: STONE.x, y: STONE.y, tilesAcross: 20 }],
    })
    try {
      const { h } = r
      await runScript(script().collect('stone', 5).craft(0), r.drivers[0]!)
      const a = h.clients[0]!
      a.setCamera({ x: FURNACE_A.x - 5, y: FURNACE_A.y, tilesAcross: 20 })
      await h.advanceTicks(30)
      const results: Array<[number, unknown]> = []
      a.onActionResult((s, res) => results.push([s, res]))
      const seq = a.dispatch({ PlaceFurnace: { origin: FURNACE_A } })
      // `before_flush`: the link dies before the action left the client. `ack_lost`: the host
      // applied it (two ticks at zero latency) and the ack died with the connection.
      if (when === 'ack_lost') await h.advanceTicks(2)
      h.link(0).disconnect()
      h.link(0).reconnect()
      await h.settle()
      h.assertConverged()
      const own = results.filter(([s]) => s === seq).map(([, res]) => res)
      expect(
        own.filter((x) => x === 'Confirmed').length,
        `seed ${seed}: ${JSON.stringify(own)}`,
      ).toBe(when === 'before_flush' ? 1 : 0)
      expect(
        own.filter((x) => x !== 'NotPredictable' && x !== 'Confirmed' && x !== 'Lost'),
      ).toEqual([])
      expect(own.length, `seed ${seed}: one terminal verdict`).toBeGreaterThan(0)
      // Applied exactly once: the item is spent once and one furnace stands.
      expect(uiOf(h, 0).inventory[4], `seed ${seed}`).toBe(0)
      expect(sprites(a).map((d) => d.flags & PREDICTED)).toEqual([0])
    } finally {
      await r.dispose()
    }
  }, 30_000)
}

test('reference_returning_player_supersedes_and_keeps_presence', async () => {
  const seed = 3465
  const secret = secretOf(0x42)
  const r = await refHarness({
    clients: 2,
    seed,
    secrets: [secret],
    conditions: { latencyMs: 60, jitterMs: 20 },
    cameras: [
      { x: -7, y: 3, tilesAcross: 20 },
      { x: -4, y: 1, tilesAcross: 20 },
    ],
  })
  try {
    const { h } = r
    await h.advanceTicks(60)
    // The same identity dials in while the first connection is still open: the host supersedes it.
    const last = h.clients[1]!.samplePresences().find((p) => p.who === 1)
    expect(last, `seed ${seed}: B sees A`).toBeDefined()
    const again = h.addClient(secret)
    // The returning client's camera is far away: only a seeded spring starts at the last sample
    // (-7,3) and moves toward it; an unseeded one (a new player) would appear at (30,30).
    again.setCamera({ x: 30, y: 30, tilesAcross: 20 })
    let moved: { x: number; y: number } | undefined
    for (let i = 0; i < 60 && moved === undefined; i++) {
      await h.advanceTicks(1)
      const row = h.clients[1]!.samplePresences().find((p) => p.who === 1)
      if (row && (row.x !== last!.x || row.y !== last!.y)) moved = row
    }
    expect(moved, `seed ${seed}: the returning player's first new sample`).toBeDefined()
    const tile = 256 // Q24.8
    expect(Math.abs(moved!.x - last!.x), `seed ${seed}: x ${moved!.x} vs ${last!.x}`).toBeLessThan(
      3 * tile,
    )
    expect(Math.abs(moved!.y - last!.y), `seed ${seed}: y ${moved!.y} vs ${last!.y}`).toBeLessThan(
      3 * tile,
    )
    await h.settle()
    // The old connection got `Bye{Superseded}` and is closed: its tick stops, the new one's goes on.
    const [oldTick, newTick] = [h.clients[0]!.status().tick, again.status().tick]
    await h.advanceTicks(20)
    expect(h.clients[0]!.status().tick, 'the superseded client hears nothing more').toBe(oldTick)
    expect(again.status().tick).toBeGreaterThan(newTick)
    expect(again.status().ownPlayerId, 'same player').toBe(h.clients[0]!.status().ownPlayerId)
    const ui = again.ui() as ReturnType<typeof uiOf>
    expect(
      ui.roster.map((e) => [e.id, e.online]),
      'one slot for the player',
    ).toEqual([
      [1, true],
      [2, true],
    ])
  } finally {
    await r.dispose()
  }
}, 30_000)

test('reference_idle_world_pauses', async () => {
  const seed = 3466
  const secret = secretOf(0x43)
  const r = await refHarness({
    clients: 2,
    seed,
    secrets: [secret],
    cameras: [
      { x: STONE.x, y: STONE.y, tilesAcross: 20 },
      { x: STONE.x, y: STONE.y, tilesAcross: 20 },
    ],
  })
  try {
    const { h } = r
    const a = r.drivers[0]!
    // A furnace smelting one ingot: 100 ticks from the deposit.
    await runScript(
      script()
        .collect('stone', 5)
        .craft(0)
        .panTo({ x: FURNACE_A.x - 5, y: FURNACE_A.y })
        .place(FURNACE_A)
        .collect('iron', 1)
        .collect('coal', 1)
        .panTo({ x: FURNACE_A.x - 5, y: FURNACE_A.y })
        .deposit(FURNACE_A, 'iron', 1)
        .deposit(FURNACE_A, 'coal', 1)
        .waitTicks(10),
      a,
    )
    const host = worldServerTestHandle(h.server)
    expect(serverInternals(h.server).isTicking).toBe(true)
    // Both leave: the last `Disconnected` stops the tick loop.
    h.clients[0]!.leave()
    h.clients[1]!.leave()
    await h.advanceTicks(10)
    expect(serverInternals(h.server).isTicking, `seed ${seed}: ticking stopped`).toBe(false)
    const frozen = host.counters.ticksRun
    await h.advanceTicks(400) // twice the smelt, and past the idle delay of nothing
    expect(host.counters.ticksRun, `seed ${seed}: no tick while empty`).toBe(frozen)

    // Someone returns: ticking resumes, and the furnace had made no progress meanwhile.
    const back = h.addClient(secret)
    back.setCamera({ x: FURNACE_A.x - 5, y: FURNACE_A.y, tilesAcross: 20 })
    await h.advanceTicks(6)
    expect(serverInternals(h.server).isTicking).toBe(true)
    const take = () => back.dispatch({ FurnaceTake: { at: { x: FURNACE_A.x, y: FURNACE_A.y } } })
    const seen: unknown[] = []
    back.onActionResult((_s, res) => {
      if (res !== 'NotPredictable') seen.push(res)
    })
    take()
    await h.advanceTicks(4)
    expect(seen, `seed ${seed}: nothing smelted while the world slept`).toEqual([
      { Rejected: { Game: 'NothingToTake' } },
    ])
    await h.advanceTicks(110)
    seen.length = 0
    take()
    await h.advanceTicks(4)
    expect(seen, `seed ${seed}: smelting went on after the return`).toEqual(['Confirmed'])
    expect((back.ui() as ReturnType<typeof uiOf>).inventory[5]).toBe(1)
  } finally {
    await r.dispose()
  }
}, 30_000)
