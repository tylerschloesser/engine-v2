// The control block: one `SharedArrayBuffer` shared by every thread (docs/decisions/0015-threads-
// memory-and-topology.md §2 "Wake-ups"; docs/plan/06-sab-primitives-and-workers.md, Planning
// decisions "Control-block layout"). `Int32Array[64]`: four global words, then seven 8-word
// per-worker blocks (four used). The wake word is per *consumer thread*, not per ring (0024 §10):
// a worker with several input rings still blocks on one address.

export const CONTROL_BLOCK_INT32S = 64
export const CONTROL_BLOCK_BYTES = CONTROL_BLOCK_INT32S * 4

// Global words (indices 0-7; 5-7 reserved).
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
   * Consumer side: block until the wake word differs from `last`, or `timeoutMs` elapses.
   * Returns the word's current value (the next `last` to pass in). Cannot lose a wake-up: if
   * `wake()` already ran between the caller's own load and this call, `Atomics.wait` sees the
   * mismatch and returns immediately instead of blocking.
   */
  waitForWake(index: number, last: number, timeoutMs: number): number {
    const at = workerWord(index, W_WAKE)
    Atomics.wait(this.words, at, last, timeoutMs)
    return Atomics.load(this.words, at)
  }
}
