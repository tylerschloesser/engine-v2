// Terrain renderer (docs/decisions/0018-renderer.md §3, §5; docs/plan/09-renderer-terrain.md Scope,
// Planning decisions "Bind group layout"): page texture, indirection texture, visual-table uniform,
// tile-art array texture, frame uniform, one pipeline, one draw. Everything a frame touches is
// created once and reused (`.claude/rules/hot-paths.md`): the write-side "hand-fill" methods below
// (`writePageChunk`, `writeIndir`, ...) are the one exception -- test-only setup and, from M09's
// step 5, the ring-drain call sites in `render/upload.ts`, neither of which runs inside this
// milestone's zero-GC measured window (that page lands in step 7).
// `VISUAL_TABLE_BYTES` is owned by `render/art.ts` (Deviations: it lays the table's bytes out, and
// step 3 precedes step 4 in the Order of work); re-exported here so a caller of this module never
// needs to know that.
import { VISUAL_TABLE_BYTES, VISUAL_TABLE_ENTRIES } from './art.js'
import { TERRAIN_WGSL } from './wgsl.generated.js'

export { VISUAL_TABLE_BYTES, VISUAL_TABLE_ENTRIES }

/** 1024x1024 `rg16uint` = 1,024 slots of 32x32 (0018 §3): the cache slot *is* the page slot. */
export const PAGE_TEXTURE_EDGE = 1024
export const CHUNK_EDGE = 32
export const SLOTS_PER_ROW = PAGE_TEXTURE_EDGE / CHUNK_EDGE // 32
/** 64x64 `r16uint`, toroidal (0018 §3), independent of chunk size. */
export const INDIR_TEXTURE_EDGE = 64
export const FRAME_UNIFORM_BYTES = 48
/** Sentinel `value` in the indirection texture: no chunk resident at that toroidal cell (matches
 * `client::upload::INDIR_NONE`, `crates/engine/src/client/upload.rs`). */
export const INDIR_NONE = 0xffff

/** Byte-offset layout of `FrameUniform` in `terrain.wgsl` (Planning decisions "Bind group layout").
 * Written here once, matched against WGSL by `terrain.probe_tile_colours` (a wrong offset shows up
 * as a wrong pixel, not a compile error). */
const FU_CAM_TILE_X = 0
const FU_CAM_TILE_Y = 4
const FU_CAM_FRAC_X = 8
const FU_CAM_FRAC_Y = 12
const FU_VIEWPORT_W = 16
const FU_VIEWPORT_H = 20
const FU_TILES_PER_PX = 24
const FU_SEED = 28
const FU_CURSOR_TILE_X = 32
const FU_CURSOR_TILE_Y = 36
const FU_CURSOR_VALID = 40
const FU_NEIGHBOUR_CUTOFF_PX = 44

export type FrameUniformValues = {
  camTileX: number
  camTileY: number
  camFracX: number
  camFracY: number
  viewportPxW: number
  viewportPxH: number
  tilesPerPx: number
  seed: number
  cursorTileX: number
  cursorTileY: number
  cursorValid: number
  neighbourCutoffPx: number
}

export type IndirEntry = { x: number; y: number; value: number }
/** Base/resource visual ids for one tile (mirrors `client::texel::TileTexel`). */
export type Texel = { base: number; resource: number }

