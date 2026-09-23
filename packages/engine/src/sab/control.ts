// The control block: one `SharedArrayBuffer` shared by every thread (docs/decisions/0015-threads-
// memory-and-topology.md §2 "Wake-ups"; docs/plan/06-sab-primitives-and-workers.md, Planning
// decisions "Control-block layout"). `Int32Array[64]`: four global words, then seven 8-word
// per-worker blocks (four used). The wake word is per *consumer thread*, not per ring (0024 §10):
// a worker with several input rings still blocks on one address.

export const CONTROL_BLOCK_INT32S = 64
export const CONTROL_BLOCK_BYTES = CONTROL_BLOCK_INT32S * 4

// Global words (indices 0-7; 7 reserved).
export const CB_VERSION = 0
export const CB_LIFECYCLE = 1
export const CB_FRAME_REQ = 2
export const CB_FLAGS = 3
/** Test-only negative-control target, read only by a worker whose setup carried `test.gcHook`
 * (docs/plan/06b-workers-and-spawn.md, orchestrator decision 2: no new `postMessage` type for the
 * zero-GC hook). `0` = no control armed; else `((workerIndex + 1) << 8) | kind`, `kind` a
 * `StepControl`-shaped value (1 = object, 2 = burst) applied by `src/worker/gc-hook.ts`. One global
 * word, not per-worker: `zeroGcSuite` arms at most one isolate's control at a time. */
export const CB_TEST_CONTROL = 4
/**
 * The sim worker's own step-tick request word (docs/plan/13-sim-host-tick-loop.md, Scope: "A
 * `CB_*` step-tick request word serves `stepTick`"), the same monotonic-counter shape as
 * `CB_FRAME_REQ` (`worker/client.ts`'s own `frameReq !== lastFrameReq` idiom): a caller
 * `Atomics.add`s the number of ticks wanted, then wakes `WORKER_HOST`; `worker/sim.ts`'s `body()`
 * diffs the word against what it last saw and runs that many ticks through `SimHost.stepTick`,
 * bypassing the real-time pacing timer entirely (deterministic, for `engine/test`'s `stepTick` and
 * `asHarness.stepTick`'s own generic per-call "run one tick" contract, not for production pacing,
 * which never touches this word). One global word, not per-worker: there is at most one `sim`/`net`
 * worker (`WORKER_HOST`) in any topology. */
export const CB_SIM_STEP_REQ = 5
/**
 * The sim worker's own `SimHostCounters.ticksRun`, mirrored by `worker/sim.ts`'s `body()` after
 * every pass (one `Atomics.store` of a Smi, allocation-free) so a test can watch real-time pacing
 * advance from main without parking the worker (docs/plan/16d-sim-pacing-under-external-wakes.md,
 * step 1: a park/resume per sample would itself perturb the pacing under test). Read-only for
 * everyone but the sim worker. One global word, same reasoning as `CB_SIM_STEP_REQ`. */
export const CB_SIM_TICKS_RUN = 6

export const Lifecycle = { Booting: 0, Running: 1, Stopping: 2, Fatal: 3 } as const
export type Lifecycle = (typeof Lifecycle)[keyof typeof Lifecycle]

export const FLAG_REBASE = 1
export const FLAG_RENDERER_RESET = 2

// Per-worker block: `WORKER_BASE + WORKER_STRIDE * index + <field>`.
export const WORKER_BASE = 8
export const WORKER_STRIDE = 8
export const MAX_WORKERS = 7

export const W_WAKE = 0
export const W_YIELD = 1
export const W_PARKED = 2
export const W_READY = 3
export const W_ACK = 4
export const W_MEM_PAGES = 5
export const W_MEM_GROWS = 6
export const W_STATUS = 7

export const Ready = { No: 0, Yes: 1, Dead: 2 } as const
export type Ready = (typeof Ready)[keyof typeof Ready]

// Worker indexes (docs/plan/06-sab-primitives-and-workers.md, Seams).
export const WORKER_CLIENT = 0
export const WORKER_HOST = 1 // sim or net
export const WORKER_GEN0 = 2
export const WORKER_GEN1 = 3

/** Absolute word index of `field` in worker `index`'s block. */
export function workerWord(index: number, field: number): number {
  return WORKER_BASE + WORKER_STRIDE * index + field
}

export function createControlBlock(): SharedArrayBuffer {
  return new SharedArrayBuffer(CONTROL_BLOCK_BYTES)
}

/**
 * The control block. `words` is public so a later milestone can read/write any field (`Ack`,
 * `Yield`, memory counters, …) with `Atomics` directly; this class owns only the two operations
 * every producer/consumer pair needs.
 */
export class ControlBlock {
  readonly words: Int32Array

  constructor(sab: SharedArrayBuffer) {
    this.words = new Int32Array(sab)
  }

  /** Producer side, called after a commit: bump the consumer's wake word and notify it. */
  wake(index: number): void {
    const at = workerWord(index, W_WAKE)
    Atomics.add(this.words, at, 1)
    Atomics.notify(this.words, at)
  }

  /**
   * Consumer side: block until the wake word differs from `last`, or `timeoutMs` elapses. Cannot
   * lose a wake-up: if `wake()` already ran between the caller's own load and this call,
   * `Atomics.wait` sees the mismatch and returns immediately instead of blocking.
   *
   * Deliberately returns nothing (docs/plan/11-camera-and-input.md step 7, Deviations, "fix 1"):
   * `runBlockingLoop` used to discard this method's own return value and then re-read the same
   * word a second time with its own separate `Atomics.load` one line later -- a genuine redundant
   * native call on every single wake, removed here (the caller now does the one load it always
   * needed anyway). A real cleanup on its own merits, and nothing more: it did not move the byte
   * total that motivated it.
   *
   * This method's body is pinned to that one statement by `sab/no-alloc-syntax.test.ts`'s
   * `sab.wait_for_wake_shape` -- `worker/shell.ts` blocks only through here, so ordinary hot-path
   * discipline. It is no longer load-bearing for the zero-GC instrument: the ~13.5 KB this frame
   * was once blamed for is a one-off V8 JIT code-installation burst billed to whichever frame
   * happens to be executing (measured on seven different ones, `waitForWake` among them), which
   * docs/decisions/0028-zero-gc-two-measured-windows.md separates by measuring two windows and
   * taking the lower total, not by excluding any name.
   */
  waitForWake(index: number, last: number, timeoutMs: number): void {
    Atomics.wait(this.words, workerWord(index, W_WAKE), last, timeoutMs)
  }
}
