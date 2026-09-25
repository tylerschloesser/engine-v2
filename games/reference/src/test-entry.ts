// Test-only entry (docs/plan/20b-reference-player-and-collect-ui.md step 0): the same real
// device/renderer/client wiring as `main.ts` (via `startGame`), but with `ClientOptions.test` set
// (a manual clock, never done by the production entry) and every diagnostic `window.__*` hook this
// package's browser tests need. Built into `test.html`, served by the `reference` Playwright
// preview alongside `index.html` (Deviations has the exact build wiring).
//
// **Never imported by `main.ts`/`game.ts`.** Production must never carry this file's hooks or set
// `ClientOptions.test` (`packages/engine/src/client.ts`'s own "never set by a game" -- true for
// this game's *production* page; a *test* page is exactly what that field exists for).
import { clientTestHandle } from 'engine'
import { createUploadDrain, RingConsumer, type UploadDrain } from 'engine/render'
import {
  attachCameraInputTestHooks,
  createManualClock,
  type DrawRecord,
  drawListRecords,
  pumpUntilLive,
  resumeWorkers,
  setCamera,
  stepFrame,
  stepTick,
} from 'engine/test'
import type { RefAction } from './bindings/RefAction.js'
import { startGame } from './game.js'

declare global {
  interface Window {
    __pageReady?: true
    /** Test-only diagnostic hook: renders one tile in isolation into a fresh offscreen target and
     * reads its centre pixel back (0020 §6's probe-not-screenshot rule). Unlike M20's own
     * production-page version, this drives the client with `stepFrame` (not real animation
     * frames) between attempts, and drains the upload ring explicitly (`drainUploadsFully`)
     * before every draw -- nothing here relies on real time passing. */
    __probeTile?: (
      tileX: number,
      tileY: number,
    ) => Promise<{ r: number; g: number; b: number; a: number }>
    /** Dispatches a real `StartCollect` through the production `client.dispatch` path. Returns
     * the action's own `seq`. */
    __dispatchStartCollect?: (tileX: number, tileY: number, fromX: number, fromY: number) => number
    /** Instantly moves the camera (bypassing the integrator entirely: a direct `cameraState`
     * write, `engine/test.setCamera`) and pushes it to the client with one `stepFrame`. */
    __setCamera?: (x: number, y: number, tilesAcross: number) => Promise<void>
    /** Reads `client.cameraState` back (a public, production field): works regardless of what last
     * wrote it (`__setCamera` above, or real gestures integrated through `__tickCamera` below).
     * Moved here from `main.ts` (orchestrator ruling on cut 1's flagged decision: "the production
     * page exposes no `window.__*` hooks"). */
    __cameraState?: () => { x: number; y: number; tilesAcross: number }
    /** Runs one main-thread camera integration step (`client.camera.tick(dtMs)`, the same call
     * `game.ts`'s own `onCamera` makes every real rAF): a real Playwright pointer/wheel gesture
     * against this page's canvas is recorded by the engine's own real DOM listeners (installed by
     * `createClient` regardless of the manual clock) into fixed slots, same as production --
     * nothing on this page ever calls `camera.tick()` on its own (step 0's own note: `real.loop`
     * never fires), so `reference_pan_and_zoom_work` drives it explicitly instead. Deliberately
     * *not* folded into `__stepFrame`: that hook's own behaviour must stay exactly what every other
     * spec here already depends on (`player.spec.ts`, `depletion.spec.ts`), so this is a new, one-
     * purpose hook rather than a change to an existing one. Pure main-thread state (no worker
     * round trip, unlike `__stepFrame`): synchronous, no `resumeWorkers` needed. */
    __tickCamera?: (dtMs: number) => void
    /** Advances the client by one stepped frame of `dtMs` (`engine/test.stepFrame`, synchronous:
     * resolves only once the client worker has acked it -- M20b's own "stepped frames" contract). */
    __stepFrame?: (dtMs: number) => Promise<void>
    /** Runs `n` sim ticks deterministically (`engine/test.stepTick`), bypassing the real 20 Hz
     * pace `depletion.spec.ts` used to wait on. */
    __stepTick?: (n: number) => Promise<void>
    /** The own-player circle's current DrawList record (`kind === 1`, `engine::client::
     * KIND_CIRCLE`), or `null` if `extract` skipped it (below the 2px cull, Scope). Reads the
     * DrawList directly off its SAB (`engine/test.drawListRecords`): no GPU render needed to
     * observe the spring's own computed position. */
    __playerCircle?: () => { x: number; y: number } | null
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement

// One manual clock drives everything on this page (Deviations): `ClientOptions.test.clock` (what
// `engine/test`'s `stepFrame`/`stepSimTickSync` advance and spin on) *and* the frame loop's own
// `clock`/`scheduler` (`startGame`'s own params) -- `connected-terrain.ts`'s own precedent. Nothing
// on this page ever calls `.frame()` on it (this page draws through `renderer` directly, like
// M20's own `__probeTile`, rather than relying on the frame loop's per-rAF render phase), so
// `real.loop.resume()` inside `startGame` registers a callback that simply never fires: harmless.
const clock = createManualClock()

const { client, renderer, device, canvasFormat } = await startGame({
  canvas,
  host: {
    kind: 'local',
    world: { worldId: 'reference', params: { seed: '6840143426475589698', worldgen: {} } },
    connect: true,
  },
  test: { clock, flags: {} },
  clock,
  scheduler: clock,
})

// `pumpUntilLive`, not a bare `await client.ready` (`engine/test`'s own doc comment): this page's
// ticks are test-driven, so `client.ready` (which now also waits for a real host frame) only
// resolves once something drives the sim -- `pumpUntilLive` does that itself.
await pumpUntilLive(client)

attachCameraInputTestHooks(client, clientTestHandle(client).cameraBundle)

const uploadConsumer = new RingConsumer(client.uploadRing)
const uploadDrain: UploadDrain = createUploadDrain(uploadConsumer, renderer)

/** Drains every currently-enqueued upload-ring record into `renderer`'s GPU textures. */
function drainUploadsFully(): void {
  for (;;) {
    const { records } = uploadDrain.drain(1_000_000)
    if (records === 0) break
  }
}

// A real (wall-clock) background interval, not a one-shot call before each read (Deviations,
// found live by `reference_depletion_visible`'s own `stepTick` loop): a delta frame's own PATCH
// record reaches `uploadRing` only once the client worker's *own* thread wakes and processes the
// downlink frame -- asynchronous relative to `stepSimTickSync`'s spin-wait on the *sim* worker's
// ack -- and `engine/test.untilQuiescent` (inside `stepTick`) waits for every ring, `uploadRing`
// included, to reach `pushed === popped` before resolving. Nothing else on this page ever drains
// it (unlike a real per-rAF frame loop), so without this interval `stepTick` hangs until its own
// 10 s timeout the first time a collect actually changes a tile. `connected-terrain.ts`'s own
// precedent for exactly this gap (`packages/engine/tests/browser/pages/src/connected-terrain.ts`).
setInterval(drainUploadsFully, 16)

// `resumeWorkers` before every step (Deviations, "resume before every step"): `stepTick`/
// `untilQuiescent` both end by parking every worker (`engine/test`'s own doc comments), and a
// parked worker never acks a later `stepFrame`/`stepSimTickSync` wake until explicitly resumed
// (`worker/shell.ts`'s own `yield` protocol) -- found live by this milestone's own
// `reference_depletion_visible`, whose second `stepTick` call hung until this was added.
// `resumeWorkers` on an already-running client is a documented no-op, so calling it
// unconditionally here is always safe.

window.__setCamera = async (x, y, tilesAcross) => {
  await resumeWorkers(client)
  setCamera(client, { x, y, tilesAcross })
  stepFrame(client, 16)
}

window.__cameraState = () => ({
  x: client.cameraState.centreX,
  y: client.cameraState.centreY,
  tilesAcross: client.cameraState.tilesAcross,
})

window.__tickCamera = (dtMs) => {
  client.camera.tick(dtMs)
}

window.__stepFrame = async (dtMs) => {
  await resumeWorkers(client)
  stepFrame(client, dtMs)
  // M20b step 3 (M18 Deviations: "a page must wire it through its own `onOverlay` hook once per
  // rAF"): `startGame`'s own `onOverlay` is wired into `real.loop`'s per-rAF phase list, but
  // nothing ever fires that loop on this page (step 0's own note: no `.frame()`/scheduler tick) --
  // called directly here instead, so collect buttons track their tiles across every stepped frame,
  // not only a real one.
  client.overlay.update()
}

window.__stepTick = async (n) => {
  await resumeWorkers(client)
  await stepTick(client, n)
}

window.__dispatchStartCollect = (tileX, tileY, fromX, fromY) => {
  const action: RefAction = {
    StartCollect: { tile: { x: tileX, y: tileY }, from: { x: fromX, y: fromY } },
  }
  return client.dispatch(action)
}

const drawRecordsScratch: DrawRecord[] = []
/** `engine::client::KIND_CIRCLE` (0018 §2): bits 12..16 of `kind_sprite`. */
const KIND_CIRCLE = 1

window.__playerCircle = () => {
  drawListRecords(client, drawRecordsScratch)
  for (const rec of drawRecordsScratch) {
    if (rec.kind === KIND_CIRCLE) {
      return { x: rec.pos[0], y: rec.pos[1] }
    }
  }
  return null
}

// `terrain.wgsl`'s own `NEUTRAL_COLOR`: 32/255 exactly on every channel, alpha opaque -- "chunk not
// resident at this tile" (0018 §3). Same probe technique as M20's own production-page version
// (`renderTileCentre`), reused here verbatim; only the *wait* loop below differs (stepped, not
// real frames).
const NEUTRAL_RGBA = [32, 32, 32, 255] as const
const PROBE_SIZE = 8
const PROBE_MAX_STEPS = 300

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
  for (let i = 0; i < PROBE_MAX_STEPS; i++) {
    // One stepped client frame (lets the client's own gen-queue/upload-enqueue pump run, the same
    // work a real rAF would have driven), then drain whatever it enqueued onto the GPU.
    // Deliberately *not* `untilQuiescent` (that also parks every worker afterward, `engine/test`'s
    // own doc comment -- a parked worker needs an explicit `resumeWorkers` before it acks another
    // `stepFrame`, which is why every attempt resumes first below; `stepFrame` itself already
    // confirms the client acted on this wake, and each loop iteration's own real `await` gives the
    // gen worker's real OS thread the turn it needs to answer a chunk request between attempts).
    await resumeWorkers(client)
    stepFrame(client, 16)
    drainUploadsFully()
    const [r, g, b, a] = await renderTileCentre(tileX, tileY)
    if (r !== NEUTRAL_RGBA[0] || g !== NEUTRAL_RGBA[1] || b !== NEUTRAL_RGBA[2]) {
      return { r, g, b, a }
    }
  }
  throw new Error(
    `__probeTile(${tileX}, ${tileY}): still the neutral colour after ${PROBE_MAX_STEPS} stepped frames`,
  )
}

window.__pageReady = true
