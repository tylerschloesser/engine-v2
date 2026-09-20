// Messages between `client.ts` (main) and `worker.ts`'s `run()` (docs/plan/06b-workers-and-spawn.md,
// Seams: "the only steady use of postMessage besides fatal and resume"). Types only, erased at
// compile time.
import type { InstanceConfig } from '../loader.js'
import { WORKER_GEN1 } from '../sab/control.js'
import type { SabSet } from '../sab/layout.js'

export type WorkerKind = 'client' | 'sim' | 'gen' | 'net'

/** The isolate name budgets and controls use (docs/plan/06b-workers-and-spawn.md, orchestrator
 * decision 1): `'client' | 'sim' | 'gen0' | 'gen1' | 'net'`; `'main'` is reserved for the page
 * thread. Shared by `worker.ts` (sets `self.__engineIsolateName`) and `test/client.ts`'s
 * `asHarness` (names `Harness.workerNames` the same way), so a CDP `Runtime.evaluate` of
 * `self.__engineIsolateName` always agrees with what the test driver expects. */
export function isolateName(kind: WorkerKind, index: number): string {
  if (kind === 'gen') return index === WORKER_GEN1 ? 'gen1' : 'gen0'
  return kind
}

/** Test-only behaviour carried in the setup message, never read by a production build that omits
 * `engine/test` (docs/plan/06b-workers-and-spawn.md, Consumes: M04's `gcHook`). */
export type TestFlags = {
  /** Drives the `echo` zero-GC page's SAB -> region -> region -> SAB round trip (Tests added). */
  echo?: boolean
  /** `false` exercises the URL fallback (the worker calls `instantiateStreaming` itself) instead
   * of a posted `Module` (Planning decisions "Posted `Module` first, URL as fallback"). */
  postModule?: boolean
  /** M04's negative-control hook (`applyStepControl`), applied once per tick/frame this worker
   * runs, read fresh from the control block's `Control` word set up the same way `step-block.ts`
   * does it for the test harness. */
  gcHook?: boolean
}

export type SetupMessage = {
  type: 'setup'
  kind: WorkerKind
  /** This worker's index into the control block (`sab/control.ts`'s `WORKER_*` constants). */
  index: number
  /** Posted by default (Planning decisions); absent when `test.postModule === false`. */
  module?: WebAssembly.Module
  /** Present only when `module` is absent: the worker calls `instantiateStreaming` itself. */
  wasmUrl?: string
  sabs: SabSet
  config: InstanceConfig
  test?: TestFlags
}

/**
 * Main -> worker, parked-only: one generic test-gated call channel (docs/plan/
 * 08b-gen-workers-and-queue.md, orchestrator decision 1 at the step-5 boundary), used by
 * `engine/test`'s `callParked` instead of a new `SabSet` field or a query-specific message. `a`/`b`
 * are the export's arguments in order (0 or 2 args covers every export named by this milestone;
 * `undefined` means "not passed", not "pass 0"). Answered only by a worker whose setup message
 * carried `test` (`worker/test-call.ts`) and only while it is parked (a worker blocked in
 * `Atomics.wait` receives no events, 0015 §2).
 */
export type TestCallMessage = {
  type: 'test-call'
  id: number
  name: string
  a?: number
  b?: number
  resultBytes?: number
}

export type ToWorker = SetupMessage | { type: 'resume' } | { type: 'stop' } | TestCallMessage

export type FromWorker =
  | { type: 'ready' }
  | { type: 'fatal'; message: string }
  /** `test-call`'s reply: `value` is the export's return value, `result` a copy of the first
   * `resultBytes` bytes of `Result` (empty when 0 or absent). */
  | { type: 'test-result'; id: number; value: number; result: Uint8Array }
  /** `test-call`'s reply for an unknown export, a missing instance (e.g. the `net` kind), or a
   * trap. */
  | { type: 'test-error'; id: number; message: string }
