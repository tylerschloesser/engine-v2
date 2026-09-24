// `real-camera.html`'s script (docs/plan/11-camera-and-input.md, Order of work step 6): a real
// `createClient()` whose canvas is actually attached to the document, so the client's own
// automatically-installed `installPointerListeners`/`installKeyListeners`/`installWheelListeners`
// (`src/client.ts`, this range's own production wiring) receive *real* DOM events from Playwright's
// `page.mouse`/`page.keyboard`, not injection -- the one real-DOM-path page this range's Tests added
// list asks for (`input.dom_path_pan_and_tap`), reused by every other new browser test in this range
// that doesn't specifically need real dispatch (persistence, suspend/resume use `engine/test`
// injection instead, into the *same* internal bundle via `clientTestHandle`).
import { CameraState } from '../../../../src/camera/state.ts'
import type { Client, ClientOptions } from '../../../../src/client.ts'
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import type { InputEventType } from '../../../../src/input/semantic.ts'
import type { AnchorAlign, AnchorHandle } from '../../../../src/overlay/anchors.ts'
import {
  DRAW_BYTES,
  LAYER_COUNT,
  packDrawKindLayerFlags,
} from '../../../../src/render/drawables.ts'
import { DRAWLIST_BODY_BYTES, DRAWLIST_HEADER_BYTES } from '../../../../src/sab/layout.ts'
import { TripleWriter } from '../../../../src/sab/triple.ts'
import { attachCameraInputTestHooks, injectKey, injectPointer } from '../../../../src/test/input.ts'
import { fixtureWasm } from './fixture-wasm.ts'

const wasm = await fixtureWasm('terrain')

declare global {
  interface Window {
    __rcCreate?: (opts?: { cameraKey?: string }) => void
    __rcReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __rcDestroy?: () => void
    __rcRead?: () => { centreX: number; centreY: number; tilesAcross: number }
    __rcRestored?: () => boolean
    __rcSetConstraints?: (opts: { minTiles?: number; maxTiles?: number }) => void
    __rcMoveTo?: (x: number, y: number, opts?: { tiles?: number; durationMs?: number }) => void
    __rcTick?: (dtMs: number) => void
    __rcSuspend?: () => void
    __rcResume?: () => void
    __rcOnCount?: (type: InputEventType) => void
    __rcCount?: (type: InputEventType) => number
    __rcInjectPointer?: (
      phase: 'down' | 'move' | 'up' | 'cancel',
      id: number,
      cssX: number,
      cssY: number,
      tMs: number,
    ) => void
    __rcInjectKey?: (code: string, down: boolean) => void
    __rcKeysMask?: () => number
    __rcMountWidget?: (x: number, y: number, w: number, h: number) => void
    // docs/plan/18-picking-and-overlay.md: picking hooks -- a spec hand-fills the DrawList's own
    // back slot and publishes it (the same "hand-built slot" shape `input/pick.test.ts`'s unit
    // tests use, over the real triple-buffer SAB this time), then drives picking exactly the way
    // `frame-loop.ts`'s `acquire` phase and `input/semantic.ts`'s recognizer do.
    __rcPublishDrawList?: (
      records: Array<{
        posX: number
        posY: number
        sizeX: number
        sizeY: number
        kind: number
        layer: number
        flags?: number
        pickId: number
      }>,
      windowOriginX?: number,
      windowOriginY?: number,
    ) => void
    __rcPickAcquire?: () => void
    __rcPickAt?: (cssX: number, cssY: number) => number
    __rcPickScanned?: () => number
    // docs/plan/18-picking-and-overlay.md: overlay hooks -- `id` names both the DOM element (its own
    // `id` attribute, so a spec can query it with a Playwright locator, reading layout is allowed
    // there) and the `AnchorHandle` this page keeps.
    __rcOverlayAnchor?: (id: string, worldX: number, worldY: number, align?: AnchorAlign) => void
    __rcOverlaySet?: (id: string, worldX: number, worldY: number) => void
    __rcOverlayRemove?: (id: string) => void
    __rcOverlayUpdate?: () => void
    __rcOverlayStyleWrites?: () => number
    __pageReady?: true
  }
}

