// `belts/edit_during_flow_converges` and `belts/predicted_request_is_not_predictable` (M48b,
// docs/decisions/0078 A8, 0079 §17 (f)): topology edits through real frames while items flow, and
// an action whose `apply` reads a line. Hash-all (the harness default), so every frame also checks
// the chunk hashes that cover the anchored structures; the arbiter (`support.ts`'s `arbitrate`)
// compares every held line's items with the host's every tick.
import { expect, test } from 'vitest'
import type { ActionOutcome } from '../../src/client.js'
import { forecastCounters, lineStructures } from '../../src/test/lines.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { arbitrate, beltsBenchWorld, beltsFixture, hostItems } from './support.js'

// Per-test timeouts (M47b's reason, `belts-forecast.test.ts`): CI's runner is 5-10x slower.
const FAST_TIMEOUT_MS = 60_000

/** The arbiter's small worlds' caps (`belts-forecast.test.ts`). */
const SMALL = { maxLines: 4_096, maxItems: 16_384 }

function request(op: unknown): unknown {
  return { Request: op }
}

/** A chain request from the origin (its entity is born and gone in one tick: no chunk version). */
function chain(tiles: number, speed: number): unknown {
  return request({ Chain: { from: { x: 0, y: 0 }, dir: 'East', tiles, speed } })
}

/** `Segments` for chain index `line`: one straight segment east along tile row `row` from tile
 * `x0`, through tile centres. */
function segments(line: number, x0: number, row: number, tiles: number): unknown {
  const seg = {
    Straight: {
      len: tiles * 256,
      from: { x: x0 * 256 + 128, y: row * 256 + 128 },
      to: { x: (x0 + tiles) * 256 + 128, y: row * 256 + 128 },
    },
  }
  return request({ Segments: { line, segments: [seg, 'None', 'None', 'None'] } })
}

/** The edit lines' row (chunk row 3): clear of the 1/64 saturated world's two belt rows (chunk
 * row 0), inside client 0's view, and the only lines client 1 holds. */
const ROW = 100

/**
 * The script, by arbitrated tick: two lines built (A, chain 0, at tiles 8-15, speed 64; B, chain 1,
 * at 24-31, speed 128; both 8 tiles), A feeding B into a sink and a spawner on A trying every tick,
 * so items stream along A 64 positions apart and along B 128 apart (B never packs); then, with both
 * lines carrying moving items, a cut of A in the middle of its stream (the back half is chain 2)
 * and both halves re-segmented, the join back, B extended at the back, B shrunk at the back (A's
 * output is set `DeadEnd` five ticks before, so B's rear drains clear: a shrink over an item is
 * refused, `NotEmpty`; A feeds B again after), A rescaled, B's speed changed and B destroyed. Each
 * length change clears the line's segments (0079 §13), so a `Segments` follows two ticks later.
 * Actions are two ticks apart or more (the 20/s admission rate).
 */
const SCRIPT: [number, unknown][] = [
  [0, chain(8, 64)],
  [2, segments(0, 8, ROW, 8)],
  [4, chain(8, 128)],
  [6, segments(1, 24, ROW, 8)],
  [8, request({ Link: { from_line: 0, to_line: 1 } })],
  [10, request({ Sink: { line: 1 } })],
  [12, request({ Spawner: { line: 0, item: 3, period: 256 } })],
  [100, request({ Cut: { line: 0, at: 4 * 256 } })],
  [102, segments(0, 8, ROW, 4)],
  [104, segments(2, 12, ROW, 4)],
  [107, request({ Join: { front: 0, back: 2 } })],
  [109, segments(0, 8, ROW, 8)],
  [160, request({ Extend: { line: 1, front: false, by: 4 * 256 } })],
  [162, segments(1, 24, ROW, 12)],
  [185, request({ DeadEnd: { line: 0 } })],
  [190, request({ Shrink: { line: 1, front: false, by: 2 * 256 } })],
  [192, segments(1, 24, ROW, 10)],
  [194, request({ Link: { from_line: 0, to_line: 1 } })],
  [220, request({ Rescale: { line: 0, new_len: 6 * 256 } })],
  [222, segments(0, 8, ROW, 6)],
  [250, request({ Speed: { line: 1, speed: 96 } })],
  [280, request({ Destroy: { line: 1 } })],
]
/** The host line each edit acts on (A 55, B 56, A's cut-off back half 57), by script tick. */
const EDITED: Record<number, number[]> = {
  100: [55],
  107: [55, 57],
  160: [56],
  190: [56],
  220: [55],
  250: [56],
  280: [56],
}
/** Ticks at which the script lines' structures are read (each a few ticks after an edit and its
 * `Segments`), from client 1, which holds only them (`client_line_structures` fits its `Tx`). */
