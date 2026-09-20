// `net`-kind worker body (docs/plan/06b-workers-and-spawn.md, Scope): "event-driven idle shell, no
// WASM" until M29 gives it the `WebSocket` and a byte pump (0015 §1: a net worker "must receive
// socket events", so it is never blocked in `Atomics.wait` the way the other kinds are). It never
// enters `runBlockingLoop`; `W_PARKED` is set once, immediately, since an event-driven worker is
// always reachable the way a parked one is (park/resume helpers that poll every worker's
// `W_PARKED` see it as already quiescent).
import { W_PARKED, workerWord } from '../sab/control.js'
import type { SetupMessage } from './protocol.js'
import type { LoopState, Shell } from './shell.js'

/** `null`: net has no blocking loop (event-driven, must receive socket events, 0015 §2) and
 * nothing to await until M29's socket connect. */
export function setup(shell: Shell, _message: SetupMessage): Promise<LoopState | null> {
  Atomics.store(shell.control.words, workerWord(shell.index, W_PARKED), 1)
  return Promise.resolve(null)
}
