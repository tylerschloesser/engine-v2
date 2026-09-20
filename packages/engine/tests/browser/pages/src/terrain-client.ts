// `terrain-client.html`: the real-client host for `terrain-readback.spec.ts` (docs/plan/
// 09-renderer-terrain.md, step 5). Unlike `terrain.ts` (steps 2-4: hand-filled page/indirection
// textures, no worker), this page runs a real `createClient()` over `fx-terrain` (Gen + Client
// roles) so `probe_tile_colours`/`nonresident_is_neutral`/`patch_one_texel`/
// `upload_budget_while_panning` exercise the whole worker -> ring -> drain data path.
import { createClient } from '../../../../src/client.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import type { RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import type { TerrainRenderer } from '../../../../src/render/terrain.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import type { UploadDrain } from '../../../../src/render/upload.ts'
import { createUploadDrain } from '../../../../src/render/upload.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import { stepFrame as clientStepFrame } from '../../../../src/test/client.ts'
import { chunkHash, stats as genStats } from '../../../../src/test/gen.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { attachRenderer, readPixels, renderTo } from '../../../../src/test/render.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
  }
}

let device: RendererDevice | undefined
let renderer: TerrainRenderer | undefined
let client: import('../../../../src/client.ts').Client | undefined
let uploadDrain: UploadDrain | undefined

function requireClient(): import('../../../../src/client.ts').Client {
  if (!client) throw new Error('__terrainClient.init() must be called first')
  return client
}

