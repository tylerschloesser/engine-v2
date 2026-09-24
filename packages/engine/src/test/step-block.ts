// Test-only control block: one small `SharedArrayBuffer` per harness worker, read and written with
// `Atomics` only. **Internal, replaced later**: M06/M06b own the production control block, its
// `yield` flag and the ring sequence/ack counters (docs/plan/03-browser-harness.md, Seams); this
// shape exists only so `harness.ts`/`harness-worker.ts` can drive `stepTick`/`stepFrame`/`park`/
// `resume` at the ABI level. Never imported by production code.
//
// M04 adds `Control` (docs/plan/04-zero-gc-harness.md, Seams: "the hook sits in ... workers"):
// M03 shipped five slots (Req/Ack/State/Yield/Op), collapsing the brief's assumed `CONTROL`/`ERR`
// into `Op`; M04's negative-control hook needs its own word (a worker reads it fresh every tick, so
// `harness.ts`'s `setWorkerControl` can write it any time, typically while the worker is parked)
// rather than reusing `Op`, which already carries the `StepOp` of the in-flight request.

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
  /** A `StepControl` value: the negative-control allocation this worker applies on its next tick
   * (docs/decisions/0016 §3 step 8). Read fresh every tick, not latched. */
  Control: 5,
  /** M19b (docs/plan/19b-sim-park-while-armed.md) step 2: diagnostic only, never read by
   * production logic. Bumped once per `Atomics.wait` call `armedLoop` makes since this worker last
   * armed, so a `park('<name>')`/`send(...)` timeout can report how many waits this worker had
   * already completed (`harness.ts`'s `diagWorkers`) -- distinguishing "stuck on its very first
   * wait" from "stuck after N real steps". */
  Waits: 6,
  /** M19b step 3: bumped by *every* producer-side signal `armedLoop` blocks on -- a real step
   * request (`harness.ts`'s `wake()`) and a park request (`parkOne`) alike -- so `Atomics.wait`'s
   * own compare-then-sleep is self-healing regardless of interleaving, mirroring `sab/control.ts`'s
   * `W_WAKE`/`ControlBlock.wake()`. `Req`/`Ack` keep their own separate step-sequencing meaning;
   * `parkOne` still never touches them ("keeps `Req === Ack` true across a park", its own doc
   * comment, unchanged). Before this field existed, `parkOne` notified on `Req` itself without
   * changing its value: a real step request is self-healing (the value changes, so a late
   * `Atomics.wait` call sees the mismatch and returns without blocking), but a park request was not
   * -- a notify landing in the gap between `armedLoop`'s own `Yield` check and the moment its
   * `Atomics.wait` call actually registers as a waiter was lost for good, with nothing left to send
   * a second one. Fixed by giving every signal a word whose *value* always changes, not by
   * narrowing the gap further (docs/plan/19b, Deviations). */
  Wake: 7,
} as const

export const STEP_BLOCK_INT32S = 8

/** Negative-control allocation a worker applies once per tick (0016 §3 step 8); `None` is the
 * default a fresh `SharedArrayBuffer` already reads as zero. `'post-message'` controls are not
 * encoded here: they replace the SAB step protocol itself (docs/plan/04-zero-gc-harness.md,
 * Planning decisions "Sequence"). */
export const StepControl = {
  None: 0,
  /** One small retained object per tick. */
  Object: 1,
  /** 2,000 small retained objects per tick. */
  Burst: 2,
} as const
export type StepControl = (typeof StepControl)[keyof typeof StepControl]

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
