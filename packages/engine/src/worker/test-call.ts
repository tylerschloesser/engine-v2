// The test-only, parked-only call channel a worker kind with a WASM instance can carry
// (docs/plan/08b-gen-workers-and-queue.md, orchestrator decision 1 at the step-5 boundary): lets
// `engine/test`'s `callParked` read a worker's own instance state (an ABI export's return value plus
// a copy of the first `resultBytes` bytes of its `Result` region) from main, the same way
// `worker/gc-hook.ts` reads `CB_TEST_CONTROL` instead of a message -- production code cannot import
// `src/test/**`. `worker.ts` routes a `test-call` message here only when this worker's setup message
// carried `test` and only while it is parked (a worker blocked in `Atomics.wait` receives no events,
// so nothing here ever runs from inside a kind's blocking loop). Allocation is irrelevant: this never
// runs inside a measured zero-GC window.
import { RegionId } from '../abi.js'
import type { EngineInstance } from '../loader.js'
import type { FromWorker, TestCallMessage } from './protocol.js'

type ExportsRecord = Record<string, unknown>

/** Calls the named ABI export with 0, 1 or 2 arguments (`m.a`/`m.b`, in order) through
 * `call0`/`call1`/`call2` -- the same fixed-arity discipline every hot-path call uses, just off the
 * hot path here. Copies the first `m.resultBytes` bytes of `Result` into the reply. */
export function handleTestCall(inst: EngineInstance, m: TestCallMessage): FromWorker {
  const fn = (inst.x as unknown as ExportsRecord)[m.name]
  if (typeof fn !== 'function') {
    return { type: 'test-error', id: m.id, message: `callParked: unknown export '${m.name}'` }
  }
  try {
    let value: number
    if (m.b !== undefined) {
      value = inst.call2(fn as (a: number, b: number) => number, m.a ?? 0, m.b)
    } else if (m.a !== undefined) {
      value = inst.call1(fn as (a: number) => number, m.a)
    } else {
      value = inst.call0(fn as () => number)
    }
    const bytes = m.resultBytes ?? 0
    const result = new Uint8Array(bytes)
    if (bytes > 0) {
      const region = inst.region(RegionId.Result)
      if (!region || bytes > region.len) {
        return {
          type: 'test-error',
          id: m.id,
          message: `callParked: resultBytes ${bytes} exceeds the Result region (${region?.len ?? 0} B)`,
        }
      }
      result.set(region.u8.subarray(0, bytes))
    }
    return { type: 'test-result', id: m.id, value, result }
  } catch (e) {
    return { type: 'test-error', id: m.id, message: e instanceof Error ? e.message : String(e) }
  }
}
