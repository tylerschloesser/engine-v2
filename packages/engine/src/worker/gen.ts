// `gen`-kind worker body (docs/plan/06b-workers-and-spawn.md, Scope): instantiate, `engine_init`,
// reserve the arena, block. Waits until M08b gives it a request ring to drain (Non-scope). `W_ACK`
// is stored on every real wake regardless of `gcHook` (a plain `Atomics.store`, allocation-free):
// see `sim.ts`'s own comment on why a test driver needs this before real ring traffic exists.
import { Role } from '../abi.js'
import { W_ACK, workerWord } from '../sab/control.js'
import { applyGcHook } from './gc-hook.js'
import { instantiateForSetup } from './instantiate.js'
import type { SetupMessage } from './protocol.js'
import type { LoopState, Shell } from './shell.js'

const NO_TIMEOUT = (): number => Number.POSITIVE_INFINITY

export async function setup(shell: Shell, message: SetupMessage): Promise<LoopState> {
  await instantiateForSetup(shell, message, Role.Gen)
  const gcHook = message.test?.gcHook === true

  function body(wokenBy: number): void {
    if (gcHook) applyGcHook(shell.control, shell.index)
    Atomics.store(shell.control.words, workerWord(shell.index, W_ACK), wokenBy)
  }

  return { body, timeoutMs: NO_TIMEOUT }
}
