// `busy-furnace-field @slow` (docs/plan/36b-suite-audit-and-measurements.md, "Byte diffing: measure,
// do not build"; 0010's worked example, M15's question, 0011's byte-diffing deferral). The reference
// game on its `bench` save with 200 (then 1,000, for scale) lit, stocked furnaces whose smelt timers
// are uniformly staggered, all inside one client's view, plus two players taking once per second,
// 60 virtual seconds after every chunk has arrived. The build carries cargo feature `measure-diff`
// (`engine::host::measure_diff`): beside the real encoding, the host counts what a byte-mask diff of
// every entity put would have sent. Production hashing (`hashAll: false`), never the harness's
// hash-all default (M31b R1).
//
// This is a REPORT, not a gate (the field is heavier than typical play): the test asserts only that
// both counters are non-zero and that two runs of the same seed agree; the decision reads
// `test-results/netcode/busy-furnace-field.json`. `rates/steady-busy-field`'s fixture-level twin
// (`fx-busy-field`, the same 5 s window) is recorded in the same file.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, test } from 'vitest'
import { type BuildGameResult, buildGame } from '../../src/build-game.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { benchBudgets, benchWorldConfig, REFERENCE_SIM } from '../support/bench-build.js'
import { fixtureDir } from '../support/fixtures.js'

const TICK_HZ = 20
const WINDOW_SECONDS = 60
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const OUT = join(REPO, 'test-results/netcode/busy-furnace-field.json')

let bench: BuildGameResult
let fixture: BuildGameResult
beforeAll(async () => {
  // The same module the bench tests run, plus the counters: its own build hash, never joined to a
  // normal server, never shipped.
  bench = await buildGame({
    crate: REFERENCE_SIM,
    profile: 'release',
    features: ['bench', 'measure-diff'],
  })
  fixture = await buildGame({
    crate: fixtureDir('busy-field'),
    profile: 'dev',
    features: ['measure-diff'],
  })
}, 240_000)

type Window = {
  bytesDown: number
  bytesPerSec: number
  chunkDeltasBytes: number
  diffBytesWhole: number
  diffBytesMasked: number
  /** masked / whole: below 1 is what a diff would save. */
  maskedOverWhole: number
  degradeLevel: number
  collapses: number
}

const report: Record<string, unknown> = {}
const record = (name: string, value: unknown): void => {
  report[name] = value
  mkdirSync(join(REPO, 'test-results/netcode'), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`busy-furnace-field ${name} ${JSON.stringify(value)}`)
}

/** `bench.rs`'s layout: furnace `i` of a save with `n` furnaces (200 per chunk, `cols` chunks wide). */
function furnaceTile(i: number, n: number): { x: number; y: number } {
  const chunks = Math.ceil(n / 200)
  let cols = 1
  while (cols * cols < chunks) cols++
  const chunk = Math.floor(i / 200)
  const slot = i % 200
  return {
    x: (chunk % cols) * 32 + (slot % 16) * 2,
    y: Math.floor(chunk / cols) * 32 + Math.floor(slot / 16) * 2,
  }
}

