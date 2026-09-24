// Entity picking (docs/decisions/0019-camera-input-and-overlay.md §4 "Picking"; docs/plan/
// 18-picking-and-overlay.md Scope, Order of work steps 1-2): scans the frame's already-acquired
// DrawList slot (`render/drawlist-slot.ts`) front to back -- layers high to low, reverse submission
// order within a layer -- for the first `pick_id != 0` record, skipping any `ANCHOR_CURSOR_TILE`
// record, whose shape contains the pointer. The pointer is converted once (not per record) to
// continuous world tiles relative to the slot's own `window_origin`, matching `Draw.pos`'s own space
// (0018 §2). Synchronous, allocation-free in steady state: every scratch object below is created
// once, in `createPicker` (`.claude/rules/hot-paths.md`).
import type { CameraState } from '../camera/state.js'
import type { CameraViewport, ScreenPoint } from '../camera/transform.js'
import { pxPerTile, screenToWorld } from '../camera/transform.js'
import {
  ANCHOR_CURSOR_TILE,
  DRAW_BYTES,
  KIND_CIRCLE,
  KIND_RADIAL,
  KIND_RING,
  LAYER_COUNT,
  SCREEN_PX_STROKE,
} from '../render/drawables.js'
import type { DrawListSlot } from '../render/drawlist-slot.js'

// `client/drawlist.rs`'s own header layout (docs/plan/17-drawlist-and-sprites.md Deviations,
// "Header, as landed"): the one field picking needs beyond what `DrawListSlot` already parses.
// Duplicated the same way `render/drawables.ts`'s own `OFF_*` constants mirror the Rust layout.
const HEADER_OFF_LAYER_COUNT = 16

// One `Draw` record's own field offsets (0018 §2), the four picking reads.
const DRAW_OFF_POS = 0
const DRAW_OFF_SIZE = 8
const DRAW_OFF_KIND_LAYER_FLAGS = 16
const DRAW_OFF_PICK_ID = 28

/** 0019 §4 Planning decisions "Containment per kind": "a minimum pick radius of 6 CSS px" applies
 * when `SCREEN_PX_STROKE` is set (a thin ring's own band would otherwise be nearly untappable). */
export const MIN_STROKE_PICK_RADIUS_PX = 6

function containsRecord(
  kind: number,
  flags: number,
  posX: number,
  posY: number,
  sizeX: number,
  sizeY: number,
  relX: number,
  relY: number,
  minPickRadiusTiles: number,
): boolean {
  const dx = relX - posX
  const dy = relY - posY
  // Circle, ring (outer radius), radial: distance from `pos` <= `size.x / 2`.
  if (kind === KIND_CIRCLE || kind === KIND_RING || kind === KIND_RADIAL) {
    let r = sizeX * 0.5
    if ((flags & SCREEN_PX_STROKE) !== 0 && r < minPickRadiusTiles) r = minPickRadiusTiles
    return dx * dx + dy * dy <= r * r
  }
  // Rect, bar, ghost, sprite: the axis-aligned box of `pos` and `size` (`uberquad.wgsl`'s own
  // `vs_main`: every non-sprite kind's box is centred at `pos`, `+/- size / 2` per axis -- a
  // sprite's own pivot offset needs the loaded sprite table this cut does not wire in, Deviations;
  // it falls back to the same centred box every other kind uses).
  let hx = sizeX * 0.5
  let hy = sizeY * 0.5
  if ((flags & SCREEN_PX_STROKE) !== 0) {
    if (hx < minPickRadiusTiles) hx = minPickRadiusTiles
    if (hy < minPickRadiusTiles) hy = minPickRadiusTiles
  }
  return Math.abs(dx) <= hx && Math.abs(dy) <= hy
}

/** The pure scan (Order of work step 1: "pick.ts with unit tests on hand-built slots"). `header`/
 * `bodyView` are long-lived typed views over one triple-buffer slot (`DrawListSlot`, or a hand-built
 * pair in a unit test); `layerCounts`/`layerFirst` are caller-owned length-`LAYER_COUNT` scratch (no
 * allocation here). `relX`/`relY` are the pointer already converted to continuous world tiles
 * relative to the slot's own `window_origin` -- converted once by the caller, not per record. Reads
 * the `pick_id` column first and touches the other fields only for a non-zero id (Planning
 * decisions). Returns the first contained, non-zero, non-`ANCHOR_CURSOR_TILE` `pick_id`, front to
 * back: layers high to low, reverse submission order within a layer. */
