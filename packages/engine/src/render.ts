// `engine/render`: the WebGPU rendering pieces a game assembles into its own real page (0018 §1:
// "rendering never touches a WASM instance", so this never imports `loader.ts`). Every internal
// test/device page already builds a page this way (`tests/browser/pages/src/device.ts`,
// `slice.ts`); this subpath is the first time a *game outside packages/engine* needs the same
// pieces (docs/plan/20-reference-game-v0.md: a real dev page with terrain, pan and zoom), so it is
// added now, together with this file (`packages/engine/CLAUDE.md`: "Add an exports subpath only
// together with the file that backs it").

export type { Clock, Scheduler } from './clock.js'
export { systemClock, systemScheduler } from './clock.js'
export type {
  FramePhase,
  RealFrameLoop,
  RealFrameLoopOptions,
} from './frame-loop.js'
export { attachVisibilityHandling, createRealFrameLoop, FRAME_PHASES } from './frame-loop.js'
export { installPageStyles } from './input/page-css.js'
export type { LoadedArt, TilesManifest } from './render/art.js'
export { loadTileArt, ManifestError } from './render/art.js'
export type { AdapterInfo, RendererDevice } from './render/device.js'
export { initDevice, NoAdapterError, ShaderCompilationError } from './render/device.js'
export type { FrameUniformValues, TerrainRenderer, Viewport } from './render/terrain.js'
export { createTerrainRenderer } from './render/terrain.js'
