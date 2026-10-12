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
   * M13: connections are M15, Non-scope there). */
  input?: { everyTicks: number; bytes: number; rule: string }
  /** Calls `sim_genesis()` once before ticking (M13: a real
   * `Game`'s sim role needs a world before `sim_tick` does anything but `Status.NotInitialised`;
   * a low-level fixture like `fixtures/hash` builds its state in `Instance::init` instead and
   * leaves this absent. */
  genesis?: boolean
  /** M15b, Orchestrator ruling 1: calls
   * `sim_connect(0)` once, right after `genesis` and before ticking -- the same "once, before the
   * loop" shape `genesis` above already has. `Host::connect`'s own `Record::Player{Joined,
   * Connected}` queue changes `sim_hash()` from the very first tick, which is exactly why
   * `puts_idle_100` (this field absent) and a connected scenario (this field `true`) need separate
   * goldens rather than one re-blessed in place. */
  connect?: boolean
}

/**
 * `fixtures/worldgen/golden/scenario.json`: a gen-role chunk-list scenario
 * (M08 Seams). One checkpoint per 64 chunks, each the
 * `fnv1a64Hex` of the concatenated `GenOut` bytes.
 */
export type WorldgenScenario = {
  kind: 'worldgen'
  role: 'gen'
  config: InstanceConfig
  chunks: [number, number][]
}

/** One scripted action, JSON-encoded exactly as `client.dispatch` would encode it (M16 step 5): `seq` is the client-assigned per-player sequence (0004), and
 * `action` is `G::Action`'s own external-tag JSON shape (a fixture author writes `{"Paint":
 * {...}}` or a bare `"Roll"` for a unit variant, exactly as `serde_json` would produce). */
export type ScriptAction = { seq: number; action: unknown }

/** One tick's worth of a `ScriptScenario` (`fixtures/puts/tests/puts_scenarios.rs`'s `script_a()`,
 * mirrored here): `connect` calls `sim_connect(0)` and `actions` are admitted, both *before* the
 * one `sim_tick()` call that applies them together -- the same "one `Sim::step(batch)` call per
 * distinct `Tick`" shape `engine::testing::testkit::run_script` uses natively. */
export type ScriptEntry = { tick: number; connect?: boolean; actions?: ScriptAction[] }

/**
 * `fixtures/puts/golden/scenario-script-a.json` (M16 step 5): a
 * sim-role script of real per-tick actions, driven through the real admit pipeline (`sim_connect`/
 * `sim_admit`) rather than `SimScenario.input`'s synthetic byte fill. No TS postcard encoder exists
 * (0003: rejected) or is needed: `encoderConfig` is a second, client-role instance of the *same*
 * `.wasm` used purely to turn each scripted action's JSON into real wire bytes (`on_action` +
 * `client_poll_uplink`, the exact client-side half `client.dispatch` drives) which are then copied
 * straight into the sim instance's own `Rx` region for `sim_admit` -- two real WASM instances, one
 * script, no bytes ever hand-encoded. `runScriptScenario` (not `runHashScenario`, which takes only
 * one instance) is this scenario kind's own driver. One checkpoint, at `checkpointAt` (`fixtures/
 * puts/tests/puts_scenarios.rs`'s own `puts_script_a_golden` likewise returns one final hash, not a
 * series).
 */
export type ScriptScenario = {
  kind: 'script'
  role: 'sim'
  config: InstanceConfig
  encoderConfig: InstanceConfig
  genesis?: boolean
  script: ScriptEntry[]
  checkpointAt: number
}

/** `kind` dispatches which scenario shape this is; absent means `SimScenario` (M02). */
export type HashScenario = SimScenario | WorldgenScenario | ScriptScenario

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
 * hash per checkpoint. A `ScriptScenario` needs two instances (`runScriptScenario`, below), so it
 * is never valid here. */
export function runHashScenario(inst: EngineInstance, scenario: HashScenario): string[] {
  if (scenario.kind === 'worldgen') return runWorldgenScenario(inst, scenario)
  if (scenario.kind === 'script') {
    throw new Error('runHashScenario: a script scenario needs runScriptScenario(sim, encoder, ..)')
  }
  return runSimScenario(inst, scenario)
}

