// `belts/items_advance_on_the_item_clock` (M49, docs/decisions/0078 A12 revised): the items
// `fx-belts`' client draws (`transport::draw::draw_items`) sit on the item clock
// `clamp(hostNow, T, T + 4)` (`T` the follower's tick, `hostNow` the client's host-clock estimate,
// `interpCounters().hostClockNow`).
//
// - The median cell: one line of the 1/64 jam-free `SaturatedView` world, the median link profile,
//   12.5 ms frames for 60 ticks. After every frame each drawn item of the line is exactly where the
//   replica's items at `T` (`lineItems`) put it, moved `floor(p - speed * frac)`, mapped through the
//   line's one straight segment and the draw list's window origin (an item past the front of a held
//   `Next` is drawn on that line, out of this one's span; otherwise at the front). The clock never
//   stands still (a line holder gets a frame every tick), so every item strictly advances every
//   frame (no correction on this line in the window); the lead over the render time is pinned.
// - The level-4 cell: the same line under production hashing (a tick with nothing to say is a
//   header-only frame) through a 2.6 s stall (`degraded_client_follows`'s): levels 1, 2, 4, 2, 1,
//   every frame's draws checked as above (stall included: the engine's own clock, not only this
//   file's formula). A degraded hold keeps the latest header-only frame (`host/pacing.rs`), so a bundle's
//   last frame carries the current tick; the clock's frames are counted from the first bundle after
//   the stall.
import { expect, test } from 'vitest'
import { recordWorldPos } from '../../src/test/client.js'
import type { HeadlessClient } from '../../src/test/headless-client.js'
import { lineStructures } from '../../src/test/lines.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { beltsBenchWorld, beltsFixture } from './support.js'

const SMALL = { maxLines: 4_096, maxItems: 16_384 }
// M47b's reason (`belts-forecast.test.ts`): CI's runner is 5-10x slower than the local budget.
const FAST_TIMEOUT_MS = 60_000
const TICK_HZ = 20

/** The tested line's lane: tile row 0, lane 0 (a quarter tile in), the line under tile x 16. */
const LANE_Y = 64
const PICK_X = 16
const VIEW_X = 16
const HALF_W = 8
/** `view::visible_tile_rect`'s x range for the view: `floor(x -+ (halfW + 2))`: tiles 6..=26. */
const VIS_MIN = VIEW_X - HALF_W - 2
const VIS_MAX = VIEW_X + HALF_W + 2

/** The item clock seen frame to frame (any held line: the follower has one tick). */
interface Clocked {
  frames: number
  /** Frames whose item clock moved forward, stood still, or went back. */
  advanced: number
  frozen: number
  backward: number
}

function clockStep(c: Clocked, prev: number, now: number): number {
  const dt = now - prev
  if (dt > 0) c.advanced++
  else if (dt === 0) c.frozen++
  else c.backward++
  return dt
}

function itemTime(client: HeadlessClient, t: number): number {
  return Math.min(Math.max(client.interpCounters().hostClockNow, t), t + 4)
}

/** The picked line of a jam-free `SaturatedView` world under the narrow view, and its geometry. */
function pickLine(client: HeadlessClient) {
  const line = lineStructures(client).find((l) => {
    const s = l.segments[0]
    return (
      s?.kind === 'Straight' &&
      s.from[1] === LANE_Y &&
      s.from[0] <= PICK_X * 256 &&
      s.to[0] > PICK_X * 256
    )
  })
  if (!line) throw new Error('no held line under the picked tile')
  const seg = line.segments[0]
  if (seg?.kind !== 'Straight') throw new Error('one straight segment')
  return { line, fromX: seg.from[0] }
}

/**
 * What one frame drew of the picked line against where the follower's items at `T` put them on
 * the item clock (the line is jam-free: no stops). `d` is the follower as the previous frame left
 * it (a `stepFrame` draws, then applies arrivals). Returns the drawn x positions, the clock, `T`,
 * the items that crossed onto a held `Next`, or a failure.
 */