export interface TerrainRenderer {
  readonly device: GPUDevice
  /** Writes the whole `FrameUniform` (0018 §5's camera-relative fields); called once per frame
   * before `draw` in production, any time in a test. */
  writeFrameUniform(v: FrameUniformValues): void
  /** Replaces the whole 16 KiB visual table (`bytes.length === VISUAL_TABLE_BYTES`): built by
   * `render/art.ts` from `tiles.json`, main-thread-only (Planning decisions "Visual table comes from
   * tiles.json on main"). */
  writeVisualTable(bytes: Uint8Array): void
  /** Test/step-5 hand-fill: `texels.length === CHUNK_EDGE * CHUNK_EDGE`, row-major, for page slot
   * `slot` (0018 §3's one `writeTexture` per chunk). Not a per-frame path. */
  writePageChunk(slot: number, texels: readonly Texel[]): void
  /** `render/upload.ts`'s own fast path (Planning decisions "`writeTexture` from a SAB view is
   * unverified"): `le16` is already exactly the wire layout (`[base0, resource0, base1, ...]`,
   * length `CHUNK_EDGE * CHUNK_EDGE * 2`) -- a CHUNK record's payload bytes reinterpreted as
   * `Uint16Array`, whether that view is backed by a `SharedArrayBuffer` (the probe passed) or a
   * preallocated non-shared staging copy (it didn't). No `Texel[]` conversion, unlike
   * `writePageChunk`. */
  writePageChunkBytes(slot: number, le16: Uint16Array): void
  /** Test/step-5 hand-fill: one page texel at `slot`'s local `index` (row-major within the chunk). */
  writePageTexel(slot: number, index: number, texel: Texel): void
  /** Test/step-5 hand-fill: indirection entries (toroidal `x`/`y` in `[0, 64)`, `value` a page slot
   * or `INDIR_NONE`). `count` (default `entries.length`) lets `render/upload.ts`'s real drain pass
   * a fixed-size, reused scratch array and only the first `count` entries of it are written --
   * `.claude/rules/hot-paths.md` forbids a fresh per-record array there. */
  writeIndir(entries: readonly IndirEntry[], count?: number): void
  /** Installs the tile-art array texture `render/art.ts` builds from `tiles.json`; rebuilds the bind
   * group (a one-time/init cost: WebGPU bind groups are immutable once created). */
  setTileArray(texture: GPUTexture): void
  /** Encodes and submits one frame: the reused colour-attachment/pass-descriptor objects, one
   * `draw(3, 1, 0, 0)`. `target` may be a `GPUTexture` (skips `createView()` when `viewProbePasses`)
   * or an explicit `GPUTextureView`. */
  draw(target: GPUTexture | GPUTextureView): void
  /** Count of `draw()` calls since creation (`engine/test`'s `drawCalls` counter, Seams). */
  drawCalls(): number
  /** Count of distinct page slots written by `writePageChunk`/`writePageTexel` since creation
   * (`engine/test`'s `pageSlotsUsed` counter, Seams). */
  pageSlotsUsed(): number
  /** Mutated in place by whoever owns the camera each frame (M11 writes `camTile*`/`camFrac*`/
   * `tilesPerPx`, M17 writes the cursor fields); `frame-loop.ts`'s own "render" phase just calls
   * `writeFrameUniform(frameUniform)` with whatever is currently set (Seams, Provides). Not written
   * by this milestone's own code outside its constructor defaults -- M09's tests still call
   * `writeFrameUniform` directly with their own values. */
  readonly frameUniform: FrameUniformValues
  /** Mutated in place by M09b's resize observer and M11's camera (Seams, Provides); not read by
   * anything in this milestone. */
  readonly viewport: { widthPx: number; heightPx: number; dpr: number; renderScale: number }
}

const TEXEL_BYTES = 4 // rg16uint: 2 x u16

function placeholderTileArray(device: GPUDevice): GPUTexture {
  const texture = device.createTexture({
    size: [1, 1, 1],
    format: 'rgba8unorm',
    dimension: '2d',
    usage: GPUTextureUsage.TEXTURE_BINDING,
    // Compatibility mode (0018 §7: "each texture bound with one view dimension"): a texture's
    // *bindable* view dimension must be declared at creation and match every view of it used in a
    // bind group -- found by `device: view probe both paths`'s own `uncapturederror` (docs/plan/
    // 09-renderer-terrain.md Deviations), since `buildBindGroup` always views this as `2d-array`.
    textureBindingViewDimension: '2d-array',
  })
  return texture
}