function runSimScenario(inst: EngineInstance, scenario: SimScenario): string[] {
  const { ticks, checkpointEvery, input, genesis, connect } = scenario
  if (genesis) ok(inst.call0(inst.x.sim_genesis), 'sim_genesis', 0)
  if (connect) ok(inst.call1(inst.x.sim_connect, 0), 'sim_connect', 0)
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

const scriptEncoder = new TextEncoder()
/** `wire::MsgType::UplinkBatch` (`crates/engine/src/wire/mod.rs`), an uplink's first byte. */
const UPLINK_BATCH = 0x02

/**
 * M16 step 5: `sim`'s own admit pipeline driven by real per-tick
 * actions, each turned into wire bytes by `encoder` (a second, client-role instance of the same
 * `.wasm`) rather than a hand-written postcard encoder. Mirrors `engine::testing::testkit::
 * run_script`'s own contract exactly: a `ScriptEntry`'s `tick` names the ordinal `sim_tick()` call
 * that applies it (idle ticks in between are filled with a bare `sim_tick()`), `connect` and every
 * `actions` entry for that tick are queued (`sim_connect`/`sim_admit`) *before* that tick's own
 * `sim_tick()` call, so they land in the same batch a native `Sim::step(batch)` call would apply
 * together. `connect` is `Host::connect`'s `Record::Player{Joined}` then `{Connected}`, and the
 * second one changes `state_hash()` even for a `Game::on_player` that only handles `Joined`:
 * `Sim::step` sets the player's roster bit on `Connected` (0024 §8), so a native leg replays both
 * (`fixtures/belts/tests/golden_scenarios.rs`). One checkpoint, at `checkpointAt`.
 *
 * The encoder is a client the host serves (M44b): after every tick once connection 0 exists, the
 * sim builds that connection's frame (`sim_build_frame`, whose header carries `ack_seq`) and the
 * encoder applies it (`on_frame` pops every pending action up to it, and its replica follows every
 * `Global`/`OwnPlayer` change, so no scope hash falls due on a stale replica) and drains its UI
 * ring. Without the acks its pending queue (0012, `OUTBOX_CAPACITY` 32) filled and the 33rd
 * `on_action` failed `OutOfMemory`. Building a frame reads the world and never changes
 * `state_hash()`, so the native legs (which build none) still match. Every uplink admitted must
 * start with an `UplinkBatch`: a `ResyncChunk` (`ClientCore::note_desync`) would go out alone,
 * ahead of the batch, delaying the action; the runner throws instead of admitting it.
 */
export function runScriptScenario(
  sim: EngineInstance,
  encoder: EngineInstance,
  scenario: ScriptScenario,
): string[] {
  if (scenario.genesis) ok(sim.call0(sim.x.sim_genesis), 'sim_genesis', 0)
  const simRx = sim.region(RegionId.Rx)
  if (!simRx) throw new Error('runScriptScenario: sim Rx region is missing')
  const encoderRx = encoder.region(RegionId.Rx)
  const encoderTx = encoder.region(RegionId.Tx)
  const encoderDown = encoder.region(RegionId.Downlink)
  const simTx = sim.region(RegionId.Tx)
  if (!encoderRx || !encoderTx || !encoderDown || !simTx) {
    throw new Error('runScriptScenario: encoder Rx/Tx/Downlink or sim Tx region is missing')
  }
  let connected = false
  /** Delivers connection 0's frame to the encoder: its `ack_seq` retires the pending queue. */
  const ackEncoder = (t: number): void => {
    const len = sim.call1(sim.x.sim_build_frame, 0)
    if (len < 0) throw new Error(`sim_build_frame at tick ${t}: ${statusName(-len)}`)
    if (len === 0) return
    encoderDown.u8.set(simTx.u8.subarray(0, len))
    ok(encoder.call1(encoder.x.on_frame, len), 'on_frame', t)
    // The UI ring holds the frame's result records; nothing reads them here, so drop them.
    let drained = encoder.call0(encoder.x.client_poll_ui)
    while (drained > 0) drained = encoder.call0(encoder.x.client_poll_ui)
  }

  let tick = 0
  const checkpoints: string[] = []
  /** One `sim_tick`, then (once connected) the frame to the encoder. */
  const step = (t: number): void => {
    ok(sim.call0(sim.x.sim_tick), 'sim_tick', t)
    if (connected) ackEncoder(t)
  }
  const recordEntry = (t: number): void => {
    while (tick + 1 < t) {
      step(tick + 1)
      tick += 1
    }
  }
  for (const entry of scenario.script) {
    recordEntry(entry.tick)
    if (entry.connect) {
      ok(sim.call1(sim.x.sim_connect, 0), 'sim_connect', entry.tick)
      connected = true
    }
    for (const { seq, action } of entry.actions ?? []) {
      const json = scriptEncoder.encode(JSON.stringify(action))
      const record = new Uint8Array(8 + json.length)
      const view = new DataView(record.buffer)
      view.setUint32(0, seq, true)
      view.setUint32(4, json.length, true)
      record.set(json, 8)
      encoderRx.u8.set(record)
      ok(encoder.call1(encoder.x.on_action, record.length), 'on_action', entry.tick)
      const len = encoder.call1(encoder.x.client_poll_uplink, 0)
      if (len <= 0) {
        throw new Error(`runScriptScenario: encoder produced no uplink batch at tick ${entry.tick}`)
      }
      if (encoderTx.u8[0] !== UPLINK_BATCH) {
        throw new Error(
          `runScriptScenario: encoder uplink at tick ${entry.tick} starts with message type ${encoderTx.u8[0]}, not UplinkBatch (a ResyncChunk means its replica desynced)`,
        )
      }
      simRx.u8.set(encoderTx.u8.subarray(0, len))
      ok(sim.call2(sim.x.sim_admit, 0, len), 'sim_admit', entry.tick)
    }
    step(entry.tick)
    tick = entry.tick
    if (entry.tick === scenario.checkpointAt) {
      ok(sim.call0(sim.x.sim_hash), 'sim_hash', entry.tick)
      checkpoints.push(sim.readU64Hex(RegionId.Result, 0))
    }
  }
  while (tick < scenario.checkpointAt) {
    step(tick + 1)
    tick += 1
  }
  if (checkpoints.length === 0) {
    ok(sim.call0(sim.x.sim_hash), 'sim_hash', tick)
    checkpoints.push(sim.readU64Hex(RegionId.Result, 0))
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

/** The checkpoints of any `golden/scenario*.json` (`scripts/golden.mjs`'s own dispatch): a `script`
 * scenario on a sim instance plus a client-role encoder, every other kind on one instance of its
 * role. `instantiate` is passed in so each runtime keeps its own module graph (`src/` under Vitest,
 * `dist/` under Bun). */
export function runGoldenScenario(
  instantiate: (
    wasm: WebAssembly.Module,
    role: Role,
    config: InstanceConfig,
    hooks?: { onLog?: () => void },
  ) => EngineInstance,
  wasm: WebAssembly.Module,
  scenario: HashScenario,
): string[] {
  if (scenario.kind === 'script') {
    const sim = instantiate(wasm, Role.Sim, scenario.config, { onLog() {} })
    const encoder = instantiate(wasm, Role.Client, scenario.encoderConfig, { onLog() {} })
    return runScriptScenario(sim, encoder, scenario)
  }
  return runHashScenario(
    instantiate(wasm, roleOf(scenario), scenario.config, { onLog() {} }),
    scenario,
  )
}

/** `<fixture>/<scenario file>` pairs a named test already replays from the `.wasm`, per runtime: the
 * discovery legs (`determinism.test.ts` under Node, `bun-leg.mjs`'s `runScenarioLegs` under Bun)
 * skip them, so no golden runs twice. Node: `determinism: node matches golden` (hash),
 * `worldgen.test.ts`, `puts.test.ts` (idle, connected, script-a). Bun: `bun-leg.mjs`'s hash,
 * worldgen and puts legs (idle only). A new named replay adds its pair here. */
export const REPLAYED_BY_NAME = {
  node: new Set([
    'hash/scenario.json',
    'worldgen/scenario.json',
    'puts/scenario.json',
    'puts/scenario-connected.json',
    'puts/scenario-script-a.json',
  ]),
  bun: new Set(['hash/scenario.json', 'worldgen/scenario.json', 'puts/scenario.json']),
} as const
