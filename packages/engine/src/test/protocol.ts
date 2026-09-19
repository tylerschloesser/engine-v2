// Messages between `harness.ts` (main) and `harness-worker.ts` (the harness worker). Types only,
// erased at compile time.
import type { Role } from '../abi.js'
import type { InstanceConfig } from '../loader.js'

export type ToWorker =
  | {
      type: 'setup'
      module: WebAssembly.Module
      name: string
      role: Role
      config: InstanceConfig
      sab: SharedArrayBuffer
      /** M04 (docs/plan/04-zero-gc-harness.md, Seams): a fixed block copied SAB -> `Rx` and a fixed
       * block copied `Tx` -> SAB, through view pairs created here at setup. Absent for a worker that
       * only needs plain `sim_tick` (M03's `stepping.html`). */
      rxTx?: { rx: SharedArrayBuffer; tx: SharedArrayBuffer }
    }
  | { type: 'resume' }
  | { type: 'hash' }
  | { type: 'admit'; bytes: Uint8Array }
  | { type: 'memory' }
  | { type: 'memGrows' }
  /** M04: marks this isolate for `analyse.ts`'s trace-side naming (Planning decisions "Naming
   * isolates"). Only reachable while the worker is idle (parked), like every other message here. */
  | { type: 'markIsolate' }
  /** M04: one tick driven by a message round trip instead of the SAB step protocol -- the
   * `post-message` negative control (0016 §3 step 8). Only valid while the worker was never armed
   * for this run (`Harness.resume({ except })`). */
  | { type: 'pmTick' }
  | { type: 'dispose' }

export type FromWorker =
  | { type: 'ready'; gcExposed: boolean }
  | { type: 'setupError'; message: string }
  | { type: 'armed' }
  | { type: 'parked' }
  | { type: 'hash'; value: string }
  | { type: 'admit'; status: number }
  | { type: 'memory'; bytes: number }
  | { type: 'memGrows'; grows: number }
  | { type: 'markedIsolate' }
  | { type: 'pmTick' }
  /** Panic or trap; accumulated by the harness, never rejects an in-flight step (Planning decisions). */
  | { type: 'error'; message: string }
