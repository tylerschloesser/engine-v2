// DrawList renderer (docs/decisions/0018-renderer.md §2, §4 "Shapes need no art"; docs/plan/
// 17-drawlist-and-sprites.md Scope, steps 4-6): `acquire()` the newest `drawList` triple-buffer slot,
// one `queue.writeBuffer(instanceBuf, 0, slotView, 0, usedBytes)`, then one instanced `draw(6, n, 0,
// first)` per non-empty layer through the uber-quad pipeline (`wgsl/uberquad.wgsl`) -- every kind
// except sprite (M17b). Terrain and drawables share one render pass (Planning decisions "Final
// main-thread bytes per frame"): `attachDrawables` wires this renderer's own `encodeInto` into
// `render/terrain.ts`'s `onEncode` hook, so production issues one encoder/pass/commandBuffer for
// both, and `TerrainRenderer.draw()`'s own `drawCalls()` counts every GPU draw call, terrain's
// triangle included. `draw()`/`acquireFromBytes()` below are the standalone path (`renderTo` against
// this renderer alone, no terrain): a probe test builds a header+body byte scene by hand (the same
// "hand-fill the renderer directly" precedent `render/terrain.ts`'s `writePageChunk` etc. set, M09)
// instead of driving a real client/worker.
import { DRAWLIST_BODY_BYTES, DRAWLIST_HEADER_BYTES } from '../sab/layout.js'
import { BLOCK_BYTES, TripleReader } from '../sab/triple.js'
import type { TerrainRenderer } from './terrain.js'
import { UBERQUAD_WGSL } from './wgsl.generated.js'

/** 0018 §2: "Capacity: 65,536 records (2 MiB)" -- matches `client/drawlist.rs`'s own `CAPACITY`. */
export const CAPACITY = 65_536
/** Matches `client::drawlist::DRAW_BYTES`. */
export const DRAW_BYTES = 32
export const LAYER_COUNT = 8
const INSTANCE_BUFFER_BYTES = CAPACITY * DRAW_BYTES

// Header field offsets (`client/drawlist.rs`'s own `OFF_*`; Planning decisions "Slot header is
// 1,024 bytes"): the four this renderer reads. `frame_seq`/`dropped`/`frame_time_ms` are read too
// (`drawListDropped()`), everything else (follow/anchors, M18/M19) is untouched here.
const OFF_FRAME_SEQ = 0
const OFF_RECORD_COUNT = 4
const OFF_WINDOW_ORIGIN = 8
const OFF_LAYER_COUNT = 16
const OFF_DROPPED = 88

/** One 32-byte `Draw` record's vertex-buffer layout (0018 §2), covering every byte except `pick_id`
 * (bytes 28..32, never bound -- 0018 §2, Scope: "the vertex buffer layout binds every `Draw` field
 * except `pick_id`"): `pos`/`size` as plain floats, `kind_sprite`+`layer`+`flags` packed into one
 * `uint32` (unpacked in `uberquad.wgsl`'s `vs_main`), `color` as `unorm8x4` (byte order `[r, g, b,
 * a]`, the same order `Draw::color`'s bytes are written in -- see `packDrawColor` below -- so this
 * format needs no shader-side swizzle), `param` as a plain float. Exported (Scope: "a module
 * constant ... so a test can read it") -- `uberquad.vertex_layout_has_no_pick_id` (Tests added)
 * reads it directly. */
export const UBERQUAD_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: DRAW_BYTES,
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' }, // pos
    { shaderLocation: 1, offset: 8, format: 'float32x2' }, // size
    { shaderLocation: 2, offset: 16, format: 'uint32' }, // kind_sprite | layer<<16 | flags<<24
    { shaderLocation: 3, offset: 20, format: 'unorm8x4' }, // color, bytes [r, g, b, a]
    { shaderLocation: 4, offset: 24, format: 'float32' }, // param
  ],
}

