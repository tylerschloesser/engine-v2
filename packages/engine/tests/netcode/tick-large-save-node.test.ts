// `tick-large-save node @slow` (docs/plan/36-slow-tier-and-benchmarks.md step 4, 0024 §14): the same
// load as the native `slow_tick_large_save` (standard large save at full scale, eight clients with
// maximum views, one `FurnaceTake` a second each) driven as `.wasm` through the real
// `createWorldServer`, so the TS sim host, its fan-out and the WASM codegen show up somewhere.
// RECORD-ONLY: `gate('tick-node', ..., { warnOnly: true })` prints a `warn` line over 25 % of its
// baseline and never fails; it has no absolute budget. What is timed is `SimHost.stepTick` (the
// admit, `sim_tick`, `sim_build_frame` per connection and the connection sends); the eight
// `HeadlessClient` replicas decode in the same Node process but outside the timer.
import { performance } from 'node:perf_hooks'
import { beforeAll, expect, test } from 'vitest'
// @ts-expect-error -- plain .mjs helper without types (the repo's scripts)
import { gate } from '../../../../scripts/lib/bench-gate.mjs'
import type { BuildGameResult } from '../../src/build-game.js'
import { worldServerTestHandle } from '../../src/server.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { benchBudgets, benchWorldConfig, buildBench } from '../support/bench-build.js'

let bench: BuildGameResult
beforeAll(async () => {
  // `BENCH_VARIANT=wasm-opt|simd128` times that build instead (M36b's tick-time delta; never set by
  // `pnpm test:slow`). The gate then compares it with the plain baseline: a warn line, nothing more.
  const variant = process.env.BENCH_VARIANT
  bench = await buildBench(
    'release',
    variant === 'wasm-opt' || variant === 'simd128' ? variant : 'plain',
  )
}, 240_000)

const PLAYERS = 8
const WARMUP = 200
const MEASURED = 1_200

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number

test('tick-large-save node @slow', async () => {
  const cfg = benchWorldConfig(bench.buildHash, 1)
  const harness = await createNetHarness({
    fixture: bench.dir,
    seed: 3601,
    worldSeed: cfg.params.seed,
    clients: PLAYERS,
    hashAll: false,
    world: { params: { worldgen: cfg.params.worldgen, ...benchBudgets(1) } },
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
        x: 160 + (i % 4) * 280,
        y: 300 + Math.floor(i / 4) * 500,
        halfW: 128,
        halfH: 128,
      })
    })
    await harness.advanceTicks(10) // handshakes settle: a client dispatches only once online
    for (let t = 0; t < WARMUP + MEASURED; t++) {
      if (t === WARMUP) timing = true
      if (t % 20 === 0) {
        harness.clients.forEach((c, i) => {
          const slot = ((t / 20) * 37 + i * 11) % 200
          c.dispatch({
            FurnaceTake: {
              at: {
                x: (5 + (i % 4) * 8) * 32 + (slot % 16) * 2,
                y: (9 + Math.floor(i / 4) * 12) * 32 + Math.floor(slot / 16) * 2,
              },
            },
          })
        })
      }
      await harness.advanceTicks(1)
    }
    expect(times.length).toBe(MEASURED)
    const sorted = [...times].sort((a, b) => a - b)
    const sample = {
      medianMs: Number(percentile(sorted, 0.5).toFixed(4)),
      p99Ms: Number(percentile(sorted, 0.99).toFixed(4)),
      maxMs: Number((sorted.at(-1) ?? 0).toFixed(4)),
    }
    gate('tick-node', sample, { warnOnly: true, suite: 'netcode' })
  } finally {
    await harness.dispose()
  }
}, 600_000)
