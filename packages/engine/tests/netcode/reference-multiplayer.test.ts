// M34 (docs/plan/34-reference-multiplayer.md Tests added, netcode): the reference game on the
// netcode harness, the real `reference-sim` dev build, the reference world's worldgen (`world.json`:
// the harness seed is a number, so the seed itself is the harness's own; `{}` is the worldgen).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createNetHarness, type NetHarness } from '../../src/test/net-harness.js'
import { budget } from '../support/budgets.js'
import { gameCrateBuildDir } from '../support/fixtures.js'

const WORLD = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../games/reference/world.json', import.meta.url)),
    'utf8',
  ),
) as { seed: string; worldgen: unknown }

type RosterEntry = { id: number; online: boolean; colour: [number, number, number]; me: boolean }
const roster = (h: NetHarness, i: number): RosterEntry[] =>
  (h.clients[i]?.ui() as { roster: RosterEntry[] } | null)?.roster ?? []

function make(seed: number, clients: number, extra: { production?: boolean } = {}) {
  return createNetHarness({
    fixture: gameCrateBuildDir('reference'),
    seed,
    clients,
    world: {
      params: { worldgen: WORLD.worldgen },
      ...(extra.production ? { debugHashMode: 'production' as const } : {}),
    },
  })
}

test('reference_roster_follows_join_grace_and_return', async () => {
  const seed = 3401
  const h = await make(seed, 2)
  try {
    h.clients[0]?.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    h.clients[1]?.setCamera({ x: 4, y: 0, tilesAcross: 20 })
    await h.advanceTicks(20)
    const both = roster(h, 0)
    expect(both, `seed ${seed}`).toHaveLength(2)
    expect(both.every((r) => r.online)).toBe(true)
    expect(both.filter((r) => r.me)).toHaveLength(1)
    const away = both.find((r) => !r.me) as RosterEntry
    // The other player sees the same two dots.
    expect(roster(h, 1).map((r) => [r.id, r.colour])).toEqual(both.map((r) => [r.id, r.colour]))

    // A drop: the dot stays filled through the grace of 0013 (10 s, 200 ticks) ...
    h.link(1).disconnect()
    await h.advanceTicks(150)
    expect(roster(h, 0).find((r) => r.id === away.id)?.online, 'inside the grace').toBe(true)
    // ... and goes hollow once the logged `Disconnected` lands; the player and colour stay.
    await h.advanceTicks(100)
    const gone = roster(h, 0).find((r) => r.id === away.id)
    expect(gone?.online, 'after the grace').toBe(false)
    expect(gone?.colour).toEqual(away.colour)

    // The same player returns: filled again, same colour.
    h.link(1).reconnect()
    await h.advanceTicks(30)
    const back = roster(h, 0).find((r) => r.id === away.id)
    expect(back?.online, 'after the return').toBe(true)
    expect(back?.colour).toEqual(away.colour)
    expect(roster(h, 0)).toHaveLength(2)
  } finally {
    await h.dispose()
  }
})

test('reference_presence_only_to_subscribers', async () => {
  const seed = 3402
  // Production hash cadence: this measures what a player pays (the harness default is hash-all).
  const h = await make(seed, 3, { production: true })
  try {
    const TICKS = 200
    const move = (): void => {
      const s = h.clock.now() / 1000
      h.clients[0]?.setCamera({ x: 3 * Math.sin(0.7 * s), y: 0, tilesAcross: 20 })
      h.clients[1]?.setCamera({ x: 6 + 3 * Math.sin(0.5 * s + 1), y: 2, tilesAcross: 20 })
      h.clients[2]?.setCamera({ x: 10_000, y: 10_000, tilesAcross: 20 }) // nowhere near
    }
    for (let k = 0; k < 40; k++) {
      move()
      await h.advanceTicks(1)
    }
    const start = h.counters(1).perTick.length
    const hashStart = h.counters(1).sections.Hashes ?? 0
    for (let k = 0; k < TICKS; k++) {
      move()
      await h.advanceTicks(1)
    }
    expect(h.clients[1]?.samplePresences().length, `seed ${seed}: sees the other mover`).toBe(1)
    expect(h.clients[0]?.samplePresences().length, `seed ${seed}`).toBe(1)
    expect(h.clients[2]?.samplePresences().length, `seed ${seed}: far away, sees no one`).toBe(0)

    const seconds = TICKS / 20
    const perSec =
      h
        .counters(1)
        .perTick.slice(start)
        .reduce((n, t) => n + t.bytesDown, 0) / seconds
    const hashPerSec = ((h.counters(1).sections.Hashes ?? 0) - hashStart) / seconds
    // M31's row is for seven remotes, plus the hashes' row (`net.hashesBytesPerS`: the harness's
    // production cadence, which the presence row was not measured with).
    const ceiling =
      budget('counters.presence.downBytesPerSec7Remotes') +
      budget('counters.net.hashesBytesPerS.ceiling')
    expect(perSec, `seed ${seed}: down bytes/s`).toBeLessThanOrEqual(ceiling)
  } finally {
    await h.dispose()
  }
})
