// `soak-netcode @slow` (M36 step 7): the reference game with
// eight headless players over a conditioned link for 30 virtual minutes (36,000 ticks at 20 Hz). Two
// players keep an economy cycle going (place a furnace, pick it up, again) beside the stone landmark;
// six tour the map in large views (subscription churn, chunk generation, presence) and are dropped
// and brought back on a schedule. At the end every client's replica hash equals the host's region hash
// at quiescence; across the whole run the sim instance never grew; its memory is the same from minute
// 5 on; and each client's downlink stayed inside the `net.*` budgets of `budgets.json`.
//
// Wall-clock: the netcode suite runs on a virtual clock and nothing here sleeps, so the 30 virtual
// minutes cost about 8 s of real time (36,128 ticks, dev profile, measured on Tyler's Mac at load 3).
import { serverInternals } from 'engine/test'
import { expect, test } from 'vitest'
import { budget } from '../../../../packages/engine/tests/support/budgets.js'
import { type RefHarness, refHarness } from '../helpers/net.js'
import { FURNACE_A, FURNACE_B, runScript, script, type Tile } from '../helpers/script.js'

const TICKS_PER_MINUTE = 20 * 60
const MINUTES = 30
const CLIENTS = 8
/** Clients 0 and 1 run the furnace cycle; 2 to 7 tour and are dropped in turn. */
const ECONOMY = 2
const TICKS_PER_HOUR = 20 * 3600
/** Every `DROP_EVERY_TICKS` the next touring client loses its link for `DROP_FOR_TICKS`. */
const DROP_EVERY_TICKS = 2 * TICKS_PER_MINUTE
const DROP_FOR_TICKS = 800
/** The longest a client takes to dial again after an outage (dead timer plus the capped backoff). */
const REDIAL_TICKS = 220
/**
 * A tight arena, not the 96 MiB default: the soak's live set is under 5 MiB (a 4 MiB arena traps in
 * `engine_init`, 5 MiB passes with zero grows: probed), so 8 MiB leaves 60 % headroom and a leak of
 * 3 MiB over the 30 minutes (about 100 B a tick) exhausts it. With the default arena the same leak
 * would need 90 MiB, and "memory flat" could not fail for anything small. The module exposes no live-byte
 * accessor (0014), so the reservation is the detector: a dev build traps when it is exceeded.
 */
const SOAK_ARENA_BYTES = 8 << 20
const standBy = (o: Tile): Tile => ({ x: o.x - 5, y: o.y })

