// Test-only entry (docs/plan/20b-reference-player-and-collect-ui.md step 0): the same real
// device/renderer/client wiring as `main.ts` (via `startGame`), but with `ClientOptions.test` set
// (a manual clock, never done by the production entry) and every diagnostic `window.__*` hook this
// package's browser tests need. Built into `test.html`, served by the `reference` Playwright
// preview alongside `index.html` (Deviations has the exact build wiring).
//
// **Never imported by `main.ts`/`game.ts`.** Production must never carry this file's hooks or set
// `ClientOptions.test` (engine `src/client.ts`'s own "never set by a game" -- true for
// this game's *production* page; a *test* page is exactly what that field exists for).
import { clientTestHandle } from 'engine'
import { createUploadDrain, RingConsumer, type UploadDrain } from 'engine/render'
import {
  attachCameraInputTestHooks,
  createManualClock,
  type DrawRecord,
  drawListRecords,
  injectPointer,
  lastUi,
  pumpUntilLive,
  readPixels,
  resumeWorkers,
  setCamera,
  stepFrame,
  stepTick,
  untilConfigured,
} from 'engine/test'
import type { RefAction } from './bindings/RefAction.js'
import type { RefUi } from './bindings/RefUi.js'
import { startGame } from './game.js'
import { selectHost } from './mode.js'

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
    /** M20b step 6 (Seams, Provides: "`uiState(page)`"): the most recent `Ui` `client.onUi` has
     * delivered so far (`engine/test.lastUi`, M16b's own read-back seam -- not previously reached
     * from outside the engine package itself, so this milestone's own "engine only for bug fixes"
     * added it to `engine/test`'s barrel export, engine `src/test.ts`), or `null` before
     * the first one has arrived. */
    __uiState?: () => RefUi | null
    /** M20b step 6: `client.clock()`'s own reading (M16b), copied into a plain object -- the live
     * object `clock()` returns is reused across calls (Provides: "read the fields, do not keep the
     * object past the next call"), which does not survive a `page.evaluate` structured-clone round
     * trip unchanged the way a fresh literal does. */
    /** M33: the furnace sprites (`kind 0`) and ghost records (`kind 6`) of the newest DrawList. */
    __draws?: () => Array<{
      kind: number
      x: number
      y: number
      w: number
      h: number
      flags: number
      color: number
      param: number
      pickId: number
    }>
    /** M33d: `client.pick` at a CSS-pixel point on the newest DrawList slot (acquired first). */
    __pickAt?: (cssX: number, cssY: number) => number
    /** M33: the engine's cursor tile (`cameraState.cursor*`): mouse hover tile or last touch tap. */
    __cursorTile?: () => { x: number; y: number; valid: boolean }
    /** M33: `engine/test.injectPointer` (touch taps and drags, `pointerType` 'touch'). */
    __injectPointer?: (
      phase: 'down' | 'move' | 'up' | 'cancel',
      id: number,
      x: number,
      y: number,
      tMs: number,
      kind?: 'mouse' | 'touch',
    ) => void
    /** M33: dispatches `PlaceFurnace` straight through `client.dispatch` (the `placeFurnace`
     * helper; the UI flows are exercised by `reference_place_mouse`/`_touch` themselves). */
    __dispatchPlaceFurnace?: (x: number, y: number) => number
    /** M33c: the centre pixel of a 32x32 frame centred on world point (x, y), drawn with the
     * drawables pass on and with it off, from the same newest DrawList slot. RGBA, 0..255. */
    __pixelAt?: (
      x: number,
      y: number,
    ) => Promise<{ on: [number, number, number, number]; off: [number, number, number, number] }>
    /** M34 (remote pages only): runs `n` ticks on the test's own server (`page.exposeFunction`). */
    __serverTick?: (n: number) => Promise<void>
    __untilConfigured?: () => Promise<void>
    __linkState?: () => string
    __circles?: () => Array<{ x: number; y: number; color: number }>
    __clock?: () => { authoritative: number; predicted: number; ticksPerSecond: number }
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

// Gate round 1 fix (docs/plan/20b-reference-player-and-collect-ui.md Deviations): `?altSpawnParams`
// -- a test-entry option for a *different world* (`ClientOptions.test.game`, the documented escape
// hatch for every worker's own config, engine `src/client.ts`'s own doc comment) -- raises
// `water_level` enough that the origin becomes water, so `spawn.spec.ts` can exercise the real
// `RefClient::on_init` -> `Ui.spawn` -> `game.ts`'s `onUi` -> `client.camera.moveTo` pipeline against
// a nearest land tile that is not `(0, 0)`, the trivial "origin is already land" case every real
// seed hits (`content::SEED`'s own height-channel value at the exact origin lattice point is `0.0`
// regardless of seed) and also `nearest_land_tile`'s own fallback value -- indistinguishable without
// this. Every other test on this page omits the query param and gets the real, unmodified world.
const altSpawnParams = new URLSearchParams(location.search).has('altSpawnParams')

