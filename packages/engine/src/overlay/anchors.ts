// Overlay anchoring, static anchors only (docs/decisions/0019-camera-input-and-overlay.md §5;
// docs/plan/18-picking-and-overlay.md Scope, Order of work step 3): one engine-owned anchor layer
// element, re-parenting each anchored `el` into it; each anchor stores its own offset from a
// floating origin tile once, in custom properties `--wx`/`--wy`, under one injected, shared,
// *static* CSS rule per `align` value -- never a per-anchor `style.transform` write
// (0019's own "Alternatives rejected": that is the `'translate'` fallback mode, a later step, Non-
// scope here). Per rAF (`update()`, wired to `frame-loop.ts`'s `overlay` phase) the engine writes at
// most two properties on the *layer* element: `transform` if the origin's own screen position moved,
// `--z` (CSS px per tile) if zoom changed -- panning is compositor-only for any anchor count, an
// idle camera writes nothing (Planning decisions: "the at-most-two-writes rule"). Slot anchors, the
// `'translate'` fallback mode and `anchorSlot` are *not* built here (Non-scope of this cut): the
// layer, the static rule and `writeAnchorVars`'s "recompute `--wx/--wy` relative to the current
// origin" shape are left exactly what a later step's `anchorSlot` needs to drive per-slot anchors
// the same way `.set()` drives a static one.
//
// No layout read anywhere in this file (exit criterion: `getBoundingClientRect`/`offsetWidth`
// scan of `src/overlay/`) -- every position is computed from `cameraState`/`viewport` (the same pure
// `camera/transform.ts` math `input/pick.ts` and `camera/camera.ts` already use), never read back
// off the DOM.
import type { CameraState } from '../camera/state.js'
import type { CameraViewport, ScreenPoint } from '../camera/transform.js'
import { pxPerTile, worldToScreen } from '../camera/transform.js'
import type { DrawListSlot } from '../render/drawlist-slot.js'

export type AnchorAlign = 'center' | 'top' | 'bottom'

/** The static rule's own per-align percentage pair, unit-testable without a DOM
 * (`overlay.align_offsets`). `bottom` matches 0019 §5's own literal transform (`translate(-50%,
 * -100%)`): an anchor's own bottom-centre point sits on its world tile, the natural default for a
 * marker-style DOM element. */
export const ALIGN_OFFSET_PERCENT: Record<AnchorAlign, { x: number; y: number }> = {
  center: { x: -50, y: -50 },
  top: { x: -50, y: 0 },
  bottom: { x: -50, y: -100 },
}

/** The static rule text for one `align` value (0019 §5's own formula, `--z`/`--wx`/`--wy` read
 * through `var()` with a safe zero/one default so an anchor never mis-places itself before its first
 * `writeAnchorVars` call lands). */
export function anchorTransform(align: AnchorAlign): string {
  const o = ALIGN_OFFSET_PERCENT[align]
  return (
    'translate(calc(var(--z, 1) * var(--wx, 0) * 1px), calc(var(--z, 1) * var(--wy, 0) * 1px)) ' +
    `translate(${o.x}%, ${o.y}%)`
  )
}

/** Pure re-base math (`overlay.rebase_math`): an anchor's own `--wx`/`--wy` (its offset from the
 * floating origin, in tiles) once the origin sits at `originX`/`originY`. The same function computes
 * an anchor's *first* offset (origin already chosen) and its offset *after* a re-base (origin moved)
 * -- a re-base changes only which world point is "0,0" for every anchor at once, never an anchor's
 * own `worldX`/`worldY`, so recomputing this is always correct and idempotent. */
export function rebaseOffset(
  worldX: number,
  worldY: number,
  originX: number,
  originY: number,
): { wx: number; wy: number } {
  return { wx: worldX - originX, wy: worldY - originY }
}

/** 0019 §5: "The origin is re-based ... when the camera is more than 50,000 CSS px from it." */
export const REBASE_THRESHOLD_PX = 50_000

export function needsRebase(originScreenX: number, originScreenY: number): boolean {
  return (
    Math.abs(originScreenX) > REBASE_THRESHOLD_PX || Math.abs(originScreenY) > REBASE_THRESHOLD_PX
  )
}

/** "Anchors leaving the viewport plus a margin get `visibility: hidden`" (0019 §5) -- the margin. */
const VISIBILITY_MARGIN_PX = 64

