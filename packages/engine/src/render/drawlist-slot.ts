// The frame's one acquired DrawList slot (docs/plan/18-picking-and-overlay.md Scope, step 1: "a new
// first phase `acquire` (take the newest DrawList slot once per rAF; camera, picking, overlay and
// render all read that same slot)"). `createDrawListSlot` builds three long-lived typed views (one
// `DataView` header + one `Uint8Array`/`DataView` body pair per triple-buffer slot, `sab/triple.ts`'s
// own precedent, `render/drawables.ts`'s `headerViewsBySlot`): `acquire()` swaps which of the three
// the public fields below reference -- a plain reference reassignment, never a new object
// (`.claude/rules/hot-paths.md`) -- and copies the header's own scalar fields (`record_count`,
// `window_origin`, `frame_seq`, `dropped`) into reused fields on the same returned object, the same
// "reused, mutated in place" shape `CameraState`/`ClockSnapshot` already use.
//
// One `DrawListSlot` owns the *only* `TripleReader` over a given `drawList` SAB for the life of a
// `Client` (docs/plan/17-drawlist-and-sprites.md Deviations, "Two-reader torn read": `TripleReader.
// acquire()` mutates shared triple-buffer state on every call, so two independent readers racing it
// tear the handoff) -- `createClient` builds exactly one, in `src/client.ts`.
import { DRAWLIST_BODY_BYTES, DRAWLIST_HEADER_BYTES } from '../sab/layout.js'
import { TripleReader } from '../sab/triple.js'

// `client/drawlist.rs`'s own header layout (docs/plan/17-drawlist-and-sprites.md Deviations,
// "Header, as landed"; docs/plan/18-picking-and-overlay.md steps 4-6 add `follow_valid`/`follow`):
// the scalar fields this slot reads out. Duplicated here the same way `render/drawables.ts`'s own
// `OFF_*` constants mirror the Rust layout (that file's own precedent).
const OFF_FRAME_SEQ = 0
const OFF_RECORD_COUNT = 4
const OFF_WINDOW_ORIGIN = 8
const OFF_FOLLOW_VALID = 48
const OFF_FOLLOW = 56
const OFF_DROPPED = 88

export type DrawListSlot = {
  /** The acquired slot's header (1,024 B), one of three precomputed `DataView`s -- the reference
   * itself changes on `acquire()`, never a new view. */
  header: DataView
  /** The acquired slot's body (2 MiB) as bytes -- what `queue.writeBuffer` wants. */
  body: Uint8Array
  /** The same body bytes, as a `DataView` -- what `input/pick.ts`'s scan wants (`getUint32`/
   * `getFloat32` over `Draw` fields). */
  bodyView: DataView
  /** `header`'s own `record_count`, copied out for convenience. */
  recordCount: number
  /** `header`'s own `window_origin` (tiles): every `Draw.pos` in `body` is relative to this. */
  windowOriginX: number
  windowOriginY: number
  /** `header`'s own `frame_seq`: changes only when a new publish was actually acquired (a cheap
   * "did the picture change" key, `input/pick.ts`'s own scan cache uses it). */
  frameSeq: number
  /** `header`'s own `dropped` counter. */
  dropped: number
  /** docs/plan/18-picking-and-overlay.md steps 4-6: `header`'s own `follow_valid`/`follow` (0019
   * §1) -- absolute world tiles, the same unit `camera.setFollow(x, y, valid)` takes. `client.ts`'s
   * `camera.tick(dtMs)` reads these straight off the acquired slot before `integrate()` runs, so a
   * target set this frame centres this same frame. */
  followValid: boolean
  followX: number
  followY: number
  /** Whether this call's `acquire()` actually swapped in a new publish (`TripleReader.fresh`). */
  fresh: boolean
  /** Takes the newest published slot, once. Called at most once per rAF, from `frame-loop.ts`'s
   * `acquire` phase (or, on a page not built on `frame-loop.ts`, from whatever else drives one frame
   * at a time -- `Client.pick.acquire()` is the public seam either way). */
  acquire(): void
}

export function createDrawListSlot(sab: SharedArrayBuffer): DrawListSlot {
  const reader = new TripleReader(sab, DRAWLIST_HEADER_BYTES, DRAWLIST_BODY_BYTES)
  const headerViews: DataView[] = [0, 1, 2].map((slot) => {
    const h = reader.headerView(slot)
    return new DataView(h.buffer, h.byteOffset, h.byteLength)
  })
  const bodyViews: DataView[] = [0, 1, 2].map((slot) => {
    const b = reader.bodyView(slot)
    return new DataView(b.buffer, b.byteOffset, b.byteLength)
  })

  const slot: DrawListSlot = {
    header: headerViews[0] as DataView,
    body: reader.bodyView(0),
    bodyView: bodyViews[0] as DataView,
    recordCount: 0,
    windowOriginX: 0,
    windowOriginY: 0,
    frameSeq: 0,
    dropped: 0,
    followValid: false,
    followX: 0,
    followY: 0,
    fresh: false,
    acquire() {
      const s = reader.acquire()
      const header = headerViews[s] as DataView
      slot.header = header
      slot.body = reader.bodyView(s)
      slot.bodyView = bodyViews[s] as DataView
      slot.recordCount = header.getUint32(OFF_RECORD_COUNT, true)
      slot.windowOriginX = header.getInt32(OFF_WINDOW_ORIGIN, true)
      slot.windowOriginY = header.getInt32(OFF_WINDOW_ORIGIN + 4, true)
      slot.frameSeq = header.getUint32(OFF_FRAME_SEQ, true)
      slot.dropped = header.getUint32(OFF_DROPPED, true)
      slot.followValid = header.getUint32(OFF_FOLLOW_VALID, true) !== 0
      slot.followX = header.getFloat64(OFF_FOLLOW, true)
      slot.followY = header.getFloat64(OFF_FOLLOW + 8, true)
      slot.fresh = reader.fresh
    },
  }
  return slot
}
