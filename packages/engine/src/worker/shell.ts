// The blocking-loop shell every worker kind runs inside (docs/decisions/0015-threads-memory-and-
// topology.md §2 "Wake-ups"; docs/plan/06b-workers-and-spawn.md, Planning decisions "`yield`
// protocol"). One `WorkerShell` per worker; `runBlockingLoop` is the loop, `shell.fatal`/
// `shell.runAsync` are the two ways a kind body leaves it early. `Atomics.wait` itself lives only in
// `ControlBlock.waitForWake` (`sab/control.ts`): this file blocks only through that.
import {
  type ControlBlock,
  Ready,
  W_PARKED,
  W_READY,
  W_WAKE,
  W_YIELD,
  workerWord,
} from '../sab/control.js'
import type { FromWorker, TestCallMessage } from './protocol.js'

export type LoopState = {
  body: (wokenBy: number) => void
  timeoutMs: () => number
  /** Optional: a kind with a WASM instance answers a parked-only `test-call` message through this
   * (`worker/test-call.ts`'s `handleTestCall`, closed over its own instance). Absent for a kind
   * with no instance (`net`). Not part of the loop `runBlockingLoop` re-enters with -- `worker.ts`
   * reads it once, off the returned `LoopState`, and routes `test-call` messages to it directly
   * (docs/plan/08b-gen-workers-and-queue.md, orchestrator decision 1 at the step-5 boundary). */
  testCall?: (m: TestCallMessage) => FromWorker
}

/** Every kind's `timeoutMs` until M13 gives `sim` a real tick deadline: a module-level constant
 * closed over once, not `Number.POSITIVE_INFINITY` read fresh on every pass. Fix round 2 evidence
 * (docs/plan/06b-workers-and-spawn.md, Deviations, `byFn` attribution on `topology clean`) found
 * each kind's own `const NO_TIMEOUT = (): number => Number.POSITIVE_INFINITY` was the single
 * largest allocation site in the idle `sim`/`gen0`/`client` isolates: reading the named property
 * `Number.POSITIVE_INFINITY` boxed a fresh `HeapNumber` on every call, in the interpreter tier a
 * worker blocked in `Atomics.wait` most of its life may never leave. Returning an already-boxed
 * local instead (computed once, at module load) avoids the re-box. */
const INFINITE_TIMEOUT_MS: number = Number.POSITIVE_INFINITY

/** Shared by every kind with no real deadline yet (`sim`, `gen`, `client`): see
 * `INFINITE_TIMEOUT_MS`'s own comment. */
export function noTimeout(): number {
  return INFINITE_TIMEOUT_MS
}

export interface WorkerShell {
  readonly control: ControlBlock
  readonly index: number
  /** Marks the worker dead (`W_READY = Ready.Dead`) and posts `{ type: 'fatal', message }`; no
   * loop iteration and no `resume()` runs again afterwards. */
  fatal(message: string): void
  /**
   * Leaves the blocking loop, awaits `fn`, then re-enters it: for a Promise-only host API (opening
   * an OPFS file, M23) a worker cannot otherwise reach while blocked in `Atomics.wait`. A rejection
   * is reported through `fatal`.
   */
  runAsync(fn: () => Promise<void>): void
}

/** `postMessage` is the worker's only channel to main outside setup (0015 §2): shared by every
 * kind body through the shell, so no kind imports `self.postMessage` directly. */
function post(m: FromWorker): void {
  ;(self as unknown as { postMessage(m: FromWorker): void }).postMessage(m)
}

export class Shell implements WorkerShell {
  readonly control: ControlBlock
  readonly index: number
  #loop: LoopState | null = null
  #stopped = false

  constructor(control: ControlBlock, index: number) {
    this.control = control
    this.index = index
  }

  fatal(message: string): void {
    this.#stopped = true
    Atomics.store(this.control.words, workerWord(this.index, W_READY), Ready.Dead)
    post({ type: 'fatal', message })
  }

