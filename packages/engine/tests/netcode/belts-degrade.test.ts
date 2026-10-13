// `belts/degraded_client_follows` and `belts/reconnect_reputs_structures` (M48b, docs/decisions/
// 0078 A8, 0079 §20): forecasts through a degraded connection and across a reconnect. Under degrade
// the host builds every tick's frame whole and holds it, then sends the held frames as one bundle
// (`host/pacing.rs`); the client applies a bundle's frames in order, catching up a frameless tick
// first (`on_frame`). A reconnect keeps the unchanged chunks (`ChunkKeeps`) but the client clears
// its structures at every `Welcome` and the host's line routing is per connection, so every held
// line is put again with its list.
import { expect, test } from 'vitest'
import { forecastCounters, type LineItemsDump, lineItems } from '../../src/test/lines.js'
import { createNetHarness, type NetHarness } from '../../src/test/net-harness.js'
import {
  arbitrate,
  beltsBenchWorld,
  beltsFixture,
  framesAfterWelcome,
  hostItems,
  pairs,
} from './support.js'

// Per-test timeouts (M47b's reason, `belts-forecast.test.ts`): CI's runner is 5-10x slower.
const FAST_TIMEOUT_MS = 60_000

const TICK_HZ = 20
/** The arbiter's small worlds' caps (`belts-forecast.test.ts`). */
const SMALL = { maxLines: 4_096, maxItems: 16_384 }
/** The 1/64 `SaturatedView` (20 %, 20) world (54 lines, ids 1..=54) and the view holding it all. */
const WORLD = () => beltsBenchWorld({ SaturatedView: { jam_pct: 20, period: 20 } }, 64, SMALL)
const VIEW = { x: 128, y: 1, halfW: 128, halfH: 72 }
const LINES = 54
const WIRE = { ChunkSnapshots: 5, LineStructs: 12, Forecasts: 13, ChunkKeeps: 11 } as const
/** `reconnect_reputs_structures`' request-built line, anchored in a kept chunk. */
const K = 55

/** What `degraded_client_follows` saw. */
interface Followed {
  /** Client forecast ticks compared (one a delivery: a bundle's frames apply in one pump, so only
   * its last tick is observable from here; the Rust twin compares every frame). */
  delivered: number
  /** Of those, while the host held frames (level 2 or 4). */
  deliveredDegraded: number
  compared: number
  items: number
  /** Line-ticks skipped at a compared delivery: the line not held (yet) or held `unknown`; and
   * those after the first delivery that held every line (the join's puts spill over frames). */
  skipped: number
  skippedAfterWhole: number
  /** A delivery has held every host line. */
  whole: boolean
  /** Deliveries that applied a correction late (`forecastSeenLate` grew): client tick, host tick,
   * how many. */
  lateDeliveries: { tick: number; host: number; late: number }[]
}

/**
 * After each host tick records the host's items; whenever the client's forecast tick moved (a frame
 * or bundle was applied), every line it holds must equal the host's at that tick. Never steps the
 * client itself: a frameless tick is caught up by the next frame's `on_frame`.
 */
async function follow(
  h: NetHarness,
  ticks: number,
  seen: Followed,
  history: Map<number, LineItemsDump>,
  onTick: (level: number) => void,
): Promise<void> {
  const client = h.clients[0]
  if (!client) throw new Error('one client')
  let last = -1
  let lateSoFar = forecastCounters(client).forecastSeenLate
  for (let i = 0; i < ticks; i++) {
    await h.advanceTicks(1)
    const hd = hostItems(h)
    history.set(hd.tick, hd)
    const level = h.counters(0).degradeLevel
    onTick(level)
    const any = lineItems(client, 1)
    if (any === null || any.tick === last || any.tick < 0) continue
    last = any.tick
    let partial = false
    const want = history.get(any.tick)
    if (!want) throw new Error(`tick ${any.tick}: no host record (host at ${hd.tick})`)
    for (const hl of want.lines) {
      const cd = lineItems(client, hl.id)
      const l = cd?.lines[0]
      if (!cd || !l || l.unknown) {
        seen.skipped++
        if (seen.whole) seen.skippedAfterWhole++
        else partial = true
        continue
      }
      if (cd.tick !== any.tick) throw new Error(`line ${hl.id} at ${cd.tick}, not ${any.tick}`)
      if (l.items.length !== hl.items.length || l.items.some((v, k) => v !== hl.items[k])) {
        expect(
          pairs(l.items),
          `tick ${any.tick} (host ${hd.tick}, level ${level}): line ${hl.id}: client vs host`,
        ).toEqual(pairs(hl.items))
      }
      seen.compared++
      seen.items += hl.items.length / 2
    }
    if (!partial) seen.whole = true
    const late = forecastCounters(client).forecastSeenLate
    if (late !== lateSoFar) {
      seen.lateDeliveries.push({ tick: any.tick, host: hd.tick, late: late - lateSoFar })
      lateSoFar = late
    }
    seen.delivered++
    if (level > 1) seen.deliveredDegraded++
    for (const t of history.keys()) if (t < any.tick) history.delete(t)
  }
}

