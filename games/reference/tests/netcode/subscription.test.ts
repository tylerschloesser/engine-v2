// M34c step 3 (M34c Scope): the subscription edge
// (`NotPredictable`, "reached only by luck" in `0003` Consequences) and a furnace on a chunk corner
// under partial subscription. Chunks are 32x32 tiles and a client holds ring 1 around its view
// (`0010` "Subscription set").
import { expect, test } from 'vitest'
import { advanceProbed, PREDICTED, refHarness, tornStateProbe, uiOf } from '../helpers/net.js'
import { FURNACE_A, runScript, script } from '../helpers/script.js'

const FURNACE = 4
const STONE = 0
/** Tiles (-65,-5) and (-64,-5) straddle chunk columns -3 and -2; land (found by trying origins near
 * the spawn; a worldgen change fails the `Confirmed` assertion below). */
const EDGE_ORIGIN = { x: -65, y: -5 }
/** An origin inside the view of the player at (-1, 2): predicts normally. */
const NEAR_ORIGIN = FURNACE_A
/** The corner of chunks (-2,-1), (-1,-1), (-2,0), (-1,0): a 2x2 origin on land (same way). */
const CORNER_ORIGIN = { x: -33, y: -1 }

const fmt = (o: unknown): string => JSON.stringify(o)

/**
 * One run of the edge scenario. A (camera at the stone, so ring 1 of its view is chunk columns -2..1
 * and rows -2..1) holds two furnace items. Another player's iron collect completes in A's view, so a
 * frame reaches A while its actions are still pending (an idle world sends none, and the taint rule
 * only acts when a frame replays the queue). A then dispatches `PlaceFurnace` at `EDGE_ORIGIN`
 * (column -3 is not held) when `withEdge`, and at `NEAR_ORIGIN` (in view, predictable) either way.
 */
async function edgeRun(seed: number, latencyMs: number, withEdge: boolean) {
  const tag = `seed ${seed}, ${latencyMs} ms, ${withEdge ? 'edge' : 'control'}`
  const r = await refHarness({
    clients: 2,
    seed,
    conditions: { latencyMs, jitterMs: 20 },
    cameras: [
      { x: -1, y: 2, tilesAcross: 20 },
      { x: 0, y: 0, tilesAcross: 20 },
    ],
  })
  try {
    const { h } = r
    const [a, b] = h.clients as [(typeof h.clients)[0], (typeof h.clients)[0]]
    await runScript(script().collect('stone', 10).craft(0).craft(0), r.drivers[0]!)
    await h.settle()
    expect(uiOf(h, 0).inventory, tag).toEqual([0, 0, 0, 0, 2, 0])
    expect(h.counters(0).heldChunks, `${tag}: ring 1 of A's view, 4 x 4 chunks`).toBe(16)

    // B starts collecting the iron at (0,0) and A dispatches on the tick the host finishes it.
    const entry = uiOf(h, 1).in_range.find((e) => e.tile.x === 0 && e.tile.y === 0)
    if (!entry) throw new Error(`${tag}: B has no iron in range`)
    // `done_at` once the host has confirmed it: before that, `Ui.collecting` is B's own prediction.
    let bConfirmed = false
    b.onActionResult((_s, res) => {
      if (res === 'Confirmed') bConfirmed = true
    })
    b.dispatch({ StartCollect: { tile: { x: 0, y: 0 }, from: entry.from } })
    let done = -1
    for (let i = 0; i < 60 && done < 0; i++) {
      await h.advanceTicks(1)
      if (bConfirmed) done = uiOf(h, 1).collecting?.done_at ?? -1
    }
    expect(done, `${tag}: B's collect began`).toBeGreaterThan(0)
    while (h.hostTick() < done) await h.advanceTicks(1)

    const seen: Array<[number, unknown]> = []
    a.onActionResult((s, res) => seen.push([s, res]))
    const verdictOf = (seq: number) =>
      seen.find(([s, res]) => s === seq && res !== 'NotPredictable')
    const probe = tornStateProbe(a)
    const edge = withEdge ? a.dispatch({ PlaceFurnace: { origin: EDGE_ORIGIN } }) : -1
    if (withEdge) probe.trackPlace(edge)
    const near = a.dispatch({ PlaceFurnace: { origin: NEAR_ORIGIN } })
    probe.trackPlace(near)
    const framesAtDispatch = h.counters(0).frames
    const ghostSeries: boolean[] = []
    let framesAtVerdict = framesAtDispatch
    // The step the `Ui` shows the item spent, and the step `draws()` first shows a real (not ghost)
    // sprite: `draws()` trails `ui()` by one step (measured here at each latency).
    let spentStep = -1
    let realStep = -1
    const itemBefore = uiOf(h, 0).inventory[FURNACE] ?? 0
    for (let step = 1; step <= 80 && (spentStep < 0 || realStep < 0); step++) {
      await advanceProbed(h, [probe], 1)
      if (spentStep < 0 && (uiOf(h, 0).inventory[FURNACE] ?? 0) < itemBefore) spentStep = step
      const sp = a.draws().filter((d) => d.kind === 0)
      if (realStep < 0 && sp.some((d) => (d.flags & PREDICTED) === 0)) realStep = step
      if (verdictOf(near) === undefined) {
        ghostSeries.push(sp.some((d) => (d.flags & PREDICTED) !== 0))
        framesAtVerdict = h.counters(0).frames
      }
    }
    expect(spentStep, `${tag}: the item was spent`).toBeGreaterThan(0)
    expect(realStep - spentStep, `${tag}: draws() trails ui() by one step`).toBe(1)
    expect(probe.frames, tag).toBeGreaterThan(4)
    // Declined at dispatch, each once: the edge placement (`Unknown`) and, by taint rule R1 (M25), the
    // valid placement behind it; both still sent, and the host confirms both.
    const verdicts = seen.filter(([, res]) => res !== 'NotPredictable')
    expect(
      seen.filter(([, res]) => res === 'NotPredictable'),
      `${tag}: ${fmt(seen)}`,
    ).toEqual(
      withEdge
        ? [
            [edge, 'NotPredictable'],
            [near, 'NotPredictable'],
          ]
        : [],
    )
    expect(
      verdicts.sort((x, y) => x[0] - y[0]),
      tag,
    ).toEqual((withEdge ? [edge, near] : [near]).map((s) => [s, 'Confirmed']))
    await h.settle()
    h.assertConverged()
    expect(uiOf(h, 0).inventory[FURNACE], `${tag}: the host took the item(s)`).toBe(
      withEdge ? 0 : 1,
    )
    return { ghostSeries, framesWhilePending: framesAtVerdict - framesAtDispatch, r, a, h, tag }
  } finally {
    await r.dispose()
  }
}