/** `Draw::color`'s own byte order (steps 4-6 Deviations: fixed by this cut, since 0018 §2 says only
 * "rgba8"): byte 0 = r, byte 1 = g, byte 2 = b, byte 3 = a -- the same order `UBERQUAD_VERTEX_LAYOUT`
 * reads a `unorm8x4` attribute in, so the shader needs no swizzle. `r`/`g`/`b`/`a` each `0..255`. */
export function packDrawColor(r: number, g: number, b: number, a: number): number {
  return (r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16) | ((a & 0xff) << 24)
}

/** `Draw::kind_sprite`'s own packing (0018 §2) plus `layer`/`flags`, as the one `uint32` vertex
 * attribute at offset 16 reads them (module doc comment). */
export function packDrawKindLayerFlags(
  kind: number,
  spriteId: number,
  layer: number,
  flags: number,
): number {
  const kindSprite = ((kind & 0xf) << 12) | (spriteId & 0x0fff)
  return (kindSprite & 0xffff) | ((layer & 0xff) << 16) | ((flags & 0xff) << 24)
}

export const KIND_SPRITE = 0
export const KIND_CIRCLE = 1
export const KIND_RING = 2
export const KIND_RECT = 3
export const KIND_BAR = 4
export const KIND_RADIAL = 5
export const KIND_GHOST = 6

export const ANCHOR_CURSOR_TILE = 1 << 0
export const SCREEN_PX_STROKE = 1 << 1
export const PREDICTED = 1 << 2
export const FLIP_X = 1 << 3

/** `uberquad.wgsl`'s own `STROKE_PX` constant (`SCREEN_PX_STROKE`'s fixed on-screen ring-band
 * width, device pixels): duplicated here, like `DRAW_BYTES`/`CAPACITY` mirror `client/drawlist.rs`'s
 * own constants, so a test can assert the exact value without parsing WGSL text. */
export const SCREEN_PX_STROKE_WIDTH = 6

/** The DrawFrame uniform `uberquad.wgsl` reads (48 bytes, module doc comment there): everything the
 * vertex shader needs to place an instance relative to the live camera -- `cam_tile`/`cam_frac`
 * (0018 §5, the same pair `terrain.wgsl`'s `FrameUniform` carries), `window_origin` (this DrawList
 * publish's own anchor, `DrawList::sort_into`'s header field), `cursor_tile`/`cursor_valid`
 * (`ANCHOR_CURSOR_TILE`, resolved here rather than by the DrawList producer, Planning decisions),
 * `viewport_px` (device pixels, `render/viewport.ts`'s own `renderer.viewport`) and `tiles_per_px`
 * (`1 / pxPerTile`, `camera/transform.ts`'s own scalar). A separate uniform buffer from terrain's
 * own `FrameUniform` (Files touched lists neither `render/terrain.ts`'s bind group nor `wgsl/
 * terrain.wgsl` as touched by this milestone): every page that drives both renderers writes the
 * overlapping fields (`camTileX/Y`, `camFracX/Y`, `viewportPxW/H`, `tilesPerPx`) into each renderer's
 * own uniform once per frame, the same "each page owns wiring its renderer(s) from the live camera"
 * shape `terrain.ts`'s own test pages already use (no engine-owned camera-to-uniform bridge exists
 * yet for either renderer). */
export type DrawFrameUniformValues = {
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
}

const DRAW_FRAME_UNIFORM_BYTES = 48
const DFU_CAM_TILE_X = 0
const DFU_CAM_TILE_Y = 4
const DFU_CAM_FRAC_X = 8
const DFU_CAM_FRAC_Y = 12
const DFU_WINDOW_ORIGIN_X = 16
const DFU_WINDOW_ORIGIN_Y = 20
const DFU_CURSOR_TILE_X = 24
const DFU_CURSOR_TILE_Y = 28
const DFU_VIEWPORT_PX_W = 32
const DFU_VIEWPORT_PX_H = 36
const DFU_TILES_PER_PX = 40
const DFU_CURSOR_VALID = 44

