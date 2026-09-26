// docs/plan/24-recovery-and-migration.md step 4: `recovery.ts`'s state machine (`SimHost.recover`/
// `onRecovered`/`onFatal`, the loop guard) driven under Node with `memoryStorage`, against the real
// `panicky` fixture -- never a hand-built container. Steps 1-3's own `panicky-trap.test.ts` proved
// the loader/ABI-level guarantees this machinery depends on; this file proves the state machine on
// top of it.
//
// **Never hand an `EngineInstance` itself to `expect()`** (`panicky-trap.test.ts`'s own file-level
// warning: `toBe`/`not.toBe`/`toEqual` pretty-print both operands, even on a passing assertion, and
// measured to run the Vitest worker out of heap). Every comparison here uses a plain
// `===`/property read instead.
import { beforeAll, expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import { Persistence } from '../../src/host/persistence.js'
import {
  RECOVERY_GOOD_TICKS_RESET,
  RECOVERY_LOOP_LIMIT,
  type RecoveryDeps,
} from '../../src/host/recovery.js'
import type { EngineInstance } from '../../src/loader.js'
import { instantiate } from '../../src/loader.js'
import {
  buildSimInstanceConfig,
  createSimHostFromInstance,
  type SimHost,
  wrapEngineInstance,
} from '../../src/server.js'
import type { MemoryStorage } from '../../src/storage/memory.js'
import { memoryStorage } from '../../src/storage/memory.js'
import { replayWorld, runHeavy } from '../../src/test/replay.js'
import { trapSim } from '../../src/test/trap.js'
import { loadFixture } from '../support/fixtures.js'

const CFG = {
  worldId: 'w1',
  buildHash: 'ef'.repeat(32),
  params: { seed: '3', worldgen: null },
}

let wasmModule: WebAssembly.Module
beforeAll(async () => {
  wasmModule = (await loadFixture('panicky')).wasm
})

function newInstance(cfg: typeof CFG = CFG): EngineInstance {
  return instantiate(wasmModule, Role.Sim, buildSimInstanceConfig(cfg))
}

function manualTimer() {
  let fn: (() => void) | null = null
  return {
    services: {
      every: (_ms: number, cb: () => void) => {
        fn = cb
        return () => {
          fn = null
        }
      },
    },
    fire() {
      fn?.()
    },
  }
}

/** Same shape as `panicky-trap.test.ts`'s own `admitAction`: encodes `action` through a real
 * client-role encoder instance and admits it on `sim` at `conn` 0. Throws (an `EngineTrap`) exactly
 * when `sim_admit` itself traps (`PanicInAdmit`, `OverflowStackInAdmit`); otherwise returns the raw
 * `sim_admit` status. */
function admitAction(sim: EngineInstance, seq: number, action: unknown): number {
  const encoder = instantiate(wasmModule, Role.Client, buildSimInstanceConfig(CFG))
  const encoderRx = encoder.region(RegionId.Rx)
  const encoderTx = encoder.region(RegionId.Tx)
  const simRx = sim.region(RegionId.Rx)
  if (!encoderRx || !encoderTx || !simRx) throw new Error('a required region is missing')
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

/** A minimal 0009 `Connection` double: records every `send` call (never encodes/decodes the real
 * frame bytes -- this file only needs to prove `send` is called again after recovery, and that the
 * same object identity is what `SimHost` keeps calling). */
function fakeConnection(): {
  connection: {
    send(cls: number, bytes: Uint8Array): void
    close(code: number): void
    onMessage: ((bytes: Uint8Array) => void) | null
    onClose: ((code: number) => void) | null
    readonly datagrams: boolean
  }
  sendCount: () => number
} {
  let sendCount = 0
  const connection = {
    send(_cls: number, _bytes: Uint8Array) {
      sendCount++
    },
    close(_code: number) {},
    onMessage: null as ((bytes: Uint8Array) => void) | null,
    onClose: null as ((code: number) => void) | null,
    datagrams: false,
  }
  return { connection, sendCount: () => sendCount }
}

/** Builds one `SimHost` wired for recovery: a real `Persistence` over `storage`, `recoveryDeps`
 * tracking whatever raw instance is current, and a manual timer/clock (never real-time paced --
 * every test here drives ticks itself). */
function makeHost(storage: MemoryStorage): { host: SimHost; deps: RecoveryDeps } {
  const inst = newInstance()
  const persistence = Persistence.create(storage, CFG, inst)
  const timer = manualTimer()
  const deps: RecoveryDeps = { instance: inst, newInstance: () => newInstance() }
  const host = createSimHostFromInstance(
    wrapEngineInstance(inst),
    { clock: { now: () => 0 }, timer: timer.services },
    persistence,
    0,
    deps,
  )
  return { host, deps }
}

async function snapshotStorage(storage: MemoryStorage): Promise<Map<string, Uint8Array | null>> {
  const keys = await storage.list('')
  const out = new Map<string, Uint8Array | null>()
  for (const k of keys) out.set(k, await storage.read(k))
  return out
}

async function expectStorageUnchanged(
  storage: MemoryStorage,
  before: Map<string, Uint8Array | null>,
): Promise<void> {
  const after = await snapshotStorage(storage)
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
  for (const [k, v] of before) {
    expect(after.get(k)).toEqual(v)
  }
}

test('panic_in_admit_recovers_and_rejects_engine_fault', async () => {
  // `PanicInAdmit` traps inside `Game::admit` -- never logged (0004: an admission rejection is not
  // a record at all), so the stored log holds nothing about it at all. Recovery therefore has
  // nothing to replay past and nothing to `Skip`: `Persistence.recover` cleanly reaches the exact
  // same, already-durable state as before the doomed admit attempt.
  const storage = memoryStorage()
  const { host, deps } = makeHost(storage)
  host.accept(fakeConnection().connection)
  host.stepTick(1) // logs+applies Joined/Connected

  const before = await snapshotStorage(storage)
  const result = catchThrown(() => admitAction(deps.instance, 1, 'PanicInAdmit'))
  expect(result.threw).toBe(true)
  expect(deps.instance.dead).toBe(true)

  const outcome = await host.recover()
  expect(outcome).toBe('resumed')
  expect(deps.instance.dead).toBe(false)
  await expectStorageUnchanged(storage, before)

  // The connection is usable again: a real, distinct action from the same player admits and
  // applies normally (recovery did not wedge the connection or the admit pipeline).
  expect(admitAction(deps.instance, 2, { ArmTickPanic: { at: 999 } })).toBe(Status.Ok)
  host.stepTick(1)
  expect(deps.instance.dead).toBe(false)
})

test('panic_in_apply_writes_skip_then_resumes', async () => {
  const storage = memoryStorage()
  const { host, deps } = makeHost(storage)
  host.accept(fakeConnection().connection)
  host.stepTick(1) // Joined/Connected

  // Admitted and logged write-ahead, cleanly -- only `apply` panics (`Phase::ApplyRecord`).
  expect(admitAction(deps.instance, 1, 'PanicInApply')).toBe(Status.Ok)
  const trapResult = catchThrown(() => host.stepTick(1))
  expect(trapResult.threw).toBe(true)
  expect(deps.instance.dead).toBe(true)

  const outcome = await host.recover()
  expect(outcome).toBe('skipped')
  expect(deps.instance.dead).toBe(false)

  // 0005 Budgets: "zero admitted actions lost other than the skipped one" -- a further real tick
  // runs cleanly on the recovered instance.
  host.stepTick(1)
  expect(deps.instance.dead).toBe(false)
})

test('skipped_action_acked_engine_fault', async () => {
  const storage = memoryStorage()
  const { host, deps } = makeHost(storage)
  host.accept(fakeConnection().connection)
  host.stepTick(1)

  expect(admitAction(deps.instance, 1, 'PanicInApply')).toBe(Status.Ok)
  catchThrown(() => host.stepTick(1))
  expect(await host.recover()).toBe('skipped')

  // A resend of the skipped `seq` (an additive action this time, `ArmTickPanic`, so a real
  // double-apply would be observable) must not apply: `Authority::record_ack` already advanced
  // `last_seq` for it during replay (Planning decisions 4), so the dedup floor drops the resend
  // silently, the same as any other already-processed `seq`.
  const hashBefore = host.hash()
  expect(admitAction(deps.instance, 1, { ArmTickPanic: { at: 999 } })).toBe(Status.Ok)
  host.stepTick(1)
  expect(host.hash()).toBe(hashBefore)

  // A *new* seq for the same additive action does apply, proving the dedup above was real and not
  // vacuous (the action itself is not silently rejected for some unrelated reason).
  expect(admitAction(deps.instance, 2, { ArmTickPanic: { at: 999 } })).toBe(Status.Ok)
  host.stepTick(1)
  expect(host.hash()).not.toBe(hashBefore)
})

test('recovered_hash_equals_replay_with_skip', async () => {
  const storage = memoryStorage()
  const { host, deps } = makeHost(storage)
  host.accept(fakeConnection().connection)
  host.stepTick(1)
  expect(admitAction(deps.instance, 1, 'PanicInApply')).toBe(Status.Ok)
  catchThrown(() => host.stepTick(1))
  expect(await host.recover()).toBe('skipped')
  host.stepTick(3)
  const wantHash = host.hash()
  const wantTick = host.counters.ticksRun

  // An independent replay of the stored log (including the `Skip` record), never the recovering
  // host's own number.
  const replayed = await replayWorld({
    wasm: wasmModule,
    storage,
    worldId: CFG.worldId,
    checkpoints: [wantTick],
  })
  expect(replayed).toHaveLength(1)
  expect(replayed[0]?.hash).toBe(wantHash)
})

test('panic_in_tick_is_fatal_and_files_untouched', async () => {
  const storage = memoryStorage()
  const { host, deps } = makeHost(storage)
  host.accept(fakeConnection().connection)
  host.stepTick(1)
  expect(admitAction(deps.instance, 1, { ArmTickPanic: { at: 1 } })).toBe(Status.Ok)

  // `cx.tick()` is one behind the post-call counter (`panicky-trap.test.ts`'s own doc comment):
  // armed at `at` and reaching it takes `at + 1` total `sim_tick()` calls from genesis -- keep
  // stepping until the armed panic actually fires, rather than hand-computing the exact count.
  let threw = false
  for (let i = 0; i < 6 && !threw; i++) {
    const r = catchThrown(() => host.stepTick(1))
    threw = r.threw
  }
  expect(threw).toBe(true)
  expect(deps.instance.dead).toBe(true)

  const before = await snapshotStorage(storage)
  let fatalMessage: { tick: number; message: string } | undefined
  host.onFatal = (f) => {
    fatalMessage = f
  }
  const outcome = await host.recover()
  expect(outcome).toBe('fatal')
  expect(fatalMessage).toBeDefined()
  await expectStorageUnchanged(storage, before)
})

test('alloc_failure_in_tick_is_fatal_and_files_untouched', async () => {
  const storage = memoryStorage()
  const { host, deps } = makeHost(storage)
  host.accept(fakeConnection().connection)
  host.stepTick(1)
  expect(admitAction(deps.instance, 1, { ArmTickAlloc: { at: 1 } })).toBe(Status.Ok)

  let threw = false
  for (let i = 0; i < 6 && !threw; i++) {
    const r = catchThrown(() => host.stepTick(1))
    threw = r.threw
  }
  expect(threw).toBe(true)
  expect(deps.instance.dead).toBe(true)

  const before = await snapshotStorage(storage)
  let fatalMessage: { tick: number; message: string } | undefined
  host.onFatal = (f) => {
    fatalMessage = f
  }
  const outcome = await host.recover()
  expect(outcome).toBe('fatal')
  expect(fatalMessage).toBeDefined()
  await expectStorageUnchanged(storage, before)
})

test('recovery_fires_onRecovered_once', async () => {
  const storage = memoryStorage()
  const { host, deps } = makeHost(storage)
  host.accept(fakeConnection().connection)
  host.stepTick(1)
  expect(admitAction(deps.instance, 1, 'PanicInApply')).toBe(Status.Ok)
  catchThrown(() => host.stepTick(1))

  let calls = 0
  let lastReport: { reason: string; tick: number; skipped: number } | undefined
  host.onRecovered = (r) => {
    calls++
    lastReport = r
  }
  const outcome = await host.recover()
  expect(outcome).toBe('skipped')
  expect(calls).toBe(1)
  expect(lastReport?.reason).toBe('panic')
  expect(lastReport?.skipped).toBe(1)
})

test('test_trap_recovers_without_skip', async () => {
  const storage = memoryStorage()
  const { host, deps } = makeHost(storage)
  host.accept(fakeConnection().connection)
  host.stepTick(2)

  const result = catchThrown(() => trapSim(deps.instance))
  expect(result.threw).toBe(true)
  expect(deps.instance.dead).toBe(true)

  let calls = 0
  host.onRecovered = () => {
    calls++
  }
  const outcome = await host.recover()
  expect(outcome).toBe('resumed')
  expect(calls).toBe(1)
})

test('recovery_loop_guard', async () => {
  const storage = memoryStorage()
  const { host, deps } = makeHost(storage)
  host.accept(fakeConnection().connection)
  host.stepTick(1)

  let fatalMessage: { tick: number; message: string } | undefined
  host.onFatal = (f) => {
    fatalMessage = f
  }

  for (let i = 0; i < RECOVERY_LOOP_LIMIT; i++) {
    catchThrown(() => trapSim(deps.instance))
    const outcome = await host.recover()
    expect(outcome).toBe('resumed')
  }
  // The `RECOVERY_LOOP_LIMIT + 1`th recovery, with fewer than `RECOVERY_GOOD_TICKS_RESET` good
  // ticks since the last one, is refused outright.
  catchThrown(() => trapSim(deps.instance))
  const guarded = await host.recover()
  expect(guarded).toBe('fatal')
  expect(fatalMessage?.message).toMatch(/loop guard/)

  // `deps.instance` is still the dead one from the guarded attempt (recovery never ran): a fresh
  // host proves the *other* half -- `RECOVERY_GOOD_TICKS_RESET` good ticks between recoveries
  // resets the count, so a run that recovers 3 times with a long quiet stretch between each never
  // trips the guard.
  const storage2 = memoryStorage()
  const h2 = makeHost(storage2)
  h2.host.accept(fakeConnection().connection)
  h2.host.stepTick(1)
  for (let i = 0; i < RECOVERY_LOOP_LIMIT; i++) {
    catchThrown(() => trapSim(h2.deps.instance))
    expect(await h2.host.recover()).toBe('resumed')
    h2.host.stepTick(RECOVERY_GOOD_TICKS_RESET)
  }
  catchThrown(() => trapSim(h2.deps.instance))
  expect(await h2.host.recover()).toBe('resumed')
})

test('connections_stay_open_across_recovery', async () => {
  const storage = memoryStorage()
  const { host, deps } = makeHost(storage)
  const { connection, sendCount } = fakeConnection()
  const conn = host.accept(connection)
  host.stepTick(1)

  expect(admitAction(deps.instance, 1, 'PanicInApply')).toBe(Status.Ok)
  catchThrown(() => host.stepTick(1))
  expect(await host.recover()).toBe('skipped')

  const wantTick = host.counters.ticksRun
  const sentBefore = sendCount()
  host.stepTick(1)
  // Re-attach delivers a fresh baseline frame (`first_frame_pending`) plus the queued `EngineFault`
  // ack for the skipped record, both on this same connection's very next `simBuildFrame` call.
  expect(sendCount()).toBeGreaterThan(sentBefore)
  expect(conn).toBe(0)

  // Re-attach itself must not perturb game state: the hash after recovery (before this last real
  // tick) matches an independent replay of the stored log including the `Skip`.
  const replayed = await replayWorld({
    wasm: wasmModule,
    storage,
    worldId: CFG.worldId,
    checkpoints: [wantTick],
  })
  // `wantTick` was read right after `recover()`, before the extra `stepTick(1)` above -- take a
  // second reading now the extra tick has run, and compare against a checkpoint at *that* tick
  // instead, so the comparison is exact.
  const finalTick = host.counters.ticksRun
  const replayedFinal = await replayWorld({
    wasm: wasmModule,
    storage,
    worldId: CFG.worldId,
    checkpoints: [finalTick],
  })
  expect(replayed).toHaveLength(1)
  expect(replayedFinal[0]?.hash).toBe(host.hash())
})

test('heavy_mode_restore_mid_skip_matches_uninterrupted_replay', async () => {
  // The gap the orchestrator flagged: `runHeavy`'s own mid-drive `restoreFresh` swap builds a
  // brand-new instance that never re-runs the `Skip`-target scan pass, so a restore landing between
  // a segment's start and a `Skip`'s own *target* frame loses skip enforcement for the rest of that
  // run -- the fresh instance then genuinely *applies* `PanicInApply`'s own poisoned record, which
  // panics for real (this fixture's own `apply` still calls `panic!` unconditionally for it),
  // throwing out of `runHeavy` instead of returning a clean `firstDivergentTick`.
  const storage = memoryStorage()
  const { host, deps } = makeHost(storage)
  host.accept(fakeConnection().connection)
  host.stepTick(3) // a few ticks of headroom before the poisoned record's own tick

  expect(admitAction(deps.instance, 1, 'PanicInApply')).toBe(Status.Ok)
  catchThrown(() => host.stepTick(1))
  expect(await host.recover()).toBe('skipped')
  host.stepTick(3) // more log content after the Skip, so the segment has real ticks past it too

  // `everyN = 1`: cellB restores after *every* tick, guaranteeing a restore lands before the
  // poisoned record's own tick is ever reached.
  const result = await runHeavy({ wasm: wasmModule, storage, worldId: CFG.worldId, everyN: 1 })
  expect(result.firstDivergentTick).toBe(null)
})

function catchThrown(fn: () => void): { threw: boolean; message: string } {
  try {
    fn()
    return { threw: false, message: '' }
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) }
  }
}