test(
  'belts/degraded_client_follows',
  async () => {
    // A 2.6 s stall of both directions (`rates/degrade-on-stall`'s, under the link's 3 s dead-peer
    // timeout) backs the connection up past 12 ticks: level 2, then 4; the held frames go out as
    // bundles once it clears, and the level steps back down one per calm 2 s. The chunk pacing is
    // lifted (`beltsBenchWorld`), so the backlog alone degrades.
    const h = await createNetHarness({
      fixture: await beltsFixture(),
      seed: 4811,
      clients: 1,
      world: WORLD(),
    })
    try {
      const client = h.clients[0]
      if (!client) throw new Error('one client')
      client.setView(VIEW)
      const seen: Followed = {
        delivered: 0,
        deliveredDegraded: 0,
        compared: 0,
        items: 0,
        skipped: 0,
        skippedAfterWhole: 0,
        whole: false,
        lateDeliveries: [],
      }
      const history = new Map<number, LineItemsDump>()
      const levels: number[] = []
      const track = (level: number) => {
        // 0 before the connection attaches (the counters read nothing yet).
        if (level > 0 && levels[levels.length - 1] !== level) levels.push(level)
      }
      await follow(h, 20, seen, history, track)
      const before = forecastCounters(client)
      const bundlesBefore = h.counters(0).bundles
      h.link(0).stall(2_600)
      await follow(h, 3 * TICK_HZ + 12 * TICK_HZ, seen, history, track)
      const after = forecastCounters(client)
      const c = h.counters(0)
      if (process.env.MEASURE) {
        console.log(`MEASURE degraded ${JSON.stringify({ seen, levels, before, after, c })}`)
      }
      expect(levels, 'levels 1, 2, 4, then back down').toEqual([1, 2, 4, 2, 1])
      expect(
        {
          ...seen,
          bundles: c.bundles - bundlesBefore,
          maxEmitGap: c.maxEmitGap,
          states: after.stateMessagesApplied - before.stateMessagesApplied,
          lists: after.forecastsApplied - before.forecastsApplied,
          arrivals: after.arrivalsApplied - before.arrivalsApplied,
          late: after.forecastSeenLate - before.forecastSeenLate,
        },
        'the measured counts',
      ).toEqual(DEGRADED_PINS)
      expect(after.listsUnknown, 'unknown lists').toBe(0)
      expect(after.recordsUnheld, 'records for unheld lines').toBe(0)
      await h.settle()
      h.assertConverged()
    } finally {
      await h.dispose()
    }
  },
  FAST_TIMEOUT_MS,
)

/** `degraded_client_follows`' counts, pinned (seed 4811): a moved pin is a finding. */
// `late` is `forecastSeenLate`: corrections (States, and lists of lines held before their frame)
// applied from a frame whose tick the client had already rendered (`transport/follow.rs`, per
// record, not per delivery). All 30 come in one delivery (`lateDeliveries`, pinned), the bundle that
// ends the stall (host tick 71, frames up to 71): the client's render clock ran on through the
// stall. M49 (0078 A12 revised): a line holder gets a frame every tick, header-only when nothing
// changed, so more frames are delivered, held and compared (before: delivered 163, degraded 30,
// compared 8,789, items 665,987, the late bundle's frames up to 69, 35 bundles, max emit gap 5).
const DEGRADED_PINS = {
  delivered: 209,
  deliveredDegraded: 33,
  compared: 11_273,
  items: 853_940,
  skipped: 13,
  skippedAfterWhole: 0,
  whole: true,
  lateDeliveries: [{ tick: 71, host: 71, late: 30 }],
  bundles: 45,
  maxEmitGap: 4,
  states: 210,
  lists: 0,
  arrivals: 0,
  late: 30,
}

