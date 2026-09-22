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

  // One batch, as `client_poll_ui` would produce it: an unknown kind (1, M16b's future `Ui`
  // record) first, then two kind-2 `ActionResults` records -- the drain must skip the first by
  // its own length field, not crash, and deliver the other two in order.
  const encoder = new TextEncoder()
  const unknownBody = new Uint8Array(6)
  const confirmedJson = encoder.encode('{"seq":1,"result":"Confirmed"}')
  const rejectedJson = encoder.encode('{"seq":2,"result":{"Rejected":{"Game":"NotFound"}}}')
  const batch = new Uint8Array(
    5 + unknownBody.length + 5 + confirmedJson.length + 5 + rejectedJson.length,
  )
  let off = 0
  batch[off] = 1 // unknown kind
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