function drawnVsWant(
  client: HeadlessClient,
  picked: ReturnType<typeof pickLine>,
  d: ReturnType<HeadlessClient['lineItems']>,
): { got: number[]; it: number; t: number; crossed: number } | string {
  const { line, fromX } = picked
  const items = d?.lines[0]?.items
  if (!d || !items) return `line ${line.id} not held`
  const t = d.tick
  const it = itemTime(client, t)
  const frac = it - t
  const next = line.out.kind === 'Next' ? line.out.line : null
  const nextHeld = next !== null && client.lineItems(next) !== null
  const origin = client.drawsOrigin()
  const want: number[] = []
  let crossed = 0
  for (let k = 0; k < items.length; k += 2) {
    const p = items[k + 1] as number
    let q = Math.floor(p - line.speed * frac)
    if (q < 0 && nextHeld) {
      crossed++
      continue
    }
    q = Math.max(q, 0)
    const tileX = Math.floor((fromX + q) / 256)
    if (q >= line.len || tileX < VIS_MIN || tileX > VIS_MAX) continue
    want.push(Math.fround((fromX + q - origin.x * 256) / 256) + origin.x)
  }
  const got: number[] = []
  for (const r of client.draws()) {
    const [x, y] = recordWorldPos(r, origin)
    if (y * 256 === LANE_Y && x * 256 >= fromX && x * 256 < fromX + line.len) got.push(x)
  }
  got.sort((a, b) => a - b)
  want.sort((a, b) => a - b)
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    return `T ${t}, frac ${frac}: drawn ${JSON.stringify(got)} want ${JSON.stringify(want)}`
  }
  return { got, it, t, crossed }
}

test(
  'belts/items_advance_on_the_item_clock',
  async () => {
    const h = await createNetHarness({
      fixture: await beltsFixture(),
      seed: 4_901,
      clients: 1,
      clientFrameMs: 12.5,
      world: beltsBenchWorld({ SaturatedView: { jam_pct: 0, period: 0 } }, 64, SMALL),
    })
    try {
      const client = h.clients[0]
      if (!client) throw new Error('one client')
      // The median profile (`support.ts`'s `measure()`).
      h.link(0).set({ latencyMs: 40, jitterMs: 20 })
      // A narrow view (the client's 4 KiB `Tx` holds the structures of the lines it meets): tiles
      // 6..=26 drawn (`visible()` adds a 2-tile margin), the picked line culled outside them.
      client.setView({ x: VIEW_X, y: 1, halfW: HALF_W, halfH: 8 })
      // `tilesAcross` stays the camera default (32): 20 px a tile (the fixture style needs 4).
      client.setViewportPx(640, 640)
      await h.advanceTicks(20)
      const picked = pickLine(client)
      const { line, fromX } = picked

      const c: Clocked = { frames: 0, advanced: 0, frozen: 0, backward: 0 }
      let compared = 0
      let fronts = 0
      let crossed = 0
      let leadFirst = Number.NaN
      let leadLast = Number.NaN
      let prev: number[] | null = null
      let prevItemTime = Number.NaN
      let entered = 0
      let failure: string | null = null
      // A `stepFrame` draws (`frame`) and then applies what arrived (`pump`): a frame's draws are
      // of the follower as the previous frame left it, at this frame's `hostNow`.
      let held = client.lineItems(line.id)
      h.onFrame = () => {
        if (failure) return
        const d = held
        held = client.lineItems(line.id)
        const r = drawnVsWant(client, picked, d)
        if (typeof r === 'string') {
          failure = `frame ${c.frames}: ${r}`
          return
        }
        const { got, it } = r
        crossed += r.crossed
        // Frame to frame each item moves `speed x` the item clock's advance (floored: within one
        // position): its last-frame self is there. An item held at the front is exempt; an item with
        // no last-frame self behind every other came in at the back.
        if (prev) {
          const shift = (line.speed * clockStep(c, prevItemTime, it)) / 256
          const back = Math.max(...prev)
          for (const x of got) {
            if (x * 256 === fromX) {
              fronts++
              continue
            }
            const self = x + shift
            if (prev.some((px) => Math.abs(px - self) <= 1 / 256)) continue
            if (self > back + 1 / 256) {
              entered++
              continue
            }
            failure = `frame ${c.frames}: an item at ${x} (the clock ${prevItemTime} -> ${it}) has no last-frame self near ${self}`
            return
          }
        }
        prevItemTime = it
        prev = got
        const lead = it - client.interpCounters().renderTime
        if (c.frames === 0) leadFirst = lead
        leadLast = lead
        compared += got.length
        c.frames++
      }
      await h.advanceTicks(60)
      h.onFrame = null
      expect(failure).toBe(null)
      expect({ ...c, compared, fronts, crossed, entered, leadFirst, leadLast }).toEqual({
        frames: 240,
        advanced: 239,
        frozen: 0,
        backward: 0,
        compared: 20_160,
        fronts: 0,
        crossed: 0,
        entered: 22,
        // The interpolation delay (200 ms at the median profile, four ticks) and the clock's fraction.
        leadFirst: 4.074999999999999,
        leadLast: 4,
      })
    } finally {
      await h.dispose()
    }
  },
  FAST_TIMEOUT_MS,
)