test(
  'belts/reconnect_reputs_structures',
  async () => {
    const h = await createNetHarness({
      fixture: await beltsFixture(),
      seed: 4812,
      clients: 1,
      world: WORLD(),
    })
    try {
      const client = h.clients[0]
      if (!client) throw new Error('one client')
      client.setView(VIEW)
      // K (line 55): eight items at rest on a dead end at tiles (64, 40)-(71, 40), anchored in chunk
      // (2, 1), which holds no entity: nothing moves its version, so the resume hint keeps it.
      const rest = [0, 64, 128, 192, 256, 320, 384, 448].map((pos, k) => [k + 1, pos])
      const build: Record<number, unknown> = {
        10: {
          Request: {
            Chain: { from: { x: 0, y: 0 }, dir: 'East', tiles: 8, speed: 24, items_at_rest: rest },
          },
        },
        12: {
          Request: {
            Segments: {
              line: 0,
              segments: [
                {
                  Straight: {
                    len: 8 * 256,
                    from: { x: 64 * 256 + 128, y: 40 * 256 + 128 },
                    to: { x: 72 * 256 + 128, y: 40 * 256 + 128 },
                  },
                },
                'None',
                'None',
                'None',
              ],
            },
          },
        },
      }
      await arbitrate(h, 0, 'join', 20, false, (i) => {
        const a = build[i]
        if (a !== undefined) client.dispatch(a)
      })
      await arbitrate(h, 0, 'joined', 40, true)
      const held = () => {
        let n = 0
        for (let id = 1; id <= LINES + 1; id++) if (lineItems(client, id) !== null) n++
        return n
      }
      expect(held(), 'every line held before the drop').toBe(LINES + 1)
      const before = forecastCounters(client)
      h.link(0).disconnect()
      h.link(0).reconnect()
      // Ticks until the new `Welcome` (it empties the replica's structures), then until every
      // line is held again (the hint keeps chunks, not lines); and the tick K is held again.
      let ticks = 0
      let kTicks = -1
      for (;;) {
        const welcomed = framesAfterWelcome(h.trace(), 0).welcomes >= 2
        if (welcomed && kTicks < 0 && lineItems(client, K) !== null) kTicks = ticks
        if (welcomed && held() === LINES + 1) break
        await h.advanceTicks(1)
        if (++ticks > 200) throw new Error(`not re-held after 200 ticks: ${held()} of ${LINES + 1}`)
      }
      const { frames } = framesAfterWelcome(h.trace(), 0)
      const sum = (id: number) => frames.reduce((a, f) => a + (f.sectionBytes.get(id) ?? 0), 0)
      const keeps = coordList(frames[0]?.bodies.get(WIRE.ChunkKeeps))
      const reheld = {
        ticks,
        kTicks,
        frames: frames.length,
        keeps: keeps.length,
        kAnchorKept: keeps.some(([x, y]) => x === 2 && y === 1),
        snapshotBytes: frames[0]?.sectionBytes.get(WIRE.ChunkSnapshots) ?? 0,
        structsBytes: sum(WIRE.LineStructs),
        forecastsBytes: sum(WIRE.Forecasts),
        lists: forecastCounters(client).forecastsApplied - before.forecastsApplied,
      }
      // Hash-all: a kept chunk whose anchored line were not put again would mismatch its hash
      // (the client lost the structure at the `Welcome`) and be resynced by snapshot.
      expect(h.desyncs(), 'no chunk resynced across the reconnect').toEqual([])
      expect(lineItems(client, K)?.lines[0]?.items, 'K re-held with its items').toEqual(rest.flat())
      // Items exact once re-held, every tick, every line.
      const mid = forecastCounters(client)
      const seen = await arbitrate(h, 0, 'after the reconnect', 40, true)
      const after = forecastCounters(client)
      if (process.env.MEASURE) {
        console.log(`MEASURE reconnect ${JSON.stringify({ reheld, seen, before, mid, after })}`)
      }
      expect(reheld, 'the reconnect, measured').toEqual(RECONNECT_PINS)
      expect(seen.ticks, 'every tick after the re-hold compared').toBe(40)
      expect(seen.partial, 'every line held from the first compared tick').toBe(0)
      expect(after.forecastSeenLate - mid.forecastSeenLate, 'forecastSeenLate after').toBe(0)
      expect(after.forecastsApplied - mid.forecastsApplied, 'no list after the re-hold').toBe(0)
      h.assertConverged()
    } finally {
      await h.dispose()
    }
  },
  FAST_TIMEOUT_MS,
)

/** `reconnect_reputs_structures`' figures, pinned (seed 4812): a moved pin is a finding. */
// M53 (0079 §21): `keeps` 82 and `snapshotBytes` 251 before. The spawners' schedules are line state,
// so their entities no longer write during the drop: the chunks holding them are unchanged, the
// resume hint keeps them too (six more) and nothing is snapshotted.
const RECONNECT_PINS = {
  ticks: 4,
  kTicks: 4,
  frames: 2,
  keeps: 88,
  kAnchorKept: true,
  snapshotBytes: 0,
  structsBytes: 1_894,
  forecastsBytes: 27_371,
  lists: 55,
}

/** A coordinate list body (`wire/coordlist.rs`: zigzag varint `(x, y)` pairs, the first absolute,
 * the rest deltas). */
function coordList(body: Uint8Array | undefined): [number, number][] {
  const out: [number, number][] = []
  if (!body) return out
  let at = 0
  const next = () => {
    let v = 0
    let shift = 0
    for (;;) {
      const b = body[at++] as number
      v += (b & 0x7f) * 2 ** shift
      if ((b & 0x80) === 0) break
      shift += 7
    }
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2
  }
  let x = 0
  let y = 0
  while (at < body.length) {
    x += next()
    y += next()
    out.push([x, y])
  }
  return out
}