window.__terrainClient = {
  async init() {
    device = await initDevice()
    renderer = await createTerrainRenderer(device.device, {
      colorFormat: 'rgba8unorm',
      viewProbePasses: device.viewProbePasses,
      checkCompilation: device.checkCompilation,
    })
    const art = await loadTileArt(device.device, '/terrain/tiles.json')
    renderer.setTileArray(art.texture)
    renderer.writeVisualTable(art.visualTableBytes)

    const wasm = await fixtureWasm('terrain')
    const canvas = document.createElement('canvas')
    const clock = createManualClock()
    client = createClient({
      canvas,
      wasm,
      host: { kind: 'remote', url: 'ws://unused.invalid' },
      genWorkers: 1,
      assets: { tiles: '/terrain/tiles.json' },
      // `flags: {}` (truthy): enables the `test-call` channel (`worker/test-call.ts`) `engine/
      // test.gen`'s `chunkHash`/`stats` need (`callParked`, "not enabled for this worker" without
      // it).
      test: { clock, flags: {} },
    })
    await client.ready
    attachRenderer(client, renderer)
    // One drain, reused everywhere this page steps a frame (`idle`/`driveFrame`/`panAndDrive`):
    // `sabWriteTextureOk` (Planning decisions "`writeTexture` from a SAB view is unverified") picks
    // the CHUNK-record fast/fallback path once, from this real device's own probe.
    uploadDrain = createUploadDrain(new RingConsumer(client.uploadRing), renderer, {
      sabWriteTextureOk: device.sabWriteTextureOk,
    })
    return { adapterInfo: device.adapterInfo, sabWriteTextureOk: device.sabWriteTextureOk }
  },

  setCamera(x, y, tilesAcross) {
    const c = requireClient()
    c.cameraState.centreX = x
    c.cameraState.centreY = y
    c.cameraState.tilesAcross = tilesAcross
  },

  setHalfExtent(x, y) {
    const c = requireClient()
    c.cameraState.halfExtentTilesX = x
    c.cameraState.halfExtentTilesY = y
  },

  setVelocity(x, y) {
    const c = requireClient()
    c.cameraState.velocityX = x
    c.cameraState.velocityY = y
  },

  writeFrameUniform(v) {
    ;(renderer as TerrainRenderer).writeFrameUniform({
      camTileX: v.camTileX,
      camTileY: v.camTileY,
      camFracX: v.camFracX,
      camFracY: v.camFracY,
      viewportPxW: v.viewportPxW,
      viewportPxH: v.viewportPxH,
      tilesPerPx: v.tilesPerPx,
      seed: v.seed ?? 0,
      cursorTileX: v.cursorTileX ?? 0,
      cursorTileY: v.cursorTileY ?? 0,
      cursorValid: v.cursorValid ?? 0,
      neighbourCutoffPx: v.neighbourCutoffPx ?? 0,
    })
  },

  stepFrame(dtMs) {
    clientStepFrame(requireClient(), dtMs)
  },

  // A custom idle loop, not `engine/test.gen.idle`: that helper ends with `untilQuiescent`, which
  // waits for *every* ring including `uploadRing` to reach `pushed === popped` -- but nothing
  // drains `uploadRing` except this page's own test code, so `untilQuiescent` would poll for the
  // full 10 s and reject (docs/plan/09-renderer-terrain.md Deviations "Steps 5-7"). This loop
  // drains the ring itself on every step, so residency and upload both converge together.
  //
  // `s.pending === 0 && s.inFlight === 0` alone is not enough to stop: `stepFrame`'s own ack is
  // stored *before* `body()`'s `uploadPump.pump()` runs (`worker/client.ts`), so main can observe
  // an idle gen queue on a step whose own `upload_stage` call has not landed in the ring yet --
  // found by this milestone's own real-client tests going flaky under worker contention (a race
  // that exists on every run, contention just changes which side wins). Requiring several
  // consecutive frames with nothing generating *and* nothing drained is a cheap way to be sure the
  // uploader's own queue (`pending_chunks`/`pending_indir`, `client::upload::Uploader`) has fully
  // caught up, not just the gen queue.
  async idle() {
    const c = requireClient()
    const drain = uploadDrain as UploadDrain
    const QUIET_STREAK_NEEDED = 8
    let quietStreak = 0
    for (let i = 0; i < 4000; i++) {
      clientStepFrame(c, 1000 / 60)
      const stats = drain.drain(Number.MAX_SAFE_INTEGER)
      const s = await genStats(c)
      const quiet = s.pending === 0 && s.inFlight === 0 && stats.records === 0
      quietStreak = quiet ? quietStreak + 1 : 0
      if (quietStreak >= QUIET_STREAK_NEEDED) return
    }
    throw new Error('__terrainClient.idle: never reached a quiet steady state')
  },

  driveFrame(dtMs, budgetBytes) {
    const c = requireClient()
    clientStepFrame(c, dtMs)
    const stats = (uploadDrain as UploadDrain).drain(budgetBytes)
    return { uploadBytes: stats.bytes, uploadRecords: stats.records }
  },

  panAndDrive(frames, dtMs, panPerFrameX, panPerFrameY, budgetBytes) {
    const c = requireClient()
    const drain = uploadDrain as UploadDrain
    const uploadBytesPerFrame: number[] = []
    for (let i = 0; i < frames; i++) {
      c.cameraState.centreX += panPerFrameX
      c.cameraState.centreY += panPerFrameY
      clientStepFrame(c, dtMs)
      const stats = drain.drain(budgetBytes)
      uploadBytesPerFrame.push(stats.bytes)
    }
    return { uploadBytesPerFrame }
  },

  async renderAndRead(width, height) {
    const c = requireClient()
    renderTo(c, { width, height })
    const pixels = await readPixels(c)
    return { width: pixels.width, height: pixels.height, data: Array.from(pixels.data) }
  },

  drawCalls() {
    return (renderer as TerrainRenderer).drawCalls()
  },

  pageSlotsUsed() {
    return (renderer as TerrainRenderer).pageSlotsUsed()
  },

  async chunkHash(cx, cy) {
    return chunkHash(requireClient(), cx, cy)
  },

  errors() {
    return device ? device.errors() : []
  },
}

window.__pageReady = true
