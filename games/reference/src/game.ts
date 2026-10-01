// `startGame` (docs/plan/20b-reference-player-and-collect-ui.md step 0): the reusable half of what
// was, through M20, a single `main.ts` -- device/renderer/art/client/camera-drive wiring shared by
// the production entry (`main.ts`) and the test-only entry (`test-entry.ts`). Neither entry's own
// diagnostic `window.__*` hooks live here: this file is imported by both and must stay free of
// anything that would make the production bundle carry test-only surface.
import wasm from 'virtual:engine/wasm'
import type { Client, ClientOptions } from 'engine'
import { createClient, EngineStartError } from 'engine'
import {
  type AttachedDrawables,
  attachVisibilityHandling,
  type Clock,
  createGpuHost,
  createRealFrameLoop,
  type GpuHost,
  installPageStyles,
  type RealFrameLoop,
  type RendererDevice,
  type Scheduler,
  systemClock,
  systemScheduler,
  type TerrainRenderer,
} from 'engine/render'
import type { RefReject } from './bindings/RefReject.js'
import type { RefUi } from './bindings/RefUi.js'
import { poseOf, shouldMoveToSpawn } from './spawn.js'
import { createBuildUi } from './ui/build.js'
import { createCollectUi } from './ui/collect.js'
import { createCraftUi } from './ui/craft.js'
import { createFurnaceUi } from './ui/furnace.js'
import { createInventoryUi } from './ui/inventory.js'
import { createRosterUi } from './ui/roster.js'
import { createStatusUi, type StatusUi } from './ui/status.js'

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
  /** The dev-only desync counter (default: a Vite dev server, `import.meta.env.DEV`). */
  dev?: boolean
}

