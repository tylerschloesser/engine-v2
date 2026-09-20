// `sim`-kind worker body (docs/plan/06b-workers-and-spawn.md, Scope): instantiate, `engine_init`,
// reserve the arena, block. Waits without a timeout ("`Infinity`") until M13 gives it a real tick
// deadline; no ring traffic yet (Non-scope: sim host and tick pacing, M13).
import { Role } from '../abi.js'
import { instantiateForSetup } from './instantiate.js'
import type { SetupMessage } from './protocol.js'
import type { LoopState, Shell } from './shell.js'

const NO_TIMEOUT = (): number => Number.POSITIVE_INFINITY

/** No-op: nothing drains yet (Non-scope). */
function noop(): void {}

export async function setup(shell: Shell, message: SetupMessage): Promise<LoopState> {
  await instantiateForSetup(shell, message, Role.Sim)
  return { body: noop, timeoutMs: NO_TIMEOUT }
}
