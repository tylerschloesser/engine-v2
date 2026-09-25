// Step 3 (docs/plan/20-reference-game-v0.md Order of work): the real WebGPU terrain pipeline, now
// that `assets/tiles.json`/`tiles.png` exist -- replaces step 1's neutral-colour placeholder.
// `createClient` (main thread) owns camera/input automatically on a real, document-attached canvas;
// this file assembles the device/renderer/art the same way `packages/engine/tests/browser/pages/
// src/device.ts` does for its own real page, through the `engine/render` subpath (Deviations: added
// this milestone, `packages/engine/CLAUDE.md`'s own "add a subpath together with the file that
// backs it" -- no game outside `packages/engine` needed these pieces before this one).

import wasm from 'virtual:engine/wasm'
import type { Client, ClientOptions } from 'engine'
import { createClient } from 'engine'
import {
  attachVisibilityHandling,
  createRealFrameLoop,
  createTerrainRenderer,
  initDevice,
  installPageStyles,
  loadTileArt,
  type RealFrameLoop,
  type RendererDevice,
  systemClock,
  systemScheduler,
  type TerrainRenderer,
} from 'engine/render'
import type { RefAction } from './bindings/RefAction.js'

declare global {
  interface Window {
    __pageReady?: true
    /** Test-only diagnostic hook (outside the zero-GC rule, `device.ts`/`slice.ts`'s own
     * precedent): moves the real production camera, exactly like a real `moveTo`. */
    __setCamera?: (x: number, y: number, tilesAcross: number) => void
    /** Test-only diagnostic hook: renders one tile in isolation into a fresh offscreen target and
     * reads its centre pixel back (0020 §6's probe-not-screenshot rule), polling real animation
     * frames until the tile's chunk is resident (the shader's own `NEUTRAL_COLOR`,
     * `terrain.wgsl`, otherwise). Built from `TerrainRenderer`'s own production API plus plain
     * WebGPU calls only -- never `engine/test` (Deviations: production code must not import it).
     */
    __probeTile?: (
      tileX: number,
      tileY: number,
    ) => Promise<{ r: number; g: number; b: number; a: number }>
    /** Test-only diagnostic hook (step 5, same precedent as `__setCamera`/`__probeTile`): dispatches
     * a real `StartCollect` through the production `client.dispatch` path -- no `engine/test`,
     * `client.dispatch` is itself a production API (0003 "Actions across the boundary"). Returns
     * the action's own `seq`. */
    __dispatchStartCollect?: (tileX: number, tileY: number, fromX: number, fromY: number) => number
    /** Test-only diagnostic hook: the real camera's own current block, `client.cameraState` (a
     * production, public field `createClient` already maintains from real pointer/wheel input --
     * proving "pan and zoom work" needs only reading it before and after a real gesture, not a new
     * production capability). */
    __cameraState?: () => { x: number; y: number; tilesAcross: number }
  }
}

installPageStyles() // 0019 §3: pull-to-refresh structurally prevented, canvas touch-action.

const canvas = document.getElementById('game') as HTMLCanvasElement

const device: RendererDevice = await initDevice()
// `TerrainRenderer` builds one pipeline fixed to one colour-target format (`createTerrainRenderer`'s
// own contract): the probe target below must use the *same* format, since it draws through this
// same renderer/pipeline (Deviations).
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
  host: {
    kind: 'local',
    // `6840143426475589698` = `0x5EED_1234_ABCD_0042` = `sim/tests/common/mod.rs::TEST_SEED`:
    // the real page uses the same seed every native test does, so the landmark tiles this
    // brief's browser tests probe (Deviations has the exact coordinates) are the same ones a
    // player actually sees.
    world: { worldId: 'reference', params: { seed: '6840143426475589698', worldgen: {} } },
    connect: true,
  },
  genWorkers: 1,
  assets: { tiles: '/tiles.json' },
}
const client: Client = createClient(options)
await client.ready

