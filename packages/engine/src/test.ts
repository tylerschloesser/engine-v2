// `engine/test` (docs/decisions/0020 §8, docs/decisions/0017 §2): the test entrypoint, absent from
// production bundles. Never imported by production code: `loader.ts`, `abi.ts`, `client.ts`,
// `vite.ts`, `server-node.ts` never import from `src/test/` or this file (checked by grepping
// `dist/`, an exit criterion of docs/plan/03-browser-harness.md).
export type { Clock, Scheduler } from './clock.js'
export type { NegativeControl } from './test/controls.js'
export { fnv1a64Hex } from './test/fnv.js'
export { type GcPageApi, installGcPage } from './test/gc-page.js'
export {
  createHarness,
  type Harness,
  type HarnessWorkerSpec,
} from './test/harness.js'
export { createManualClock, type ManualClock } from './test/manual-clock.js'