async function runField(furnaces: number, seed: number): Promise<Window & { takes: number[] }> {
  // `benchWorldConfig`'s scale divides the 262,144-furnace save: 200 is 1/1310, 1,000 is 1/262.
  const scale = Math.round(262_144 / furnaces)
  const cfg = benchWorldConfig(bench.buildHash, scale)
  const harness = await createNetHarness({
    fixture: bench.dir,
    seed,
    worldSeed: cfg.params.seed,
    clients: 3,
    hashAll: false,
    world: { params: { worldgen: cfg.params.worldgen, ...benchBudgets(scale) } },
  })
  try {
    // Everyone sees the whole field: client 0 only watches, 1 and 2 also act.
    const chunks = Math.ceil(furnaces / 200)
    const side = Math.ceil(Math.sqrt(chunks)) * 16
    for (const c of harness.clients) {
      c.setView({ x: side, y: side, halfW: side + 16, halfH: side + 16 })
    }
    let quiet = 0
    for (let t = 0; t < 600 && quiet < 5; t += 10) {
      await harness.advanceTicks(10)
      const c = harness.counters(0)
      quiet = c.heldChunks > 0 && c.queuedEnters === 0 ? quiet + 1 : 0
    }
    expect(quiet, 'every chunk arrived').toBeGreaterThanOrEqual(5)

    const outcomes: number[] = [0, 0] // confirmed, rejected
    for (const c of [harness.clients[1], harness.clients[2]]) {
      c?.onActionResult((_seq, res) => {
        if (res === 'Confirmed') outcomes[0] = (outcomes[0] ?? 0) + 1
        else if (res !== 'NotPredictable') outcomes[1] = (outcomes[1] ?? 0) + 1
      })
    }
    const before = harness.counters(0)
    const diffBefore = harness.diffBytes(0)
    for (let s = 0; s < WINDOW_SECONDS; s++) {
      for (const [a, c] of [harness.clients[1], harness.clients[2]].entries()) {
        const at = furnaceTile((s * 37 + a * 101) % furnaces, furnaces)
        c?.dispatch({ FurnaceTake: { at } })
      }
      await harness.advanceTicks(TICK_HZ)
    }
    const after = harness.counters(0)
    const diffAfter = harness.diffBytes(0)
    const whole = diffAfter.whole - diffBefore.whole
    const masked = diffAfter.masked - diffBefore.masked
    const bytesDown = after.bytesDown - before.bytesDown
    return {
      bytesDown,
      bytesPerSec: Math.round(bytesDown / WINDOW_SECONDS),
      chunkDeltasBytes: (after.sections.ChunkDeltas ?? 0) - (before.sections.ChunkDeltas ?? 0),
      diffBytesWhole: whole,
      diffBytesMasked: masked,
      maskedOverWhole: Number((masked / whole).toFixed(3)),
      degradeLevel: after.degradeLevel,
      collapses: after.collapses,
      takes: outcomes,
    }
  } finally {
    await harness.dispose()
  }
}

test('busy-furnace-field 200 furnaces @slow', async () => {
  const a = await runField(200, 3601)
  expect(a.diffBytesWhole, 'whole-value put bytes counted').toBeGreaterThan(0)
  expect(a.diffBytesMasked, 'masked bytes counted').toBeGreaterThan(0)
  const again = await runField(200, 3601)
  expect(again, 'reproducible for the seed').toEqual(a)
  record('furnaces200', a)
}, 600_000)

test('busy-furnace-field 1000 furnaces @slow', async () => {
  const a = await runField(1000, 3602)
  expect(a.diffBytesWhole).toBeGreaterThan(0)
  expect(a.diffBytesMasked).toBeGreaterThan(0)
  record('furnaces1000', a)
}, 600_000)

test('busy-furnace-field rates/steady-busy-field twin @slow', async () => {
  // `rates/steady-busy-field`'s own window (80 ticks to arrive, then 5 s) on `fx-busy-field`.
  const h = await createNetHarness({ fixture: fixture.dir, seed: 3102, clients: 1, hashAll: false })
  try {
    h.clients[0]?.setView({ x: 30, y: 14, halfW: 40, halfH: 40 })
    await h.advanceTicks(80)
    const before = h.counters(0)
    const diffBefore = h.diffBytes(0)
    await h.advanceTicks(5 * TICK_HZ)
    const after = h.counters(0)
    const diffAfter = h.diffBytes(0)
    const whole = diffAfter.whole - diffBefore.whole
    const masked = diffAfter.masked - diffBefore.masked
    expect(whole).toBeGreaterThan(0)
    expect(masked).toBeGreaterThan(0)
    record('steadyBusyField5s', {
      bytesDown: after.bytesDown - before.bytesDown,
      diffBytesWhole: whole,
      diffBytesMasked: masked,
      maskedOverWhole: Number((masked / whole).toFixed(3)),
    })
  } finally {
    await h.dispose()
  }
}, 600_000)
