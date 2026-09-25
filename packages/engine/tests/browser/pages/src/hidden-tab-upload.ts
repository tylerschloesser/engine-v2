// `hidden-tab-upload.html`'s script (docs/plan/20c-client-ack-freeze-under-untilquiescent.md, the
// "production question": can a client worker reach the same frozen-ack state a hidden tab would
// also produce, since a hidden tab's own `FrameLoop.pause()` -- 0018 §8's own backgrounding rule,
// `attachVisibilityHandling` -- stops exactly the "upload" phase (`frame-loop.ts`'s `tick()`) that
// drains `client.uploadRing` in every real page). **No `ClientOptions.test` at all**: unlike every
// other page in this directory, this is production wiring verbatim (`games/reference/src/main.ts`'s
// own shape) -- no manual clock, no `test.flags`, so the sim worker paces itself for real
// (`worker/sim.ts`'s own `!message.test` gate) and the client worker frames for real, off the
// injected `systemClock`/`systemScheduler`'s own real `requestAnimationFrame`. The one test seam is
// `attachVisibilityHandling`'s own `doc` parameter (`frame-loop.ts`): a fake `Document`-shaped
// object this page controls directly, so a spec can flip "hidden" deterministically without CDP.
import { createClient } from '../../../../src/client.ts'
import { systemClock, systemScheduler } from '../../../../src/clock.ts'
import {
  attachVisibilityHandling,
  createRealFrameLoop,
  type RealFrameLoop,
} from '../../../../src/frame-loop.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import { initDevice } from '../../../../src/render/device.ts'
import { createTerrainRenderer, type TerrainRenderer } from '../../../../src/render/terrain.ts'
import { RingConsumer, type RingStats } from '../../../../src/sab/ring.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __init?: () => Promise<{ adapterInfo: unknown }>
    __setHidden?: (hidden: boolean) => void
    __uploadStats?: () => RingStats
    __errors?: () => string[]
  }
}

// `attachVisibilityHandling`'s own `doc` parameter (Seams: any `{ hidden, addEventListener,
// removeEventListener }`), not the real `document` -- a spec drives `hidden` directly, deterministic
// and CDP-free, the same "inject the minimal shape" idiom `viewport.ts`'s own `doc` option already
// uses elsewhere in this directory (`viewport.spec.ts`).
type FakeDoc = { hidden: boolean; addEventListener(type: 'visibilitychange', cb: () => void): void }
const listeners: Array<() => void> = []
const fakeDoc: FakeDoc = {
  hidden: false,
  addEventListener: (_type, cb) => {
    listeners.push(cb)
  },
}

let client: ReturnType<typeof createClient> | undefined
let real: RealFrameLoop | undefined
let renderer: TerrainRenderer | undefined

window.__init = async () => {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)

  const wasm = await fixtureWasm('puts')
  const device = await initDevice()
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

  // No `test` field at all (the module comment's own point): production topology.
  client = createClient({
    canvas,
    wasm,
    host: {
      kind: 'local',
      world: { worldId: 'hidden-tab-upload-test', params: { seed: '1', worldgen: null } },
      connect: true,
    },
    genWorkers: 1,
  })
  await client.ready // no `pumpUntilLive`: the sim paces itself for real, same as `main.ts`.

  real = createRealFrameLoop({
    client,
    renderer,
    canvas,
    clock: systemClock,
    scheduler: systemScheduler,
    maxTextureDimension2D: device.device.limits.maxTextureDimension2D,
  })
  attachVisibilityHandling(real.loop, fakeDoc as unknown as Document)
  real.loop.resume()

  return { adapterInfo: device.adapterInfo }
}

window.__setHidden = (hidden) => {
  fakeDoc.hidden = hidden
  for (const cb of listeners) cb()
}

window.__uploadStats = () => {
  const stats: RingStats = { drops: 0, pushed: 0, popped: 0 }
  new RingConsumer((client as ReturnType<typeof createClient>).uploadRing).stats(stats)
  return stats
}

window.__errors = () => []

window.__pageReady = true
