// `mp.html`'s script (docs/plan/29-net-worker-and-reference-server.md Scope): a real multiplayer
// `createClient()` topology (`host: { kind: 'remote' }`, fixture `puts`, M16's action fixture) --
// `slice.html`'s own HUD/Paint-control precedent, plus the link state and `?linklog=1`'s on-page
// `client.debug.linkLog()` view. Unlike `slice.ts` (a real device page with real camera/input),
// this is a fixture test page: the camera is set once, directly (`__mpSetCamera`), not integrated
// from real gestures -- `mp/*` specs drive everything through the window hooks below, against a
// Node-side `startTestServer` (`tests/browser/support/test-server.ts`) on its own manual timer.
import type { Action } from '../../../../fixtures/puts/bindings/Action.ts'
import type { Reject } from '../../../../fixtures/puts/bindings/Reject.ts'
import { halfExtentTiles } from '../../../../src/camera/transform.ts'
import { hexEncode, loadOrMintSecret } from '../../../../src/client/secret.ts'
import type { Client, ClientOptions, LinkLogEntry, LinkState } from '../../../../src/client.ts'
import { clientTestHandle, createClient, readInvite, wsUrl } from '../../../../src/client.ts'
import { systemClock, systemScheduler } from '../../../../src/clock.ts'
import { createRealFrameLoop } from '../../../../src/frame-loop.ts'
import { installPageStyles } from '../../../../src/input/page-css.ts'
import { loadTileArt } from '../../../../src/render/art.ts'
import type { AdapterInfo, RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import type { TerrainRenderer } from '../../../../src/render/terrain.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { RingConsumer, type RingStats } from '../../../../src/sab/ring.ts'
import { readPixels, renderTo } from '../../../../src/test/render.ts'
import { untilConfigured } from '../../../../src/test.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    /** `{ ok: true } | { ok: false, code, message }`, `client.ready`'s own settled outcome --
     * `mp/coep-worker-error-message`'s own read (`?blockedWorker=1`, below): a bare unhandled
     * rejection would fail `openPage`'s pageerror assertion before a spec ever gets to read it. */
    __mpClientReadyResult?: () => { ok: true } | { ok: false; code: string; message: string }
    __mpSetCamera?: (x: number, y: number, tilesAcross: number) => void
    __mpDispatchPaintAt?: (x: number, y: number) => number
    /** Any `Action` (`fixtures/puts/bindings/Action.ts`), e.g. `{ SetMotd: { n } }` -- the
     * global-scope action `mp/two-pages` dispatches for its own convergence check. */
    __mpDispatch?: (action: unknown) => number
    __mpConfirmed?: () => number
    __mpRejected?: () => number
    /** The last `SetMotd`-shaped `Ui` this page's own `client.onUi` has seen, or `null` before the
     * first one -- `mp/two-pages`'s own convergence check (global-scope `Ui`, no camera/
     * subscription dependency, `tests/netcode/CLAUDE.md`'s own `join-converges` precedent). */
    __mpUi?: () => unknown
    __mpLinkState?: () => LinkState
    __mpLinkLog?: () => LinkLogEntry[]
    __mpRevealed?: () => boolean
    /** Reads back the centre pixel of a small offscreen probe target, drawn atomically with
     * `client.revealed()`'s own current value (`mp/reveal-waits-for-visible-chunks`): the clear
     * colour (`render/terrain.ts`'s own `colorAttachment.clearValue`, opaque black) until revealed,
     * terrain after. */
    __mpProbeCenterPixel?: () => Promise<{ r: number; g: number; b: number; a: number }>
    __mpHudText?: () => string
    /** docs/plan/33f: what `mp/remote_client_configures_from_welcome` reads: how many gen workers
     * exist now, and the page's own timeline in ms since page start (`null` = not yet). */
    /** Chunk results the gen workers have pushed to this client (their result rings' counters). */
    __mpGenDelivered?: () => number
    __mpConfig?: () => {
      genWorkers: number
      testGame: boolean
      welcomeMs: number | null
      genUpMs: number | null
      revealedMs: number | null
    }
    __errors?: () => string[]
    __adapterInfo?: () => AdapterInfo
  }
}

installPageStyles() // 0019 §3: pull-to-refresh structurally prevented, canvas touch-action

const params = new URL(location.href).searchParams
const linklogVisible = params.get('linklog') === '1'
// `?testGame=1`: the pre-M33f way, the world's seed and params handed in out of band. Only
// `mp/remote_client_configures_from_welcome` uses it, to compare against the `Welcome` path.
const testGame = params.get('testGame') === '1'
const blockedWorker = params.get('blockedWorker') === '1'
const corruptBuildHash = params.get('corruptBuildHash') === '1'
const urlOverride = params.get('url')

const hudEl = document.createElement('pre')
hudEl.id = 'hud'
document.body.appendChild(hudEl)

const linklogEl = document.createElement('pre')
linklogEl.id = 'linklog'
document.body.appendChild(linklogEl)
if (!linklogVisible) linklogEl.style.display = 'none'

const canvas = document.createElement('canvas')
document.body.appendChild(canvas)

