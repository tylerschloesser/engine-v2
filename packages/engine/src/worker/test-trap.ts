// Test-only trap injection (M37 step 1; `TestFlags.trapClientAtFrame`/
// `trapGenAtChunk`, `worker/protocol.ts`). A worker that wants to behave as if its instance had
// trapped calls `injectTrap(inst, message)` in place of the export call it was about to make: the
// throw goes through the loader's own call wrapper, so the instance is marked dead and the caller
// gets the same `EngineTrap` (with `panicMessage` = `message`, the "trap with no preceding
// `engine.panic`" case of 0014 §6) a real WASM trap produces. No fixture or engine-crate change is
// needed: `sim_test_trap` exists only for the sim role, and a real trap on the client or gen role
// would need a game-specific cause.
//
// Never reached by a shipped build: the callers gate on a `TestFlags` field only a test sets.
import type { EngineInstance } from '../loader.js'

/** Kills `inst` the way a WASM trap does and throws the resulting `EngineTrap`. */
export function injectTrap(inst: EngineInstance, message: string): never {
  inst.call0(() => {
    throw new WebAssembly.RuntimeError(message)
  })
  // `call0` always throws for the function above; this only satisfies the return type.
  throw new Error('injectTrap: the call wrapper did not throw')
}

/** `TestFlags.trapClientAtFrame` / `killSimWorkerAtTick` accept one number or a list. */
export function asNumberList(v: number | number[] | undefined): number[] | null {
  if (v === undefined) return null
  return Array.isArray(v) ? v.slice() : [v]
}