const STRUCT_TICKS = [99, 106, 116, 166, 189, 198, 226, 256, 286]
/** Ticks (just before the speed change and the destroy) at which the gaps between B's items are
 * read on the host: a halted line packs at `SPACING` (64); B's stream keeps the gap its speed opens. */
const GAP_TICKS = [249, 279]
const EDIT_TICKS = 310

test(
  'belts/edit_during_flow_converges',
  async () => {
    // The 1/64 `SaturatedView` world at (20 %, 20) flows around the edits (its jams are `State`s);
    // the script's lines are request-built, since the bench lines are not in the chain table
    // (M47b Deviations), and its spawner is a request's.
    const h = await createNetHarness({
      fixture: await beltsFixture(),
      seed: 4801,
      clients: 2,
      world: beltsBenchWorld({ SaturatedView: { jam_pct: 20, period: 20 } }, 64, SMALL),
    })
    try {
      const [client, near] = [h.clients[0], h.clients[1]]
      if (!client || !near) throw new Error('two clients')
      client.setView({ x: 128, y: 40, halfW: 128, halfH: 72 })
      near.setView({ x: 24, y: ROW, halfW: 24, halfH: 6 })
      const results: ActionOutcome[] = []
      client.onActionResult((_seq, r) => {
        results.push(r)
      })
      await arbitrate(h, 0, 'join', 10)
      const before = forecastCounters(client)
      const script = new Map(SCRIPT)
      // Mid-script checks, before the tick is advanced: the cut's back half (57) is held between
      // the cut and the join (seven ticks apart: the back half, which holds A's schedule since the
      // cut (M53), feeds A), B (56) until it is destroyed; and the host's items on the line each
      // edit acts on, at the tick it is dispatched (every edit meets moving items).
      const held: Record<number, number[]> = {}
      const edited: Record<number, number[]> = {}
      const structs: Record<number, { id: number; len: number; speed: number; segs: number }[]> = {}
      const gaps: Record<number, number[]> = {}
      const seen = await arbitrate(h, 0, 'edits', EDIT_TICKS, false, (i) => {
        if (i === 107 || i === 265) {
          held[i] = [55, 56, 57].filter((id) => client.lineItems(id) !== null)
        }
        const targets = EDITED[i]
        if (targets !== undefined) {
          const lines = hostItems(h).lines
          edited[i] = targets.map((id) => (lines.find((x) => x.id === id)?.items.length ?? 0) / 2)
        }
        if (STRUCT_TICKS.includes(i)) {
          structs[i] = lineStructures(near).map((l) => ({
            id: l.id,
            len: l.len,
            speed: l.speed,
            segs: l.segments.length,
          }))
        }
        if (GAP_TICKS.includes(i)) {
          const it = hostItems(h).lines.find((x) => x.id === 56)?.items ?? []
          const g = new Set<number>()
          for (let k = 3; k < it.length; k += 2) g.add((it[k] as number) - (it[k - 2] as number))
          gaps[i] = [...g].sort((a, b) => a - b)
        }
        const a = script.get(i)
        if (a !== undefined) client.dispatch(a)
      })
      if (process.env.MEASURE) {
        console.log(`MEASURE edits-mid ${JSON.stringify({ structs, gaps, edited, held })}`)
      }
      expect(structs, 'script lines as held after each edit (len, speed, segments)').toEqual(
        STRUCTS,
      )
      expect(gaps, "gaps between B's items before the speed change and the destroy").toEqual(GAPS)
      expect(held, 'script lines held mid-run').toEqual({ 107: [55, 56, 57], 265: [55, 56] })
      expect(edited, 'host items on the edited line at each edit').toEqual(EDITED_ITEMS)
      await h.settle()
      const after = forecastCounters(client)
      const host = hostItems(h)
      if (process.env.MEASURE) {
        console.log(`MEASURE edits ${JSON.stringify({ seen, before, after, results })}`)
      }
      // Every action was applied (each Request predicts: no `NotPredictable`).
      expect(results, 'every request confirmed').toEqual(SCRIPT.map(() => 'Confirmed'))
      expect(seen.ticks, 'every tick compared').toBe(EDIT_TICKS)
      expect(seen.unknown, 'unknown lists').toBe(0)
      expect(after.recordsUnheld, 'records for unheld lines').toBe(0)
      expect(
        {
          caughtUp: seen.caughtUp,
          compared: seen.compared,
          items: seen.items,
          maxHeld: seen.maxHeld,
          held: seen.held,
          lines: seen.lines,
          states: after.stateMessagesApplied - before.stateMessagesApplied,
          lists: after.forecastsApplied - before.forecastsApplied,
          arrivals: after.arrivalsApplied - before.arrivalsApplied,
          late: after.forecastSeenLate - before.forecastSeenLate,
        },
        'the measured counts',
      ).toEqual(EDIT_PINS)
      // What the script leaves: A (55), 6 tiles, its back half (57) joined away and B (56)
      // destroyed; the bench's 54 lines untouched. The client holds A with the host's items (the
      // arbiter compared them every tick) and neither of the others.
      expect(
        host.lines.map((l) => l.id).filter((id) => id > 54),
        'script lines on the host',
      ).toEqual([55])
      expect(host.lines.find((l) => l.id === 55)?.items.length, 'A at the end: items').toBe(
        2 * A_ITEMS,
      )
      expect(client.lineItems(56), 'B gone from the client').toBeNull()
      expect(client.lineItems(57), "A's back half gone from the client").toBeNull()
      expect(client.lineItems(55)?.lines[0]?.items).toEqual(
        host.lines.find((l) => l.id === 55)?.items,
      )
      h.assertConverged()
    } finally {
      await h.dispose()
    }
  },
  FAST_TIMEOUT_MS,
)