export function scanDrawListForPick(
  header: DataView,
  bodyView: DataView,
  relX: number,
  relY: number,
  minPickRadiusTiles: number,
  layerCounts: Uint32Array,
  layerFirst: Uint32Array,
): number {
  let acc = 0
  for (let i = 0; i < LAYER_COUNT; i++) {
    const c = header.getUint32(HEADER_OFF_LAYER_COUNT + i * 4, true)
    layerCounts[i] = c
    layerFirst[i] = acc
    acc += c
  }
  for (let layer = LAYER_COUNT - 1; layer >= 0; layer--) {
    const count = layerCounts[layer] as number
    if (count === 0) continue
    const first = layerFirst[layer] as number
    for (let r = first + count - 1; r >= first; r--) {
      const off = r * DRAW_BYTES
      const pickId = bodyView.getUint32(off + DRAW_OFF_PICK_ID, true)
      if (pickId === 0) continue
      const klf = bodyView.getUint32(off + DRAW_OFF_KIND_LAYER_FLAGS, true)
      const flags = (klf >>> 24) & 0xff
      if ((flags & ANCHOR_CURSOR_TILE) !== 0) continue // pick.skips_zero_id_and_cursor_anchored
      const kind = (klf >>> 12) & 0xf
      const posX = bodyView.getFloat32(off + DRAW_OFF_POS, true)
      const posY = bodyView.getFloat32(off + DRAW_OFF_POS + 4, true)
      const sizeX = bodyView.getFloat32(off + DRAW_OFF_SIZE, true)
      const sizeY = bodyView.getFloat32(off + DRAW_OFF_SIZE + 4, true)
      if (containsRecord(kind, flags, posX, posY, sizeX, sizeY, relX, relY, minPickRadiusTiles)) {
        return pickId
      }
    }
  }
  return 0
}

export type PickerOptions = {
  drawListSlot: DrawListSlot
  cameraState: CameraState
  viewport: CameraViewport
}

export interface Picker {
  /** Pulls the newest DrawList slot -- called once per rAF by `frame-loop.ts`'s `acquire` phase, so
   * camera/picking/overlay/render this frame all read the same slot `render/drawlist-slot.ts`
   * acquired. A thin pass-through to `PickerOptions.drawListSlot.acquire()`. */
  acquire(): void
  /** `pick_id` at this CSS-pixel point on the most-recently-acquired slot, or `0`. Internal (Seams:
   * "`pickAt(cssX, cssY): number` internal, used by the semantic layer"): `input/semantic.ts`'s
   * recognizer calls this once per emitted `tap`/`hover`/`longpress`/`drag*` event;
   * `engine/test.pickAt(client, x, y)` is a thin wrapper over `Client.pick.at`. Caches the last
   * `(cssX, cssY, frameSeq)` it actually scanned (Planning decisions: "hover picks at most once per
   * rAF, when the pointer or slot changed") -- a repeated call at the same point against the same
   * acquired slot returns the cached answer without touching the DrawList body again. */
  at(cssX: number, cssY: number): number
  /** `engine/test`'s `pickScanned` counter: how many times `at()` has actually scanned the body
   * (cache misses only) since creation. */
  scanned(): number
}

/** Builds the picker over one `Client`'s own `DrawListSlot`/camera (`createClient`, `src/client.ts`
 * -- one instance per `Client`). */
export function createPicker(opts: PickerOptions): Picker {
  const layerCounts = new Uint32Array(LAYER_COUNT)
  const layerFirst = new Uint32Array(LAYER_COUNT)
  const worldPoint: ScreenPoint = { x: 0, y: 0 }
  let lastX = Number.NaN
  let lastY = Number.NaN
  let lastFrameSeq = -1
  let lastPickId = 0
  let scannedCount = 0

  function at(cssX: number, cssY: number): number {
    const slot = opts.drawListSlot
    if (cssX === lastX && cssY === lastY && slot.frameSeq === lastFrameSeq) {
      return lastPickId
    }
    screenToWorld(opts.cameraState, opts.viewport, cssX, cssY, worldPoint)
    const relX = worldPoint.x - slot.windowOriginX
    const relY = worldPoint.y - slot.windowOriginY
    const minPickRadiusTiles =
      MIN_STROKE_PICK_RADIUS_PX / pxPerTile(opts.cameraState, opts.viewport)
    const pickId = scanDrawListForPick(
      slot.header,
      slot.bodyView,
      relX,
      relY,
      minPickRadiusTiles,
      layerCounts,
      layerFirst,
    )
    lastX = cssX
    lastY = cssY
    lastFrameSeq = slot.frameSeq
    lastPickId = pickId
    scannedCount++
    return pickId
  }

  return {
    acquire() {
      opts.drawListSlot.acquire()
    },
    at,
    scanned() {
      return scannedCount
    },
  }
}
