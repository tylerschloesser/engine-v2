// docs/plan/24-recovery-and-migration.md step 1: the call-path/loader-level guarantees panic
// recovery depends on, proven against the `panicky` fixture and the raw ABI (no `SimHost`/
// `recovery.ts` involved -- that machinery is the second implementer's, step 4).
//
// **Never hand an `EngineInstance` itself to `expect()`** (`toBe`/`not.toBe`/`toEqual` all
// pretty-print both operands, even on a passing assertion): an `EngineInstance` holds `mem`
// (the WASM linear memory's own `Uint8Array`/`Uint32Array` views) and `x` (every raw export
// function) -- pretty-printing that was measured to run the Vitest worker out of heap (`FATAL
// ERROR: Reached heap limit ... JavaScript heap out of memory`, the process killed with
// `SIGABRT`) even though the assertion itself always passed. Every comparison below uses a
// plain `===`/property read instead.
import { beforeAll, expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import { instantiate } from '../../src/loader.js'
import { buildSimInstanceConfig } from '../../src/server.js'
import { loadFixture } from '../support/fixtures.js'

const CFG = {
  worldId: 'w1',
  buildHash: '00'.repeat(32),
  params: { seed: '1', worldgen: null },
}

// Compiled once for the whole file (`WebAssembly.compile` is real work; every test below only
// needs `instantiate()`, cheap by construction -- 0005 Panic recovery 1: "the compiled Module is
// kept, so a new instance is cheap").
let wasm: WebAssembly.Module
beforeAll(async () => {
  wasm = (await loadFixture('panicky')).wasm
})

function freshSim(): ReturnType<typeof instantiate> {
  return instantiate(wasm, Role.Sim, buildSimInstanceConfig(CFG))
}

function freshEncoder(): ReturnType<typeof instantiate> {
  return instantiate(wasm, Role.Client, buildSimInstanceConfig(CFG))
}

/** Runs `fn`, returning whatever it threw (or `undefined` if it didn't). Never re-throws: callers
 * assert on the *shape* of what came back (`dead`, `panicMessage`, `.message`), never on the
 * `EngineTrap`/`Error` object's own identity, for the same reason the module doc comment gives. */
function catchThrown(fn: () => void): { threw: boolean; message: string } {
  try {
    fn()
    return { threw: false, message: '' }
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) }
  }
}

/** JSON-encodes `action` into an `on_action` ring record and admits it through a real client-role
 * encoder instance, exactly `persist-log-parity.test.ts`'s own `admit()` shape. */
function admitAction(
  sim: ReturnType<typeof instantiate>,
  encoder: ReturnType<typeof instantiate>,
  seq: number,
  action: unknown,
): number {
  const simRx = sim.region(RegionId.Rx)
  const encoderRx = encoder.region(RegionId.Rx)
  const encoderTx = encoder.region(RegionId.Tx)
  if (!simRx || !encoderRx || !encoderTx) throw new Error('a required region is missing')
  const json = new TextEncoder().encode(JSON.stringify(action))
  const record = new Uint8Array(8 + json.length)
  const view = new DataView(record.buffer)
  view.setUint32(0, seq, true)
  view.setUint32(4, json.length, true)
  record.set(json, 8)
  encoderRx.u8.set(record)
  const onActionStatus = encoder.call1(encoder.x.on_action, record.length)
  if (onActionStatus !== Status.Ok) throw new Error(`on_action failed: status ${onActionStatus}`)
  const uplinkLen = encoder.call1(encoder.x.client_poll_uplink, 0)
  if (uplinkLen <= 0) throw new Error('client_poll_uplink produced no uplink batch')
  simRx.u8.set(encoderTx.u8.subarray(0, uplinkLen))
  return sim.call2(sim.x.sim_admit, 0, uplinkLen)
}

test('fresh_instance_reuses_module', () => {
  const a = freshSim()
  const b = freshSim()
  expect(a === b).toBe(false)
  // Trapping `a` (the cheapest deterministic trap: no action pipeline needed) must not touch `b`
  // at all -- a fresh `instantiate()` off the *same already-compiled* `Module` is a wholly
  // independent instance.
  const result = catchThrown(() => a.call0(a.x.sim_test_trap))
  expect(result.threw).toBe(true)
  expect(a.dead).toBe(true)
  expect(b.dead).toBe(false)
  expect(b.call0(b.x.sim_genesis)).toBe(Status.Ok)
  expect(b.dead).toBe(false)
})

test('trap_without_panic_uses_runtime_error_message', () => {
  const sim = freshSim()
  const encoder = freshEncoder()
  expect(sim.call0(sim.x.sim_genesis)).toBe(Status.Ok)
  expect(sim.call1(sim.x.sim_connect, 0)).toBe(Status.Ok)

  const result = catchThrown(() => admitAction(sim, encoder, 1, 'OverflowStackInAdmit'))
  expect(result.threw).toBe(true)
  expect(sim.dead).toBe(true)
  // The raw `unreachable` instruction traps with no preceding `engine.panic` call (0014 §6): the
  // reported message is the `WebAssembly.RuntimeError`'s own, never this crate's own `panic!`
  // formatting (`"panicky: ..."`, what every *other* action here reports).
  expect(result.message).not.toMatch(/panicky:/)
  expect(sim.panicMessage?.length).toBeGreaterThan(0)
  expect(sim.panicMessage).not.toMatch(/panicky:/)
})

