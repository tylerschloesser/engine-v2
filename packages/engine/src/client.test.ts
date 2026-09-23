// `client.ts`'s `dispatch`/`onActionResult`/the extended `ready` (docs/plan/16-action-round-trip.md
// step 3), driven against the real `createClient()` -- real `SabSet`, real rings, real clock block
// -- with a fake `Worker` (never a real one under Node) that just replies `{ type: 'ready' }`, and
// a fake `Scheduler` this file pumps by hand instead of real timers/rAF (`.claude/rules/hot-paths.
// md`'s sibling rule: no bare `setTimeout` outside `clock.ts`, and a bare `requestAnimationFrame`
// does not exist under Node at all). This is the "TS unit" tier (Node, no browser, no real WASM):
// the client worker is played by this file writing straight into the SABs `clientTestHandle`
// exposes, the same way a real client worker would after `on_frame`/`client_clock_stats`.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ActionOutcome } from './client.js'
import { clientTestHandle, createClient } from './client.js'
import type { Scheduler } from './clock.js'
import { ClockBlockView, SessionState, writeClockBlock } from './clock-block.js'
import { RingConsumer, RingProducer } from './sab/ring.js'
import { actionResults, dispatchRaw } from './test/client.js'

/** A fake `Scheduler`: `setTimer`/`requestFrame` just queue the callback; `flush()` runs every
 * callback queued *before* the call, once each (a single "tick"), draining that same snapshot even
 * if running one callback queues another (`waitForLive`'s own re-arm, `resultsFrame`'s own re-
 * arm) -- so a caller drives "one macrotask" or "one rAF" by calling `flush()` again. */
function fakeScheduler(): Scheduler & { flush(): void } {
  let queue: Array<() => void> = []
  let nextId = 1
  return {
    setTimer(cb) {
      queue.push(cb)
      return nextId++
    },
    clearTimer() {},
    requestFrame(cb) {
      queue.push(() => cb(0))
      return nextId++
    },
    cancelFrame() {},
    flush() {
      const ran = queue
      queue = []
      for (const cb of ran) cb()
    },
  }
}

class FakeWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: ErrorEvent) => void) | null = null
  postMessage(): void {
    queueMicrotask(() => {
      this.onmessage?.({ data: { type: 'ready' } } as MessageEvent)
    })
  }
  terminate(): void {}
}

function fakeCanvas(): HTMLCanvasElement {
  return {
    getBoundingClientRect: () => ({ width: 100, height: 100 }) as DOMRect,
  } as unknown as HTMLCanvasElement
}

/** Builds one `[kind u8][len u32 LE][json]` UI-ring record (`client_poll_ui`'s own shape, docs/
 * plan/16b-ui-observation-and-clock.md Scope). */
function uiRecord(kind: number, json: string): Uint8Array {
  const body = new TextEncoder().encode(json)
  const rec = new Uint8Array(5 + body.length)
  rec[0] = kind
  new DataView(rec.buffer).setUint32(1, body.length, true)
  rec.set(body, 5)
  return rec
}

/** Concatenates whole records into one ring message and pushes it. */
function pushUiBatch(uiRing: SharedArrayBuffer, records: Uint8Array[]): void {
  const total = records.reduce((n, r) => n + r.length, 0)
  const batch = new Uint8Array(total)
  let off = 0
  for (const r of records) {
    batch.set(r, off)
    off += r.length
  }
  if (!new RingProducer(uiRing).tryPush(batch, off)) {
    throw new Error('pushUiBatch: ring full')
  }
}

/** `createClient` options common to every test here: a fake worker/scheduler, a minimal `local`
 * host stub (`test.game` overrides every worker's real config, so the stub's own field values
 * never reach a real WASM instance -- there is none), `postModule: false` (no real fetch/compile).
 * `connect` is the one field each test varies. */
function baseOptions(scheduler: Scheduler, connect: boolean) {
  return {
    canvas: fakeCanvas(),
    wasm: { url: 'fake://game.wasm', buildHash: 'deadbeef' },
    host: {
      kind: 'local' as const,
      world: { worldId: 'w', params: { seed: '1', worldgen: null } },
      connect,
    },
    createWorker: () => new FakeWorker() as unknown as Worker,
    genWorkers: 1,
    test: { scheduler, flags: { postModule: false }, game: {} },
  }
}