let client: Client | undefined
const counts: Record<string, number> = {}

function requireClient(): Client {
  if (!client) throw new Error('real-camera.ts: call __rcCreate first')
  return client
}

window.__rcCreate = (opts = {}) => {
  const canvas = document.createElement('canvas')
  canvas.width = 400
  canvas.height = 300
  const host = document.getElementById('canvas-host') as HTMLDivElement
  host.appendChild(canvas)
  const options: ClientOptions = {
    canvas,
    wasm,
    host: { kind: 'remote', url: 'ws://unused.invalid' },
    genWorkers: 1,
    ...(opts.cameraKey !== undefined ? { cameraKey: opts.cameraKey } : {}),
  }
  client = createClient(options)
  client.ready.catch(() => {})
  attachCameraInputTestHooks(client, clientTestHandle(client).cameraBundle)
  for (const type of ['tap', 'hover', 'longpress', 'dragstart', 'drag', 'dragend'] as const) {
    counts[type] = 0
    client.input.on(type, () => {
      counts[type] = (counts[type] ?? 0) + 1
    })
  }
}

window.__rcReady = async () => {
  try {
    await requireClient().ready
    return { ok: true }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { ok: false, code: err.code ?? '', message: err.message ?? String(e) }
  }
}

window.__rcDestroy = () => {
  client?.destroy()
  client = undefined
}

window.__rcRead = () => {
  const outState = new CameraState()
  requireClient().camera.read(outState)
  return { centreX: outState.centreX, centreY: outState.centreY, tilesAcross: outState.tilesAcross }
}

window.__rcRestored = () => requireClient().camera.restored
window.__rcSetConstraints = (opts) => requireClient().camera.setConstraints(opts)
window.__rcMoveTo = (x, y, opts) => requireClient().camera.moveTo(x, y, opts)
window.__rcTick = (dtMs) => requireClient().camera.tick(dtMs)
window.__rcSuspend = () => requireClient().input.suspend()
window.__rcResume = () => requireClient().input.resume()
window.__rcCount = (type) => counts[type] ?? 0

window.__rcInjectPointer = (phase, id, cssX, cssY, tMs) => {
  injectPointer(requireClient(), phase, id, cssX, cssY, tMs)
}
window.__rcInjectKey = (code, down) => {
  injectKey(requireClient(), code, down)
}
window.__rcKeysMask = () => clientTestHandle(requireClient()).cameraBundle.keys.mask

// `input: widget blocks canvas` / `input: drag survives passing under widget`: a sibling element
// above the canvas with `pointer-events: auto` (0019 §4's own "Input over DOM UI" shape) at a given
// CSS rect, relative to `#canvas-host` (same origin as the canvas itself).
window.__rcMountWidget = (x, y, w, h) => {
  const host = document.getElementById('canvas-host') as HTMLDivElement
  const widget = document.createElement('div')
  widget.id = 'widget'
  widget.style.position = 'absolute'
  widget.style.left = `${x}px`
  widget.style.top = `${y}px`
  widget.style.width = `${w}px`
  widget.style.height = `${h}px`
  widget.style.background = 'rgba(255,0,0,0.3)'
  widget.style.pointerEvents = 'auto'
  host.appendChild(widget)
}

// docs/plan/18-picking-and-overlay.md: picking. `writer` is built once, lazily (the client doesn't
// exist until `__rcCreate`) -- the *only* `TripleWriter` this page ever builds over `sabs.drawList`,
// matching production's own "one writer" shape (the client worker's real publish pump).
let drawListWriter: TripleWriter | undefined
// A globally monotonic counter (`client/drawlist.rs`'s own `frame_seq`, "wraps every `begin_frame`")
// -- *not* read-modify-written from the slot's own bytes: `publish()` alternates which of the three
// physical slots is `backSlot()`, so a per-slot read-increment would (and did, found running this
// page's own first draft of `pick.matches_interpolated_frame_on_screen`) produce the *same* value
// twice from two different, untouched slots, defeating `Picker.at`'s own cache key.
let nextFrameSeq = 1
const HEADER_OFF_FRAME_SEQ = 0
const HEADER_OFF_RECORD_COUNT = 4
const HEADER_OFF_WINDOW_ORIGIN = 8
const HEADER_OFF_LAYER_COUNT = 16

