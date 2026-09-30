// `engine/test` (docs/decisions/0020 §8, docs/decisions/0017 §2): the test entrypoint, absent from
// production bundles. Never imported by production code: `loader.ts`, `abi.ts`, `client.ts`,
// `vite.ts`, `server-node.ts` never import from `src/test/` or this file (checked by grepping
// `dist/`, an exit criterion of docs/plan/03-browser-harness.md).
export type { Clock, Scheduler } from './clock.js'
export {
  type ConditionedLink,
  type ConditionerConditions,
  type ConditionerOptions,
  conditionLink,
  type StallOptions,
} from './net/conditioner.js'
export { memoryConnectionPair } from './net/memory-connection.js'
export { type BytePump, createBytePump } from './net/pump.js'
export { serverInternals, worldServerTestHandle } from './server.js'
export { assertBudget } from './test/budget.js'
export {
  actionResults,
  asHarness,
  callParked,
  type DrawRecord,
  dispatchRaw,
  drawListHash,
  drawListRecords,
  forceSnapshot,
  hashDrawListFields,
  hostRegionHash,
  interpCounters,
  lastUi,
  type NetCounters,
  netCounters,
  parkWorkers,
  persistenceCounters,
  pickAt,
  pickScanned,
  pumpUntilLive,
  replicaHash,
  resumeWorkers,
  samplePresences,
  setCamera,
  simCounters,
  stepFrame,
  stepSimTickSync,
  stepTick,
  styleWrites,
  type TestCallResult,
  untilConfigured,
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
  createHeadlessClient,
  type HeadlessClient,
  type HeadlessClientOptions,
  type HeadlessClientStatus,
  type ViewReport,
} from './test/headless-client.js'
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
  createNetHarness,
  type NetHarness,
  type NetHarnessCounters,
  type NetHarnessOptions,
} from './test/net-harness.js'
export type {
  InterpCounters,
  InterpModeName,
  PresenceSampleRow,
} from './test/presence-samples.js'
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
  readPixels,
  renderTo,
  tileCentrePx,
  uploadBytes,
  uploadRecords,
} from './test/render.js'
export {
  type ReplayWorldOptions,
  type RunHeavyOptions,
  replayWorld,
  runHeavy,
} from './test/replay.js'
export { trapSim } from './test/trap.js'
export {
  attachViewportTestHooks,
  clearRebaseFlag,
  rebaseFlagSet,
  setViewport,
  setVisibility,
} from './test/viewport.js'
export {
  createVirtualClock,
  type PendingDelivery,
  type VirtualClock,
} from './test/virtual-clock.js'
