// M56: text-map layouts for belt scenarios, the TypeScript half of `sim/tests/common/layout.rs`
// (its module doc has the format: one two-character token per tile, tokens separated by single
// spaces, rows top to bottom; `x` grows east and `y` south, so the first row is the northmost; `..`
// empty, kind `b`/`s`/`d`/`S`/`u`/`x` (belt, spawner, despawner, splitter anchor, underground
// entrance, exit) then facing `^`/`>`/`v`/`<`, `--` a splitter's other tile). `LAYOUTS` holds the same
// text as the Rust `const`s; `layoutHash` is the same FNV-1a 64 over the placements (`x i32 | y i32 |
// dir u8 | kind u8`, little-endian), and both sides pin one hash per layout (`LAYOUT_HASHES` in
// `tests/unit/layout.test.ts` and `scenarios.rs`), so the two parsers cannot drift: a change to a
// layout moves both pins in one commit.
//
// `buildPaced` dispatches a layout through one headless client at the host's action rate (0004: 20
// a second, burst 40; `host/pacing.rs`) and within the client's pending queue (32,
// `OUTBOX_CAPACITY`), waiting for every verdict, and reports the ticks it used. Runtime-light, like
// `script.ts`: no runtime imports.

import type { HeadlessClient } from 'engine/test'
import type { BeltKind, Dir } from './game.js'

export type Placement = { x: number; y: number; dir: Dir; kind: BeltKind }
export type Layout = { placements: Placement[]; width: number; height: number }

/** The layouts, the same text as `sim/tests/common/layout.rs` (one place each side). */
export const LAYOUTS = {
  balancer: [
    '.. d^ d^ .. d^ d^',
    '.. S^ -- .. S^ --',
    '.. x^ b^ b> b^ b^',
    'b> u> b^ b^ x> b^',
    'b^ u^ b^ b^ .. ..',
    'S^ -- S^ -- .. ..',
    's^ s^ s^ s^ .. ..',
  ].join('\n'),
  'balancer-blocked': [
    '.. d^ d^ .. d^ b^',
    '.. S^ -- .. S^ --',
    '.. x^ b^ b> b^ b^',
    'b> u> b^ b^ x> b^',
    'b^ u^ b^ b^ .. ..',
    'S^ -- S^ -- .. ..',
    's^ s^ s^ s^ .. ..',
  ].join('\n'),
  ring: [
    'b> b> b> b> b> b> bv',
    'b^ .. .. .. .. .. bv',
    'b^ .. .. .. .. .. bv',
    'b^ .. .. .. .. .. bv',
    'b^ b< b< b< b< b< b<',
  ].join('\n'),
  'ring-fed': [
    '.. .. .. .. sv .. ..',
    'b> b> b> b> b> b> bv',
    'b^ .. .. .. .. .. bv',
    'b^ .. .. .. .. .. bv',
    'b^ .. .. sv .. .. bv',
    'b^ b< b< b< b< b< b<',
  ].join('\n'),
  'ring-splitter': [
    '.. .. .. .. sv .. ..',
    'b> b> S> b> b> b> bv',
    'b^ .. -- b> .. .. bv',
    'b^ .. .. .. .. .. bv',
    'b^ .. .. sv .. .. bv',
    'b^ b< b< b< b< b< b<',
  ].join('\n'),
  'sideload-chain': [
    '.. .. sv .. .. sv .. .. sv .. .. sv .. .. sv .. .. sv .. .. sv .. .. sv ..',
    's> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> b> d>',
  ].join('\n'),
} as const

export type LayoutName = keyof typeof LAYOUTS

const KINDS: Record<string, BeltKind> = {
  b: 'Belt',
  s: 'Spawner',
  d: 'Despawner',
  S: 'Splitter',
  u: 'UndergroundIn',
  x: 'UndergroundOut',
}
const FACINGS: Record<string, Dir> = { '^': 'North', '>': 'East', v: 'South', '<': 'West' }
/** `Dir` and `BeltKind` variant indexes (`sim/src/lib.rs`), the bytes the hash eats. */
const DIR_INDEX: Record<Dir, number> = { East: 0, South: 1, West: 2, North: 3 }
const KIND_INDEX: Record<BeltKind, number> = {
  Belt: 0,
  Spawner: 1,
  Despawner: 2,
  Splitter: 3,
  UndergroundIn: 4,
  UndergroundOut: 5,
}

/** The tiles a placement covers, relative to the layout: a splitter's second tile east of a
 * north/south splitter's anchor and south of an east/west one (the footprint's min corner is the
 * anchor, `content::belt_footprint`). */
export function footprint(p: Placement): Array<{ x: number; y: number }> {
  if (p.kind !== 'Splitter') return [{ x: p.x, y: p.y }]
  const other =
    p.dir === 'North' || p.dir === 'South' ? { x: p.x + 1, y: p.y } : { x: p.x, y: p.y + 1 }
  return [{ x: p.x, y: p.y }, other]
}

/** `Layout::parse`: placements in row-major order; throws on empty text, an unknown token, a ragged row, or a
 * `--` that is not exactly a splitter's other tile. */
