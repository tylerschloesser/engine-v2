// Mip generation (docs/decisions/0018-renderer.md §4: "generates mips to 1x1"; docs/plan/
// 09b-terrain-art-and-lifecycle.md Scope): one blit pipeline shared by every (layer, level) pass,
// reused colour-attachment/pass-descriptor objects mutated in place across the loop -- setup cost,
// run once per `loadTileArt` call (exempt from `.claude/rules/hot-paths.md`'s per-frame budget),
// but built the same disciplined way a hot path would be since nothing here needs the sloppier
// alternative.
import { MIPS_WGSL } from './wgsl.generated.js'

/** `size` must be a power of two (0018 §4's tile sheets always are: `tile_px`/the sprite atlas).
 * Levels run `size, size/2, ..., 1` inclusive, so a 4px cell has 3 levels (4, 2, 1). */
export function mipLevelCountFor(size: number): number {
  if (!Number.isInteger(size) || size <= 0 || (size & (size - 1)) !== 0) {
    throw new RangeError(`mipLevelCountFor: ${size} is not a positive power of two`)
  }
  return Math.floor(Math.log2(size)) + 1
}

export type GenerateMipsOptions = {
  /** Number of `texture_2d_array` layers to generate mips for (0018 §4: one array layer per tile
   * image). */
  layerCount: number
  /** The base (level 0) size in texels; the texture must be square (`tile_px` always is) and its
   * `mipLevelCount` must equal `mipLevelCountFor(baseSize)`. */
  baseSize: number
  /** Awaited right after the one shared blit shader module is created, same "init, not per frame"
   * point `render/terrain.ts`'s own `checkCompilation` call uses (0020 §6). Optional: a caller with
   * no `RendererDevice` (a unit test constructing a bare `GPUDevice`) may omit it. */
  checkCompilation?(label: string, module: GPUShaderModule): Promise<void>
}

/** Blits every array layer's mip level `m` (`1 <= m < mipLevelCountFor(opts.baseSize)`) from level
 * `m - 1` with one bilinear tap per destination texel -- a standard box-filter mip chain (`toji.dev`
 * -style "renderpass blit", cited by 0018 §3's own sources). `texture` must already have been
 * created with that many `mipLevelCount` and `TEXTURE_BINDING | RENDER_ATTACHMENT` usage (`render/
 * art.ts`'s `loadTileArt` requests both). One command encoder, one queue submit for the whole
 * chain. Returns once every blit command is enqueued (not once the GPU has executed them) -- callers
 * needing an "actually landed on the GPU" barrier already have `device.queue.onSubmittedWorkDone()`
 * for that; ordinary sampling never needs it, since WebGPU executes a queue's submissions in
 * program order. */
export async function generateMips(
  device: GPUDevice,
  texture: GPUTexture,
  opts: GenerateMipsOptions,
): Promise<void> {
  const mipLevelCount = mipLevelCountFor(opts.baseSize)
  if (mipLevelCount <= 1) return // a 1x1 source has no chain to blit

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const bindGroupLayout = device.createBindGroupLayout({
    label: 'mips-blit',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d-array' },
      },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  })
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] })
  const module = device.createShaderModule({ code: MIPS_WGSL, label: 'mips-blit' })
  if (opts.checkCompilation) await opts.checkCompilation('mips-blit', module)
  const pipeline = device.createRenderPipeline({
    label: 'mips-blit',
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  })

  // Reused across every (layer, level) pass below: only `colorAttachment.view` and the bind group
  // (immutable once created -- a fresh view/texture needs a fresh bind group) change per pass.
  const colorAttachment: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    loadOp: 'clear',
    storeOp: 'store',
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
  }
  const passDescriptor: GPURenderPassDescriptor = { colorAttachments: [colorAttachment] }

  // One tiny uniform buffer per array layer (Deviations: compat mode requires a `2d-array` texture
  // *binding* to reference every one of the texture's layers, so the source view below can only be
  // narrowed by mip level, never by layer -- `mip_layer` selects the layer inside the shader
  // instead). Each buffer is a distinct object written exactly once, so recording every pass into
  // one command encoder and submitting once at the end is safe: unlike one shared buffer rewritten
  // between passes (whose queue-ordered `writeBuffer` calls would all complete before a single
  // deferred `submit()`'s passes ever execute, leaving every pass reading the *last* write), a
  // distinct buffer per layer has nothing to race with.
  const layerBuffers: GPUBuffer[] = []
  for (let layer = 0; layer < opts.layerCount; layer++) {
    const buffer = device.createBuffer({
      label: 'mips-blit-layer',
      size: 16, // one u32 field; padded to a comfortable minimum uniform-buffer size
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(buffer, 0, new Uint32Array([layer, 0, 0, 0]))
    layerBuffers.push(buffer)
  }

  const encoder = device.createCommandEncoder({ label: 'mips-blit' })
  for (let level = 1; level < mipLevelCount; level++) {
    // Shared across every layer at this level: all-layers, one (the previous) source mip level.
    const srcView = texture.createView({
      label: 'mips-blit-src',
      dimension: '2d-array',
      baseMipLevel: level - 1,
      mipLevelCount: 1,
    })
    for (let layer = 0; layer < opts.layerCount; layer++) {
      // The destination is a render-pass attachment, always a plain single-layer/single-level view
      // regardless of the texture's declared binding dimension (a WebGPU core rule, not
      // compat-specific -- an attachment is never itself a "texture binding").
      const dstView = texture.createView({
        label: 'mips-blit-dst',
        dimension: '2d',
        baseMipLevel: level,
        mipLevelCount: 1,
        baseArrayLayer: layer,
        arrayLayerCount: 1,
      })
      const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: srcView },
          { binding: 2, resource: { buffer: layerBuffers[layer] as GPUBuffer } },
        ],
      })
      colorAttachment.view = dstView
      const pass = encoder.beginRenderPass(passDescriptor)
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
    }
  }
  device.queue.submit([encoder.finish()])
}