test('reference_subscription_edge_not_predictable', async () => {
  for (const latency of [60, 250]) {
    const seed = 3450 + latency
    const control = await edgeRun(seed, latency, false)
    const edge = await edgeRun(seed, latency, true)
    // Control (no edge action): the ghost of the in-view placement stays until the verdict, through the
    // frame that replays the queue.
    expect(control.framesWhilePending, control.tag).toBeGreaterThan(0)
    expect(control.ghostSeries.length, control.tag).toBeGreaterThan(2)
    expect(control.ghostSeries.every(Boolean), `${control.tag}: ${fmt(control.ghostSeries)}`).toBe(
      true,
    )
    // With the declined action ahead of it, taint rule R1 (M25) declines the later action at dispatch:
    // it is never predicted, so its ghost is never drawn although it is valid (no frame has to replay
    // the queue first).
    expect(edge.framesWhilePending, edge.tag).toBeGreaterThan(0)
    expect(edge.ghostSeries.length, edge.tag).toBeGreaterThan(2)
    expect(
      edge.ghostSeries.every((g) => !g),
      `${edge.tag}: never ghosted: ${fmt(edge.ghostSeries)}`,
    ).toBe(true)
  }
}, 60_000)

test('reference_furnace_across_chunk_border', async () => {
  const seed = 3451
  const r = await refHarness({
    clients: 3,
    seed,
    conditions: { latencyMs: 60, jitterMs: 20 },
    // A: at the stone; D holds all four chunks of the corner and draws the furnace; C holds the one at
    // its north-west only (view chunk (-3,-2), ring 1 = cols -4..-2 x rows -3..-1).
    cameras: [
      { x: -1, y: 2, tilesAcross: 20 },
      { x: -33, y: -1, tilesAcross: 20 },
      { x: -75, y: -45, tilesAcross: 20 },
    ],
  })
  try {
    const { h } = r
    const [a, d, c] = h.clients as [
      (typeof h.clients)[0],
      (typeof h.clients)[0],
      (typeof h.clients)[0],
    ]
    await runScript(script().collect('stone', 5).craft(0), r.drivers[0]!)
    await h.advanceTicks(40)
    expect(h.counters(1).heldChunks, `seed ${seed}: D holds 4 x 4`).toBe(16)
    expect(h.counters(2).heldChunks, `seed ${seed}: C holds 3 x 3`).toBe(9)

    a.setCamera({ x: -33, y: -1, tilesAcross: 20 })
    await h.advanceTicks(30)
    const cHashes = [c.replicaHash()]
    const hashBefore = h.counters(2).sections.Hashes ?? 0
    const verdicts: unknown[] = []
    a.onActionResult((_s, res) => verdicts.push(res))
    a.dispatch({ PlaceFurnace: { origin: CORNER_ORIGIN } })
    for (let i = 0; i < 40; i++) {
      await h.advanceTicks(1)
      cHashes.push(c.replicaHash())
    }
    expect(verdicts, `seed ${seed}: placed on the corner`).toEqual(['Confirmed'])
    await h.settle()
    h.assertConverged() // every held chunk's hash, hash-all, equals the host's (and no desync report)
    expect(h.desyncs(), `seed ${seed}`).toEqual([])
    expect(h.counters(2).sections.Hashes ?? 0, 'C was sent chunk hashes').toBeGreaterThan(
      hashBefore,
    )

    // C received the furnace once: its replica changed in exactly one frame, and never drew it (the
    // furnace is outside its view: a view that shows a tile of it holds all four chunks).
    const changes = cHashes.filter((x, i) => i > 0 && x !== cHashes[i - 1]).length
    expect(changes, `seed ${seed}: C's replica changed once`).toBe(1)
    expect(c.draws().filter((x) => x.kind === 0)).toEqual([])
    // D draws it: one real sprite.
    expect(
      d
        .draws()
        .filter((x) => x.kind === 0)
        .map((x) => x.flags & PREDICTED),
    ).toEqual([0])
    // The chunk C holds agrees with D's.
    expect(c.chunkHash(-2, -1), `seed ${seed}`).toBe(d.chunkHash(-2, -1))
    expect(c.chunkHash(-2, -1)).not.toBeNull()
  } finally {
    await r.dispose()
  }
}, 30_000)
