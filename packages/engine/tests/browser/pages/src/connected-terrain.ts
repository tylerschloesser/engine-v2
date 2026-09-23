// `connected-terrain.html`: the renderer-backed sibling of `connected.html` (docs/plan/
// 15b-ring-connection-and-replica-rendering.md, step 6) -- `hidden_tab_sends_no_camera_report`
// needs a real `TerrainRenderer`/`FrameLoop`, which `connected.html`'s bare client deliberately has
// none of. A real `createClient()` local topology over `fx-puts`, `host.connect: true`, driven
// through `frame-loop.ts`'s `createRealFrameLoop` -- `viewport.ts`'s own precedent for a manual
// clock *and* scheduler together (so `FrameLoop.resume()` re-arming the scheduler never actually
// fires a real `requestAnimationFrame`) plus `attachViewportTestHooks` for `engine/test.
// setVisibility`. Reuses `/terrain/tiles.json`'s existing art and `PutsClient` (`fixtures/puts/src/
// lib.rs`).
//
// `overlay_tile_reaches_screen` (docs/plan/15c-terrain-visibility-and-cache-invalidation.md, steps
// 3-5): `__writeFrameUniform`/`__renderAndRead` below are the GPU readback this page was built for
// but could not use while the M15b-discovered cache-invalidation bug stood (M15c steps 1-2 fixed
// it). Renders through the `renderer` object directly (`renderTo`'s `Renderable` overload, not its
// `Client` overload) -- the `Client` overload builds its own `RingConsumer(client.uploadRing)`
// internally, which would be a *second*, independent consumer racing the background drain below
// over the same ring; the background interval already keeps `renderer`'s page/indirection textures
// converged, so a plain `renderer.draw()` needs nothing more from the ring itself.
import type { Client } from '../../../../src/client.ts'
import { createClient } from '../../../../src/client.ts'
import type { RealFrameLoop } from '../../../../src/frame-loop.ts'
import { createRealFrameLoop } from '../../../../src/frame-loop.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import type { RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import type { FrameUniformValues, TerrainRenderer } from '../../../../src/render/terrain.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { createUploadDrain } from '../../../../src/render/upload.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import {
  netCounters,
  pumpUntilLive,
  resumeWorkers,
  setCamera,
  stepFrame,
  stepTick,
} from '../../../../src/test/client.ts'
import { createManualClock, type ManualClock } from '../../../../src/test/manual-clock.ts'
import { readPixels, renderTo } from '../../../../src/test/render.ts'
import { attachViewportTestHooks, setVisibility } from '../../../../src/test/viewport.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __init?: () => Promise<{ adapterInfo: unknown }>
    __setCamera?: (x: number, y: number, tilesAcross: number) => void
    __setVisibility?: (state: 'hidden' | 'visible') => void
    __resume?: () => Promise<void>
    __stepTick?: (n: number) => Promise<void>
    /** `connected.ts`'s own `__advance`, verbatim (same doc comment there): resume + camera + one
     * `stepFrame` 2 s ahead of the manual clock (past `ClientCore::poll_uplink`'s own rate limits,
     * 0010 "Rates") + `stepTick(n)`. Returns `netCounters()` after settling. */
    __advance?: (
      x: number,
      y: number,
      tilesAcross: number,
      ticks: number,
    ) => Promise<import('../../../../src/test/client.ts').NetCounters>
    __netCounters?: (conn?: number) => Promise<import('../../../../src/test/client.ts').NetCounters>
    /** `overlay_tile_reaches_screen`: writes the renderer's frame uniform directly (camera position
     * and viewport shape for the next `__renderAndRead` call), the same shape `terrain-client.ts`'s
     * own `writeFrameUniform` already uses. */
    __writeFrameUniform?: (v: FrameUniformValues) => void
    /** `overlay_tile_reaches_screen`: draws one frame into a fresh offscreen target and reads it
     * back (`renderTo`/`readPixels`, `engine/test`, the `Renderable` overload -- see the module
     * comment above for why not the `Client` one). */
    __renderAndRead?: (
      width: number,
      height: number,
    ) => Promise<{ width: number; height: number; data: number[] }>
    __errors?: () => string[]
  }
}