export type StartedGame = {
  client: Client
  /** The GPU resources as first built. After a WebGPU device loss these are the dead ones: read
   * `gpu.current` for the live set (`null` while the device is lost). */
  renderer: TerrainRenderer
  device: RendererDevice
  canvasFormat: GPUTextureFormat
  drawables: AttachedDrawables
  /** Owns the current `GpuResources` and rebuilds them after a device loss (M37b). */
  gpu: GpuHost
  real: RealFrameLoop
  /** Link status and the refused-start screen (`status.showStartFailure`). */
  status: StatusUi
  /** The world id the client was started on (`host.world.worldId`; empty for a remote host). */
  worldId: string
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
  // `TerrainRenderer` builds one pipeline fixed to one colour-target format (`createTerrainRenderer`'s
  // own contract): a probe target must use the *same* format, since it draws through this same
  // renderer/pipeline.
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat()
  const assets = { tiles: '/tiles.json', sprites: '/sprites.json' }

  const options: ClientOptions = {
    canvas,
    wasm,
    host: opts.host,
    genWorkers: 1,
    assets,
    // M20b step 5 (Seams, Consumes: "`ClientOptions.cameraKey` (pass the world id)", M11): only
    // `host.kind === 'local'` ever names a world here (the `'remote'` branch has none this game
    // ever builds) -- one world per session today, so this only matters once a second world exists,
    // but it is the seam M11 already provides for that day.
    ...(opts.host.kind === 'local' ? { cameraKey: opts.host.world.worldId } : {}),
    ...(opts.test ? { test: opts.test } : {}),
  }
  const client: Client = createClient(options)
  // A refused start (`world-busy`, `save-incompatible`) rejects `client.ready` while the GPU setup
  // below is still awaited, before the caller attaches its own handler: mark it handled here so it
  // is never an unhandled rejection. The caller still sees the rejection through `client.ready`.
  client.ready.catch(() => {})
  // M37: `ui/status.ts` is the one place engine events are handled: storage, resyncing, the
  // renderer-lost prompt (M37b), fatal, desync (a dev-build counter) beside the link line. Registered
  // before the first `await`: `onStorage` and `onResyncing` do not replay to a late subscriber.
  const statusUi = createStatusUi(document.body, document, {
    ...(opts.scheduler ? { scheduler: opts.scheduler } : {}),
    dev: opts.dev ?? import.meta.env.DEV,
  })
  client.onLink((e) => statusUi.onLink(e))
  client.onStorage((s) => statusUi.onStorage(s))
  client.onResyncing(() => statusUi.onResyncing())
  client.onRendererLost((e) => statusUi.onRendererLost(e))
  client.onFatal((e) => statusUi.onFatal(e))
  client.onDesync((r) => statusUi.onDesync(r))
  if (opts.host.kind === 'remote') statusUi.onLink({ state: 'connecting' }) // `onLink` starts at the first change
  // M37b: every GPU object (device, terrain pipeline and art, and M33c's drawables pass: the
  // client's DrawList drawn in the terrain renderer's own pass, which loads `assets.sprites`) lives
  // in one `GpuResources` owned by the host, which rebuilds it after a WebGPU device loss.
  const gpu: GpuHost = await createGpuHost({
    colorFormat: canvasFormat,
    tilesUrl: assets.tiles,
    client,
    ...(opts.clock ? { clock: opts.clock } : {}),
  })
  const first = gpu.current as NonNullable<GpuHost['current']>
  const { device, renderer } = first
  const drawables = first.drawables as AttachedDrawables

  // M20b step 3-4 (Scope: collect buttons, progress, cancel-on-pan-out, rejection flash, inventory
  // readout): wired here, not in each entry, so both `main.ts` and `test-entry.ts` get a working
  // collect UI from one place. `onUi`/`onActionResult` are polled by `client` itself on its own
  // `Scheduler` (`docs/plan/16-action-round-trip.md`/`16b-ui-observation-and-clock.md`); no page
  // wiring beyond subscribing here.
  const collectUi = createCollectUi(client)
  const inventoryUi = createInventoryUi(document.body)
  const rosterUi = createRosterUi(document.body)
  const craftUi = createCraftUi(client)
  const buildUi = createBuildUi(client)
  const furnaceUi = createFurnaceUi(client)
  // M20b step 5 (Scope: "`main.ts` calls `client.camera.moveTo(spawn, { durationMs: 0 })` only when
  // the engine restored no camera"): built here, in the shared `onUi` subscription, the same
  // reasoning as `collectUi`/`inventoryUi` above -- both `main.ts` and the stepped `test-entry.ts`
  // get a camera that starts on the spawn tile for a fresh session, and `test-entry.ts`'s own specs
  // can observe it through `__cameraState()` with no extra hook. `client.camera.restored` is a fixed
  // snapshot taken once at `createClient` (M11), so it never needs rechecking after the first `Ui`.
  // 33e: only for an untouched camera. `onUi` rides the real rAF, so a player (or a test) may have
  // panned or zoomed before the first `Ui`; `shouldMoveToSpawn` compares position and zoom only, so
  // `stepFrame`'s viewport write or a resize never counts as the player moving it.
  const poseAtCreation = poseOf(client.cameraState)
  let spawnDecided = false
  client.onUi<RefUi>((ui) => {
    collectUi.onUi(ui)
    inventoryUi.onUi(ui)
    rosterUi.onUi(ui)
    craftUi.onUi(ui)
    buildUi.onUi(ui)
    furnaceUi.onUi(ui)
    if (!spawnDecided) {
      spawnDecided = true
      if (shouldMoveToSpawn(client.camera.restored, poseAtCreation, client.cameraState)) {
        client.camera.moveTo(ui.spawn.x + 0.5, ui.spawn.y + 0.5, { durationMs: 0 })
      }
    }
  })
  client.onActionResult<RefReject>((seq, result) => {
    collectUi.onActionResult(seq, result)
    craftUi.onActionResult(seq, result)
    buildUi.onActionResult(seq, result)
    furnaceUi.onActionResult(seq, result)
  })

  let lastCameraT: number | undefined
  function onCamera(): void {
    const t = performance.now()
    const dtMs = lastCameraT === undefined ? 0 : t - lastCameraT
    lastCameraT = t
    client.camera.tick(dtMs) // real pan/pinch/wheel/WASD/inertia + semantic recognition

    const live = gpu.current
    if (live === null) return // no device (M37b): the camera block still goes out, the uniform has no target
    const renderer = live.renderer
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
    gpu,
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

  return {
    client,
    renderer,
    device,
    canvasFormat,
    drawables,
    gpu,
    real,
    status: statusUi,
    worldId: opts.host.kind === 'local' ? opts.host.world.worldId : '',
  }
}

/**
 * Shows the screen for a refused start (`EngineStartError` `'world-busy'` / `'save-incompatible'`,
 * `ui/status.ts`) and returns true; any other failure returns false and the caller rethrows it.
 */
export function showStartFailure(game: StartedGame, e: unknown): boolean {
  if (!(e instanceof EngineStartError)) return false
  const { client } = game
  const world = game.worldId
  return game.status.showStartFailure(e, {
    worldId: world,
    exportWorld: () => client.exportWorld(),
    deleteWorld: (id) => client.deleteWorld(id),
    afterDelete: () => location.reload(),
  })
}