beforeEach(() => {
  vi.stubGlobal('crossOriginIsolated', true)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

test('dispatch_before_ready_throws', () => {
  const scheduler = fakeScheduler()
  const client = createClient(baseOptions(scheduler, true))
  // No clock block written yet (a real client worker has not applied a frame): `session_state`
  // is still 0 (`Connecting`), so `dispatch` must reject synchronously, before `ready` is even
  // awaited.
  expect(() => client.dispatch({ Paint: {} })).toThrowError('engine: dispatch before ready')
  client.destroy()
})

test('dispatch_returns_monotonic_seq_from_seed', async () => {
  const scheduler = fakeScheduler()
  const client = createClient(baseOptions(scheduler, true))
  const h = clientTestHandle(client)
  // Plays "the client worker after its first on_frame": seeds session_state = Live and
  // seq_seed = 5 before `ready`'s own `waitForLive()` ever runs its first (synchronous) poll.
  writeClockBlock(new ClockBlockView(h.sabs.clockBlock), {
    authoritativeTick: 10,
    predictedTick: 10,
    ticksPerSecond: 20,
    sessionState: SessionState.Live,
    seqSeed: 5,
    ackSeq: 5,
  })
  await client.ready
  expect(client.dispatch({ Paint: {} })).toBe(6)
  expect(client.dispatch({ Paint: {} })).toBe(7)
  expect(client.dispatch({ Paint: {} })).toBe(8)
  client.destroy()
})

test('dispatch_when_queue_full_fails_locally', async () => {
  const scheduler = fakeScheduler()
  const client = createClient(baseOptions(scheduler, true))
  const h = clientTestHandle(client)
  const clockView = new ClockBlockView(h.sabs.clockBlock)
  writeClockBlock(clockView, {
    authoritativeTick: 1,
    predictedTick: 1,
    ticksPerSecond: 20,
    sessionState: SessionState.Live,
    seqSeed: 0,
    ackSeq: 0,
  })
  await client.ready

  // `ack_seq` held still at 0: 32 dispatches (the 0012 pending-queue capacity) succeed.
  for (let i = 0; i < 32; i++) {
    client.dispatch({ Paint: {} })
  }
  const ringStats = { drops: 0, pushed: 0, popped: 0 }
  new RingConsumer(h.sabs.actionRing).stats(ringStats)
  expect(ringStats.pushed).toBe(32)

  // The 33rd throws, and writes nothing to the action ring.
  expect(() => client.dispatch({ Paint: {} })).toThrowError('engine: action queue full')
  new RingConsumer(h.sabs.actionRing).stats(ringStats)
  expect(ringStats.pushed).toBe(32)

  // `ack_seq` advances by one: exactly one more dispatch succeeds.
  writeClockBlock(clockView, {
    authoritativeTick: 1,
    predictedTick: 1,
    ticksPerSecond: 20,
    sessionState: SessionState.Live,
    seqSeed: 0,
    ackSeq: 1,
  })
  expect(client.dispatch({ Paint: {} })).toBe(33)
  new RingConsumer(h.sabs.actionRing).stats(ringStats)
  expect(ringStats.pushed).toBe(33)
  expect(() => client.dispatch({ Paint: {} })).toThrowError('engine: action queue full')

  client.destroy()
})

test('ui_ring_delivers_results_in_order', async () => {
  const scheduler = fakeScheduler()
  // Not linked: this test drives the UI-ring drain directly, independent of session readiness.
  const client = createClient(baseOptions(scheduler, false))
  await client.ready
  const h = clientTestHandle(client)

  const seen: Array<{ seq: number; result: ActionOutcome<string> }> = []
  client.onActionResult<string>((seq, result) => {
    seen.push({ seq, result })
  })

  // One batch, as `client_poll_ui` would produce it: a genuinely unknown kind (99 -- kind 1 is now
  // M16b's own real `Ui` record, covered by its own tests below) first, then two kind-2
  // `ActionResults` records -- the drain must skip the first by its own length field, not crash,
  // and deliver the other two in order.
  const encoder = new TextEncoder()
  const unknownBody = new Uint8Array(6)
  const confirmedJson = encoder.encode('{"seq":1,"result":"Confirmed"}')
  const rejectedJson = encoder.encode('{"seq":2,"result":{"Rejected":{"Game":"NotFound"}}}')
  const batch = new Uint8Array(
    5 + unknownBody.length + 5 + confirmedJson.length + 5 + rejectedJson.length,
  )
  let off = 0
  batch[off] = 99 // genuinely unknown kind
  new DataView(batch.buffer).setUint32(off + 1, unknownBody.length, true)
  batch.set(unknownBody, off + 5)
  off += 5 + unknownBody.length
  batch[off] = 2
  new DataView(batch.buffer).setUint32(off + 1, confirmedJson.length, true)
  batch.set(confirmedJson, off + 5)
  off += 5 + confirmedJson.length
  batch[off] = 2
  new DataView(batch.buffer).setUint32(off + 1, rejectedJson.length, true)
  batch.set(rejectedJson, off + 5)
  off += 5 + rejectedJson.length

  expect(new RingProducer(h.sabs.uiRing).tryPush(batch, off)).toBe(true)

  // One rAF tick: `resultsFrameHandle` was armed as soon as `ready` resolved.
  scheduler.flush()

  expect(seen).toEqual([
    { seq: 1, result: 'Confirmed' },
    { seq: 2, result: { Rejected: { Game: 'NotFound' } } },
  ])

  client.destroy()
})

test('dispatchRaw_and_actionResults_round_trip', async () => {
  const scheduler = fakeScheduler()
  // Not linked: `dispatchRaw` never checks readiness (Provides: only `dispatch` throws "before
  // ready"), so this test needs no session-live setup for `dispatchRaw` itself -- `client.ready`
  // is still awaited so the per-rAF results loop (`resultsFrameHandle`) is armed before `flush()`.
  const client = createClient(baseOptions(scheduler, false))
  await client.ready
  const h = clientTestHandle(client)

  const encoder = new TextEncoder()
  dispatchRaw(client, 7, encoder.encode('{"n":1}'))
  const ringStats = { drops: 0, pushed: 0, popped: 0 }
  new RingConsumer(h.sabs.actionRing).stats(ringStats)
  expect(ringStats.pushed).toBe(1)

  // `actionResults` subscribes lazily, on its first call (Provides): called here, before the
  // result actually arrives, exactly like a page that reads it every frame would.
  const results = actionResults(client)
  expect(results).toEqual([])

  // Plays "the client worker's client_poll_ui output": one kind-2 record for seq 7.
  const confirmedJson = encoder.encode('{"seq":7,"result":"Confirmed"}')
  const batch = new Uint8Array(5 + confirmedJson.length)
  batch[0] = 2
  new DataView(batch.buffer).setUint32(1, confirmedJson.length, true)
  batch.set(confirmedJson, 5)
  expect(new RingProducer(h.sabs.uiRing).tryPush(batch, batch.length)).toBe(true)
  scheduler.flush()

  // The same array `actionResults` returned before now holds the delivered result (Provides:
  // "the same live array on every call" -- not a fresh, empty subscription each time).
  expect(results).toEqual([{ seq: 7, result: 'Confirmed' }])
  expect(actionResults(client)).toBe(results)

  client.destroy()
})

test('onui_gets_only_latest_per_drain', async () => {
  const scheduler = fakeScheduler()
  const client = createClient(baseOptions(scheduler, false))
  await client.ready
  const h = clientTestHandle(client)

  const seen: unknown[] = []
  client.onUi((ui) => seen.push(ui))

  // Three kind-1 records in one drain (docs/plan/16b-ui-observation-and-clock.md Planning
  // decisions: "Ui is coalesced to the newest value per rAF"): only the last one's JSON reaches
  // `onUi`, parsed exactly once.
  pushUiBatch(h.sabs.uiRing, [
    uiRecord(1, '{"n":1}'),
    uiRecord(1, '{"n":2}'),
    uiRecord(1, '{"n":3}'),
  ])
  scheduler.flush()

  expect(seen).toEqual([{ n: 3 }])

  // A drain with nothing new: no further call.
  scheduler.flush()
  expect(seen).toEqual([{ n: 3 }])

  client.destroy()
})

test('onui_fires_before_action_results', async () => {
  const scheduler = fakeScheduler()
  const client = createClient(baseOptions(scheduler, false))
  await client.ready
  const h = clientTestHandle(client)

  const order: string[] = []
  client.onUi(() => order.push('ui'))
  client.onActionResult(() => order.push('result'))

  // The kind-2 record precedes the kind-1 one in the raw ring bytes (the reverse of the order
  // `game_instance::GameInstance::on_frame` actually produces, docs/plan/
  // 16b-ui-observation-and-clock.md Deviations "Delivery order") -- proving the drain's own
  // delivery-order rule ("onUi then results", Provides) holds independent of byte order, since a
  // real drain always sees the Rust-side order anyway; this is the stronger claim.
  pushUiBatch(h.sabs.uiRing, [
    uiRecord(2, '{"seq":1,"result":"Confirmed"}'),
    uiRecord(1, '{"n":1}'),
  ])
  scheduler.flush()

  expect(order).toEqual(['ui', 'result'])

  client.destroy()
})

test('clock_returns_same_object', async () => {
  const scheduler = fakeScheduler()
  const client = createClient(baseOptions(scheduler, true))
  const h = clientTestHandle(client)
  writeClockBlock(new ClockBlockView(h.sabs.clockBlock), {
    authoritativeTick: 42,
    predictedTick: 42,
    ticksPerSecond: 20,
    sessionState: SessionState.Live,
    seqSeed: 0,
    ackSeq: 0,
  })
  await client.ready

  const a = client.clock()
  expect(a).toEqual({ authoritative: 42, predicted: 42, ticksPerSecond: 20 })
  const b = client.clock()
  expect(b).toBe(a) // the same reused object (Planning decisions: "clock() returns a reused object")

  // Refreshed on the next call.
  writeClockBlock(new ClockBlockView(h.sabs.clockBlock), {
    authoritativeTick: 43,
    predictedTick: 43,
    ticksPerSecond: 20,
    sessionState: SessionState.Live,
    seqSeed: 0,
    ackSeq: 0,
  })
  const c = client.clock()
  expect(c).toBe(a)
  expect(c).toEqual({ authoritative: 43, predicted: 43, ticksPerSecond: 20 })

  client.destroy()
})
