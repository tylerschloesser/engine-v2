// `connected-terrain.html`: the renderer-backed sibling of `connected.html` (docs/plan/
// 15b-ring-connection-and-replica-rendering.md, step 6) -- `hidden_tab_sends_no_camera_report`
// needs a real `TerrainRenderer`/`FrameLoop`, which `connected.html`'s bare client deliberately has
// none of. A real `createClient()` local topology over `fx-puts`, `host.connect: true`, driven
// through `frame-loop.ts`'s `createRealFrameLoop` -- `viewport.ts`'s own precedent for a manual
// clock *and* scheduler together (so `FrameLoop.resume()` re-arming the scheduler never actually
// fires a real `requestAnimationFrame`) plus `attachViewportTestHooks` for `engine/test.
// setVisibility`. Reuses `/terrain/tiles.json`'s existing art and `PutsClient` (`fixtures/puts/src/
// lib.rs`) -- built for `overlay_tile_reaches_screen` (this milestone's own Deviations: blocked by
// a newly-found pre-existing bug, not built here) but left in place since a real renderer/art
// pipeline is exactly what that test will need once the blocking bug is fixed.
import type { Client } from '../../../../src/client.ts'
import { createClient } from '../../../../src/client.ts'
import type { RealFrameLoop } from '../../../../src/frame-loop.ts'
import { createRealFrameLoop } from '../../../../src/frame-loop.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import type { RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import type { TerrainRenderer } from '../../../../src/render/terrain.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { createUploadDrain } from '../../../../src/render/upload.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import {
  netCounters,
  resumeWorkers,
  setCamera,
  stepFrame,
  stepTick,
} from '../../../../src/test/client.ts'
import { createManualClock, type ManualClock } from '../../../../src/test/manual-clock.ts'
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
  renderer.setTileArray(art.texture)
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
  await client.ready

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

window.__errors = () => (device ? device.errors() : [])

window.__pageReady = true
