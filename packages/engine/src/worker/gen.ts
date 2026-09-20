// `gen`-kind worker body (docs/plan/06b-workers-and-spawn.md, Scope): instantiate, `engine_init`,
// reserve the arena, block. Waits until M08b gives it a request ring to drain (Non-scope).
import { Role } from '../abi.js'
import { instantiateForSetup } from './instantiate.js'
import type { SetupMessage } from './protocol.js'
import type { LoopState, Shell } from './shell.js'

const NO_TIMEOUT = (): number => Number.POSITIVE_INFINITY

/** No-op: nothing drains yet (Non-scope: M08b). */
function noop(): void {}

export async function setup(shell: Shell, message: SetupMessage): Promise<LoopState> {
  await instantiateForSetup(shell, message, Role.Gen)
  return { body: noop, timeoutMs: NO_TIMEOUT }
}