test('panic_in_admit_traps_before_the_action_is_queued', () => {
  const sim = freshSim()
  const encoder = freshEncoder()
  expect(sim.call0(sim.x.sim_genesis)).toBe(Status.Ok)
  expect(sim.call1(sim.x.sim_connect, 0)).toBe(Status.Ok)

  const result = catchThrown(() => admitAction(sim, encoder, 1, 'PanicInAdmit'))
  expect(result.threw).toBe(true)
  expect(sim.dead).toBe(true)
})

test('panic_in_apply_traps_at_tick', () => {
  const sim = freshSim()
  const encoder = freshEncoder()
  expect(sim.call0(sim.x.sim_genesis)).toBe(Status.Ok)
  expect(sim.call1(sim.x.sim_connect, 0)).toBe(Status.Ok)

  // Admit succeeds (only `apply` panics): the action is logged write-ahead before the trap.
  expect(admitAction(sim, encoder, 1, 'PanicInApply')).toBe(Status.Ok)
  const sealLen = sim.call0(sim.x.sim_seal_frame)
  expect(sealLen).toBeGreaterThan(0)
  const result = catchThrown(() => sim.call0(sim.x.sim_tick))
  expect(result.threw).toBe(true)
  expect(sim.dead).toBe(true)
})

test('dead_instance_memory_still_readable', () => {
  const sim = freshSim()
  const encoder = freshEncoder()
  expect(sim.call0(sim.x.sim_genesis)).toBe(Status.Ok)
  expect(sim.call1(sim.x.sim_connect, 0)).toBe(Status.Ok)
  expect(admitAction(sim, encoder, 1, 'PanicInApply')).toBe(Status.Ok)
  sim.call0(sim.x.sim_seal_frame)
  const result = catchThrown(() => sim.call0(sim.x.sim_tick))
  expect(result.threw).toBe(true)
  expect(sim.dead).toBe(true)

  // docs/plan/24-recovery-and-migration.md Provides: the `Progress` region is readable from a
  // *dead* instance through `inst.region(id).u8`/`inst.mem`, which call no export at all (0014
  // §6) -- `region()`/`mem` never check `dead` (`loader.ts`'s own `Instance` methods; only
  // `call0`/`call1`/`call2` do). `phase u32 | tick u32 | record u32`, little-endian.
  const progress = sim.region(RegionId.Progress)
  if (!progress) throw new Error('the Progress region is absent')
  const view = new DataView(progress.u8.buffer, progress.u8.byteOffset, progress.u8.byteLength)
  const phase = view.getUint32(0, true)
  const tick = view.getUint32(4, true)
  // `Phase::ApplyRecord = 2` (`persist::progress::Phase`, docs/plan/
  // 24-recovery-and-migration.md Seams): `PanicInApply` traps mid-`Game::apply`, so the last
  // write before the trap names that phase, at the tick the frame was applied for.
  expect(phase).toBe(2)
  expect(tick).toBe(0) // `completed = sim.tick()` read *before* `advance_tick()`: the tick 0 -> 1
  // transition this very call is applying, matching `sim_seal_frame`'s own "next_tick" convention.
  // Also readable through the whole-memory view, with no export call either.
  expect(sim.mem.u32[progress.ptr / 4]).toBe(2)
})

test('arm_tick_panic_traps_at_the_armed_tick_not_before', () => {
  const sim = freshSim()
  const encoder = freshEncoder()
  expect(sim.call0(sim.x.sim_genesis)).toBe(Status.Ok)
  expect(sim.call1(sim.x.sim_connect, 0)).toBe(Status.Ok)

  // `Game::tick` reads `cx.tick()` *before* `Sim::step`'s own `advance_tick()` runs (host/mod
  // Deviations, "seal timing": `sim.tick()` mid-call is always the tick about to complete, one
  // behind the counter's post-call value) -- arming `at: 3` and admitting during the tick-0-to-1
  // transition means `Game::tick` sees `cx.tick()` == 0, 1, 2 on the first three `sim_tick()`
  // calls and only reaches 3 on the fourth.
  expect(admitAction(sim, encoder, 1, { ArmTickPanic: { at: 3 } })).toBe(Status.Ok)
  sim.call0(sim.x.sim_seal_frame)
  expect(sim.call0(sim.x.sim_tick)).toBe(Status.Ok) // cx.tick() == 0: armed, not due
  expect(sim.call0(sim.x.sim_tick)).toBe(Status.Ok) // cx.tick() == 1: not due
  expect(sim.call0(sim.x.sim_tick)).toBe(Status.Ok) // cx.tick() == 2: not due
  const result = catchThrown(() => sim.call0(sim.x.sim_tick)) // cx.tick() == 3: due
  expect(result.threw).toBe(true)
  expect(sim.dead).toBe(true)
})