let lastCameraT: number | undefined
function onCamera(): void {
  const t = performance.now()
  const dtMs = lastCameraT === undefined ? 0 : t - lastCameraT
  lastCameraT = t
  client.camera.tick(dtMs) // real pan/pinch/wheel/WASD/inertia + semantic recognition

  const v = renderer.viewport
  // `camera/transform.ts`'s `pxPerTile` formula, inlined (not re-exported; a one-line pure
  // function, `packages/engine/CLAUDE.md`'s own precedent for `engine/render` staying focused on
  // device/renderer/art/frame-loop machinery, Deviations).
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
  clock: systemClock,
  scheduler: systemScheduler,
  maxTextureDimension2D: device.device.limits.maxTextureDimension2D,
  onCamera,
})
attachVisibilityHandling(real.loop)
real.loop.resume()

window.__setCamera = (x, y, tilesAcross) => {
  client.cameraState.centreX = x
  client.cameraState.centreY = y
  client.cameraState.tilesAcross = tilesAcross
}

window.__cameraState = () => ({
  x: client.cameraState.centreX,
  y: client.cameraState.centreY,
  tilesAcross: client.cameraState.tilesAcross,
})

window.__dispatchStartCollect = (tileX, tileY, fromX, fromY) => {
  const action: RefAction = {
    StartCollect: { tile: { x: tileX, y: tileY }, from: { x: fromX, y: fromY } },
  }
  return client.dispatch(action)
}

// `terrain.wgsl`'s own `NEUTRAL_COLOR`: 32/255 exactly on every channel, alpha opaque -- "chunk not
// resident at this tile" (0018 §3).
const NEUTRAL_RGBA = [32, 32, 32, 255] as const
const PROBE_SIZE = 8
const PROBE_MAX_FRAMES = 300

function renderTileCentre(tileX: number, tileY: number): Promise<[number, number, number, number]> {
  renderer.writeFrameUniform({
    camTileX: tileX,
    camTileY: tileY,
    camFracX: 0,
    camFracY: 0,
    viewportPxW: PROBE_SIZE,
    viewportPxH: PROBE_SIZE,
    tilesPerPx: 1,
    seed: 0,
    cursorTileX: 0,
    cursorTileY: 0,
    cursorValid: 0,
    neighbourCutoffPx: 0,
  })
  const target = device.device.createTexture({
    label: 'probe-tile-target',
    size: [PROBE_SIZE, PROBE_SIZE],
    format: canvasFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
  renderer.draw(target)
  const bytesPerRow = Math.ceil((PROBE_SIZE * 4) / 256) * 256
  const buffer = device.device.createBuffer({
    size: bytesPerRow * PROBE_SIZE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = device.device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [
    PROBE_SIZE,
    PROBE_SIZE,
  ])
  device.device.queue.submit([encoder.finish()])
  return buffer.mapAsync(GPUMapMode.READ).then(() => {
    const mapped = new Uint8Array(buffer.getMappedRange())
    const cx = Math.floor(PROBE_SIZE / 2)
    const cy = Math.floor(PROBE_SIZE / 2)
    const o = cy * bytesPerRow + cx * 4
    // `bgra8unorm` (the common `getPreferredCanvasFormat()` result) stores blue before red;
    // normalise back to r/g/b/a channel order regardless of which preferred format this device has.
    const swapRB = canvasFormat === 'bgra8unorm'
    const pixel: [number, number, number, number] = [
      (swapRB ? mapped[o + 2] : mapped[o]) as number,
      mapped[o + 1] as number,
      (swapRB ? mapped[o] : mapped[o + 2]) as number,
      mapped[o + 3] as number,
    ]
    buffer.unmap()
    buffer.destroy()
    target.destroy()
    return pixel
  })
}

window.__probeTile = async (tileX, tileY) => {
  for (let i = 0; i < PROBE_MAX_FRAMES; i++) {
    const [r, g, b, a] = await renderTileCentre(tileX, tileY)
    if (r !== NEUTRAL_RGBA[0] || g !== NEUTRAL_RGBA[1] || b !== NEUTRAL_RGBA[2]) {
      return { r, g, b, a }
    }
    await new Promise(requestAnimationFrame)
  }
  throw new Error(
    `__probeTile(${tileX}, ${tileY}): still the neutral colour after ${PROBE_MAX_FRAMES} frames`,
  )
}

window.__pageReady = true
