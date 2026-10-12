// `belts/*` (M46, docs/decisions/0078 §1, §4, §6): line structures replicate. The host builds lines
// from `fx-belts` requests (`Action::Request(op)`, executed on the next tick); a client holds the
// structure of every line whose chunk set meets its held chunks (`engine/test`'s `lineStructures`),
// loses it with `Gone` when the set leaves, gets a late subscribe's structures with the snapshots,
// and a corrupted structure resyncs through its anchor chunk's hash. Hash-all (the harness
// default) all along, so every `assertConverged` also proves the per-chunk structure hashes agree.
import { expect, test } from 'vitest'
import type { HeadlessClient } from '../../src/test/headless-client.js'
import { corruptLineStructure, type LineStructure, lineStructures } from '../../src/test/lines.js'
import { createNetHarness, type NetHarness } from '../../src/test/net-harness.js'
import { beltsFixture } from './support.js'

/** Small caps: the replica reserves what the world declares (0079 §5). */
const WORLD = { params: { maxLines: 64, maxItems: 1024 } } as const
/** Client 0 sits over the lines; client 1 far away until it moves in. */
const NEAR = { x: 24, y: 8, tilesAcross: 64 }
const FAR = { x: 3000, y: 3000, tilesAcross: 64 }
/** The chunk anchoring line 2 (index 1, from tile (8, 12)): the origin chunk. */
const ANCHOR = 0

type Pos = { x: number; y: number }

function request(op: unknown): unknown {
  return { Request: op }
}

/** One east-going straight segment along tile row `row` from tile `x0`, through tile centres. */
function straight(x0: number, row: number, tiles: number): unknown {
  return {
    Straight: {
      len: tiles * 256,
      from: { x: x0 * 256 + 128, y: row * 256 + 128 },
      to: { x: (x0 + tiles) * 256 + 128, y: row * 256 + 128 },
    },
  }
}

/** `Segments` for line index `line`. */
function segments(line: number, x0: number, row: number, tiles: number): unknown {
  const seg = straight(x0, row, tiles)
  return request({ Segments: { line, segments: [seg, 'None', 'None', 'None'] } })
}

/**
 * A chain request, its entity at the origin, where the lines and client 0 are too: it is spawned by
 * `apply` and gone by the next tick, which moves no chunk version (M48: a replica never sees it).
 */
function chain(tiles: number, speed: number): unknown {
  const from: Pos = { x: 0, y: 0 }
  return request({ Chain: { from, dir: 'East', tiles, speed } })
}

/** Sends `actions` from `client` a few at a time (the 20/s admission limit) and lets them land. */
async function run(h: NetHarness, client: HeadlessClient, actions: unknown[]): Promise<void> {
  for (const a of actions) {
    client.dispatch(a)
    await h.advanceTicks(2)
  }
  await h.advanceTicks(4)
  await h.settle()
}

/**
 * The scripted world, by chain index (`Global::lines`): line 0 is 48 tiles along row 4
 * from tile 8 (two chunks), cut at 16 tiles (index 2: the back part, `Next(0)`) and joined back;
 * line 1 is 8 tiles along row 12, extended back and re-segmented, then slowed; line 3 is made and
 * destroyed. Lines are named by host id in `lineStructures` (1 for index 0, and so on).
 */
async function build(h: NetHarness, client: HeadlessClient): Promise<void> {
  await run(h, client, [chain(48, 24), segments(0, 8, 4, 48), chain(8, 24), segments(1, 8, 12, 8)])
  // Cut (both parts lose their segments) and re-segment both parts.
  await run(h, client, [
    request({ Cut: { line: 0, at: 16 * 256 } }),
    segments(0, 8, 4, 16),
    segments(2, 24, 4, 32),
  ])
  // Join them back (back is destroyed, front grows) and re-segment.
  await run(h, client, [request({ Join: { front: 0, back: 2 } }), segments(0, 8, 4, 48)])
  // Extend line 1 at the back, re-segment, slow it down.
  await run(h, client, [
    request({ Extend: { line: 1, front: false, by: 4 * 256 } }),
    segments(1, 8, 12, 12),
    request({ Speed: { line: 1, speed: 12 } }),
  ])
  // A line that lives and dies while held.
  await run(h, client, [chain(4, 24), segments(3, 40, 20, 4), request({ Destroy: { line: 3 } })])
}

