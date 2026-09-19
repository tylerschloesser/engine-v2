// The determinism scenario driver, shared by Vitest under Node, the Bun leg, `pnpm golden` and (M03)
// the browser page. Its only runtime import is `abi.ts`, which has none, so a plain runtime can
// load it as it is. The native leg makes the same calls: `fixtures/hash/tests/scenario.rs`.
import { RegionId, Status, statusName } from '../../src/abi.ts'
import type { EngineInstance, InstanceConfig } from '../../src/loader.ts'

/** `fixtures/<name>/golden/scenario.json` */
export type HashScenario = {
  role: 'sim'
  config: InstanceConfig
  ticks: number
  checkpointEvery: number
  /** Before tick t (1-based) when t % everyTicks == 0; the byte rule is in the JSON. */
  input: { everyTicks: number; bytes: number; rule: string }
}

/** `fixtures/<name>/golden/golden.json`; written only by `pnpm golden`. */
export type Golden = { checkpoints: string[] }

function ok(status: number, what: string, tick: number): void {
  if (status !== Status.Ok) throw new Error(`${what} at tick ${tick}: ${statusName(status)}`)
}

/** Run the scenario on a fresh sim instance; one 16-digit hex state hash per checkpoint. */
export function runHashScenario(inst: EngineInstance, scenario: HashScenario): string[] {
  const { ticks, checkpointEvery, input } = scenario
  const rx = inst.region(RegionId.Rx)
  if (!rx || rx.len < input.bytes) throw new Error('scenario: Rx region is missing or too small')
  const checkpoints: string[] = []
  for (let t = 1; t <= ticks; t++) {
    if (t % input.everyTicks === 0) {
      // Integer ops only, so every runtime derives the same bytes.
      for (let i = 0; i < input.bytes; i++) rx.u8[i] = (t * 31 + i * 17 + (t >> 3)) & 0xff
      ok(inst.call2(inst.x.sim_admit, 0, input.bytes), 'sim_admit', t)
    }
    ok(inst.call0(inst.x.sim_tick), 'sim_tick', t)
    if (t % checkpointEvery === 0) {
      ok(inst.call0(inst.x.sim_hash), 'sim_hash', t)
      checkpoints.push(inst.readU64Hex(RegionId.Result, 0))
    }
  }
  return checkpoints
}

/** First checkpoint where `actual` differs from `golden`, as a message; `null` when equal. */
export function diffCheckpoints(actual: string[], golden: string[]): string | null {
  for (let i = 0; i < Math.max(actual.length, golden.length); i++) {
    if (actual[i] !== golden[i]) {
      return `checkpoint ${i}: got ${actual[i] ?? 'nothing'}, golden has ${golden[i] ?? 'nothing'}`
    }
  }
  return null
}
