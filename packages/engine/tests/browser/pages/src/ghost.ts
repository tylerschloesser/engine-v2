// `ghost.html`'s script (docs/plan/18-picking-and-overlay.md Tests added, steps 7-8: `ghost.
// mouse_tracks_cursor_tile`, `ghost.touch_tap_then_confirm`; Scope: "a cursor-anchored ghost works
// end to end for mouse and for the touch tap-then-confirm flow"). Unlike `framecx.html` (no camera,
// no overlay -- proves only that `cx.input()`/`client.input.emit` reach Rust) and `real-camera.html`
// (real camera/picking/overlay, but no WASM -- `pick.spec.ts`/`overlay.spec.ts`/`follow.spec.ts`'s
// own hand-filled-DrawList precedent), this page needs *both* halves live at once: a real WASM
// `fx-overlay` instance whose `extract()` draws the cursor-anchored ghost (`ANCHOR_CURSOR_TILE`,
// `view.cursor_tile()`), and the real `CameraIntegrator`/`SemanticRecognizer`/`Client.overlay` that
// feed it (`FrameView::cursor_tile()` is populated from the camera block's own `cursor_tile`/`cursor_
// valid` fields, written by `client.camera.tick()` -> `writeCameraBlock`, `stepFrame`'s own second
// half).
//
// A real *connected* topology (`host: 'local', connect: true`, `connected.ts`'s own precedent), not
// `framecx.ts`'s unconnected `'remote'` one: `ghost.touch_tap_then_confirm`'s own "confirm dispatches
// the action" needs `client.dispatch` to actually work, which needs `session_state === Live`
// (`client.ts`'s own `dispatch`: "throws if `session_state !== Live`"), which only a real net-pump
// round trip over a real sim connection ever sets (`worker/client-net.ts`).
//
// The confirm button itself is *this page's own* job, not Rust's (Planning decisions: "`FrameCx` has
// no `dispatch`... a game turns a tap into an action in `client.input.on('tap', ...)`"): on a real
// `tap` event, the page reads `cameraState.cursorTileX/Y` (already the tapped tile -- `input/
// semantic.ts`'s own fix, this cut: "touch: tile of the last tap") and anchors a real DOM button
// there through `client.overlay.anchor`; a real click calls `client.dispatch(null)` (`fx-overlay`'s
// `Action` is a unit struct, `serde_json`'s own unit-struct convention: JSON `null`).
import type { Client, ClientOptions } from '../../../../src/client.ts'
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import { recordMouseHover } from '../../../../src/input/pointers.ts'
import { KIND_GHOST } from '../../../../src/render/drawables.ts'
import {
  type DrawRecord,
  drawListRecords,
  pumpUntilLive,
  stepFrame,
} from '../../../../src/test/client.ts'
import {
  attachCameraInputTestHooks,
  injectPointer,
  type PointerKindName,
  type PointerPhase,
} from '../../../../src/test/input.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __ready?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __injectPointer?: (
      phase: PointerPhase,
      id: number,
      cssX: number,
      cssY: number,
      tMs: number,
      kind?: PointerKindName,
    ) => void
    /** `input/pointers.ts`'s own `recordMouseHover` (0019 §4: "written by every mouse-kind
     * `pointermove` regardless of whether a `PointerSlot` is press-active"): the genuine "mouse
     * hovering, no button held" path -- unlike a held+moved pointer (`__injectPointer('move', ...)`
     * on an already-`'down'` id), which the camera also reads as a pan gesture. */
    __injectHover?: (cssX: number, cssY: number) => void
    /** `client.pick.acquire()` then `client.camera.tick(dtMs)` then `stepFrame(client, dtMs)`
     * (drains `inputRing`, writes the camera block, wakes the client worker, spins for its ack --
     * one real `frame()`+`extract()`+publish) then `client.overlay.update()`: the same phase order
     * `frame-loop.ts`'s `FRAME_PHASES` uses (`acquire`, `camera`, `writeCamera`/publish, `overlay`),
     * minus `upload`/`render` (no GPU on this page). */
    __driveFrame?: (dtMs: number) => void
    __cursorTile?: () => { x: number; y: number; valid: boolean }
    /** The newest DrawList slot's own `KIND_GHOST` record, if any (`extract()` only emits one while
     * `view.cursor_tile()` is `Some`). `pos` is always `[0, 0]` by construction (Deviations: the
     * ghost's own `pos` argument is `WorldPos::from_tile(view.window_origin())`, so `relative_pos`
     * is exactly zero -- the *shader* places it at the live cursor tile via `ANCHOR_CURSOR_TILE`,
     * not this record's own `pos`). */
    __ghostRecord?: () => { pos: [number, number]; flags: number } | undefined
    __lastTap?: () => { tileX: number; tileY: number } | undefined
    __confirmVisible?: () => boolean
    __lastDispatchSeq?: () => number | undefined
  }
}