/** What `build` leaves: two lines (ids 1 and 2; 3 joined away, 4 destroyed). */
function expectBuilt(lines: LineStructure[]): void {
  expect(lines.map((l) => l.id)).toEqual([1, 2])
  expect(lines[0]).toMatchObject({ len: 48 * 256, speed: 24, out: { kind: 'DeadEnd' } })
  const [x0, x1, y] = [8 * 256 + 128, 56 * 256 + 128, 4 * 256 + 128]
  expect(lines[0]?.segments).toEqual([
    { len: 48 * 256, kind: 'Straight', from: [x0, y], to: [x1, y] },
  ])
  expect(lines[1]).toMatchObject({ len: 12 * 256, speed: 12, out: { kind: 'DeadEnd' } })
}

test('belts/structures_converge', async () => {
  const harness = await createNetHarness({
    fixture: await beltsFixture(),
    seed: 4601,
    clients: 2,
    world: WORLD,
  })
  try {
    const [near, far] = [harness.clients[0], harness.clients[1]]
    if (!near || !far) throw new Error('two clients')
    near.setCamera(NEAR)
    far.setCamera(FAR)
    await harness.advanceTicks(10)
    await build(harness, near)
    harness.assertConverged()
    expectBuilt(lineStructures(near))
    expect(lineStructures(far)).toEqual([])
    expect(harness.counters(0).sections.LineStructs ?? 0).toBeGreaterThan(0)
    expect(harness.counters(1).sections.LineStructs ?? 0).toBe(0)
    expect(near.lineStructures().structsDropped).toBe(0)
    expect(harness.desyncs()).toEqual([])
  } finally {
    await harness.dispose()
  }
})

test('belts/structure_gone_on_leave', async () => {
  const harness = await createNetHarness({
    fixture: await beltsFixture(),
    seed: 4602,
    clients: 1,
    world: WORLD,
  })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('one client')
    client.setCamera(NEAR)
    await harness.advanceTicks(10)
    await build(harness, client)
    expect(lineStructures(client).length).toBe(2)
    // Far away: past ring 3 and the 5 s hold every chunk of both lines' sets leaves.
    client.setCamera(FAR)
    await harness.advanceTicks(160)
    await harness.settle()
    expect(lineStructures(client)).toEqual([])
    harness.assertConverged()
    // And back: they come again.
    client.setCamera(NEAR)
    await harness.advanceTicks(20)
    await harness.settle()
    expectBuilt(lineStructures(client))
    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})

test('belts/structure_resync_after_corruption', async () => {
  const harness = await createNetHarness({
    fixture: await beltsFixture(),
    seed: 4603,
    clients: 1,
    world: WORLD,
  })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('one client')
    client.setCamera(NEAR)
    await harness.advanceTicks(10)
    await build(harness, client)
    harness.assertConverged()
    corruptLineStructure(client, 2)
    expect(lineStructures(client)[1]?.speed).toBe(13)
    await harness.advanceTicks(10)
    await harness.settle()
    // Line 2's anchor chunk mismatched (hash-all checks it in every frame until the host
    // has the `ResyncChunk`), was resent once, and holds the host's speed again.
    const reports = harness.desyncs()
    expect(reports.length).toBeGreaterThanOrEqual(1)
    for (const r of reports) expect(r).toMatchObject({ scope: 'chunk', cx: ANCHOR, cy: ANCHOR })
    expect(harness.hostDesyncs().count).toBe(1)
    expect(lineStructures(client)[1]?.speed).toBe(12)
    // The dump of the chunk's bytes shows the structure: the two encodings differ.
    const dumps = harness.desyncDumps()
    expect(dumps.length).toBe(1)
    expect(dumps[0]?.firstDiff).toBeGreaterThanOrEqual(0)
    harness.assertConverged()
    await harness.advanceTicks(20)
    await harness.settle()
    expect(harness.desyncs().length).toBe(reports.length)
    expect(harness.hostDesyncs().count).toBe(1)
  } finally {
    await harness.dispose()
  }
})