/** `edit_during_flow_converges`' counts, pinned (seed 4801): a moved pin is a finding. */
// M49 (0078 A12 revised): `caughtUp` was 10 (ticks no frame came for); a line holder now gets a
// frame every tick. M53 (0079 §21): `items` was 1,279,680; the cut's back half holds A's schedule
// until the join and carries more items between them (`EDITED_ITEMS`' tick 107).
const EDIT_PINS = {
  caughtUp: 0,
  compared: 17_313,
  items: 1_279_985,
  maxHeld: 57,
  held: 55,
  lines: 55,
  states: 264,
  lists: 15,
  arrivals: 16,
  late: 0,
}
/** Script line structures as client 1 holds them at each `STRUCT_TICKS` tick (pinned). */
const STRUCTS = {
  99: [
    { id: 55, len: 2048, speed: 64, segs: 1 },
    { id: 56, len: 2048, speed: 128, segs: 1 },
  ],
  106: [
    { id: 55, len: 1024, speed: 64, segs: 1 },
    { id: 56, len: 2048, speed: 128, segs: 1 },
  ],
  116: [
    { id: 55, len: 2048, speed: 64, segs: 1 },
    { id: 56, len: 2048, speed: 128, segs: 1 },
  ],
  166: [
    { id: 55, len: 2048, speed: 64, segs: 1 },
    { id: 56, len: 3072, speed: 128, segs: 1 },
  ],
  189: [
    { id: 55, len: 2048, speed: 64, segs: 1 },
    { id: 56, len: 3072, speed: 128, segs: 1 },
  ],
  198: [
    { id: 55, len: 2048, speed: 64, segs: 1 },
    { id: 56, len: 2560, speed: 128, segs: 1 },
  ],
  226: [
    { id: 55, len: 1536, speed: 64, segs: 1 },
    { id: 56, len: 2560, speed: 128, segs: 1 },
  ],
  256: [
    { id: 55, len: 1536, speed: 64, segs: 1 },
    { id: 56, len: 2560, speed: 96, segs: 1 },
  ],
  286: [{ id: 55, len: 1536, speed: 64, segs: 1 }],
}
/** B's item gaps (pinned): 128 at speed 128, 96 after the change to 96. */
const GAPS = { 249: [128], 279: [96] }
/** Host items on the edited line at each edit's dispatch tick (pinned). */
// M53 (0079 §21): the cut moves A's schedule to its back half (57), which keeps taking the inserts
// until the join moves it back: 57 holds 15 at the join (10 before, when the spawner kept inserting
// at the front half's back and 57 only drained).
const EDITED_ITEMS: Record<number, number[]> = {
  100: [31],
  107: [16, 15],
  160: [16],
  190: [21],
  220: [31],
  250: [20],
  280: [27],
}
/** A's items at the end (pinned): 6 tiles packed at 64 positions an item behind a dead end. */
const A_ITEMS = 24