export function parseLayout(text: string): Layout {
  const placements: Placement[] = []
  const others: string[] = []
  // One trailing newline and `\r\n` endings are accepted, empty text is not: the same rule as
  // Rust's `str::lines` in `Layout::parse`.
  const body = text.replace(/\r\n/g, '\n')
  const trimmed = body.endsWith('\n') ? body.slice(0, -1) : body
  if (trimmed === '') throw new Error('an empty layout')
  const rows = trimmed.split('\n')
  let width = -1
  rows.forEach((row, y) => {
    const tokens = row.split(' ')
    if (width === -1) width = tokens.length
    else if (tokens.length !== width) throw new Error(`row ${y}: ${JSON.stringify(row)} is ragged`)
    tokens.forEach((t, x) => {
      if (t.length !== 2) throw new Error(`(${x}, ${y}): token ${JSON.stringify(t)}`)
      if (t === '..') return
      if (t === '--') {
        others.push(`${x},${y}`)
        return
      }
      const kind = KINDS[t[0] as string]
      const dir = FACINGS[t[1] as string]
      if (kind === undefined || dir === undefined) {
        throw new Error(`(${x}, ${y}): unknown token ${JSON.stringify(t)}`)
      }
      placements.push({ x, y, dir, kind })
    })
  })
  const want = placements
    .filter((p) => p.kind === 'Splitter')
    .map((p) => footprint(p)[1] as { x: number; y: number })
    .map((t) => [t.x, t.y])
    .sort((a, b) => (a[1] as number) - (b[1] as number) || (a[0] as number) - (b[0] as number))
    .map(([x, y]) => `${x},${y}`)
  if (JSON.stringify(others) !== JSON.stringify(want)) {
    throw new Error(`\`--\` tiles ${others} are not the splitters' other tiles ${want}`)
  }
  return { placements, width, height: rows.length }
}

/** `Layout::hash`: FNV-1a 64 over the placements, 16 hex digits. */
export function layoutHash(layout: Layout): string {
  const MASK = (1n << 64n) - 1n
  let h = 0xcbf29ce484222325n
  const eat = (b: number) => {
    h ^= BigInt(b)
    h = (h * 0x100000001b3n) & MASK
  }
  const le32 = (v: number) => {
    const u = v >>> 0
    for (let k = 0; k < 4; k++) eat((u >>> (8 * k)) & 0xff)
  }
  for (const p of layout.placements) {
    le32(p.x)
    le32(p.y)
    eat(DIR_INDEX[p.dir])
    eat(KIND_INDEX[p.kind])
  }
  return h.toString(16).padStart(16, '0')
}

/** The tiles of `kind`'s placements at `origin`, row-major. */
export function tilesOf(
  layout: Layout,
  origin: { x: number; y: number },
  kind: BeltKind,
): Array<{ x: number; y: number }> {
  return layout.placements
    .filter((p) => p.kind === kind)
    .map((p) => ({ x: origin.x + p.x, y: origin.y + p.y }))
}

/** `RefScenario::lay`'s actions: every placement at `origin` (row-major), then each spawner's two
 * lanes making `feed[i]` (an `ItemId`) at saturation (rate index 3). */
export function layoutActions(layout: Layout, origin: { x: number; y: number }, feed: number[]) {
  const place = layout.placements.map((p) => ({
    PlaceBelt: { at: { x: origin.x + p.x, y: origin.y + p.y }, dir: p.dir, kind: p.kind },
  }))
  const spawners = tilesOf(layout, origin, 'Spawner')
  if (spawners.length !== feed.length) throw new Error('one item per spawner')
  const config = spawners.flatMap((at, i) =>
    [0, 1].map((lane) => ({ SetSpawner: { at, lane, item: feed[i], rate: 3 } })),
  )
  return [...place, ...config]
}

/** The host's action rate (0004 defaults) and the client's pending queue. */
const RATE_BURST = 40
const RATE_PER_TICK = 1 // 20 a second at 20 Hz
const OUTBOX = 32

/** Dispatches `actions` from `client` at the host's rate: a token bucket mirroring the host's (40
 * to start, one more a tick, at most 40) and at most 32 actions awaiting a verdict; advances one
 * tick at a time until every verdict is in. Throws on any verdict but `Confirmed`. Returns the ticks
 * it advanced. */
export async function buildPaced(
  client: HeadlessClient,
  advance: (ticks: number) => Promise<void>,
  actions: unknown[],
): Promise<{ ticks: number }> {
  const verdicts = new Map<number, unknown>()
  const off = client.onActionResult((seq, result) => {
    if (result !== 'NotPredictable') verdicts.set(seq, result)
  })
  try {
    const seqs: number[] = []
    let tokens = RATE_BURST
    let next = 0
    let ticks = 0
    while (next < actions.length || seqs.some((s) => !verdicts.has(s))) {
      const waiting = seqs.filter((s) => !verdicts.has(s)).length
      let room = Math.min(Math.floor(tokens), OUTBOX - waiting)
      while (room > 0 && next < actions.length) {
        seqs.push(client.dispatch(actions[next]))
        next++
        tokens--
        room--
      }
      await advance(1)
      ticks++
      tokens = Math.min(RATE_BURST, tokens + RATE_PER_TICK)
      if (ticks > 2_000) throw new Error('buildPaced: verdicts did not arrive')
    }
    for (const [i, s] of seqs.entries()) {
      const v = verdicts.get(s)
      if (v !== 'Confirmed') {
        throw new Error(
          `buildPaced: action ${i} ${JSON.stringify(actions[i])}: ${JSON.stringify(v)}`,
        )
      }
    }
    return { ticks }
  } finally {
    off()
  }
}