test('belts/late_subscriber_gets_snapshot_structures', async () => {
  const harness = await createNetHarness({
    fixture: await beltsFixture(),
    seed: 4604,
    clients: 2,
    world: WORLD,
  })
  try {
    const [near, late] = [harness.clients[0], harness.clients[1]]
    if (!near || !late) throw new Error('two clients')
    near.setCamera(NEAR)
    late.setCamera(FAR)
    await harness.advanceTicks(10)
    await build(harness, near)
    expect(lineStructures(late)).toEqual([])
    late.setCamera(NEAR)
    await harness.advanceTicks(20)
    await harness.settle()
    expect(lineStructures(late)).toEqual(lineStructures(near))
    expectBuilt(lineStructures(late))
    harness.assertConverged()
    // The anchor chunk entered by snapshot, so its structures rode the snapshot's frame.
    expect(harness.counters(1).sections.ChunkSnapshots ?? 0).toBeGreaterThan(0)
    expect(harness.counters(1).sections.LineStructs ?? 0).toBeGreaterThan(0)
  } finally {
    await harness.dispose()
  }
})

test('belts/resume_keeps_carry_structures', async () => {
  // M46 review, finding 2b: a same-epoch reconnect with a resume hint keeps the held chunks (no
  // line write moves a chunk version), while the new `Welcome` empties the replica's structures:
  // the host's enter scan of the kept chunks sends every one again.
  const harness = await createNetHarness({
    fixture: await beltsFixture(),
    seed: 4605,
    clients: 1,
    world: WORLD,
  })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('one client')
    client.setCamera(NEAR)
    await harness.advanceTicks(10)
    await build(harness, client)
    harness.assertConverged()
    const before = lineStructures(client)
    const keepsBefore = harness.counters(0).sections.ChunkKeeps ?? 0
    harness.link(0).disconnect()
    harness.link(0).reconnect()
    await harness.settle()
    await harness.advanceTicks(10)
    await harness.settle()
    expect(harness.counters(0).sections.ChunkKeeps ?? 0).toBeGreaterThan(keepsBefore)
    expect(lineStructures(client)).toEqual(before)
    expectBuilt(lineStructures(client))
    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})

test('belts/line_holder_frames_every_tick', async () => {
  // M49 (0078 A12 revised): a connection holding a line gets a frame every tick, header-only when
  // nothing changed, so its follower's tick tracks the host's. The idle cost: one client holding one
  // empty request-built line in a world with nothing else moving, 10 s at the default rates.
  const h = await createNetHarness({
    fixture: await beltsFixture(),
    seed: 4_621,
    clients: 1,
    // Production hashing (the 0013 schedule), not hash-all: the row pins the real hash bytes.
    hashAll: false,
    world: { ...WORLD, debugHashMode: 'production' },
  })
  try {
    const client = h.clients[0]
    if (!client) throw new Error('one client')
    client.setCamera(NEAR)
    await h.advanceTicks(10)
    await run(h, client, [chain(8, 24), segments(0, 8, 4, 8)])
    expect(lineStructures(client).map((l) => l.id)).toEqual([1])
    const c0 = h.counters(0)
    await h.advanceTicks(200)
    const c1 = h.counters(0)
    const section = (c: typeof c0, name: string) => c.sections[name] ?? 0
    const m = {
      frames: c1.frames - c0.frames,
      bytesPerSec: (c1.bytesDown - c0.bytesDown) / 10,
      headerPerSec: (c1.header - c0.header) / 10,
      hashesPerSec: (section(c1, 'Hashes') - section(c0, 'Hashes')) / 10,
    }
    if (process.env.MEASURE) console.log(`MEASURE holder ${JSON.stringify({ m, c1 })}`)
    // 20 frames (messages) a second: 10 B headers (200 B/s) and the 0013 hash schedule riding them
    // (68.6 B/s); a holder with nothing to say before M49 got the 500 ms heartbeat alone.
    expect(m, 'an idle line holder, 10 s').toEqual({
      frames: 200,
      bytesPerSec: 268.6,
      headerPerSec: 200,
      hashesPerSec: 68.6,
    })
  } finally {
    await h.dispose()
  }
})
