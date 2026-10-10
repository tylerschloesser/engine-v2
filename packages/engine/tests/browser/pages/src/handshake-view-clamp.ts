// `handshake-view-clamp.html`'s script (M28 step 5, Tests added:
// "welcome-view-clamp-limits-zoom"): a real single-player `createClient()` topology (`host.connect:
// true`, `fx-puts`, `WorldConfig.view.maxTilesPerAxis: 128`) whose host clamp is *not* 0010's
// default 256 -- proving the `Welcome` -> `client-welcome` postMessage -> `cameraIntegrator.
// setViewClamp` wiring actually carries a real, non-default value end to end, not just that some
// clamp exists. No renderer/canvas drawing (bare, but real-sized and attached `<canvas>`, matching
// `gc-input.ts`'s own reasoning: `client.camera.tick()` needs a real `getBoundingClientRect()` so
// `pxPerTile` is sane, not the `{1, 1}` fallback) -- this page is for the one camera-clamp test, not
// a pixel one.
import { CameraState } from '../../../../src/camera/state.ts'
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import { pumpUntilLive } from '../../../../src/test/client.ts'
import { attachCameraInputTestHooks, injectWheel } from '../../../../src/test/input.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __hvcInjectWheel?: (deltaY: number, cssX: number, cssY: number) => void
    __hvcTickCamera?: (dtMs: number) => void
    __hvcCameraState?: () => { centreX: number; centreY: number; tilesAcross: number }
  }
}

const wasm = await fixtureWasm('puts')
const clock = createManualClock()

const canvas = document.createElement('canvas')
canvas.style.width = '800px'
canvas.style.height = '600px'
canvas.style.position = 'fixed'
canvas.style.left = '-9999px' // never visible; only its layout box matters (gc-input.ts's own precedent)
document.body.appendChild(canvas)

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: {
      worldId: 'handshake-view-clamp-test',
      params: { seed: '1', worldgen: null },
      // 0010's own default is 256: a deliberately smaller, non-default value, so a test that reads
      // 256 back could only mean the clamp wiring was never reached at all, not "it works but
      // happens to match the default anyway".
      view: { maxTilesPerAxis: 128 },
    },
    connect: true,
  },
  genWorkers: 1,
  test: { clock, flags: {} },
})
await pumpUntilLive(client)

// Injection targets the *same* internal bundle `client.camera.tick()` drives (`gc-input.ts`'s own
// precedent, `ClientTestHandle.cameraBundle`), not a second, unrelated one.
attachCameraInputTestHooks(client, clientTestHandle(client).cameraBundle)

const cameraOut = new CameraState()

window.__hvcInjectWheel = (deltaY, cssX, cssY) => {
  injectWheel(client, deltaY, cssX, cssY)
}
window.__hvcTickCamera = (dtMs) => {
  client.camera.tick(dtMs)
}
window.__hvcCameraState = () => {
  client.camera.read(cameraOut)
  return {
    centreX: cameraOut.centreX,
    centreY: cameraOut.centreY,
    tilesAcross: cameraOut.tilesAcross,
  }
}

window.__pageReady = true
