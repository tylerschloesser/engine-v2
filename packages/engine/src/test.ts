// `engine/test` (docs/decisions/0020 §8, docs/decisions/0017 §2): the test entrypoint, absent from
// production bundles. Never imported by production code: `loader.ts`, `abi.ts`, `client.ts`,
// `vite.ts`, `server-node.ts` never import from `src/test/` or this file (checked by grepping
// `dist/`, an exit criterion of docs/plan/03-browser-harness.md).
export type { Clock, Scheduler } from './clock.js'
export {
  actionResults,
  callParked,
  type DrawRecord,
  dispatchRaw,
  drawListHash,
  drawListRecords,
  hashDrawListFields,
  hostRegionHash,
  type NetCounters,
  netCounters,
  parkWorkers,
  pumpUntilLive,
  replicaHash,
  resumeWorkers,
  setCamera,
  simCounters,
  stepFrame,
  stepSimTickSync,
  stepTick,
  type TestCallResult,
  untilQuiescent,
  worldHash,
} from './test/client.js'
export type { NegativeControl } from './test/controls.js'
export { fnv1a64Hex } from './test/fnv.js'
export { type GcPageApi, installGcPage } from './test/gc-page.js'
export * as gen from './test/gen.js'
export {
  createHarness,
  type Harness,
  type HarnessWorkerSpec,
} from './test/harness.js'
export {
  attachCameraInputTestHooks,
  type CameraInputBundle,
  injectKey,
  injectPointer,
  injectWheel,
  type PointerPhase,
} from './test/input.js'
export { createManualClock, type ManualClock } from './test/manual-clock.js'
export {
  drawCalls,
  drawListDropped,
  expectPixel,
  instanceBytes,
  type PixelBuffer,
  pageSlotsUsed,
  pipelineSwitches,
  type Renderable,
  type RenderTarget,
  renderTo,
  tileCentrePx,
  uploadBytes,
  uploadRecords,
} from './test/render.js'
export {
  attachViewportTestHooks,
  clearRebaseFlag,
  rebaseFlagSet,
  setViewport,
  setVisibility,
} from './test/viewport.js'
