// `startGame` (docs/plan/20b-reference-player-and-collect-ui.md step 0): the reusable half of what
// was, through M20, a single `main.ts` -- device/renderer/art/client/camera-drive wiring shared by
// the production entry (`main.ts`) and the test-only entry (`test-entry.ts`). Neither entry's own
// diagnostic `window.__*` hooks live here: this file is imported by both and must stay free of
// anything that would make the production bundle carry test-only surface.
import wasm from 'virtual:engine/wasm'
import type { Client, ClientOptions } from 'engine'
import { createClient } from 'engine'
import {
  attachVisibilityHandling,
  type Clock,
  createRealFrameLoop,
  createTerrainRenderer,
  initDevice,
  installPageStyles,
  loadTileArt,
  type RealFrameLoop,
  type RendererDevice,
  type Scheduler,
  systemClock,
  systemScheduler,
  type TerrainRenderer,
} from 'engine/render'
import type { RefReject } from './bindings/RefReject.js'
import type { RefUi } from './bindings/RefUi.js'
import { createCollectUi } from './ui/collect.js'
import { createInventoryUi } from './ui/inventory.js'

export type StartGameOptions = {
  canvas: HTMLCanvasElement
  host: ClientOptions['host']
  /** Test-only escape hatch, forwarded verbatim to `createClient` (never set by the production
   * entry: `main.ts` never imports the type this field needs, so it structurally cannot set it). */
  test?: ClientOptions['test']
  /** The production entry omits both (defaults to `engine/render`'s real `systemClock`/
   * `systemScheduler`); the test entry passes one `ManualClock` as both, the same instance it also
   * passes as `test.clock` (Deviations: "one manual clock drives everything"). */
  clock?: Clock
  scheduler?: Scheduler
}

export type StartedGame = {
  client: Client
  renderer: TerrainRenderer
  device: RendererDevice
  canvasFormat: GPUTextureFormat
  real: RealFrameLoop
}

/**
 * Builds the real WebGPU terrain pipeline plus a real `Client` and wires the camera drive between
 * them (`onCamera`, called from the frame loop's own per-frame phase) -- everything `main.ts` did
 * through M20's step 3, minus `client.ready`/`window.__pageReady` (the caller's own job: the
 * production and test entries wait on readiness differently, `pumpUntilLive` vs a bare `ready`) and
 * minus every diagnostic `window.__*` hook (the caller's own job too).
 */
export async function startGame(opts: StartGameOptions): Promise<StartedGame> {
  installPageStyles() // 0019 §3: pull-to-refresh structurally prevented, canvas touch-action.

  const { canvas } = opts
  const device: RendererDevice = await initDevice()
  // `TerrainRenderer` builds one pipeline fixed to one colour-target format (`createTerrainRenderer`'s
  // own contract): a probe target must use the *same* format, since it draws through this same
  // renderer/pipeline.
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat()
  const renderer: TerrainRenderer = await createTerrainRenderer(device.device, {
    colorFormat: canvasFormat,
    viewProbePasses: device.viewProbePasses,
    checkCompilation: device.checkCompilation,
  })
  const art = await loadTileArt(device.device, '/tiles.json', {
    checkCompilation: device.checkCompilation,
  })
  renderer.setTileArray(art.texture, art.gpuBytes)
  renderer.writeVisualTable(art.visualTableBytes)

  const options: ClientOptions = {
    canvas,
    wasm,
    host: opts.host,
    genWorkers: 1,
    assets: { tiles: '/tiles.json' },
    ...(opts.test ? { test: opts.test } : {}),
  }
  const client: Client = createClient(options)

  // M20b step 3-4 (Scope: collect buttons, progress, cancel-on-pan-out, rejection flash, inventory
  // readout): wired here, not in each entry, so both `main.ts` and `test-entry.ts` get a working
  // collect UI from one place. `onUi`/`onActionResult` are polled by `client` itself on its own
  // `Scheduler` (`docs/plan/16-action-round-trip.md`/`16b-ui-observation-and-clock.md`); no page
  // wiring beyond subscribing here.
  const collectUi = createCollectUi(client)
  const inventoryUi = createInventoryUi(document.body)
  client.onUi<RefUi>((ui) => {
    collectUi.onUi(ui)
    inventoryUi.onUi(ui)
  })
  client.onActionResult<RefReject>((seq, result) => collectUi.onActionResult(seq, result))

  let lastCameraT: number | undefined
  function onCamera(): void {
    const t = performance.now()
    const dtMs = lastCameraT === undefined ? 0 : t - lastCameraT
    lastCameraT = t
    client.camera.tick(dtMs) // real pan/pinch/wheel/WASD/inertia + semantic recognition

    const v = renderer.viewport
    // `camera/transform.ts`'s `pxPerTile` formula, inlined (`main.ts`'s own precedent, `engine/
    // render` staying focused on device/renderer/art/frame-loop machinery).
    const ppt = Math.max(v.widthPx, v.heightPx) / client.cameraState.tilesAcross
    const camTileX = Math.floor(client.cameraState.centreX)
    const camTileY = Math.floor(client.cameraState.centreY)
    const fu = renderer.frameUniform
    fu.camTileX = camTileX
    fu.camTileY = camTileY
    fu.camFracX = client.cameraState.centreX - camTileX
    fu.camFracY = client.cameraState.centreY - camTileY
    fu.viewportPxW = v.widthPx
    fu.viewportPxH = v.heightPx
    fu.tilesPerPx = 1 / ppt
  }

  const real: RealFrameLoop = createRealFrameLoop({
    client,
    renderer,
    canvas,
    maxTextureDimension2D: device.device.limits.maxTextureDimension2D,
    onCamera,
    // M18 Deviations ("client.overlay.anchor's per-frame refresh is not called automatically by
    // frame-loop.ts"): this page's own `onOverlay` hook, so collect buttons track their tiles.
    // Wired here, not per-entry, for the same reason `onUi`/`onActionResult` are (above). The
    // stepped test entry's own `real.loop` never actually ticks (Deviations, step 0: nothing calls
    // `.frame()`/fires its scheduler), so `test-entry.ts` additionally calls `client.overlay.
    // update()` directly from its own `__stepFrame` hook.
    onOverlay: () => client.overlay.update(),
    clock: opts.clock ?? systemClock,
    scheduler: opts.scheduler ?? systemScheduler,
  })
  attachVisibilityHandling(real.loop)
  real.loop.resume()

  return { client, renderer, device, canvasFormat, real }
}