export type AnchorHandle = {
  /** Moves this anchor to a new world position: recomputes and rewrites its own `--wx`/`--wy`
   * immediately (a game-driven update, not a per-frame one -- exempt from the layer's own
   * at-most-two-writes budget). */
  set(worldX: number, worldY: number): void
  /** Detaches the element from the anchor layer and stops tracking it; leaves the element itself to
   * the caller (0019 §5 Planning decisions: "`remove()` detaches the element and leaves it to the
   * caller"). */
  remove(): void
}

/** `client.overlay.anchorSlot`'s own handle (0019 §5): unlike a static [`AnchorHandle`], there is no
 * `.set()` -- the position comes from the DrawList header's own anchor table (`DrawList::anchor`,
 * Rust), read fresh every `update()` call. */
export type SlotAnchorHandle = { remove(): void }

export type AnchorOptions = { align?: AnchorAlign }

export type OverlayMode = 'properties' | 'translate'

export type OverlayOptions = { root?: HTMLElement; mode?: OverlayMode }

export interface Overlay {
  /** `client.overlay.anchor` (Seams, Provides): re-parents `el` into the engine's one anchor layer
   * (lazily built on the first call -- a page whose canvas is never attached to the DOM, or that
   * never touches overlay at all, pays nothing and needs no root) and returns a handle. */
  anchor(el: HTMLElement, worldX: number, worldY: number, opts?: AnchorOptions): AnchorHandle
  /** docs/plan/18-picking-and-overlay.md steps 4-6 (0019 §5): re-parents `el` into the anchor layer
   * (same lazy build as `anchor`) and follows the DrawList header's own `slot` entry (`DrawList::
   * anchor(slot, pos)`, Rust) -- every `update()` call reads `anchor_mask`/`anchors[slot]` off the
   * *acquired* `DrawListSlot` (Deviations: "the same slot the `acquire` phase pulled", never a second
   * reader) and rewrites `--wx`/`--wy` only when the slot's own mask bit is set and its value
   * (`window_origin + anchors[slot]`, converted to absolute world tiles) actually changed since the
   * last write. A slot whose mask bit is unset this frame is left exactly where it last was
   * ("frozen", Deviations) -- `DrawList::anchor` not being called for a slot on a given frame is not
   * itself a signal to hide it. */
  anchorSlot(el: HTMLElement, slot: number): SlotAnchorHandle
  /** Runs once per rAF (`frame-loop.ts`'s `overlay` phase, after `camera`): the layer's own
   * `transform`/`--z` writes (at most two) plus visibility toggling for every anchor (a write only on
   * a visible/hidden transition). No-op until the first `anchor()` call has built the layer. */
  update(): void
  /** `engine/test`'s `styleWrites` counter: cumulative style/custom-property writes on the layer or
   * any anchor since creation (anchor creation and `.set()` included -- a test reads the delta across
   * only the frames it cares about). */
  styleWrites(): number
  dispose(): void
}

export type OverlayDeps = {
  cameraState: CameraState
  viewport: CameraViewport
  canvas: HTMLCanvasElement
  /** docs/plan/18-picking-and-overlay.md steps 4-6: `anchorSlot`'s own source of truth -- the same
   * single `DrawListSlot` `Client.pick`/`render/drawables.ts` already read (never a second
   * `TripleReader`, steps 1-3 Deviations). */
  drawListSlot: DrawListSlot
  options?: OverlayOptions
}

const LAYER_STYLE_ID = 'engine-overlay-anchor-style'
const ANCHOR_CLASS = 'engine-anchor'

// `client/drawlist.rs`'s own header layout (docs/plan/18-picking-and-overlay.md, steps 4-6
// Deviations "Header, as landed"): duplicated here the same way `render/drawlist-slot.ts`'s own
// `OFF_*` constants mirror the Rust layout.
const OFF_ANCHOR_MASK = 76
const OFF_ANCHORS = 128

