// `welcome-frame.html`'s script (M39c step 5, ADR 0042 §3): a real
// remote `createClient()` (fixture `puts`, no `test.game`, so the world comes from `Welcome`), no
// renderer, no frame loop, gen workers spawned an hour late so the gen request ring is the
// observable. The spec holds the server's `Welcome` (it leaves on a server tick), parks the client
// worker once its `Hello` is out, lets the `Welcome` land in the downlink ring while the worker is
// parked, then bumps one frame request and resumes: the `Welcome` and the frame request are in the
// same wake, the case `worker/client.ts` `onConfigured` re-runs `frame()` for.
import { clientTestHandle, createClient, wsUrl } from '../../../../src/client.ts'
import { W_ACK, WORKER_CLIENT, workerWord } from '../../../../src/sab/control.ts'
import { RingConsumer, type RingStats } from '../../../../src/sab/ring.ts'
import { parkWorkers, resumeWorkers } from '../../../../src/test/client.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    /** Waits until the client's `Hello` is on the uplink ring, then parks every worker. */
    __hold?: () => Promise<void>
    /** Whether the `Welcome` has been pushed to the downlink ring. */
    __welcomeQueued?: () => boolean
    /** Bumps one frame request and resumes; resolves when the worker acked it, with the number of
     * gen requests pushed by then (no further frame was requested). */
    __fire?: () => Promise<{ genRequestsPushed: number; configured: boolean }>
  }
}

const params = new URL(location.href).searchParams
const wasm = await fixtureWasm('puts')
const canvas = document.createElement('canvas')
const client = createClient({
  canvas,
  wasm,
  host: { kind: 'remote', url: params.get('url') ?? wsUrl(location) },
  genWorkers: 1,
  assets: { tiles: '/terrain/tiles.json' },
  test: { genSpawnDelayMs: 3_600_000 },
})
const h = clientTestHandle(client)
const scratch: RingStats = { drops: 0, pushed: 0, popped: 0 }

function pushed(sab: SharedArrayBuffer): number {
  new RingConsumer(sab).stats(scratch)
  return scratch.pushed
}
function until(cond: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    const id = setInterval(() => {
      if (cond()) {
        clearInterval(id)
        resolve()
      } else if (performance.now() - t0 > 10_000) {
        clearInterval(id)
        reject(new Error(`welcome-frame: timed out waiting for ${what}`))
      }
    }, 2)
  })
}

window.__hold = async () => {
  await h.workersReady
  await until(() => pushed(h.sabs.uplink) > 0, 'the Hello on the uplink ring')
  await parkWorkers(client)
}
window.__welcomeQueued = () => pushed(h.sabs.downlink) > 0
window.__fire = async () => {
  const cam = client.cameraState
  cam.centreX = 0
  cam.centreY = 0
  cam.tilesAcross = 250
  cam.halfExtentTilesX = 125
  cam.halfExtentTilesY = 125
  cam.viewportPxW = 800
  cam.viewportPxH = 800
  cam.frameTimeMs = 16
  const req = client.writeCameraAndWake()
  await resumeWorkers(client)
  await until(
    () => Atomics.load(h.control.words, workerWord(WORKER_CLIENT, W_ACK)) === req,
    'the frame request ack',
  )
  let total = 0
  for (const sab of h.sabs.genRequest) total += pushed(sab)
  return { genRequestsPushed: total, configured: true }
}

window.__pageReady = true
