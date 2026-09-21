// The determinism scenario driver, shared by Vitest under Node, the Bun leg, `pnpm golden` and (M03)
// the browser page. Its only runtime imports are `abi.ts` (no imports of its own) and
// `src/test/fnv.ts` (BigInt only), so a plain runtime can load it as it is. The native legs make
// the same calls: `fixtures/hash/tests/scenario.rs`, `fixtures/worldgen/tests/scenario.rs`.
import { RegionId, Role, Status, statusName } from '../../src/abi.ts'
import type { EngineInstance, InstanceConfig } from '../../src/loader.ts'
import { fnv1a64Hex } from '../../src/test/fnv.ts'

/** `fixtures/hash/golden/scenario.json`: a sim-role tick/checkpoint scenario. */
export type SimScenario = {
  kind?: undefined
  role: 'sim'
  config: InstanceConfig
  ticks: number
  checkpointEvery: number
  /** Before tick t (1-based) when t % everyTicks == 0; the byte rule is in the JSON. Absent means
   * no admit traffic at all -- a real `Game`'s sim role with no connections yet (`fixtures/puts`,
   * docs/plan/13-sim-host-tick-loop.md: connections are M15, Non-scope there). */
  input?: { everyTicks: number; bytes: number; rule: string }
  /** Calls `sim_genesis()` once before ticking (docs/plan/13-sim-host-tick-loop.md): a real
   * `Game`'s sim role needs a world before `sim_tick` does anything but `Status.NotInitialised`;
   * a low-level fixture like `fixtures/hash` builds its state in `Instance::init` instead and
   * leaves this absent. */
  genesis?: boolean
}

/**
 * `fixtures/worldgen/golden/scenario.json`: a gen-role chunk-list scenario
 * (docs/plan/08-worldgen-and-gen-worker.md Seams). One checkpoint per 64 chunks, each the
 * `fnv1a64Hex` of the concatenated `GenOut` bytes.
 */
export type WorldgenScenario = {
  kind: 'worldgen'
  role: 'gen'
  config: InstanceConfig
  chunks: [number, number][]
}

/** `kind` dispatches which scenario shape this is; absent means `SimScenario` (M02). */
export type HashScenario = SimScenario | WorldgenScenario

/** `fixtures/<name>/golden/golden.json`; written only by `pnpm golden`. */
export type Golden = { checkpoints: string[] }

const ROLE_OF = { sim: Role.Sim, client: Role.Client, gen: Role.Gen } as const

/** The `Role` to `instantiate` with for this scenario's `role` field. */
export function roleOf(scenario: HashScenario): Role {
  return ROLE_OF[scenario.role]
}

function ok(status: number, what: string, tick: number): void {
  if (status !== Status.Ok) throw new Error(`${what} at tick ${tick}: ${statusName(status)}`)
}

const CHECKPOINT_CHUNKS = 64

/** Run the scenario on a fresh instance of the role its own `role` field names; one 16-digit hex
 * hash per checkpoint. */
export function runHashScenario(inst: EngineInstance, scenario: HashScenario): string[] {
  if (scenario.kind === 'worldgen') return runWorldgenScenario(inst, scenario)
  return runSimScenario(inst, scenario)
}

function runSimScenario(inst: EngineInstance, scenario: SimScenario): string[] {
  const { ticks, checkpointEvery, input, genesis } = scenario
  if (genesis) ok(inst.call0(inst.x.sim_genesis), 'sim_genesis', 0)
  const rx = input ? inst.region(RegionId.Rx) : null
  if (input && (!rx || rx.len < input.bytes)) {
    throw new Error('scenario: Rx region is missing or too small')
  }
  const checkpoints: string[] = []
  for (let t = 1; t <= ticks; t++) {
    if (input && rx && t % input.everyTicks === 0) {
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

/** `gen_chunk(cx, cy)` over `scenario.chunks`; one checkpoint per 64 chunks, `fnv1a64Hex` of the
 * concatenated `GenOut` bytes (no chunk coordinates: only what would actually ship). */
function runWorldgenScenario(inst: EngineInstance, scenario: WorldgenScenario): string[] {
  const out = inst.region(RegionId.GenOut)
  if (!out) throw new Error('scenario: GenOut region is missing')
  const batch = new Uint8Array(out.len * CHECKPOINT_CHUNKS)
  let offset = 0
  const checkpoints: string[] = []
  for (let i = 0; i < scenario.chunks.length; i++) {
    const pair = scenario.chunks[i] as [number, number]
    ok(inst.call2(inst.x.gen_chunk, pair[0], pair[1]), 'gen_chunk', i)
    batch.set(out.u8, offset)
    offset += out.len
    if ((i + 1) % CHECKPOINT_CHUNKS === 0) {
      checkpoints.push(fnv1a64Hex(batch.subarray(0, offset)))
      offset = 0
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