const paintBtn = document.createElement('button')
paintBtn.id = 'paint-btn'
paintBtn.textContent = 'Paint'
document.body.appendChild(paintBtn)

const wasm = await fixtureWasm('puts')
// `mp/version-mismatch-reloads-once`'s own trigger: a real, wrong `build_hash` in this client's
// own `Hello` -- the *bytes* it runs are still the real, correct fixture (only the advertised hash
// this client's own `Hello` carries is wrong), so nothing else about this page's behaviour changes.
// Deterministic (flips one hex nibble, always the same way): the `sessionStorage['engine.
// reloadedFrom']` guard (0013 "Build-hash handshake") must see the identical wrong hash again after
// `window.location.reload()` re-runs this exact script with the exact same query string.
const clientBuildHash = corruptBuildHash
  ? `${wasm.buildHash.slice(0, -1)}${wasm.buildHash.endsWith('0') ? '1' : '0'}`
  : wasm.buildHash

const device: RendererDevice = await initDevice()
const renderer: TerrainRenderer = await createTerrainRenderer(device.device, {
  colorFormat: 'rgba8unorm',
  viewProbePasses: device.viewProbePasses,
  checkCompilation: device.checkCompilation,
})
const art = await loadTileArt(device.device, '/terrain/tiles.json', {
  checkCompilation: device.checkCompilation,
})
renderer.setTileArray(art.texture, art.gpuBytes)
renderer.writeVisualTable(art.visualTableBytes)

const clientOptions: ClientOptions = {
  canvas,
  wasm: { url: wasm.url, buildHash: clientBuildHash },
  host: {
    kind: 'remote',
    url: urlOverride ?? wsUrl(location),
    ...(readInvite(location).joinKey !== undefined
      ? { joinKey: readInvite(location).joinKey }
      : {}),
  },
  genWorkers: 1,
  assets: { tiles: '/terrain/tiles.json' },
  // No `test.game`: the client and its gen workers take the world's seed and params from
  // `Welcome` (ADR 0042, docs/plan/33f), unless `?testGame=1` asks for the old escape hatch.
  ...(testGame
    ? {
        test: {
          game: {
            seed: '0x1',
            params: null,
            secret: hexEncode(loadOrMintSecret()),
            joinKey: readInvite(location).joinKey ?? '',
            buildHash: clientBuildHash,
          },
        },
      }
    : {}),
}
// `mp/coep-worker-error-message` (Scope: "unchanged from M06, just needs to still pass on the new
// page"): pattern B (0017 §3) points every spawned worker at the built worker chunk served with
// COOP but no COEP (`fixturesPlugin()`'s `/__no-coep-worker__.js` route, `start.spec.ts`'s own
// precedent) -- the same readable `'worker-blocked'`/`COEP` rejection `client.ready` already
// surfaces for `topology.html`'s imperative API, proven here on a page that auto-creates its
// client at load instead.
if (blockedWorker) {
  clientOptions.createWorker = () => new Worker('/__no-coep-worker__.js', { type: 'module' })
}

const client: Client = createClient(clientOptions)

// docs/plan/33f: the timeline `mp/remote_client_configures_from_welcome` reads. Listeners are
// attached before anything can settle: `Welcome` applied (`online`), the gen workers up
// (`untilConfigured`), the first reveal (polled).
const timeline: { welcomeMs: number | null; genUpMs: number | null; revealedMs: number | null } = {
  welcomeMs: null,
  genUpMs: null,
  revealedMs: null,
}
client.onLink((e) => {
  if (e.state === 'online' && timeline.welcomeMs === null) timeline.welcomeMs = performance.now()
})
void untilConfigured(client).then(() => {
  timeline.genUpMs = performance.now()
})
const revealPoll = setInterval(() => {
  if (timeline.revealedMs === null && workersReady && client.revealed()) {
    timeline.revealedMs = performance.now()
    clearInterval(revealPoll)
  }
}, 5)
window.__mpGenDelivered = () => {
  const stats: RingStats = { drops: 0, pushed: 0, popped: 0 }
  let pushed = 0
  for (const sab of clientTestHandle(client).sabs.genResult) {
    new RingConsumer(sab).stats(stats)
    pushed += stats.pushed
  }
  return pushed
}
window.__mpConfig = () => ({
  genWorkers: clientTestHandle(client).workers.filter((w) => w.kind === 'gen').length,
  testGame,
  ...timeline,
})

let workersReady = false
const readyResult: { ok: true } | { ok: false; code: string; message: string } =
  await client.ready.then(
    () => ({ ok: true as const }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string }
      return { ok: false as const, code: err.code ?? '', message: err.message ?? String(e) }
    },
  )
window.__mpClientReadyResult = () => readyResult
if (readyResult.ok) workersReady = true

