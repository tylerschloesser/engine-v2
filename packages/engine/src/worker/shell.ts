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
import type {
  FromWorker,
  SimControlMessage,
  SimLifecycleMessage,
  SimWorldOpMessage,
  SimWorldOpResult,
  TestCallMessage,
} from './protocol.js'

export type LoopState = {
  body: (wokenBy: number) => void
  timeoutMs: () => number
  /** Optional: a kind with a WASM instance answers a parked-only `test-call` message through this
   * (`worker/test-call.ts`'s `handleTestCall`, closed over its own instance). Absent for a kind
   * with no instance (`net`). Not part of the loop `runBlockingLoop` re-enters with -- `worker.ts`
   * reads it once, off the returned `LoopState`, and routes `test-call` messages to it directly
   * (docs/plan/08b-gen-workers-and-queue.md, orchestrator decision 1 at the step-5 boundary). */
  testCall?: (m: TestCallMessage) => FromWorker
  /** docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: `worker/sim.ts`'s own handler for
   * `SimControlMessage` (`sim-pause`/`sim-resume`), parked-only like `testCall` above -- `worker.ts`
   * routes both message types here directly, never generically. Absent for every kind but `sim`. */
  simControl?: (m: SimControlMessage) => void
  /** docs/plan/23-persistence-opfs-and-lifecycle.md step 5: `worker/sim.ts`'s own handler for
   * `SimWorldOpMessage` (export/import/delete), parked-only like `simControl` above and routed the
   * same way by `worker.ts`. Present only for a `sim`-kind worker that opened real world storage
   * (`message.world`) -- including a world whose `Persistence.open` itself failed (Deviations,
   * `'load-failed'`), which still has live OPFS handles to offer. */
  worldOp?: (m: SimWorldOpMessage) => void
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
   * is reported through `fatal`. Callable from *inside* a `body()` pass (M23 fix round 1: the loop
   * that called that pass leaves right after it returns, instead of re-entering `Atomics.wait` and
   * starving `fn` forever) or from outside one (setup, a parked message handler) exactly as before.
   * A second `runAsync` call while one is already in flight is queued, FIFO, run after the first
   * settles -- never dropped or rejected.
   */
  runAsync(fn: () => Promise<void>): void
  /** docs/plan/23-persistence-opfs-and-lifecycle.md Seams: the sim worker's own lifecycle
   * notifications beyond `ready`/`fatal` (`SimLifecycleMessage`) -- `postMessage` after setup still
   * carries lifecycle only (0015 §2). Step 5 adds `SimWorldOpResult` to the same channel (still not a
   * per-frame/per-tick path: one message per explicit export/import/delete request). */
  post(m: SimLifecycleMessage | SimWorldOpResult): void
}

/** `postMessage` is the worker's only channel to main outside setup (0015 §2): shared by every
 * kind body through the shell, so no kind imports `self.postMessage` directly. Planning decision 6
 * ("transfers the buffer back"): `export-world-result`'s own `bytes` is handed over by transfer, not
 * structured-cloned, since it can be several MB for a long-lived world. */
function post(m: FromWorker): void {
  const scope = self as unknown as { postMessage(m: FromWorker, transfer?: Transferable[]): void }
  if (m.type === 'export-world-result') {
    scope.postMessage(m, [m.bytes.buffer])
  } else {
    scope.postMessage(m)
  }
}

export class Shell implements WorkerShell {
  readonly control: ControlBlock
  readonly index: number
  #loop: LoopState | null = null
  #stopped = false
  /** M23 fix round 1: set by `runAsync` when it is called *from inside* an active `body()` pass (a
   * call within `runBlockingLoop`'s own loop -- as opposed to `resume()`'s or `worker.ts`'s own
   * first entry, from which `runAsync` also works but there is no enclosing loop pass to leave).
   * `runBlockingLoop` checks and clears this immediately after every `runBodyOnce` call: `true`
   * means leave now, without repeating the yielded-exit's own `W_PARKED` store (`runAsync` already
   * made it, before ever queuing `fn` -- see there). */
  #leaveRequested = false
  /** Whether a `runAsync` promise chain (one `fn`, or a FIFO queue of them) is currently running.
   * `resume()` reads this to stay a no-op on `W_PARKED`/`runBlockingLoop` itself while true: the
   * chain's own `.finally()` (below) is what re-enters the loop once every queued `fn` has settled,
   * and starting a second, concurrent `runBlockingLoop` here would race it. */
  #asyncInFlight = false
  #asyncQueue: Array<() => Promise<void>> = []

  constructor(control: ControlBlock, index: number) {
    this.control = control
    this.index = index
  }

  fatal(message: string): void {
    this.#stopped = true
    Atomics.store(this.control.words, workerWord(this.index, W_READY), Ready.Dead)
    post({ type: 'fatal', message })
  }

  post(m: SimLifecycleMessage | SimWorldOpResult): void {
    post(m)
  }

