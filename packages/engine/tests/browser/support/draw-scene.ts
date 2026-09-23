// Hand-builds a `RegionId::DrawList` slot's wire bytes (header + body) for a probe scene (docs/plan/
// 17-drawlist-and-sprites.md Tests added): the exact layout `client/drawlist.rs`'s `DrawList::
// sort_into` writes (Planning decisions "Slot header is 1,024 bytes"), assembled directly rather
// than through a real `Instance` -- no worker, no ABI, no sim (`draw.*.spec.ts`'s own scenes, plumbed
// through `window.__drawables.acquireFromBytes`). Records are expected pre-sorted by `layer`
// (ascending, stable) by the caller -- exactly what a real `DrawList::sort_into` output looks like,
// and what makes `layer_count`'s own per-layer counts fall out of a single pass here too.
import {
  DRAW_BYTES,
  LAYER_COUNT,
  packDrawColor,
  packDrawKindLayerFlags,
} from '../../../src/render/drawables.ts'

const HEADER_BYTES = 1024
const OFF_RECORD_COUNT = 4
const OFF_WINDOW_ORIGIN = 8
const OFF_LAYER_COUNT = 16
const OFF_DROPPED = 88

export type DrawRecordSpec = {
  pos: readonly [number, number]
  size: readonly [number, number]
  kind: number
  spriteId?: number
  layer: number
  flags?: number
  color: readonly [number, number, number, number]
  param?: number
}

/** Builds one slot's header + body bytes from `records`, stable-sorted here by ascending `layer`
 * (mirroring `client/drawlist.rs`'s own `sort_into`, so a caller can list records in whatever order
 * is clearest for the scene -- `Array.prototype.sort` is a stable sort per the ECMAScript spec, the
 * same guarantee the counting sort gives). Returns plain `number[]` (not `Uint8Array`): `window.
 * __drawables.acquireFromBytes`'s own args cross a `page.evaluate` boundary, which only accepts
 * JSON-serialisable values. */
export function buildDrawListBytes(
  records: readonly DrawRecordSpec[],
  windowOrigin: readonly [number, number] = [0, 0],
  dropped = 0,
): { header: number[]; body: number[] } {
  const sorted = records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.layer - b.r.layer || a.i - b.i)
    .map(({ r }) => r)

  const header = new Uint8Array(HEADER_BYTES)
  const hv = new DataView(header.buffer)
  hv.setUint32(OFF_RECORD_COUNT, sorted.length, true)
  hv.setInt32(OFF_WINDOW_ORIGIN, windowOrigin[0], true)
  hv.setInt32(OFF_WINDOW_ORIGIN + 4, windowOrigin[1], true)
  hv.setUint32(OFF_DROPPED, dropped, true)

  const layerCounts = new Uint32Array(LAYER_COUNT)
  for (const r of sorted) layerCounts[r.layer] = (layerCounts[r.layer] as number) + 1
  for (let i = 0; i < LAYER_COUNT; i++) {
    hv.setUint32(OFF_LAYER_COUNT + i * 4, layerCounts[i] as number, true)
  }

  const body = new Uint8Array(sorted.length * DRAW_BYTES)
  const bv = new DataView(body.buffer)
  sorted.forEach((r, i) => {
    const base = i * DRAW_BYTES
    bv.setFloat32(base + 0, r.pos[0], true)
    bv.setFloat32(base + 4, r.pos[1], true)
    bv.setFloat32(base + 8, r.size[0], true)
    bv.setFloat32(base + 12, r.size[1], true)
    const kindLayerFlags = packDrawKindLayerFlags(r.kind, r.spriteId ?? 0, r.layer, r.flags ?? 0)
    bv.setUint16(base + 16, kindLayerFlags & 0xffff, true)
    body[base + 18] = r.layer
    body[base + 19] = r.flags ?? 0
    bv.setUint32(
      base + 20,
      packDrawColor(r.color[0], r.color[1], r.color[2], r.color[3]) >>> 0,
      true,
    )
    bv.setFloat32(base + 24, r.param ?? 0, true)
    bv.setUint32(base + 28, 0, true) // pick_id
  })

  return { header: Array.from(header), body: Array.from(body) }
}

/** A `DrawFrameUniformValues`-shaped camera for a small render target where pixel index equals a
 * simple, hand-computable tile offset: `tilesPerPx` chosen by the caller, `camTile`/`camFrac` at the
 * origin by default so `world_rel` (`uberquad.wgsl`) reduces to a record's own `pos` directly. */
export function microDrawCamera(opts: {
  viewportPxW: number
  viewportPxH: number
  tilesPerPx: number
  camTileX?: number
  camTileY?: number
  camFracX?: number
  camFracY?: number
  windowOriginX?: number
  windowOriginY?: number
  cursorTileX?: number
  cursorTileY?: number
  cursorValid?: number
}): {
  camTileX: number
  camTileY: number
  camFracX: number
  camFracY: number
  windowOriginX: number
  windowOriginY: number
  cursorTileX: number
  cursorTileY: number
  viewportPxW: number
  viewportPxH: number
  tilesPerPx: number
  cursorValid: number
} {
  return {
    camTileX: opts.camTileX ?? 0,
    camTileY: opts.camTileY ?? 0,
    camFracX: opts.camFracX ?? 0,
    camFracY: opts.camFracY ?? 0,
    windowOriginX: opts.windowOriginX ?? 0,
    windowOriginY: opts.windowOriginY ?? 0,
    cursorTileX: opts.cursorTileX ?? 0,
    cursorTileY: opts.cursorTileY ?? 0,
    viewportPxW: opts.viewportPxW,
    viewportPxH: opts.viewportPxH,
    tilesPerPx: opts.tilesPerPx,
    cursorValid: opts.cursorValid ?? 0,
  }
}
