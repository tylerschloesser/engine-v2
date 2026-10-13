// M52 (Tests added): two players build one belt line together: a 7-tile east run, a curve turning
// north, a 2-tile north run and a feeder side-loading into it, the placements alternating between the
// two clients. The host maps the belts onto transport lines on its tick (`rules::belts::topology`);
// both replicas hold the same line structures (`lineStructures`: ids, lengths, outputs, segments),
// and they are the mapping the rules give: four line pairs, the curve's lanes 106 and 295 on one arc
// each, the run handing to the curve lane for lane, the feeder merging onto the north run's right
// lane at 64 and 192 past its first tile.

import { type LineStructure, lineStructures } from 'engine/test'
import { expect, test } from 'vitest'
import { refHarness } from '../helpers/net.js'
import { runScript, script, type Tile } from '../helpers/script.js'

/** Free land at `world.json`'s seed (no resource, no water): rows -8 to -6, columns -12 to -4. */
const RUN: Tile[] = [-12, -11, -10, -9, -8, -7, -6].map((x) => ({ x, y: -6 }))
const CURVE: Tile = { x: -5, y: -6 }
const NORTH: Tile[] = [
  { x: -5, y: -7 },
  { x: -5, y: -8 },
]
const FEEDER: Tile = { x: -4, y: -7 }

test('reference_belt_topology_converges', async () => {
  const r = await refHarness({ clients: 2, seed: 5200 })
  try {
    const steps: Array<[Tile, 'East' | 'North' | 'West']> = [
      ...RUN.map((t) => [t, 'East'] as [Tile, 'East']),
      [CURVE, 'North'],
      ...NORTH.map((t) => [t, 'North'] as [Tile, 'North']),
      [FEEDER, 'West'],
    ]
    for (const [i, [at, dir]] of steps.entries()) {
      const driver = r.drivers[i % 2]
      if (!driver) throw new Error('no driver')
      await runScript(script().placeBelt(at, dir), driver)
    }
    await r.h.settle()
    r.h.assertConverged()

    const [a, b] = [0, 1].map((i) => {
      const c = r.h.clients[i]
      if (!c) throw new Error(`no client ${i}`)
      return lineStructures(c)
    }) as [LineStructure[], LineStructure[]]
    expect(b, 'both replicas hold the same structures').toEqual(a)
    expect(a.map((l) => [l.len, l.speed]).sort((x, y) => x[0]! - y[0]!)).toEqual([
      [106, 24],
      [256, 24],
      [256, 24],
      [295, 24],
      [512, 24],
      [512, 24],
      [1792, 24],
      [1792, 24],
    ])
    const byLen = (len: number) => a.filter((l) => l.len === len)
    const [inner, outer] = [byLen(106)[0]!, byLen(295)[0]!]
    for (const l of [inner, outer]) {
      expect(l.segments.length).toBe(1)
      expect(l.segments[0]).toMatchObject({ kind: 'Arc', startTurnQ8: 0, sweepQ8: 64 })
    }
    // Each straight line's lane, from its segment's cross coordinate (README Lanes: lane 0 is the
    // belt's left, 68 positions from that edge; lane 1 its right, 188).
    const lane = (len: number, cross: number): LineStructure => {
      const l = byLen(len).find((x) => {
        const g = x.segments[0]
        return g?.kind === 'Straight' && (g.from[0] === cross || g.from[1] === cross)
      })
      if (!l) throw new Error(`no ${len}-long lane at ${cross}`)
      return l
    }
    // East run (row -6): lane 0 the north side (y -1536 + 68), lane 1 the south (+ 188); lane for
    // lane into the left curve, whose inner lane is lane 0.
    expect(lane(1792, -6 * 256 + 68).out).toEqual({ kind: 'Next', line: inner.id })
    expect(lane(1792, -6 * 256 + 188).out).toEqual({ kind: 'Next', line: outer.id })
    // North run (column -5, front tile (-5, -8)): lane 0 the west side (x -1280 + 68), lane 1 the
    // east (+ 188). The curve feeds it lane for lane.
    const north = [lane(512, -5 * 256 + 68), lane(512, -5 * 256 + 188)] as const
    expect([inner.out, outer.out]).toEqual([
      { kind: 'Next', line: north[0].id },
      { kind: 'Next', line: north[1].id },
    ])
    expect(north.map((l) => l.out.kind)).toEqual(['DeadEnd', 'DeadEnd'])
    // The feeder (west-going, east of (-5, -7), which starts at 256 on the north run) merges onto
    // the north run's near lane, lane 1: its lane 0 (the south side, nearer the target's back) at
    // 256 + 192, its lane 1 (north side) at 256 + 64.
    expect(lane(256, -7 * 256 + 188).out).toEqual({ kind: 'Merge', line: north[1].id, at: 448 })
    expect(lane(256, -7 * 256 + 68).out).toEqual({ kind: 'Merge', line: north[1].id, at: 320 })
  } finally {
    await r.dispose()
  }
}, 60_000)