export function createTerrainRenderer(
  device: GPUDevice,
  opts: { colorFormat: GPUTextureFormat; viewProbePasses: boolean },
): TerrainRenderer {
  const pageTexture = device.createTexture({
    size: [PAGE_TEXTURE_EDGE, PAGE_TEXTURE_EDGE],
    format: 'rg16uint',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const indirTexture = device.createTexture({
    size: [INDIR_TEXTURE_EDGE, INDIR_TEXTURE_EDGE],
    format: 'r16uint',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  // WebGPU zero-initialises new textures, but `0` is slot 0 here, not "none" -- every toroidal cell
  // must read `INDIR_NONE` until something is actually resident there (`terrain.nonresident_is_neutral`).
  // The actual `writeTexture` call for this is below, once `indirMirror`/`indirDest` exist (Open
  // gate failures item 1): it is the same "write the whole mirror" call `writeIndir` makes, run once
  // here with every cell still at its initial `INDIR_NONE`, so the one-time init path and the hot
  // path share one `writeTexture` call site instead of two.
  const visualTableBuffer = device.createBuffer({
    size: VISUAL_TABLE_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const frameUniformBuffer = device.createBuffer({
    size: FRAME_UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const sampler = device.createSampler({
    magFilter: 'nearest',
    minFilter: 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  })

  // An explicit layout, not `'auto'`: `art_sampler` (binding 5) is declared but unused by this
  // milestone's shader (`textureLoad` only, Scope: "no dithering" yet), and `'auto'` derives a bind
  // group layout only from bindings a pipeline's shader stages *statically reference* -- an
  // omitted, unreferenced binding would make `buildBindGroup`'s entry for it invalid. The Planning
  // decisions' bind group layout is fixed across M09 and M09b for exactly this reason (M09b starts
  // sampling `art_sampler` without changing the layout).
  const bindGroupLayout = device.createBindGroupLayout({
    label: 'terrain',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'uint', viewDimension: '2d' },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'uint', viewDimension: '2d' },
      },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d-array' },
      },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  })
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] })

  const shaderModule = device.createShaderModule({ code: TERRAIN_WGSL, label: 'terrain' })
  const pipeline = device.createRenderPipeline({
    label: 'terrain',
    layout: pipelineLayout,
    vertex: { module: shaderModule, entryPoint: 'vs_main' },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{ format: opts.colorFormat }],
    },
    primitive: { topology: 'triangle-list' },
  })

  let tileArray = placeholderTileArray(device)
  let bindGroup = buildBindGroup()
  let drawCallCount = 0
  const usedSlots = new Set<number>()
  const frameUniform: FrameUniformValues = {
    camTileX: 0,
    camTileY: 0,
    camFracX: 0,
    camFracY: 0,
    viewportPxW: 0,
    viewportPxH: 0,
    tilesPerPx: 1,
    seed: 0,
    cursorTileX: 0,
    cursorTileY: 0,
    cursorValid: 0,
    neighbourCutoffPx: 0,
  }
  const viewport = { widthPx: 0, heightPx: 0, dpr: 1, renderScale: 1 }

  function buildBindGroup(): GPUBindGroup {
    return device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: frameUniformBuffer } },
        { binding: 1, resource: pageTexture.createView() },
        { binding: 2, resource: indirTexture.createView() },
        { binding: 3, resource: { buffer: visualTableBuffer } },
        { binding: 4, resource: tileArray.createView({ dimension: '2d-array' }) },
        { binding: 5, resource: sampler },
      ],
    })
  }

  // Reused every frame (`.claude/rules/hot-paths.md`): the spike's own pattern
  // (`spikes/zero-gc-webgpu/public/main.js`) of mutating one descriptor object in place.
  const colorAttachment: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    loadOp: 'clear',
    storeOp: 'store',
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
  }
  const passDescriptor: GPURenderPassDescriptor = { colorAttachments: [colorAttachment] }
  const submitList: GPUCommandBuffer[] = [undefined as unknown as GPUCommandBuffer]
  const frameScratch = new ArrayBuffer(FRAME_UNIFORM_BYTES)
  const frameView = new DataView(frameScratch)

  // Test/step-5 hand-fill scratch (not per-frame): one chunk's worth of texel bytes, one page texel.
  const chunkScratch = new Uint16Array(CHUNK_EDGE * CHUNK_EDGE * 2)
  const singleTexelScratch = new Uint16Array(2)

  // Open gate failures (orchestrator, gate round 1) item 1: every `writeTexture` descriptor below
  // is built once here and mutated in place (`.claude/rules/hot-paths.md`) instead of a fresh
  // `{ texture, origin }`/`{ bytesPerRow, ... }`/`{ width, height }` literal per call -- the old
  // `slotOrigin` helper (one more object per call) is gone, replaced by plain-number origin math
  // written straight into the reused descriptor's `origin` field.
  // Not annotated with `GPUTexelCopyTextureInfo` itself: that interface's `origin` field is
  // `GPUOrigin3D`, a union that also admits a plain iterable, so a variable declared at that type
  // loses the concrete `{ x, y }` shape `writeChunkTexture`/`writePageTexel` mutate in place below.
  // Left to inference, `chunkDest.origin` keeps its own literal type; structural typing still makes
  // `chunkDest` itself assignable wherever `GPUTexelCopyTextureInfo` is expected (`writeTexture`'s
  // own parameter).
  // None of these carry an explicit `GPU*` type annotation, matching this file's pre-existing style
  // for every other descriptor literal (`colorAttachment`, `passDescriptor`, below): the ambient
  // `@webgpu/types` unions (`GPUOrigin3D`, `GPUExtent3DStrict`, ...) are broader than any one
  // concrete shape, so annotating a *variable* at one of those types --- rather than leaving it to
  // ordinary structural inference from the literal, checked against the parameter type only at the
  // `writeTexture` call site --- both loses the concrete `{ x, y }` shape these mutate in place and,
  // empirically, made `tsc` pick the wrong branch of the union at the call site.
  const chunkDest = { texture: pageTexture, origin: { x: 0, y: 0 } }
  const chunkDataLayout = { bytesPerRow: CHUNK_EDGE * TEXEL_BYTES, rowsPerImage: CHUNK_EDGE }
  const chunkSize = { width: CHUNK_EDGE, height: CHUNK_EDGE }

  const texelDest = { texture: pageTexture, origin: { x: 0, y: 0 } }
  const texelDataLayout = { bytesPerRow: TEXEL_BYTES }
  const texelSize = { width: 1, height: 1 }

  // Indirection texture: batched, not per-entry (Open gate failures item 1 -- "say ... whether
  // entries are batched"). `indirMirror` is the authoritative CPU-side copy of every one of the
  // 64x64 toroidal cells (`INDIR_NONE` until something is resident there, the same invariant the
  // old per-entry zero-fill init kept); `writeIndir` mutates only the touched cells in place and
  // re-uploads the *whole* mirror in one `writeTexture` call. Chosen over "row runs" (entries in one
  // `INDIR` record are not generally contiguous: `Uploader::stage_indir` drains a `VecDeque` in
  // eviction/residency order, not raster order) and over doing nothing (up to 1,024 separate
  // `writeTexture` calls -- and as many queue "tasks" -- per record, 0016 §1's "+24 B per task").
  // One 8,192-byte transfer is far cheaper than one CHUNK record's own 4,096 bytes and turns an
  // O(entries) queue-call count into O(1) regardless of how many toroidal cells one record touches.
  const indirMirror = new Uint16Array(INDIR_TEXTURE_EDGE * INDIR_TEXTURE_EDGE).fill(INDIR_NONE)
  const indirDest = { texture: indirTexture, origin: { x: 0, y: 0 } }
  const indirDataLayout = { bytesPerRow: INDIR_TEXTURE_EDGE * 2, rowsPerImage: INDIR_TEXTURE_EDGE }
  const indirSize = { width: INDIR_TEXTURE_EDGE, height: INDIR_TEXTURE_EDGE }
  // One-time init (not a hot path): every toroidal cell starts at `INDIR_NONE`.
  device.queue.writeTexture(indirDest, indirMirror, indirDataLayout, indirSize)

  /** The one `writeTexture` call both `writePageChunk` (converts a `Texel[]` into `chunkScratch`
   * first) and `writePageChunkBytes` (already the right layout, no conversion) end in -- `u16`'s
   * length is `CHUNK_EDGE * CHUNK_EDGE * 2`, checked by each public caller. */
  function writeChunkTexture(slot: number, u16: Uint16Array): void {
    chunkDest.origin.x = (slot % SLOTS_PER_ROW) * CHUNK_EDGE
    chunkDest.origin.y = Math.floor(slot / SLOTS_PER_ROW) * CHUNK_EDGE
    device.queue.writeTexture(chunkDest, u16, chunkDataLayout, chunkSize)
    usedSlots.add(slot)
  }

  return {
    device,

    writeFrameUniform(v) {
      frameView.setInt32(FU_CAM_TILE_X, v.camTileX, true)
      frameView.setInt32(FU_CAM_TILE_Y, v.camTileY, true)
      frameView.setFloat32(FU_CAM_FRAC_X, v.camFracX, true)
      frameView.setFloat32(FU_CAM_FRAC_Y, v.camFracY, true)
      frameView.setFloat32(FU_VIEWPORT_W, v.viewportPxW, true)
      frameView.setFloat32(FU_VIEWPORT_H, v.viewportPxH, true)
      frameView.setFloat32(FU_TILES_PER_PX, v.tilesPerPx, true)
      frameView.setUint32(FU_SEED, v.seed, true)
      frameView.setInt32(FU_CURSOR_TILE_X, v.cursorTileX, true)
      frameView.setInt32(FU_CURSOR_TILE_Y, v.cursorTileY, true)
      frameView.setUint32(FU_CURSOR_VALID, v.cursorValid, true)
      frameView.setFloat32(FU_NEIGHBOUR_CUTOFF_PX, v.neighbourCutoffPx, true)
      device.queue.writeBuffer(frameUniformBuffer, 0, frameScratch)
    },

    writeVisualTable(bytes) {
      if (bytes.length !== VISUAL_TABLE_BYTES) {
        throw new RangeError(
          `writeVisualTable: expected ${VISUAL_TABLE_BYTES} bytes, got ${bytes.length}`,
        )
      }
      device.queue.writeBuffer(visualTableBuffer, 0, bytes)
    },

    writePageChunk(slot, texels) {
      if (texels.length !== CHUNK_EDGE * CHUNK_EDGE) {
        throw new RangeError(
          `writePageChunk: expected ${CHUNK_EDGE * CHUNK_EDGE} texels, got ${texels.length}`,
        )
      }
      for (let i = 0; i < texels.length; i++) {
        const t = texels[i] as Texel
        chunkScratch[i * 2] = t.base
        chunkScratch[i * 2 + 1] = t.resource
      }
      writeChunkTexture(slot, chunkScratch)
    },

    writePageChunkBytes(slot, le16) {
      if (le16.length !== CHUNK_EDGE * CHUNK_EDGE * 2) {
        throw new RangeError(
          `writePageChunkBytes: expected ${CHUNK_EDGE * CHUNK_EDGE * 2} u16s, got ${le16.length}`,
        )
      }
      writeChunkTexture(slot, le16)
    },

    writePageTexel(slot, index, texel) {
      singleTexelScratch[0] = texel.base
      singleTexelScratch[1] = texel.resource
      const originX = (slot % SLOTS_PER_ROW) * CHUNK_EDGE
      const originY = Math.floor(slot / SLOTS_PER_ROW) * CHUNK_EDGE
      texelDest.origin.x = originX + (index % CHUNK_EDGE)
      texelDest.origin.y = originY + Math.floor(index / CHUNK_EDGE)
      device.queue.writeTexture(texelDest, singleTexelScratch, texelDataLayout, texelSize)
      usedSlots.add(slot)
    },

    // Open gate failures item 1: batched, not one `writeTexture` per entry (see `indirMirror`'s own
    // comment above). `count`'s scratch-array contract (Seams doc comment) is unchanged.
    writeIndir(entries, count) {
      const n = count ?? entries.length
      for (let i = 0; i < n; i++) {
        const e = entries[i] as IndirEntry
        indirMirror[e.y * INDIR_TEXTURE_EDGE + e.x] = e.value
      }
      if (n > 0) {
        device.queue.writeTexture(indirDest, indirMirror, indirDataLayout, indirSize)
      }
    },

    setTileArray(texture) {
      tileArray = texture
      bindGroup = buildBindGroup()
    },

    draw(target) {
      if (isTextureView(target)) {
        colorAttachment.view = target
      } else {
        // 0018 §1: skip `createView()` when the probe showed this device accepts a bare
        // `GPUTexture` as the attachment `view` (`device.view_probe_both_paths` forces both paths
        // through one real device and checks both produce the same pixels).
        colorAttachment.view = opts.viewProbePasses
          ? (target as unknown as GPUTextureView)
          : target.createView()
      }
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass(passDescriptor)
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
      submitList[0] = encoder.finish()
      device.queue.submit(submitList)
      drawCallCount++
    },

    drawCalls() {
      return drawCallCount
    },

    pageSlotsUsed() {
      return usedSlots.size
    },

    frameUniform,
    viewport,
  }
}

function isTextureView(t: GPUTexture | GPUTextureView): t is GPUTextureView {
  // `@webgpu/types` gives both interfaces no distinguishing own property; `GPUTexture` is the only
  // one of the two with `createView` (docs/plan/09-renderer-terrain.md Deviations).
  return typeof (t as GPUTexture).createView !== 'function'
}