export interface DrawablesRenderer {
  readonly device: GPUDevice
  /** Writes the whole DrawFrame uniform (module doc comment); called once per frame before `draw`/
   * `encodeInto` in production, any time in a test. */
  writeFrameUniform(v: DrawFrameUniformValues): void
  /** Production `acquire()`: pulls the newest `drawList` triple-buffer slot (`TripleReader`, built
   * once at `createDrawablesRenderer` from `drawListSab`) and does the one `writeBuffer` (Scope).
   * A no-op when `drawListSab` was not given (a renderer built for a probe scene that only ever
   * calls `acquireFromBytes`, mirroring `worker/client-drawlist.ts`'s "no region, no publish"
   * shape). */
  acquire(): void
  /** The shared core `acquire()` calls, and a probe test calls directly with a hand-built header +
   * body (no SAB, no client, no worker -- `render/terrain.ts`'s own `writePageChunk`-style test
   * hand-fill precedent). `header.length === DRAWLIST_HEADER_BYTES`(the whole slot header, though
   * only `record_count`/`window_origin`/`layer_count` are read); `body` is read for exactly
   * `record_count * 32` bytes starting at 0. */
  acquireFromBytes(header: Uint8Array, body: Uint8Array): void
  /** Standalone draw (own encoder/pass/submit): one instanced draw per non-empty layer, in the same
   * shape `TerrainRenderer.draw()` uses -- lets `renderTo(drawablesRenderer, opts)` (`test/render.ts`
   * `Renderable` overload) drive a probe scene with no terrain in the picture. */
  draw(target: GPUTexture | GPUTextureView): void
  /** The shared-pass path (`attachDrawables`, below): encodes the same per-layer draws into a
   * caller-owned pass (terrain's own, mid-frame) instead of creating one; returns how many GPU
   * `draw()` calls it issued (0..8), which the caller (`TerrainRenderer.draw()`) adds to its own
   * `drawCalls()` total. */
  encodeInto(pass: GPURenderPassEncoder): number
  /** `engine/test`'s `drawCalls` counter, this renderer's own tally: every GPU `draw()` call issued
   * by *this* renderer since creation, through either `draw()` or `encodeInto()` -- independent of
   * (smaller than, once terrain is attached) `TerrainRenderer.drawCalls()`'s combined total. */
  drawCalls(): number
  /** `engine/test`'s `instanceBytes` counter: cumulative bytes copied by every `writeBuffer` call
   * inside `acquire()`/`acquireFromBytes()` since creation. */
  instanceBytes(): number
  /** `engine/test`'s `pipelineSwitches` counter: cumulative `pass.setPipeline(uberquadPipeline)`
   * calls since creation -- one per `draw()`/`encodeInto()` call that issues at least one layer draw
   * (a pass with zero non-empty layers sets no pipeline at all: nothing to draw). */
  pipelineSwitches(): number
  /** `engine/test`'s `drawListDropped` counter: the last-acquired slot's own header `dropped`
   * field (`client/drawlist.rs`'s `DrawList::dropped()`, published every frame) -- not cumulative,
   * a plain pass-through of whatever the most recent `acquire()`/`acquireFromBytes()` read. */
  drawListDropped(): number
  /** Test-only (docs/plan/17-drawlist-and-sprites.md Tests added: `drawlist.triple_newest_wins`):
   * the last-acquired slot's own header `frame_seq` field, read through this renderer's own
   * `TripleReader` -- never build a second, independent `TripleReader` over the same `drawList` SAB
   * to check this (`sab/triple.ts`'s own `acquire()` mutates shared triple-buffer state on every
   * call, so two readers racing each other tear the "current front slot" handoff). */
  frameSeq(): number
  /** Test-only: the last-acquired slot's own header `record_count` field. */
  recordCount(): number
  /** Test-only (docs/plan/17-drawlist-and-sprites.md Tests added: `counters.draws_equal_nonempty_
   * layers`): how many of the last-acquired slot's 8 `layer_count` entries are non-zero -- a plain
   * count, not the array itself, so a caller never allocates to ask "how many draws should this
   * frame have issued". */
  nonEmptyLayerCount(): number
}

function isTextureView(t: GPUTexture | GPUTextureView): t is GPUTextureView {
  return typeof (t as GPUTexture).createView !== 'function'
}

