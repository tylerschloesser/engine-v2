// `engine/test` (docs/plan/24-recovery-and-migration.md Provides): `trapSim`, the "M24 test trap
// hook" M28b's own `harness.panicServer()` uses to force a deterministic trap on a sim-role
// instance without needing a fixture game with its own panicking action. Reached by name through
// `call0`, the same "test-only export, always through call0/1/2" shape as `hostRegionHash`/
// `netCounters`/`markUiDirty` (`test/client.ts`).
//
// Takes the raw `EngineInstance`, not `server.ts`'s `SimHost`/`SimInstance`: `SimInstance` is a
// deliberately narrow seam (`wrapEngineInstance`'s own doc comment: "a fake instance under Vitest"
// means a hand-written object shaped like it), and widening it here would ripple into every
// hand-written fake `SimInstance` this repo's existing tests already build. Wiring this into
// whatever `SimHost`-level call `recovery.ts`/`panicServer()` needs is the second implementer's
// (docs/plan/24-recovery-and-migration.md step 4).
import type { EngineInstance } from '../loader.js'

/** Calls `sim_test_trap` on `inst`: panics in whatever `Phase` the previous, successfully-completed
 * export left the `Progress` region in (`Phase.Idle` right after any ordinary call). Always traps:
 * the call never returns normally. */
export function trapSim(inst: EngineInstance): void {
  inst.call0(inst.x.sim_test_trap)
}
