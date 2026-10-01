// `highwater-large-save @slow` (docs/plan/36-slow-tier-and-benchmarks.md step 4, M07's hand-over):
// the sim instance's memory on the standard large save, asserted against `budgets.json`
// `mem.simHighWaterLargeSave` with `engine_mem_grows() == 0`. See the test body for what the number
// measures. Release profile (the shipped allocator behaviour: growth past the reservation is
// counted, not a trap).
import { beforeAll, expect, test } from 'vitest'
import { RegionId, Role } from '../../src/abi.js'
import type { BuildGameResult } from '../../src/build-game.js'
import { instantiate } from '../../src/loader.js'
import { loadGame } from '../../src/server-node.js'
import { buildSimInstanceConfig } from '../../src/sim-config.js'
import { benchWorldConfig, buildBench } from '../support/bench-build.js'
import { budget } from '../support/budgets.js'

let bench: BuildGameResult
beforeAll(async () => {
  bench = await buildBench('release')
}, 240_000)

const PLAYERS = 8
const TICKS = 80

/** An `UplinkBatch` carrying only a camera (0011): type 0x02, flags 1, last tick, no actions. */
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

/** Genesis of the full large save in an arena of `arenaBytes`, eight maximum-view connections for
 * `TICKS` ticks of frames, then one whole snapshot drained. Returns the arena growth count and the
 * snapshot size. */
async function workload(arenaBytes: number): Promise<{ grows: number; snapshot: number }> {
  const { wasm } = await loadGame(bench.dir)
  const cfg = benchWorldConfig(bench.buildHash, 1, { arenaBytes })
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
  for (let t = 0; t < TICKS; t++) {
    expect(inst.call0(inst.x.sim_tick)).toBe(0)
    for (let c = 0; c < PLAYERS; c++)
      expect(inst.call1(inst.x.sim_build_frame, c)).toBeGreaterThanOrEqual(0)
  }
  expect(inst.call2(inst.x.sim_snapshot_begin, 0, 0)).toBe(0)
  let snapshot = 0
  for (;;) {
    const n = inst.call0(inst.x.sim_snapshot_next)
    if (n === 0) break
    snapshot += n
  }
  return { grows: inst.memGrows(), snapshot }
}

test('highwater-large-save @slow', async () => {
  // What `mem.simHighWaterLargeSave` measures: the arena's live-byte peak over genesis of the full
  // save, eight maximum-view connections for 80 ticks of frames, and one whole snapshot (the
  // encoded store, ~13 MB, is held while it drains, with the encoder's own working memory: ~+24 MB
  // over the 57 MB the settled world holds). The arena is preallocated, so
  // `memory.buffer.byteLength` is flat at every scale and says nothing; the peak is read the only
  // way the module exposes it, as the smallest `arenaBytes` at which `engine_mem_grows()` stays 0
  // (release builds count growth past the reservation instead of trapping). Probed on this
  // machine: 79.75 MiB grows once, 80 MiB does not, so the peak is 80 MiB (83,886,080 B) to within
  // 0.25 MiB; the ceiling is that, plus the 10 % headroom every budgets.json row carries.
  const ceiling = budget('mem.simHighWaterLargeSave')
  const atCeiling = await workload(ceiling)
  expect(atCeiling.grows, `the large save fits an arena of the ceiling, ${ceiling} B`).toBe(0)
  expect(atCeiling.snapshot).toBeGreaterThan(10_000_000)
  // The detector can fail: an arena 8 MiB under the measured peak grows.
  const under = await workload(72 * 1024 * 1024)
  expect(under.grows, 'an arena under the peak grows (the check is not vacuous)').toBeGreaterThan(0)
}, 300_000)
