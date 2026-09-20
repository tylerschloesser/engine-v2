// `sim`-kind worker body (docs/plan/06b-workers-and-spawn.md, Scope): instantiate, `engine_init`,
// reserve the arena, block. Waits without a timeout ("`Infinity`") until M13 gives it a real tick
// deadline; no ring traffic yet (Non-scope: sim host and tick pacing, M13). `W_ACK` is stored on
// every real wake regardless of `gcHook` (a plain `Atomics.store`, allocation-free): a test driver
// (`test/client.ts`'s `asHarness`) uses it to lockstep a synthetic wake with this worker the same
// way `stepFrame` locksteps the client role, since sim has no ring traffic of its own to synchronise
// on yet.
import { Role } from '../abi.js'
import { W_ACK, workerWord } from '../sab/control.js'
import { applyGcHook } from './gc-hook.js'
import { instantiateForSetup } from './instantiate.js'
import type { SetupMessage } from './protocol.js'
import type { LoopState, Shell } from './shell.js'

const NO_TIMEOUT = (): number => Number.POSITIVE_INFINITY

export async function setup(shell: Shell, message: SetupMessage): Promise<LoopState> {
  await instantiateForSetup(shell, message, Role.Sim)
  const gcHook = message.test?.gcHook === true

  function body(wokenBy: number): void {
    if (gcHook) applyGcHook(shell.control, shell.index)
    Atomics.store(shell.control.words, workerWord(shell.index, W_ACK), wokenBy)
  }

  return { body, timeoutMs: NO_TIMEOUT }
}