let device: RendererDevice | undefined
let renderer: TerrainRenderer | undefined
let client: Client | undefined
let real: RealFrameLoop | undefined
let clock: ManualClock | undefined

window.__init = async () => {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)

  device = await initDevice()
  renderer = await createTerrainRenderer(device.device, {
    colorFormat: 'rgba8unorm',
    viewProbePasses: device.viewProbePasses,
    checkCompilation: device.checkCompilation,
  })
  const art = await loadTileArt(device.device, '/terrain/tiles.json', {
    checkCompilation: device.checkCompilation,
  })
  renderer.setTileArray(art.texture, art.gpuBytes)
  renderer.writeVisualTable(art.visualTableBytes)

  const wasm = await fixtureWasm('puts')
  // `ManualClock` implements `Scheduler` too (`viewport.ts`'s own precedent): `FrameLoop.resume()`
  // (inside `setVisibility(client, 'visible')`) re-arms without ever waiting on a real animation
  // frame.
  clock = createManualClock()

  client = createClient({
    canvas,
    wasm,
    host: {
      kind: 'local',
      world: { worldId: 'connected-terrain-test', params: { seed: '1', worldgen: null } },
      connect: true,
    },
    genWorkers: 1,
    test: { clock, flags: {} },
  })
  // `pumpUntilLive` (docs/plan/16-action-round-trip.md, `engine/test`'s own doc comment has the
  // full reasoning): this page's own ticks are test-driven, and `client.ready` now needs one
  // before it resolves, so a bare `await client.ready` here would deadlock against the very hooks
  // wired below that would otherwise drive one.
  await pumpUntilLive(client)

  real = createRealFrameLoop({
    client,
    renderer,
    canvas,
    clock,
    scheduler: clock,
    maxTextureDimension2D: 8192,
    test: { observeReal: false },
  })
  attachViewportTestHooks(client, { viewport: real.viewport, loop: real.loop })

  // `engine/test.untilQuiescent` (`stepTick`'s own trailing call) waits for *every* ring,
  // `uploadRing` included, to reach `pushed === popped` -- and nothing else here drives a render
  // loop that would drain it (`terrain-client.ts`'s own precedent, docs/plan/
  // 09-renderer-terrain.md Deviations "Steps 5-7"). A background drain into the real renderer.
  const uploadConsumer = new RingConsumer(client.uploadRing)
  const bgUploadDrain = createUploadDrain(uploadConsumer, renderer)
  setInterval(() => {
    for (;;) {
      const { records } = bgUploadDrain.drain(64)
      if (records === 0) break
    }
  }, 16)

  return { adapterInfo: device.adapterInfo }
}

window.__setCamera = (x, y, tilesAcross) => {
  const c = client as Client
  c.cameraState.centreX = x
  c.cameraState.centreY = y
  c.cameraState.tilesAcross = tilesAcross
}
window.__setVisibility = (state) => setVisibility(client as Client, state)
window.__resume = () => resumeWorkers(client as Client)
window.__stepTick = (n) => stepTick(client as Client, n)
window.__netCounters = (conn) => netCounters(client as Client, conn)
window.__advance = async (x, y, tilesAcross, ticks) => {
  const c = client as Client
  await resumeWorkers(c)
  setCamera(c, { x, y, tilesAcross })
  stepFrame(c, 2000)
  await stepTick(c, ticks)
  return netCounters(c)
}

window.__writeFrameUniform = (v) => {
  ;(renderer as TerrainRenderer).writeFrameUniform(v)
}
window.__renderAndRead = async (width, height) => {
  const target = renderTo(renderer as TerrainRenderer, { width, height })
  const pixels = await readPixels(target)
  return { width: pixels.width, height: pixels.height, data: Array.from(pixels.data) }
}

window.__errors = () => (device ? device.errors() : [])

window.__pageReady = true
