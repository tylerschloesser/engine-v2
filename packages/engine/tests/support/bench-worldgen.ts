// The worldgen-bench loop (docs/decisions/0008-chunk-generation.md §6; Planning decisions 6 of
// docs/plan/08-worldgen-and-gen-worker.md): shared by the Node slow test
// (`tests/wasm/worldgen-bench.test.ts`) and the phone-openable `worldgen-bench.html`, so both
// measure the identical chunk sequence against `fixtures/worldgen/golden/bench.json`'s pinned
// hash. Its only runtime import is `src/test/fnv.ts` (BigInt only), so a plain runtime can load it
// unbuilt, same discipline as `scenario.ts`.
import type { EngineInstance, RegionView } from '../../src/loader.ts'
import { fnv1a64Hex } from '../../src/test/fnv.ts'

export const WARM_UP_CHUNKS = 200
export const TIMED_CHUNKS = 2000

/** A deterministic, non-repeating grid of chunk coordinates: warm-up and timed chunks never
 * overlap, so neither the cache-cold first hit nor a re-generated chunk skews the median. */
export function chunkAt(k: number): [number, number] {
  return [k % 64, Math.floor(k / 64)]
}

export type BenchResult = { medianMs: number; hash: string }

/**
 * Runs `WARM_UP_CHUNKS` untimed `gen_chunk` calls, then times `TIMED_CHUNKS` more one at a time
 * with `now`, and hashes their concatenated `GenOut` bytes. `now` is injected so the caller picks
 * the clock (`performance.now` on both the main thread and a worker); median, not mean, so one
 * slow outlier does not move the reported number (0008 §6's own timing table uses a mean over a
 * whole batch, but a single ms-per-chunk headline figure on a phone benefits from the more robust
 * statistic).
 */
export function runWorldgenBench(
  inst: EngineInstance,
  region: RegionView,
  now: () => number,
): BenchResult {
  for (let k = 0; k < WARM_UP_CHUNKS; k++) {
    const [cx, cy] = chunkAt(k)
    inst.call2(inst.x.gen_chunk, cx, cy)
  }

  const timingsMs: number[] = []
  const batch = new Uint8Array(region.len * TIMED_CHUNKS)
  let offset = 0
  for (let k = 0; k < TIMED_CHUNKS; k++) {
    const [cx, cy] = chunkAt(WARM_UP_CHUNKS + k)
    const start = now()
    inst.call2(inst.x.gen_chunk, cx, cy)
    timingsMs.push(now() - start)
    batch.set(region.u8, offset)
    offset += region.len
  }

  timingsMs.sort((a, b) => a - b)
  const medianMs = timingsMs[Math.floor(timingsMs.length / 2)] ?? 0
  return { medianMs, hash: fnv1a64Hex(batch) }
}