  runAsync(fn: () => Promise<void>): void {
    const loop = this.#loop
    if (!loop || this.#stopped) return
    Atomics.store(this.control.words, workerWord(this.index, W_PARKED), 1)
    fn()
      .catch((e: unknown) => this.fatal(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        if (this.#stopped) return
        const seen = this.observeWake()
        Atomics.store(this.control.words, workerWord(this.index, W_PARKED), 0)
        runBlockingLoop(this, loop.body, loop.timeoutMs, seen)
      })
  }

  /**
   * This thread's current value of its own wake word, read *before* it publishes that it is
   * available again (`W_PARKED = 0`, or the `ready` post of the first entry). Handing it to
   * `runBlockingLoop` as `lastSeen` is what closes the lost-wake window: a producer that sees the
   * worker available and calls `ControlBlock.wake()` bumps the word past this value, so the
   * worker's first `Atomics.wait` sees the mismatch and returns instead of sleeping on a wake that
   * already happened (fix round 3, docs/plan/06b-workers-and-spawn.md, Deviations).
   */
  observeWake(): number {
    return Atomics.load(this.control.words, workerWord(this.index, W_WAKE))
  }

  /** `runBlockingLoop` records its own arguments here so `runAsync` and `resume()` can re-enter
   * with the same loop; not part of the public `WorkerShell` seam. */
  setLoop(state: LoopState): void {
    this.#loop = state
  }

  stopped(): boolean {
    return this.#stopped
  }

  /** `{ type: 'resume' }` handler (docs/plan/06b-workers-and-spawn.md, Planning decisions): store
   * `W_YIELD = 0` and re-enter the loop this worker was parked from. A no-op for a worker with no
   * loop yet (still in setup) or one that never left the event loop (a `net`-kind worker). */
  resume(): void {
    if (this.#stopped) return
    Atomics.store(this.control.words, workerWord(this.index, W_YIELD), 0)
    const loop = this.#loop
    if (loop) {
      const seen = this.observeWake()
      Atomics.store(this.control.words, workerWord(this.index, W_PARKED), 0)
      runBlockingLoop(this, loop.body, loop.timeoutMs, seen)
    }
  }

  /** `{ type: 'stop' }` handler: marks the worker so no further loop iteration or `resume()` runs.
   * `destroy()` (`client.ts`) terminates the thread outright afterwards; this is the hook a kind
   * without a blocking loop (`net`, event-driven) uses to shut down cleanly first (M29). */
  stop(): void {
    this.#stopped = true
  }
}

export function createShell(control: ControlBlock, index: number): Shell {
  return new Shell(control, index)
}

/**
 * Runs `body(last)` once, turning a thrown error into `shell.fatal` the same way every iteration of
 * `runBlockingLoop`'s own wait loop does (a trap, 0014 §6, or any other uncaught error in a kind
 * body: mark the worker dead instead of letting it escape). Returns `false` when the worker is now
 * stopped and the caller must not continue.
 */
function runBodyOnce(shell: Shell, body: (wokenBy: number) => void, last: number): boolean {
  try {
    body(last)
    return true
  } catch (e) {
    shell.fatal(e instanceof Error ? e.message : String(e))
    return false
  }
}

/**
 * Blocks the worker thread in `Atomics.wait` (through `ControlBlock.waitForWake`), calling `body`
 * on every real wake, until yielded. `timeoutMs()` is read fresh before every wait: `Infinity` for
 * every kind until M13 gives the sim role a real tick deadline.
 *
 * The `yield` protocol (Planning decisions): the loop checks `W_YIELD` first on every wake; when
 * set, it stores `W_PARKED = 1` and returns to the event loop, where `onmessage`, CDP and promises
 * run. `resume()`/`runAsync` re-enter through this same function.
 *
 * `lastSeen` is the wake-word value the caller read *before* it published this worker as available
 * (`Shell.observeWake`); every caller that publishes availability must pass it, or a wake issued
 * between the publish and this function's own read is lost and the producer waits forever.
 *
 * **Drains on entry, before the first wait** (docs/plan/08b-gen-workers-and-queue.md, orchestrator
 * decision 2 at the step-5 boundary): a wake issued while this worker was parked (M06b, "a wake
 * issued while a worker is parked is not replayed on `resume()`") can carry real ring traffic that
 * arrived with nobody able to act on it -- a `genRequest` pushed to a parked gen worker, say. Every
 * caller of this function (`worker.ts`'s first entry, `Shell.resume()`, `Shell.runAsync`'s re-entry)
 * gets the same drain for free by running `body(last)` here once, unconditionally, before ever
 * blocking. A body pass with nothing to do costs one allocation-free call and re-stores the same
 * `W_ACK` value a `sim`/`gen` body already stores on every real wake, so it never disturbs the ack
 * lockstep a test driver locksteps against.
 */
export function runBlockingLoop(
  shell: Shell,
  body: (wokenBy: number) => void,
  timeoutMs: () => number,
  lastSeen?: number,
): void {
  shell.setLoop({ body, timeoutMs })
  const { control, index } = shell
  let last = lastSeen ?? Atomics.load(control.words, workerWord(index, W_WAKE))
  if (!runBodyOnce(shell, body, last)) return
  for (;;) {
    control.waitForWake(index, last, timeoutMs())
    if (shell.stopped()) return
    if (Atomics.load(control.words, workerWord(index, W_YIELD))) break
    last = Atomics.load(control.words, workerWord(index, W_WAKE))
    if (!runBodyOnce(shell, body, last)) return
  }
  Atomics.store(control.words, workerWord(index, W_PARKED), 1)
}