// M34: `?server=<ws url>` plus an invite (`#k=<joinKey>`) makes this a remote page against a test
// server on another port (`tests/helpers/server.ts`); without them it is the local page every
// single-player spec drives. A remote page has no `test.game`: the world comes from `Welcome`.
const serverUrl = new URLSearchParams(location.search).get('server') ?? undefined
const host = selectHost(location, serverUrl)
const remote = host.kind === 'remote'

const { client, renderer, device, canvasFormat, drawables } = await startGame({
  canvas,
  host,
  test: {
    clock,
    flags: {},
    ...(altSpawnParams
      ? { game: { seed: '0x5eed1234abcd0042', params: { water_level: 0.05 } } }
      : {}),
  },
  clock,
  scheduler: clock,
})

// M30 gate round 3: subscribe `lastUi` before anything steps a frame, so `__uiState()` is non-null
// exactly once the first `Ui` has reached this thread -- and with it `startGame`'s own one-shot
// spawn `moveTo` (subscribed earlier, inside `startGame`). `panTo` waits on that before moving the
// camera; primed later (by a spec), the first `Ui` could already have gone by during
// `pumpUntilLive` below, and `Ui` is re-sent only on change.
lastUi<RefUi>(client)

// `pumpUntilLive`, not a bare `await client.ready` (`engine/test`'s own doc comment): this page's
// ticks are test-driven, so `client.ready` (which now also waits for a real host frame) only
// resolves once something drives the sim -- `pumpUntilLive` does that itself.
// A remote page has no sim worker to step: the test's own server ticks (`__serverTick`, below), and
// its handshake completes across those ticks, so the page is "ready" once its workers are.
if (remote) await client.ready
else await pumpUntilLive(client)

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

/**
 * One stepped frame. A remote page also does what the real frame loop does around it: acquire the
 * newest DrawList slot and run the camera (`client.camera.tick`), which is how a follow target the
 * game set (`cx.follow`: the returning player's one frame) reaches the camera. Local pages keep the
 * bare step their specs were written against.
 */
function step(dtMs: number): void {
  stepFrame(client, dtMs)
  if (remote) {
    client.pick.acquire()
    client.camera.tick(0)
  }
}

window.__setCamera = async (x, y, tilesAcross) => {
  await resumeWorkers(client)
  setCamera(client, { x, y, tilesAcross })
  step(16)
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
  step(dtMs)
  // M20b step 3 (M18 Deviations: "a page must wire it through its own `onOverlay` hook once per
  // rAF"): `startGame`'s own `onOverlay` is wired into `real.loop`'s per-rAF phase list, but
  // nothing ever fires that loop on this page (step 0's own note: no `.frame()`/scheduler tick) --
  // called directly here instead, so collect buttons track their tiles across every stepped frame,
  // not only a real one.
  client.overlay.update()
}

window.__stepTick = async (n) => {
  await resumeWorkers(client)
  if (!remote) {
    await stepTick(client, n)
    return
  }
  // Remote: the server is the test's (manual timer, `tests/helpers/server.ts`), exposed to the page
  // as `__serverTick`. One tick, one 50 ms frame at a time, so an action dispatched just before is
  // uplinked (paced at 50 ms) while the ticks run; then wait for the last tick's frame to arrive.
  const serverTick = window.__serverTick
  if (!serverTick)
    throw new Error('__stepTick: no __serverTick (the page was not opened by openGame)')
  const t0 = client.clock().authoritative
  for (let i = 0; i < n; i++) {
    await serverTick(1)
    step(50)
  }
  // A host holds frames while it paces a burst of chunk enters (0010 degrade), so the last tick's
  // frame can lag by a few ticks: tick on until it arrives.
  for (let spins = 0; client.clock().authoritative < t0 + n; spins++) {
    if (spins > 400) throw new Error(`__stepTick: ${n} server ticks never arrived`)
    await new Promise((r) => setTimeout(r, 1))
    await serverTick(1)
    step(50)
  }
}

/** Remote pages: resolves once `Welcome` configured the client (its gen workers are up). The test
 * ticks its server meanwhile (the handshake completes across host ticks). */
window.__untilConfigured = async () => {
  // A stepped frame per poll: the net worker's "link is up" notify is lost when the client worker has
  // not reached its first wait yet, and only a fresh wake recovers it (`gc-multiplayer-topology.ts`).
  let done = false
  const configured = untilConfigured(client).then(() => {
    done = true
  })
  while (!done) {
    step(16)
    await new Promise((r) => setTimeout(r, 0))
  }
  await configured
}