/** mulberry32: a seeded stream for the tours (the harness's own seed drives the conditioner). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Sample = { minute: number; memoryBytes: number; grows: number }

/** Runs the soak on `r`; returns the per-minute memory samples of the sim instance. */
async function runSoak(r: RefHarness, seed: number, minutes: number): Promise<Sample[]> {
  const { h, drivers } = r
  const raw = serverInternals(h.server).rawInstance
  if (!raw) throw new Error('soak: no live sim instance')
  const next = rng(seed)
  const end = minutes * TICKS_PER_MINUTE
  const samples: Sample[] = []
  const sample = (minute: number): void => {
    samples.push({ minute, memoryBytes: raw.memoryBytes(), grows: raw.memGrows() })
  }

  // The economy players mine their five stones each (the landmark holds ten) and craft a furnace.
  for (const i of [0, 1]) {
    await runScript(
      script()
        .collect('stone', 5)
        .craft(0)
        .panTo(standBy(i === 0 ? FURNACE_A : FURNACE_B)),
      drivers[i] as (typeof drivers)[0],
    )
  }

  let nextWaypoint = 0
  let nextDrop = DROP_EVERY_TICKS
  let dropped: { i: number; back: number; redialed: boolean } | null = null
  let dropCount = 0
  let rejoins = 0
  let sampledMinute = -1

  while (h.hostTick() < end) {
    const t = h.hostTick()
    const minute = Math.floor(t / TICKS_PER_MINUTE)
    if (minute !== sampledMinute) {
      sampledMinute = minute
      sample(minute)
    }
    // Tours: a fresh waypoint for every touring client every 30 virtual seconds.
    if (t >= nextWaypoint) {
      nextWaypoint = t + 30 * 20
      for (let i = ECONOMY; i < CLIENTS; i++) {
        const c = h.clients[i]
        if (!c || dropped?.i === i) continue
        c.setCamera({ x: (next() - 0.5) * 900, y: (next() - 0.5) * 900, tilesAcross: 96 })
        c.panTo((next() - 0.5) * 900, (next() - 0.5) * 900, 6 + next() * 10)
      }
    }
    // Scripted drops and rejoins.
    if (dropped === null && t >= nextDrop) {
      const i = ECONOMY + (dropCount % (CLIENTS - ECONOMY))
      h.link(i).disconnect()
      dropped = { i, back: t + DROP_FOR_TICKS, redialed: false }
      dropCount++
      nextDrop += DROP_EVERY_TICKS
    } else if (dropped !== null && !dropped.redialed && t >= dropped.back) {
      h.link(dropped.i).reconnect()
      dropped.redialed = true
    } else if (dropped?.redialed && t >= dropped.back + REDIAL_TICKS) {
      expect(
        h.clients[dropped.i]?.status().linkDown ?? null,
        `seed ${seed}: client ${dropped.i} is back at tick ${t}`,
      ).toBeNull()
      rejoins++
      dropped = null
    }
    // One economy cycle per iteration: place, wait, pick up, wait (both players, in turn).
    for (const [i, at] of [
      [0, FURNACE_A],
      [1, FURNACE_B],
    ] as const) {
      const d = drivers[i] as (typeof drivers)[0]
      await d.place(at)
      await d.waitTicks(40)
      await d.pickUp(at, false)
      await d.waitTicks(20)
    }
  }
  // Quiesce: everybody online, nobody moving, every pending delivery and verdict released.
  if (dropped !== null) {
    if (!dropped.redialed) h.link(dropped.i).reconnect()
    await h.advanceTicks(REDIAL_TICKS)
    dropped = null
  }
  for (let i = ECONOMY; i < CLIENTS; i++) h.clients[i]?.setCamera({ x: 0, y: 0, tilesAcross: 96 })
  await h.settle()
  sample(minutes)
  expect(rejoins, `seed ${seed}: drops and rejoins happened`).toBeGreaterThanOrEqual(
    Math.floor(minutes / 2) - 1,
  )
  return samples
}

test('soak-netcode @slow', async () => {
  const seed = 3601
  // Production hash cadence (`hashAll: false`, as `counters.test.ts`): this measures what a player pays.
  const r = await refHarness({
    clients: CLIENTS,
    seed,
    conditions: { latencyMs: 60, jitterMs: 20 },
    hashAll: false,
    ...{ world: { arenaBytes: SOAK_ARENA_BYTES } },
  })
  try {
    const { h } = r
    const samples = await runSoak(r, seed, MINUTES)

    // Replica hash equality at quiescence: every client's replica against the host's region hash.
    h.assertConverged()

    // Zero grows, and the memory high-water mark is flat from minute 5 on.
    for (const s of samples) {
      expect(s.grows, `seed ${seed}: sim memGrows at minute ${s.minute}`).toBe(0)
    }
    const atFive = samples.find((s) => s.minute === 5)
    expect(atFive, 'a sample at minute 5').toBeDefined()
    for (const s of samples.filter((x) => x.minute >= 5)) {
      expect(s.memoryBytes, `seed ${seed}: sim memory at minute ${s.minute}`).toBe(
        atFive?.memoryBytes,
      )
    }

    // The numbers the plan's Deviations quote.
    const per = Array.from({ length: CLIENTS }, (_, i) => h.counters(i))
    console.log(
      `soak-netcode: ${h.hostTick()} ticks, sim memory ${atFive?.memoryBytes} B (grows ${samples.at(-1)?.grows}), ` +
        `bytes down per client ${per.map((c) => c.bytesDown).join('/')}, ` +
        `worst second ${Math.max(...per.map((c) => c.worstSecondBytesDown))} B`,
    )
    // `net.*` budgets, per client: the hour's bytes at this run's rate, and the worst second.
    const ticks = h.hostTick()
    const perHour = budget('counters.net.bytesPerHour.ceiling')
    const perSecond = budget('counters.net.hardCeilingBytesPerS.ceiling')
    for (let i = 0; i < CLIENTS; i++) {
      const c = h.counters(i)
      expect(
        Math.round((c.bytesDown / ticks) * TICKS_PER_HOUR),
        `seed ${seed}: client ${i} bytes down per hour`,
      ).toBeLessThanOrEqual(perHour)
      expect(c.worstSecondBytesDown, `seed ${seed}: client ${i} worst second`).toBeLessThanOrEqual(
        perSecond,
      )
    }
  } finally {
    await r.dispose()
  }
}, 900_000)
