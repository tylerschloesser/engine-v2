// Test-only control block: one small `SharedArrayBuffer` per harness worker, read and written with
// `Atomics` only. **Internal, replaced later**: M06/M06b own the production control block, its
// `yield` flag and the ring sequence/ack counters (docs/plan/03-browser-harness.md, Seams); this
// shape exists only so `harness.ts`/`harness-worker.ts` can drive `stepTick`/`stepFrame`/`park`/
// `resume` at the ABI level. Never imported by production code.

/** Index of each `Int32Array` slot. */
export const StepBlockField = {
  /** Sequence number of the most recently requested op; the worker blocks on this word. */
  Req: 0,
  /** Sequence number of the most recently completed op. `Req === Ack` means nothing is in flight. */
  Ack: 1,
  /** A `WorkerState` value. */
  State: 2,
  /** Main sets 1 to ask the worker to leave the blocking loop after its current wait wakes. */
  Yield: 3,
  /** The `StepOp` of the pending request. */
  Op: 4,
} as const

export const STEP_BLOCK_INT32S = 5

export const WorkerState = {
  /** In its normal event loop: not blocked in `Atomics.wait`. `postMessage` reaches it. */
  Idle: 0,
  /** Blocked in `Atomics.wait` on `Req`, ready for the next request. */
  Armed: 1,
  /** Running the current request. */
  Busy: 2,
} as const

export const StepOp = {
  Tick: 1,
  Frame: 2,
} as const

export function createStepBlock(): SharedArrayBuffer {
  return new SharedArrayBuffer(STEP_BLOCK_INT32S * 4)
}

export function stepBlockView(sab: SharedArrayBuffer): Int32Array {
  return new Int32Array(sab)
}
