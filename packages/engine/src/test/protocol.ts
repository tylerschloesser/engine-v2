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
    }
  | { type: 'resume' }
  | { type: 'hash' }
  | { type: 'admit'; bytes: Uint8Array }
  | { type: 'memory' }
  | { type: 'memGrows' }
  | { type: 'dispose' }

export type FromWorker =
  | { type: 'ready' }
  | { type: 'setupError'; message: string }
  | { type: 'armed' }
  | { type: 'parked' }
  | { type: 'hash'; value: string }
  | { type: 'admit'; status: number }
  | { type: 'memory'; bytes: number }
  | { type: 'memGrows'; grows: number }
  /** Panic or trap; accumulated by the harness, never rejects an in-flight step (Planning decisions). */
  | { type: 'error'; message: string }