// --- Camera (fixture-driven, not real gestures: `__mpSetCamera`) -------------------------------
const halfScratch = { x: 0, y: 0 }
function setCameraState(x: number, y: number, tilesAcross: number): void {
  client.cameraState.centreX = x
  client.cameraState.centreY = y
  client.cameraState.tilesAcross = tilesAcross
  halfExtentTiles(client.cameraState, renderer.viewport, halfScratch)
  client.cameraState.halfExtentTilesX = halfScratch.x
  client.cameraState.halfExtentTilesY = halfScratch.y
}
window.__mpSetCamera = setCameraState
setCameraState(0, 0, 20) // `square(0)` (`tests/netcode/support.ts`'s own convention)

function onCamera(): void {
  const v = renderer.viewport
  const camTileX = Math.floor(client.cameraState.centreX)
  const camTileY = Math.floor(client.cameraState.centreY)
  const fu = renderer.frameUniform
  fu.camTileX = camTileX
  fu.camTileY = camTileY
  fu.camFracX = client.cameraState.centreX - camTileX
  fu.camFracY = client.cameraState.centreY - camTileY
  fu.viewportPxW = v.widthPx
  fu.viewportPxH = v.heightPx
  fu.tilesPerPx = Math.max(v.widthPx, v.heightPx) / client.cameraState.tilesAcross
}

if (workersReady) {
  const { loop } = createRealFrameLoop({
    client,
    renderer,
    canvas,
    clock: systemClock,
    scheduler: systemScheduler,
    maxTextureDimension2D: device.device.limits.maxTextureDimension2D,
    onCamera,
    // docs/plan/29-net-worker-and-reference-server.md Scope ("Reveal gate"): the one real page
    // this milestone wires it into -- `client.revealed()` straight through, no page-owned state.
    revealed: () => client.revealed(),
  })
  loop.resume()
}

// --- Action results ------------------------------------------------------------------------
let confirmed = 0
let rejected = 0
client.onActionResult<Reject>((_seq, result) => {
  if (result === 'Confirmed' || result === 'Lost') confirmed += 1
  else if (result !== 'NotPredictable') rejected += 1
})
window.__mpConfirmed = () => confirmed
window.__mpRejected = () => rejected

function paintAt(x: number, y: number): number {
  const action: Action = { Paint: { pos: { x, y }, base: 1, resource: 2 } }
  return client.dispatch(action)
}
window.__mpDispatchPaintAt = paintAt
window.__mpDispatch = (action: unknown) => client.dispatch(action)
paintBtn.addEventListener('click', () => {
  paintAt(Math.floor(client.cameraState.centreX), Math.floor(client.cameraState.centreY))
})

// --- Ui (global-scope convergence, `mp/two-pages`) ----------------------------------------------
let lastUi: unknown = null
client.onUi((ui) => {
  lastUi = ui
})
window.__mpUi = () => lastUi

// --- Link state / log (`mp/reconnect`, `mp/superseded`, `?linklog=1`) ---------------------------
let linkState: LinkState = 'connecting'
client.onLink((e) => {
  linkState = e.state
})
window.__mpLinkState = () => linkState
window.__mpLinkLog = () => client.debug.linkLog()
window.__mpRevealed = () => client.revealed()

function renderLinklog(): void {
  if (!linklogVisible) return
  const rows = client.debug.linkLog().map((e) => {
    const code = e.code ?? '-'
    return `${e.event.padEnd(7)} ${e.state.padEnd(12)} code=${code} sinceVisible=${Math.round(e.msSinceVisible)}ms discarded=${e.discarded}`
  })
  linklogEl.textContent = rows.join('\n')
}
setInterval(renderLinklog, 200)

// --- Reveal-gate probe (`mp/reveal-waits-for-visible-chunks`) -----------------------------------
window.__mpProbeCenterPixel = async () => {
  const size = 4
  const target = renderTo(renderer, { width: size, height: size })
  // `renderTo`'s own draw (above) always passes no second argument (`reveal: true`, Seams,
  // Provides: every pre-existing caller unaffected) -- redrawn here with this page's own *current*
  // `client.revealed()` reading before the readback, atomically (no `await` in between: nothing
  // else can run inside this turn), matching production's own per-frame gate exactly.
  renderer.draw(target.texture, { reveal: client.revealed() })
  const pixels = await readPixels(target)
  return {
    r: pixels.data[0] as number,
    g: pixels.data[1] as number,
    b: pixels.data[2] as number,
    a: pixels.data[3] as number,
  }
}

// --- HUD ------------------------------------------------------------------------------------
function hudText(): string {
  return [
    'mp.html',
    `isolated: ${globalThis.crossOriginIsolated}`,
    `adapter: ${JSON.stringify(device.adapterInfo)}`,
    `workers ready: ${workersReady}`,
    `link: ${linkState}`,
    `revealed: ${workersReady ? client.revealed() : false}`,
    `confirmed: ${confirmed}`,
    `rejected: ${rejected}`,
    `ready: ${readyResult.ok ? 'ok' : `${readyResult.code}: ${readyResult.message}`}`,
  ].join('\n')
}
function renderHud(): void {
  hudEl.textContent = hudText()
}
setInterval(renderHud, 200)
renderHud()
window.__mpHudText = hudText

window.__errors = () => device.errors()
window.__adapterInfo = () => device.adapterInfo

window.__pageReady = true
