// `tick-belts-large node @slow` (M45, 0077 A7): the load of the native `slow_tick_belts_large`
// (`fixtures/belts/tests/bench_belts.rs`: M40's standard `Mixed` belt world, 3,810 lines and
// 250,000 items at the recommended caps, built at genesis from `BeltsParams.bench`; eight clients
// with maximum views stacked over the world; nobody acts; the bench item cap, 393,216) driven as
// the release `fx-belts` `.wasm` through the real `createWorldServer`. RECORD-ONLY: `gate(
// 'belts-tick-node', ..., { warnOnly: true })` never fails on time; it prints the median and its
// ratio to the gated native median (`baselines/belts-tick.json`), the WASM-under-Node figure of
// 0077 A7. Timed: `SimHost.stepTick` (admit, `sim_tick`, `sim_build_frame` per connection and the
// sends), as `tick-large-save node`. Hashing is `production`, as the native `BenchHost`'s. The
// native bench is unpaced; here the bandwidth caps are lifted out of reach instead, so neither
// side holds a chunk back (`tick-large-save node` keeps the default caps: its ratio is not
// measured the same way). It fails if the world is not there: the frames carry under a floor of
// bytes per tick, or a snapshot's transport section (the last in the store, ending with `next_id`
// before the state hash and the CRC) does not hold 3,810 lines.
import { performance } from 'node:perf_hooks'
import { beforeAll, expect, test } from 'vitest'
// @ts-expect-error -- plain .mjs helper without types (the repo's scripts)
import { gate, readBaseline } from '../../../../scripts/lib/bench-gate.mjs'
import { RegionId, Status } from '../../src/abi.js'
import { type BuildGameResult, buildGame } from '../../src/build-game.js'
import { serverInternals, worldServerTestHandle } from '../../src/server.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { fixtureDir } from '../support/fixtures.js'

let belts: BuildGameResult
beforeAll(async () => {
  belts = await buildGame({ crate: fixtureDir('belts'), profile: 'release' })
}, 240_000)

const PLAYERS = 8
const WARMUP = 200
const MEASURED = 1_200
/// The bench world's tile extent at seed 7 (`BenchWorld::{width, height}`): 220 x 545.
const HEIGHT = 545
const LIFTED = 1_000_000_000
/// The world's lines (`bench_world(7, Mixed)`).
const LINES = 3_810
/// Frame bytes per tick, all eight connections: the native bench sends 53,501; an empty world
/// sends heartbeats only.
const FRAME_FLOOR = 20_000

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number

/** The gated native median (`baselines/belts-tick.json`), if the baseline exists. */
function nativeMedian(): number | undefined {
  const m = readBaseline('belts-tick')?.metrics?.medianMs
  return typeof m === 'number' ? m : undefined
}

test('tick-belts-large node @slow', async () => {
  const harness = await createNetHarness({
    fixture: belts.dir,
    seed: 4501,
    clients: PLAYERS,
    world: {
      debugHashMode: 'production', // the native `BenchHost`'s schedule, not the harness's hash-all
      params: {
        worldgen: { bench: { seed: 7, scale: 1 } },
        maxEntities: 4_096,
        maxModifiedTiles: 4_096,
        maxLines: 32_768,
        maxItems: 393_216, // `bench_host.rs`'s `BENCH_MAX_ITEMS`: the cap never binds
      },
      bandwidth: {
        softCapBytesPerS: LIFTED,
        chunkRefillBytesPerS: LIFTED,
        chunkBurstBytes: LIFTED,
        hardCapBytesPerS: LIFTED,
      },
    },
  })
  try {
    const host = worldServerTestHandle(harness.server)
    const times: number[] = []
    let timing = false
    const stepTick = host.stepTick.bind(host)
    host.stepTick = (n?: number) => {
      const t0 = performance.now()
      stepTick(n)
      if (timing) times.push(performance.now() - t0)
    }
    harness.clients.forEach((c, i) => {
      c.setView({
        x: 128,
        y: 128 + Math.floor(((HEIGHT - 256) * i) / (PLAYERS - 1)),
        halfW: 128,
        halfH: 128,
      })
    })
    await harness.advanceTicks(10) // handshakes settle
    let down0 = 0
    for (let t = 0; t < WARMUP + MEASURED; t++) {
      if (t === WARMUP) {
        timing = true
        down0 = harness.clients.reduce((n, _, i) => n + harness.counters(i).bytesDown, 0)
      }
      await harness.advanceTicks(1)
    }
    expect(times.length).toBe(MEASURED)
    const down = harness.clients.reduce((n, _, i) => n + harness.counters(i).bytesDown, 0)
    const bytesPerTick = Math.round((down - down0) / MEASURED)
    expect(bytesPerTick).toBeGreaterThan(FRAME_FLOOR)
    expect(transportLines(harness.server)).toBe(LINES)
    const sorted = [...times].sort((a, b) => a - b)
    const median = percentile(sorted, 0.5)
    const native = nativeMedian()
    const sample: Record<string, number> = {
      frameBytesPerTick: bytesPerTick,
      medianMs: Number(median.toFixed(4)),
      p99Ms: Number(percentile(sorted, 0.99).toFixed(4)),
      maxMs: Number((sorted.at(-1) ?? 0).toFixed(4)),
    }
    if (native !== undefined) sample.ratioToNative = Number((median / native).toFixed(3))
    console.log(
      native === undefined
        ? `tick-belts-large node: median ${median.toFixed(3)} ms (no native record to compare)`
        : `tick-belts-large node: median ${median.toFixed(3)} ms, ${(median / native).toFixed(2)}x the gated native ${native.toFixed(3)} ms; ${bytesPerTick} B of frames per tick`,
    )
    gate('belts-tick-node', sample, { warnOnly: true, suite: 'netcode' })
  } finally {
    await harness.dispose()
  }
}, 600_000)

/** Lines in the live world: a snapshot through `sim_snapshot_begin`/`next` (after the timed
 * window), whose payload ends `.. transport section (.., next_id u32) | state hash u64` and then
 * the container's CRC u32; ids are never reused and the bench world destroys none, so lines =
 * `next_id - 1`. */
function transportLines(server: Parameters<typeof serverInternals>[0]): number {
  const inst = serverInternals(server).rawInstance
  if (!inst) throw new Error('no live sim instance')
  const region = inst.region(RegionId.Persist)
  if (!region) throw new Error('the Persist region is absent')
  expect(inst.call2(inst.x.sim_snapshot_begin, 0, 0)).toBe(Status.Ok)
  const chunks: Uint8Array[] = []
  for (;;) {
    const n = inst.call0(inst.x.sim_snapshot_next)
    if (n < 0) throw new Error(`sim_snapshot_next failed: status ${-n}`)
    if (n === 0) break
    chunks.push(region.u8.slice(0, n))
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let pos = 0
  for (const c of chunks) {
    bytes.set(c, pos)
    pos += c.length
  }
  const nextId = new DataView(bytes.buffer).getUint32(bytes.length - 16, true)
  return nextId - 1
}