  runAsync(fn: () => Promise<void>): void {
    const loop = this.#loop
    if (!loop || this.#stopped) return
    if (this.#asyncInFlight) {
      // A second `runAsync` while one is already in flight (Deviations): queued, FIFO, never
      // dropped or rejected -- a caller's `fn` is always real, already-decided work (e.g. a second
      // `OpfsStorage.pendingAsync()` closure queued behind the first).
      this.#asyncQueue.push(fn)
      return
    }
    this.#asyncInFlight = true
    // Set *before* `runBodyOnce`'s own call frame (if any) returns to `runBlockingLoop`, so its own
    // post-pass check (below) sees it; harmless, and required, when `runAsync` is instead called
    // from outside any pass (setup, a parked handler) -- nothing reads it until a loop exists to
    // leave, and `runBlockingLoop`'s very first pass checks it the same way.
    this.#leaveRequested = true
    Atomics.store(this.control.words, workerWord(this.index, W_PARKED), 1)
    this.#runQueued(fn)
  }

  #runQueued(fn: () => Promise<void>): void {
    fn()
      .catch((e: unknown) => this.fatal(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        if (this.#stopped) return
        const next = this.#asyncQueue.shift()
        if (next) {
          this.#runQueued(next)
          return
        }
        this.#asyncInFlight = false
        const loop = this.#loop
        if (!loop) return
        const seen = this.observeWake()
        Atomics.store(this.control.words, workerWord(this.index, W_PARKED), 0)
        runBlockingLoop(this, loop.body, loop.timeoutMs, seen)
      })
  }

  /** `runBlockingLoop`'s own hook, checked right after every `runBodyOnce` call (including the very
   * first, before the `for` loop): `true` (and cleared) exactly once, when that pass called
   * `runAsync`. Not part of the public `WorkerShell` seam. */
  consumeLeaveRequest(): boolean {
    if (!this.#leaveRequested) return false
    this.#leaveRequested = false
    return true
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
   * loop yet (still in setup) or one that never left the event loop (a `net`-kind worker).
   *
   * M23 fix round 1: also a no-op on `W_PARKED`/the loop itself while a `runAsync` chain is in
   * flight (`#asyncInFlight`) -- that chain's own `.finally()` owns the next `runBlockingLoop` entry
   * (`#runQueued`, above), and starting a second one here would run two concurrent passes over the
   * same worker. Clearing `W_YIELD` is still correct and still happens: a park request that arrived
   * while async work was running must not make the loop immediately re-yield the instant that work's
   * own re-entry happens. Coherence for `parkWorkers`/`attachHostLifecycle`'s `sim-pause`: `W_PARKED
   * = 1` means the same thing either way (this worker is not blocked in `Atomics.wait` and will
   * accept a `postMessage`), whether it got there via the yielded exit below or via `runAsync`. */
  resume(): void {
    if (this.#stopped) return
    Atomics.store(this.control.words, workerWord(this.index, W_YIELD), 0)
    if (this.#asyncInFlight) return
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
 * The `yield` protocol (Planning decisions): the loop checks `W_YIELD` *before every wait,
 * including its own first one* -- fixed M17c step 3, round 2 (docs/plan/17c-client-park-stall.md):
 * the original shape checked it only *after* a wait returned, so a park request whose own
 * `W_YIELD = 1` store and wake both land before this function's first `waitForWake` call (inside
 * the gap `Shell.resume()`'s own steps leave between reading `W_WAKE` and calling here, or
 * symmetrically at `worker.ts`'s first entry or `Shell.runAsync`'s re-entry, every one of which
 * builds `lastSeen`/`last` before ever consulting `W_YIELD`) was invisible until a *further* wake
 * arrived -- with nothing left to send one, since the park's own wake was already folded into
 * `last`, the worker slept in `Atomics.wait` forever, `W_YIELD = 1` and `W_PARKED` never set.
 * Checking first, on every pass through the loop, means a yield that already happened by the time
 * control reaches here is caught immediately, with no wait at all; when set, the loop stores
 * `W_PARKED = 1` and returns to the event loop, where `onmessage`, CDP and promises run.
 * `resume()`/`runAsync` re-enter through this same function.
 *
 * `lastSeen` is the wake-word value the caller read *before* it published this worker as available
 * (`Shell.observeWake`); every caller that publishes availability must pass it, or a wake issued
 * between the publish and this function's own read is lost and the producer waits forever. Its own
 * ordering relative to clearing `W_YIELD` no longer matters for *this* class of loss (the check
 * above catches it either way, whichever word ends up read first) -- it is unchanged here.
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
 *
 * **Leaves right after any pass that called `runAsync`** (M23 fix round 1, `Shell.consumeLeaveRequest`
 * doc comment): checked after the drain-on-entry pass and after every pass inside the `for` loop.
 * `W_PARKED` is not stored again on this exit (`runAsync` itself already stored it, before this
 * function's own caller -- `runBodyOnce`, still on the same call stack -- ever returns), so the two
 * exits (yielded, and this one) store it exactly once between them either way.
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
  if (shell.consumeLeaveRequest()) return
  for (;;) {
    if (Atomics.load(control.words, workerWord(index, W_YIELD))) break
    control.waitForWake(index, last, timeoutMs())
    if (shell.stopped()) return
    // `waitForWake` itself returns nothing (`sab/control.ts`'s own doc comment: this is a
    // redundant-call removal, not the fix for the cost that method's own comment documents). Same
    // word, same address `waitForWake` just waited on. The loop's own top checks `W_YIELD` again
    // before the *next* wait, so a wake that turns out to also carry a park request is caught one
    // pass later rather than re-checked twice here.
    last = Atomics.load(control.words, workerWord(index, W_WAKE))
    if (!runBodyOnce(shell, body, last)) return
    if (shell.consumeLeaveRequest()) return
  }
  Atomics.store(control.words, workerWord(index, W_PARKED), 1)
}