function ensureStaticRule(doc: Document): void {
  if (doc.getElementById(LAYER_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = LAYER_STYLE_ID
  const rules = [
    `.${ANCHOR_CLASS} { position: absolute; left: 0; top: 0; pointer-events: auto; transform: ${anchorTransform('bottom')}; }`,
  ]
  for (const align of ['center', 'top'] as const) {
    rules.push(
      `.${ANCHOR_CLASS}[data-engine-align="${align}"] { transform: ${anchorTransform(align)}; }`,
    )
  }
  style.textContent = rules.join('\n')
  doc.head.appendChild(style)
}

type AnchorRecord = {
  el: HTMLElement
  worldX: number
  worldY: number
  visible: boolean
}

type SlotAnchorRecord = {
  el: HTMLElement
  slot: number
  worldX: number
  worldY: number
  visible: boolean
  /** Whether `anchor_mask` has ever had this slot's bit set (a slot `anchorSlot` was called for but
   * `DrawList::anchor` has not published yet stays at its CSS default, `var(--wx, 0)`, rather than a
   * `writeAnchorVars`-style write of a meaningless `(0, 0)` world position). */
  hasValue: boolean
}

/** `anchor_mask`'s own bit test (two `u32` words, `client/drawlist.rs`'s own `mask_lo`/`mask_hi`). */
function anchorMaskBit(header: DataView, slot: number): boolean {
  const word = header.getUint32(slot < 32 ? OFF_ANCHOR_MASK : OFF_ANCHOR_MASK + 4, true)
  const bit = slot < 32 ? slot : slot - 32
  return (word & (1 << bit)) !== 0
}

/** Builds `client.overlay` (`createClient`, `src/client.ts` -- one instance per `Client`, cheap:
 * no DOM touched until the first `anchor()` call). */
export function createOverlay(deps: OverlayDeps): Overlay {
  // `mode` is accepted for the full `ClientOptions.overlay` shape (Seams, Provides) but only
  // `'properties'` is built in this cut (Non-scope: "the per-anchor `translate()` fallback mode" is
  // a later step's); recorded rather than silently ignored.
  void (deps.options?.mode ?? 'properties')

  const anchors: AnchorRecord[] = []
  const slotAnchors: SlotAnchorRecord[] = []
  let layer: HTMLElement | undefined
  let originX = 0
  let originY = 0
  let lastOriginScreenX = Number.NaN
  let lastOriginScreenY = Number.NaN
  let lastZ = Number.NaN
  let writeCount = 0
  const screenPoint: ScreenPoint = { x: 0, y: 0 }

  function ensureLayer(): HTMLElement {
    if (layer) return layer
    const root = deps.options?.root ?? deps.canvas.parentElement
    if (!root) {
      throw new Error(
        'engine: overlay.anchor needs ClientOptions.overlay.root, or a canvas already attached ' +
          'to the DOM (0019 §5: "default root: the canvas\'s parent")',
      )
    }
    const doc = root.ownerDocument
    ensureStaticRule(doc)
    const el = doc.createElement('div')
    el.style.position = 'absolute'
    el.style.left = '0'
    el.style.top = '0'
    el.style.width = '0'
    el.style.height = '0'
    el.style.pointerEvents = 'none'
    root.appendChild(el)
    layer = el
    originX = Math.floor(deps.cameraState.centreX)
    originY = Math.floor(deps.cameraState.centreY)
    return el
  }

  function writeAnchorVars(rec: AnchorRecord): void {
    const { wx, wy } = rebaseOffset(rec.worldX, rec.worldY, originX, originY)
    rec.el.style.setProperty('--wx', String(wx))
    rec.el.style.setProperty('--wy', String(wy))
    writeCount += 2
  }

  function writeSlotAnchorVars(rec: SlotAnchorRecord): void {
    const { wx, wy } = rebaseOffset(rec.worldX, rec.worldY, originX, originY)
    rec.el.style.setProperty('--wx', String(wx))
    rec.el.style.setProperty('--wy', String(wy))
    writeCount += 2
  }

  function rebase(): void {
    originX = Math.floor(deps.cameraState.centreX)
    originY = Math.floor(deps.cameraState.centreY)
    for (let i = 0; i < anchors.length; i++) writeAnchorVars(anchors[i] as AnchorRecord)
    for (let i = 0; i < slotAnchors.length; i++) {
      const rec = slotAnchors[i] as SlotAnchorRecord
      if (rec.hasValue) writeSlotAnchorVars(rec)
    }
  }

  function anchor(
    el: HTMLElement,
    worldX: number,
    worldY: number,
    opts: AnchorOptions = {},
  ): AnchorHandle {
    const l = ensureLayer()
    el.classList.add(ANCHOR_CLASS)
    const align = opts.align ?? 'bottom'
    if (align === 'bottom') delete el.dataset.engineAlign
    else el.dataset.engineAlign = align
    l.appendChild(el)
    const rec: AnchorRecord = { el, worldX, worldY, visible: true }
    anchors.push(rec)
    writeAnchorVars(rec)
    return {
      set(x, y) {
        rec.worldX = x
        rec.worldY = y
        writeAnchorVars(rec)
      },
      remove() {
        const i = anchors.indexOf(rec)
        if (i >= 0) anchors.splice(i, 1)
        rec.el.remove()
      },
    }
  }

  function anchorSlot(el: HTMLElement, slot: number): SlotAnchorHandle {
    const l = ensureLayer()
    el.classList.add(ANCHOR_CLASS)
    l.appendChild(el)
    const rec: SlotAnchorRecord = { el, slot, worldX: 0, worldY: 0, visible: true, hasValue: false }
    slotAnchors.push(rec)
    updateSlotAnchor(rec)
    return {
      remove() {
        const i = slotAnchors.indexOf(rec)
        if (i >= 0) slotAnchors.splice(i, 1)
        rec.el.remove()
      },
    }
  }

  function updateVisibility(): void {
    const z = lastZ
    for (let i = 0; i < anchors.length; i++) {
      const rec = anchors[i] as AnchorRecord
      const { wx, wy } = rebaseOffset(rec.worldX, rec.worldY, originX, originY)
      const sx = lastOriginScreenX + wx * z
      const sy = lastOriginScreenY + wy * z
      const visible =
        sx >= -VISIBILITY_MARGIN_PX &&
        sx <= deps.viewport.widthPx + VISIBILITY_MARGIN_PX &&
        sy >= -VISIBILITY_MARGIN_PX &&
        sy <= deps.viewport.heightPx + VISIBILITY_MARGIN_PX
      if (visible !== rec.visible) {
        rec.el.style.visibility = visible ? 'visible' : 'hidden'
        rec.visible = visible
        writeCount++
      }
    }
    for (let i = 0; i < slotAnchors.length; i++) {
      const rec = slotAnchors[i] as SlotAnchorRecord
      if (!rec.hasValue) continue
      const { wx, wy } = rebaseOffset(rec.worldX, rec.worldY, originX, originY)
      const sx = lastOriginScreenX + wx * z
      const sy = lastOriginScreenY + wy * z
      const visible =
        sx >= -VISIBILITY_MARGIN_PX &&
        sx <= deps.viewport.widthPx + VISIBILITY_MARGIN_PX &&
        sy >= -VISIBILITY_MARGIN_PX &&
        sy <= deps.viewport.heightPx + VISIBILITY_MARGIN_PX
      if (visible !== rec.visible) {
        rec.el.style.visibility = visible ? 'visible' : 'hidden'
        rec.visible = visible
        writeCount++
      }
    }
  }

  /** Steps 4-6: one slot's own per-frame refresh -- reads the *acquired* slot's header (never a new
   * `TripleReader`), and rewrites `--wx`/`--wy` only when the slot's mask bit is set and the decoded
   * world position actually changed (0019 §5's own "rewrite ... only for slots whose value
   * changed"). */
  function updateSlotAnchor(rec: SlotAnchorRecord): void {
    const header = deps.drawListSlot.header
    if (!anchorMaskBit(header, rec.slot)) return // no publish this frame: frozen, not hidden
    const off = OFF_ANCHORS + rec.slot * 8
    const relX = header.getFloat32(off, true)
    const relY = header.getFloat32(off + 4, true)
    const worldX = deps.drawListSlot.windowOriginX + relX
    const worldY = deps.drawListSlot.windowOriginY + relY
    if (rec.hasValue && worldX === rec.worldX && worldY === rec.worldY) return
    rec.worldX = worldX
    rec.worldY = worldY
    rec.hasValue = true
    writeSlotAnchorVars(rec)
  }

  function update(): void {
    if (!layer) return
    worldToScreen(deps.cameraState, deps.viewport, originX, originY, screenPoint)
    if (needsRebase(screenPoint.x, screenPoint.y)) {
      rebase()
      worldToScreen(deps.cameraState, deps.viewport, originX, originY, screenPoint)
    }
    if (screenPoint.x !== lastOriginScreenX || screenPoint.y !== lastOriginScreenY) {
      layer.style.transform = `translate(${screenPoint.x}px, ${screenPoint.y}px)`
      lastOriginScreenX = screenPoint.x
      lastOriginScreenY = screenPoint.y
      writeCount++
    }
    const z = pxPerTile(deps.cameraState, deps.viewport)
    if (z !== lastZ) {
      layer.style.setProperty('--z', String(z))
      lastZ = z
      writeCount++
    }
    for (let i = 0; i < slotAnchors.length; i++) {
      updateSlotAnchor(slotAnchors[i] as SlotAnchorRecord)
    }
    updateVisibility()
  }

  return {
    anchor,
    anchorSlot,
    update,
    styleWrites() {
      return writeCount
    },
    dispose() {
      layer?.remove()
      layer = undefined
      anchors.length = 0
      slotAnchors.length = 0
    },
  }
}