const wasm = await fixtureWasm('overlay')
const canvas = document.createElement('canvas')
canvas.width = 400
canvas.height = 300
document.body.appendChild(canvas)
// `connected.ts`'s own precedent (its own comment has the full reasoning): without a manual clock,
// two `stepFrame` calls close together in real wall-clock time could land inside the same
// `client_poll_uplink` rate-limit window.
const clock = createManualClock()

const client: Client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'ghost-test', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  test: { clock, flags: {} },
} satisfies ClientOptions)
attachCameraInputTestHooks(client, clientTestHandle(client).cameraBundle)

window.__ready = async () => {
  try {
    await pumpUntilLive(client)
    return { ok: true }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { ok: false, code: err.code ?? '', message: err.message ?? String(e) }
  }
}

window.__injectPointer = (phase, id, cssX, cssY, tMs, kind) => {
  injectPointer(client, phase, id, cssX, cssY, tMs, kind)
}
window.__injectHover = (cssX, cssY) => {
  recordMouseHover(clientTestHandle(client).cameraBundle.pointers, cssX, cssY)
}

window.__driveFrame = (dtMs) => {
  client.pick.acquire()
  client.camera.tick(dtMs)
  stepFrame(client, dtMs)
  client.overlay.update()
}

window.__cursorTile = () => ({
  x: client.cameraState.cursorTileX,
  y: client.cameraState.cursorTileY,
  valid: client.cameraState.cursorValid,
})

const drawListScratch: DrawRecord[] = []
window.__ghostRecord = () => {
  drawListRecords(client, drawListScratch)
  const rec = drawListScratch.find((r) => r.kind === KIND_GHOST)
  return rec ? { pos: rec.pos, flags: rec.flags } : undefined
}

// --- Touch tap-then-confirm (Planning decisions: page-side, not Rust) -------------------------
let lastTap: { tileX: number; tileY: number } | undefined
let confirmBtn: HTMLButtonElement | undefined
let confirmHandle: ReturnType<Client['overlay']['anchor']> | undefined
let lastDispatchSeq: number | undefined

function removeConfirm(): void {
  confirmHandle?.remove()
  confirmHandle = undefined
  confirmBtn = undefined
}

client.input.on('tap', (e) => {
  lastTap = { tileX: e.tileX, tileY: e.tileY }
  removeConfirm()
  const btn = document.createElement('button')
  btn.id = 'ghost-confirm'
  btn.textContent = 'confirm'
  btn.addEventListener('click', () => {
    lastDispatchSeq = client.dispatch(null)
    removeConfirm()
  })
  confirmBtn = btn
  confirmHandle = client.overlay.anchor(btn, e.tileX + 0.5, e.tileY + 0.5)
})

window.__lastTap = () => lastTap
window.__confirmVisible = () => confirmBtn !== undefined && document.body.contains(confirmBtn)
window.__lastDispatchSeq = () => lastDispatchSeq

window.__pageReady = true