/** Remote pages: the last `client.onLink` state. */
let linkState = 'connecting'
client.onLink((e) => {
  linkState = e.state
})
window.__linkState = () => linkState

/** Every circle of the newest DrawList (own and remote): position and packed colour (`rgba`, byte
 * 0 = r). Range rings are another kind. */
window.__circles = () => {
  drawListRecords(client, drawRecordsScratch)
  const out: Array<{ x: number; y: number; color: number }> = []
  for (const rec of drawRecordsScratch) {
    if (rec.kind === KIND_CIRCLE) out.push({ x: rec.pos[0], y: rec.pos[1], color: rec.color })
  }
  return out
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

// 33e: `?lateUi=n` makes the first `n` reads answer `null` as if the first `Ui` had not reached this
// thread yet (it rides the real rAF, so under load it may not have). A spec that reads `Ui` without
// waiting for a non-null one fails on it every time, not one run in fifteen (`tests/helpers/game.ts`'s
// `readUi`). It changes no page state: `lastUi` and the spawn move are untouched.
let lateUiReads = Number(new URLSearchParams(location.search).get('lateUi') ?? 0)
window.__uiState = () => {
  if (lateUiReads > 0) {
    lateUiReads--
    return null
  }
  return lastUi<RefUi>(client) ?? null
}

window.__clock = () => {
  const c = client.clock()
  return {
    authoritative: c.authoritative,
    predicted: c.predicted,
    ticksPerSecond: c.ticksPerSecond,
  }
}

/** `engine::client::{KIND_SPRITE, KIND_GHOST}` (0018 §2). */
const KIND_SPRITE = 0
const KIND_GHOST = 6
/** `KIND_RECT`/`KIND_BAR` (M33b: the open-furnace outline and the smelt bar). */
const KIND_RECT = 3
const KIND_BAR = 4

window.__draws = () => {
  drawListRecords(client, drawRecordsScratch)
  return drawRecordsScratch
    .filter(
      (r) =>
        r.kind === KIND_SPRITE ||
        r.kind === KIND_GHOST ||
        r.kind === KIND_RECT ||
        r.kind === KIND_BAR,
    )
    .map((r) => ({
      kind: r.kind,
      x: r.pos[0],
      y: r.pos[1],
      w: r.size[0],
      h: r.size[1],
      flags: r.flags,
      color: r.color,
      param: r.param,
      pickId: r.pickId,
    }))
}

window.__pickAt = (cssX, cssY) => {
  client.pick.acquire()
  return client.pick.at(cssX, cssY)
}

window.__cursorTile = () => ({
  x: client.cameraState.cursorTileX,
  y: client.cameraState.cursorTileY,
  valid: client.cameraState.cursorValid,
})

window.__injectPointer = (phase, id, x, y, tMs, kind) => {
  injectPointer(client, phase, id, x, y, tMs, kind)
}

window.__dispatchPlaceFurnace = (x, y) => {
  const action: RefAction = { PlaceFurnace: { origin: { x, y } } }
  return client.dispatch(action)
}

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

const PIXEL_SIZE = 32

async function drawCentre(): Promise<[number, number, number, number]> {
  const texture = device.device.createTexture({
    label: 'pixel-at-target',
    size: [PIXEL_SIZE, PIXEL_SIZE],
    format: canvasFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
  renderer.writeFrameUniform(renderer.frameUniform)
  renderer.draw(texture)
  const { data, width } = await readPixels({
    device: device.device,
    texture,
    width: PIXEL_SIZE,
    height: PIXEL_SIZE,
  })
  texture.destroy()
  const o = (PIXEL_SIZE / 2) * (width * 4) + (PIXEL_SIZE / 2) * 4
  const swap = canvasFormat === 'bgra8unorm'
  return [
    (swap ? data[o + 2] : data[o]) as number,
    data[o + 1] as number,
    (swap ? data[o] : data[o + 2]) as number,
    data[o + 3] as number,
  ]
}

window.__pixelAt = async (x, y) => {
  const fu = renderer.frameUniform
  fu.camTileX = Math.floor(x)
  fu.camTileY = Math.floor(y)
  fu.camFracX = x - Math.floor(x)
  fu.camFracY = y - Math.floor(y)
  fu.viewportPxW = PIXEL_SIZE
  fu.viewportPxH = PIXEL_SIZE
  fu.tilesPerPx = 1 / PIXEL_SIZE
  client.pick.acquire() // the newest published DrawList slot (the frame loop's `acquire` phase)
  drawables.setEnabled(false)
  const off = await drawCentre()
  drawables.setEnabled(true)
  const on = await drawCentre()
  return { on, off }
}

window.__pageReady = true