export async function createDrawablesRenderer(
  device: GPUDevice,
  opts: {
    colorFormat: GPUTextureFormat
    /** `drawList` triple-buffer SAB (production); omit for a renderer only ever driven through
     * `acquireFromBytes` (a probe scene). */
    drawListSab?: SharedArrayBuffer
    checkCompilation(label: string, module: GPUShaderModule): Promise<void>
  },
): Promise<DrawablesRenderer> {
  const uniformBuffer = device.createBuffer({
    size: DRAW_FRAME_UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const instanceBuffer = device.createBuffer({
    size: INSTANCE_BUFFER_BYTES,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })

  const bindGroupLayout = device.createBindGroupLayout({
    label: 'uberquad',
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
  })
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  })
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] })
  const shaderModule = device.createShaderModule({ code: UBERQUAD_WGSL, label: 'uberquad' })
  await opts.checkCompilation('uberquad', shaderModule)
  const pipeline = device.createRenderPipeline({
    label: 'uberquad',
    layout: pipelineLayout,
    vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [UBERQUAD_VERTEX_LAYOUT] },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [
        {
          format: opts.colorFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  })

  const reader = opts.drawListSab
    ? new TripleReader(opts.drawListSab, DRAWLIST_HEADER_BYTES, DRAWLIST_BODY_BYTES)
    : undefined
  // Built once (`.claude/rules/hot-paths.md`): one `DataView` per triple-buffer slot, over the
  // `TripleReader`'s own fixed header view, reused every `acquire()`.
  const headerViewsBySlot: DataView[] = reader
    ? [0, 1, 2].map((slot) => {
        const h = reader.headerView(slot)
        return new DataView(h.buffer, h.byteOffset, h.byteLength)
      })
    : []

  const uniformScratch = new ArrayBuffer(DRAW_FRAME_UNIFORM_BYTES)
  const uniformView = new DataView(uniformScratch)

  const layerCounts = new Uint32Array(LAYER_COUNT)
  const layerFirst = new Uint32Array(LAYER_COUNT)
  let lastDropped = 0
  let lastFrameSeq = 0
  let lastRecordCount = 0
  let drawCallCount = 0
  let instanceByteTotal = 0
  let pipelineSwitchCount = 0

  // Standalone `draw()` path only (module doc comment): `encodeInto` never touches this -- it draws
  // into a caller-owned pass (terrain's own, already cleared) instead. `renderTo(renderer, opts)`
  // (`test/render.ts`) hands `draw()` a fresh target texture every call, so a plain unconditional
  // `clear` (transparent) is correct every time, not just the first.
  const colorAttachment: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    loadOp: 'clear',
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
    storeOp: 'store',
  }
  const passDescriptor: GPURenderPassDescriptor = { colorAttachments: [colorAttachment] }
  const submitList: GPUCommandBuffer[] = [undefined as unknown as GPUCommandBuffer]

  function computeLayerOffsets(header: DataView): number {
    let acc = 0
    for (let i = 0; i < LAYER_COUNT; i++) {
      const c = header.getUint32(OFF_LAYER_COUNT + i * 4, true)
      layerCounts[i] = c
      layerFirst[i] = acc
      acc += c
    }
    return header.getUint32(OFF_RECORD_COUNT, true)
  }

  function acquireCore(header: DataView, body: Uint8Array, recordCount: number): void {
    const bytes = recordCount * DRAW_BYTES
    lastDropped = header.getUint32(OFF_DROPPED, true)
    lastFrameSeq = header.getUint32(OFF_FRAME_SEQ, true)
    lastRecordCount = recordCount
    void header.getInt32(OFF_WINDOW_ORIGIN, true) // read for parity with the header shape; unused
    // here (the DrawFrame uniform's own `windowOriginX/Y` is written by the caller, not derived
    // from this header -- `window_origin` changes only when the DrawList is republished, and a
    // caller that wants it live reads `windowOriginX/Y` off wherever it already tracks the camera).
    if (bytes > 0) {
      device.queue.writeBuffer(instanceBuffer, 0, body, 0, bytes)
      instanceByteTotal += bytes
    }
  }

  function encodeDraws(pass: GPURenderPassEncoder): number {
    let anyNonEmpty = false
    for (let i = 0; i < LAYER_COUNT; i++) {
      if ((layerCounts[i] as number) > 0) {
        anyNonEmpty = true
        break
      }
    }
    if (!anyNonEmpty) return 0
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.setVertexBuffer(0, instanceBuffer)
    pipelineSwitchCount++
    let calls = 0
    for (let i = 0; i < LAYER_COUNT; i++) {
      const count = layerCounts[i] as number
      if (count === 0) continue
      pass.draw(6, count, 0, layerFirst[i] as number)
      calls++
    }
    return calls
  }

  return {
    device,

    writeFrameUniform(v) {
      uniformView.setInt32(DFU_CAM_TILE_X, v.camTileX, true)
      uniformView.setInt32(DFU_CAM_TILE_Y, v.camTileY, true)
      uniformView.setFloat32(DFU_CAM_FRAC_X, v.camFracX, true)
      uniformView.setFloat32(DFU_CAM_FRAC_Y, v.camFracY, true)
      uniformView.setInt32(DFU_WINDOW_ORIGIN_X, v.windowOriginX, true)
      uniformView.setInt32(DFU_WINDOW_ORIGIN_Y, v.windowOriginY, true)
      uniformView.setInt32(DFU_CURSOR_TILE_X, v.cursorTileX, true)
      uniformView.setInt32(DFU_CURSOR_TILE_Y, v.cursorTileY, true)
      uniformView.setFloat32(DFU_VIEWPORT_PX_W, v.viewportPxW, true)
      uniformView.setFloat32(DFU_VIEWPORT_PX_H, v.viewportPxH, true)
      uniformView.setFloat32(DFU_TILES_PER_PX, v.tilesPerPx, true)
      uniformView.setUint32(DFU_CURSOR_VALID, v.cursorValid, true)
      device.queue.writeBuffer(uniformBuffer, 0, uniformScratch)
    },

    acquire() {
      if (!reader) return
      const slot = reader.acquire()
      const header = headerViewsBySlot[slot] as DataView
      const recordCount = computeLayerOffsets(header)
      acquireCore(header, reader.bodyView(slot), recordCount)
    },

    acquireFromBytes(header, body) {
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
      const recordCount = computeLayerOffsets(view)
      acquireCore(view, body, recordCount)
    },

    draw(target) {
      colorAttachment.view = isTextureView(target) ? target : target.createView()
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass(passDescriptor)
      const calls = encodeDraws(pass)
      pass.end()
      submitList[0] = encoder.finish()
      device.queue.submit(submitList)
      drawCallCount += calls
    },

    encodeInto(pass) {
      const calls = encodeDraws(pass)
      drawCallCount += calls
      return calls
    },

    drawCalls() {
      return drawCallCount
    },

    instanceBytes() {
      return instanceByteTotal
    },

    pipelineSwitches() {
      return pipelineSwitchCount
    },

    drawListDropped() {
      return lastDropped
    },

    frameSeq() {
      return lastFrameSeq
    },

    recordCount() {
      return lastRecordCount
    },

    nonEmptyLayerCount() {
      let n = 0
      for (let i = 0; i < LAYER_COUNT; i++) if ((layerCounts[i] as number) > 0) n++
      return n
    },
  }
}

/** Wires `drawables.encodeInto` into `terrain.onEncode` (module doc comment: "terrain and drawables
 * share one render pass"). Call once, after both renderers exist. */
export function attachDrawables(terrain: TerrainRenderer, drawables: DrawablesRenderer): void {
  terrain.onEncode((pass) => drawables.encodeInto(pass))
}

// Re-exported so a caller that only imports `render/drawables.ts` never needs `sab/triple.ts`
// directly to reason about `usedBytes`/block counts the way `worker/client-drawlist.ts` does.
export { BLOCK_BYTES }
