// `tick-phases @slow` (docs/plan/39y-wasm-tick-cost.md steps 2-3): `sim_tick` of the standard large
// save split by phase under Node, from the release `bench` module. The module imports
// `engine.bench_mark(phase)` (cargo feature `bench-phases`, bench builds only); a hook reads the host
// clock and attributes the time since the previous mark. The same phase ids, sampling and overhead
// correction as the bench meter (`games/reference/src/bench-stats.ts`) and the native twin
// (`games/reference/sim/tests/bench_phases.rs`), so the three tables line up. Writes
// `test-results/wasm/tick-phases.json`. Also: a shipped (release) module has no `bench_mark` import.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { RegionId, Role } from '../../src/abi.js'
import type { BuildGameResult } from '../../src/build-game.js'
import { instantiate, setBenchMarkHook } from '../../src/loader.js'
import { loadGame } from '../../src/server-node.js'
import { buildSimInstanceConfig } from '../../src/sim-config.js'
import { benchWorldConfig, buildBench } from '../support/bench-build.js'
import { gameCrateBuildDir } from '../support/fixtures.js'

let bench: BuildGameResult
beforeAll(async () => {
  bench = await buildBench('release')
}, 240_000)

const PLAYERS = 8
const WARMUP = 200
const MEASURED = 1200
const SAMPLE_EVERY = 16
const TICK_MS = 50
const PACED_WARMUP = 40
const PACED_MEASURED = 300
const NAMES = [
  'start',
  'records',
  'begin_tick',
  'game_tick',
  'end_tick',
  'changes',
  'results',
  'subs',
  'skip',
  'drain',
  'advance',
  'wake_at',
  'put',
  'overhead',
]

function cameraUplink(x: number, y: number): Uint8Array {
  const b = new Uint8Array(2 + 4 + 1 + 16)
  const v = new DataView(b.buffer)
  b[0] = 0x02
  b[1] = 1
  v.setUint32(2, 0, true)
  b[6] = 0
  v.setInt32(7, x, true)
  v.setInt32(11, y, true)
  v.setUint16(15, 128, true)
  v.setUint16(17, 128, true)
  return b
}

const q = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number

test('tick-phases @slow', async () => {
  const { wasm } = await loadGame(bench.dir)
  const imports = WebAssembly.Module.imports(wasm).map((i) => `${i.module}.${i.name}`)
  expect(imports, 'the bench module has the phase import').toContain('engine.bench_mark')
  const shipped = await loadGame(gameCrateBuildDir('reference'))
  expect(
    WebAssembly.Module.imports(shipped.wasm).map((i) => i.name),
    'a shipped module has no bench import',
  ).not.toContain('bench_mark')

  const acc = new Float64Array(NAMES.length + 1)
  setBenchMarkHook((id) => {
    const t = performance.now()
    if (id !== 0) acc[id] = (acc[id] as number) + t - (acc[NAMES.length] as number)
    acc[NAMES.length] = t
  })
  try {
    const cfg = benchWorldConfig(bench.buildHash, 1)
    const inst = instantiate(wasm, Role.Sim, buildSimInstanceConfig(cfg), { onLog() {} })
    expect(inst.call0(inst.x.sim_genesis)).toBe(0)
    const rx = inst.region(RegionId.Rx)
    if (!rx) throw new Error('no Rx region')
    for (let c = 0; c < PLAYERS; c++) {
      expect(inst.call1(inst.x.sim_connect, c)).toBe(0)
      const up = cameraUplink(160 + (c % 4) * 280, 300 + Math.floor(c / 4) * 500)
      rx.u8.set(up)
      expect(inst.call2(inst.x.sim_admit, c, up.length)).toBe(0)
    }
    const table = (paced: boolean): Record<string, [number, number]> => {
      const per: number[][] = NAMES.map(() => [])
      const total: number[] = []
      const warm = paced ? PACED_WARMUP : WARMUP
      const n = paced ? PACED_MEASURED : MEASURED
      const sleeper = new Int32Array(new SharedArrayBuffer(4))
      for (let t = 0; t < warm + n; t++) {
        // The sim worker's own shape (`AtomicsTimer`): sleep to the next 50 ms tick, then run it.
        const wake = performance.now() + (paced ? TICK_MS : 0)
        acc.fill(0, 0, NAMES.length)
        inst.call0(inst.x.sim_seal_frame)
        const t0 = performance.now()
        expect(inst.call0(inst.x.sim_tick)).toBe(0)
        const dt = performance.now() - t0
        for (let c = 0; c < PLAYERS; c++) inst.call1(inst.x.sim_build_frame, c)
        if (t >= warm) {
          total.push(dt)
          for (let i = 1; i < NAMES.length; i++) (per[i] as number[]).push(acc[i] as number)
        }
        if (paced) {
          const left = wake - performance.now()
          if (left > 0) Atomics.wait(sleeper, 0, 0, left)
        }
      }
      for (const v of per) v.sort((a, b) => a - b)
      total.sort((a, b) => a - b)
      const over = per[13] as number[]
      const out: Record<string, [number, number]> = {
        sim_tick: [+q(total, 0.5).toFixed(4), +q(total, 0.95).toFixed(4)],
      }
      for (let i = 1; i < NAMES.length; i++) {
        const v = per[i] as number[]
        const sampled = i >= 9 && i <= 12
        const k = sampled || i === 13 ? SAMPLE_EVERY : 1
        const o50 = sampled ? q(over, 0.5) : 0
        const o95 = sampled ? q(over, 0.95) : 0
        out[NAMES[i] as string] = [
          +(Math.max(0, q(v, 0.5) - o50) * k).toFixed(4),
          +(Math.max(0, q(v, 0.95) - o95) * k).toFixed(4),
        ]
      }
      return out
    }
    const backToBack = table(false)
    // The same ticks, but asleep between them like the real worker: whether the browser's 3x over
    // native is the wake (a cold core and cache) rather than the module.
    const paced = table(true)
    const result = { backToBack, paced }
    console.log(`tick-phases (node, ms [p50, p95]): ${JSON.stringify(result)}`)
    const dir = join(process.cwd(), 'test-results', 'wasm')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tick-phases.json'), JSON.stringify(result, null, 1))
    expect(backToBack.game_tick).toBeDefined()
  } finally {
    setBenchMarkHook(null)
  }
}, 240_000)