test(
  'belts/predicted_request_is_not_predictable',
  async () => {
    // `Action::Probe` reads `lines_at` in `apply`: the client's `Predicting` answers `Unknown` to
    // every transport read (0079 §17 (f)), so the dispatch reports `NotPredictable` (no ghost); the
    // host runs the read, finds the tile free and spawns its `Op::Belt` request, whose line reaches
    // the client with its list. A second probe of the same tile: `NotPredictable` again, and the
    // host's verdict `Occupied`. A plain `Request` (no read) predicts: `Confirmed` alone.
    const h = await createNetHarness({
      fixture: await beltsFixture(),
      seed: 4802,
      clients: 1,
      world: { params: { maxLines: 64, maxItems: 1_024 } },
    })
    try {
      const client = h.clients[0]
      if (!client) throw new Error('one client')
      client.setCamera({ x: 24, y: 8, tilesAcross: 64 })
      await h.advanceTicks(10)
      const results: { seq: number; r: ActionOutcome }[] = []
      client.onActionResult((seq, r) => {
        results.push({ seq, r })
      })
      const probe = client.dispatch({ Probe: { tile: { x: 8, y: 4 } } })
      await h.advanceTicks(1)
      expect(results, 'the probe is NotPredictable at dispatch').toEqual([
        { seq: probe, r: 'NotPredictable' },
      ])
      await h.advanceTicks(10)
      await h.settle()
      expect(results.slice(1), "the host's verdict").toEqual([{ seq: probe, r: 'Confirmed' }])
      expect(lineStructures(client), 'the probed line, held').toEqual([
        {
          id: 1,
          len: 4 * 256,
          speed: 24,
          out: { kind: 'DeadEnd' },
          segments: [
            {
              len: 4 * 256,
              kind: 'Straight',
              from: [8 * 256 + 128, 4 * 256 + 128],
              to: [12 * 256 + 128, 4 * 256 + 128],
            },
          ],
        },
      ])
      // Its list: the four items at rest packed against the dead end, the host's exactly.
      const seen = await arbitrate(h, 0, 'probe', 20)
      expect(seen.compared, 'line-ticks compared').toBe(20)
      expect(client.lineItems(1)?.lines[0]?.items, 'items as [item, pos]').toEqual([
        1, 0, 1, 64, 1, 128, 1, 192,
      ])
      expect(forecastCounters(client).forecastsApplied, 'its list, with its put').toBe(1)
      // A request that reads no line predicts (its spawn is in a held chunk): no record at dispatch.
      // Dispatched alone: a `NotPredictable` taints every later pending action until it pops.
      results.length = 0
      const plain = client.dispatch({ Request: { Speed: { line: 0, speed: 12 } } })
      await h.advanceTicks(10)
      await h.settle()
      expect(results, 'a request that reads nothing').toEqual([{ seq: plain, r: 'Confirmed' }])
      results.length = 0
      const again = client.dispatch({ Probe: { tile: { x: 9, y: 4 } } })
      await h.advanceTicks(10)
      await h.settle()
      expect(results, 'a probe of an occupied tile').toEqual([
        { seq: again, r: 'NotPredictable' },
        { seq: again, r: { Rejected: { Game: 'Occupied' } } },
      ])
      h.assertConverged()
    } finally {
      await h.dispose()
    }
  },
  FAST_TIMEOUT_MS,
)
