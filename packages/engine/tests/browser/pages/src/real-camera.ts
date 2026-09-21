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

window.__pageReady = true