window.__rcPublishDrawList = (records, windowOriginX = 0, windowOriginY = 0) => {
  const c = requireClient()
  if (!drawListWriter) {
    drawListWriter = new TripleWriter(
      clientTestHandle(c).sabs.drawList,
      DRAWLIST_HEADER_BYTES,
      DRAWLIST_BODY_BYTES,
    )
  }
  const slot = drawListWriter.backSlot()
  const headerBytes = drawListWriter.headerView(slot)
  const header = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength)
  const byLayer: (typeof records)[] = Array.from({ length: LAYER_COUNT }, () => [])
  for (const r of records) byLayer[r.layer]?.push(r)
  const ordered = byLayer.flat()
  let recordCount = 0
  for (let i = 0; i < LAYER_COUNT; i++) {
    const count = (byLayer[i] as typeof records).length
    header.setUint32(HEADER_OFF_LAYER_COUNT + i * 4, count, true)
    recordCount += count
  }
  header.setUint32(HEADER_OFF_RECORD_COUNT, recordCount, true)
  header.setInt32(HEADER_OFF_WINDOW_ORIGIN, windowOriginX, true)
  header.setInt32(HEADER_OFF_WINDOW_ORIGIN + 4, windowOriginY, true)
  // `frame_seq` bumped so `Picker.at`'s own cache (keyed on it) never reuses a stale answer across
  // two publishes of the same test.
  header.setUint32(HEADER_OFF_FRAME_SEQ, nextFrameSeq >>> 0, true)
  nextFrameSeq += 1

  const bodyBytes = drawListWriter.bodyView(slot)
  const body = new DataView(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength)
  ordered.forEach((r, i) => {
    const off = i * DRAW_BYTES
    body.setFloat32(off, r.posX, true)
    body.setFloat32(off + 4, r.posY, true)
    body.setFloat32(off + 8, r.sizeX, true)
    body.setFloat32(off + 12, r.sizeY, true)
    body.setUint32(off + 16, packDrawKindLayerFlags(r.kind, 0, r.layer, r.flags ?? 0), true)
    body.setUint32(off + 28, r.pickId, true)
  })
  drawListWriter.publish()
}

window.__rcPickAcquire = () => requireClient().pick.acquire()
window.__rcPickAt = (cssX, cssY) => requireClient().pick.at(cssX, cssY)
window.__rcPickScanned = () => clientTestHandle(requireClient()).picker.scanned()

// docs/plan/18-picking-and-overlay.md: static overlay anchors.
const overlayHandles = new Map<string, AnchorHandle>()

window.__rcOverlayAnchor = (id, worldX, worldY, align) => {
  const c = requireClient()
  const el = document.createElement('div')
  el.id = id
  el.textContent = id
  const opts = align !== undefined ? { align } : {}
  // `client.overlay.anchor` re-parents `el` into the engine's own anchor layer itself (`overlay/
  // anchors.ts`'s own doc comment) -- this page never appends `el` anywhere first.
  overlayHandles.set(id, c.overlay.anchor(el, worldX, worldY, opts))
}
window.__rcOverlaySet = (id, worldX, worldY) => overlayHandles.get(id)?.set(worldX, worldY)
window.__rcOverlayRemove = (id) => {
  overlayHandles.get(id)?.remove()
  overlayHandles.delete(id)
}
window.__rcOverlayUpdate = () => requireClient().overlay.update()
window.__rcOverlayStyleWrites = () => clientTestHandle(requireClient()).overlay.styleWrites()

window.__pageReady = true