test(
  'belts/item_clock_through_a_degraded_hold',
  async () => {
    const h = await createNetHarness({
      fixture: await beltsFixture(),
      seed: 4_902,
      clients: 1,
      clientFrameMs: 12.5,
      // Production hashing: a tick with nothing to say is a header-only frame (10 B), the shape the
      // hold replaces (hash-all would put hashes in every frame).
      world: {
        ...beltsBenchWorld({ SaturatedView: { jam_pct: 0, period: 0 } }, 64, SMALL),
        debugHashMode: 'production',
      },
    })
    try {
      const client = h.clients[0]
      if (!client) throw new Error('one client')
      client.setView({ x: VIEW_X, y: 1, halfW: HALF_W, halfH: 8 })
      client.setViewportPx(640, 640)
      await h.advanceTicks(20)
      const picked = pickLine(client)
      const line = picked.line
      const c: Clocked = { frames: 0, advanced: 0, frozen: 0, backward: 0 }
      const levels: number[] = []
      let landed = false
      let lastT = -1
      let maxFrac = 0
      let compared = 0
      let prevItemTime = Number.NaN
      let failure: string | null = null
      /** Frozen frames by clamp (`lower`: at `T`; `upper`: at `T + 4`) and degrade level. */
      const frozenAt: Record<string, number> = {}
      let held = client.lineItems(line.id)
      h.onFrame = () => {
        if (failure) return
        const d = held
        held = client.lineItems(line.id)
        // Every frame, stall included: the engine's draws on the item clock (exact positions).
        const r = drawnVsWant(client, picked, d)
        if (typeof r === 'string') {
          failure = `frame ${c.frames}: ${r}`
          return
        }
        const { it, t } = r
        compared += r.got.length
        const level = h.counters(0).degradeLevel
        if (levels[levels.length - 1] !== level) levels.push(level)
        // The first bundle after the stall: from here every frame is counted.
        if (!landed && level === 4 && t > lastT && lastT >= 0) landed = true
        lastT = Math.max(lastT, t)
        if (landed) {
          if (c.frames > 0 && clockStep(c, prevItemTime, it) === 0) {
            // A frozen frame: the clock at `T` (`hostNow` behind the follower) or at `T + 4`.
            const at = it === t ? 'lower' : it === t + 4 ? 'upper' : 'between'
            const key = `${at}@${level}`
            frozenAt[key] = (frozenAt[key] ?? 0) + 1
          }
          maxFrac = Math.max(maxFrac, it - t)
          c.frames++
        }
        prevItemTime = it
      }
      h.link(0).stall(2_600)
      await h.advanceTicks(3 * TICK_HZ + 12 * TICK_HZ)
      h.onFrame = null
      expect(failure).toBe(null)
      expect(levels, 'levels 1, 2, 4, then back down').toEqual([1, 2, 4, 2, 1])
      // Frozen frames by clamp and level (pinned below). At the lower clamp (14, all at level 4):
      // the bundles end at the current tick, so `T` runs ahead of `hostNow`, whose estimate the
      // stall pulled back (the stall outlasts `HostClock`'s 2 s window) and which catches up at the
      // 10 % dilation limit; the clock stands at `T` until `hostNow` passes it. At the upper clamp
      // (`T + 4`): none. A level-4 bundle steps `T` by 4, so with a cap of 3 the clock stood at
      // `T + 3` for about a tick of every bundle (32 frames on the `MixedFeeders` cell this test
      // ran before fix round 4; this line's cap-3 inject goes red in the stall first); with 4 only jitter past the hold
      // period could reach the cap, and none does in this window.
      expect({ ...c, maxFrac, frozenAt, compared }).toEqual({
        frames: 992,
        advanced: 977,
        frozen: 14,
        backward: 0,
        maxFrac: 4,
        frozenAt: { 'lower@4': 14 },
        compared: 100_800,
      })
    } finally {
      await h.dispose()
    }
  },
  FAST_TIMEOUT_MS,
)
