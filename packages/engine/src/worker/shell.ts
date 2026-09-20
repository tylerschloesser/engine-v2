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
import type { FromWorker } from './protocol.js'

export type LoopState = { body: (wokenBy: number) => void; timeoutMs: () => number }

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
        Atomics.store(this.control.words, workerWord(this.index, W_PARKED), 0)
        runBlockingLoop(this, loop.body, loop.timeoutMs)
      })
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
      Atomics.store(this.control.words, workerWord(this.index, W_PARKED), 0)
      runBlockingLoop(this, loop.body, loop.timeoutMs)
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
 * Blocks the worker thread in `Atomics.wait` (through `ControlBlock.waitForWake`), calling `body`
 * on every real wake, until yielded. `timeoutMs()` is read fresh before every wait: `Infinity` for
 * every kind until M13 gives the sim role a real tick deadline.
 *
 * The `yield` protocol (Planning decisions): the loop checks `W_YIELD` first on every wake; when
 * set, it stores `W_PARKED = 1` and returns to the event loop, where `onmessage`, CDP and promises
 * run. `resume()`/`runAsync` re-enter through this same function.
 */
export function runBlockingLoop(
  shell: Shell,
  body: (wokenBy: number) => void,
  timeoutMs: () => number,
): void {
  shell.setLoop({ body, timeoutMs })
  const { control, index } = shell
  let last = Atomics.load(control.words, workerWord(index, W_WAKE))
  for (;;) {
    control.waitForWake(index, last, timeoutMs())
    if (shell.stopped()) return
    if (Atomics.load(control.words, workerWord(index, W_YIELD))) break
    last = Atomics.load(control.words, workerWord(index, W_WAKE))
    try {
      body(last)
    } catch (e) {
      // A trap (0014 §6) or any other uncaught error in a kind body: mark the worker dead instead
      // of letting it escape the loop (Non-scope: re-instantiation is M24; here it just stops).
      shell.fatal(e instanceof Error ? e.message : String(e))
      return
    }
  }
  Atomics.store(control.words, workerWord(index, W_PARKED), 1)
}
