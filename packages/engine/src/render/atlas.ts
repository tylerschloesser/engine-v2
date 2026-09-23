// Sprite atlas (docs/decisions/0018-renderer.md §3 "Art sampling" for sprites, §4 `sprites.png`;
// docs/plan/17b-sprites-and-frame-budget.md Scope, steps 1-3): fetches and validates `sprites.json`,
// uploads `sprites.png` (`premultipliedAlpha: true`) into a 2-mip-level atlas (mip 1 via a one-pass
// reuse of `render/mips.ts`'s own blit technique -- not `generateMips` itself, which chases a full
// pyramid to 1x1 and requires a power-of-two size; a sprite atlas is neither, 0018 §4 fixing it at
// exactly 2 levels), and builds the sprite table as two 64x64 `rgba32float` data textures read with
// `textureLoad` (Planning decisions "Sprite table in data textures, not uniforms"): one texture's
// texel `(x, y, w, h)` is a sprite's atlas rect in pixels (frame 0's own rect; further frames are at
// `x + i * w`, "frames are laid out left to right from rect"), the other's texel `(pivotX, pivotY,
// sizeW, sizeH)` is its pivot (this cut's own reading: a normalised `[0, 1]` fraction of the sprite's
// own footprint, resolution-independent, the same convention `rect`'s separate pixel/tile units
// already keep distinct -- recorded in Deviations, since 0018 §4 fixes the field's existence, not its
// units) and world size in tiles. `sprite_id` addresses both textures at `(id % 64, id / 64)`.
import { MIPS_WGSL } from './wgsl.generated.js'

export type SpriteEntry = {
  rect: [number, number, number, number]
  pivot: [number, number]
  size: [number, number]
  frames: number
}

/** `sprites.json` schema v1 (brief Seams). */
export type SpritesManifest = {
  version: 1
  image: string
  padding: number
  sprites: Record<string, SpriteEntry>
}

/** 0018 §4: "≤ 4,096 sprites." */
export const MAX_SPRITES = 4096
/** 0018 §4: "atlas ≤ 4096²." */
export const MAX_ATLAS_EDGE = 4096
/** Planning decisions "Sprite table in data textures": one texel per sprite id, 64x64. */
export const SPRITE_TABLE_EDGE = 64
export const SPRITE_TABLE_TEXELS = SPRITE_TABLE_EDGE * SPRITE_TABLE_EDGE
const SPRITE_TABLE_TEXEL_BYTES = 16 // rgba32float: 4 x f32
export const SPRITE_TABLE_BYTES = SPRITE_TABLE_TEXELS * SPRITE_TABLE_TEXEL_BYTES
/** 0018 §4: sprite atlas mips are fixed at 2 levels, unlike tile art's full-to-1x1 pyramid
 * (`render/mips.ts`'s `mipLevelCountFor`). */
export const SPRITE_MIP_LEVEL_COUNT = 2

export class SpriteManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpriteManifestError'
  }
}

function fail(message: string): never {
  throw new SpriteManifestError(`sprites.json: ${message}`)
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function validateSprite(id: string, raw: unknown): SpriteEntry {
  if (typeof raw !== 'object' || raw === null) fail(`sprite '${id}': not an object`)
  const s = raw as Record<string, unknown>

  if (!Array.isArray(s.rect) || s.rect.length !== 4 || !s.rect.every(isNonNegInt)) {
    fail(`sprite '${id}': rect must be [x, y, w, h] of non-negative integers`)
  }
  const rect = s.rect as [number, number, number, number]
  if (rect[2] === 0 || rect[3] === 0) fail(`sprite '${id}': rect w and h must be >= 1`)

  if (!Array.isArray(s.pivot) || s.pivot.length !== 2 || !s.pivot.every(isFiniteNumber)) {
    fail(`sprite '${id}': pivot must be [x, y] of finite numbers`)
  }
  const pivot = s.pivot as [number, number]
  if (pivot[0] < 0 || pivot[0] > 1 || pivot[1] < 0 || pivot[1] > 1) {
    fail(`sprite '${id}': pivot must be within [0, 1] on each axis (a normalised fraction)`)
  }

  if (!Array.isArray(s.size) || s.size.length !== 2 || !s.size.every(isFiniteNumber)) {
    fail(`sprite '${id}': size must be [w_tiles, h_tiles] of finite numbers`)
  }
  const size = s.size as [number, number]
  if (size[0] <= 0 || size[1] <= 0) fail(`sprite '${id}': size must be > 0 on each axis`)

  if (!isNonNegInt(s.frames) || s.frames === 0) fail(`sprite '${id}': frames must be >= 1`)

  return { rect, pivot, size, frames: s.frames as number }
}

/** `sprites.schema_errors` (Tests added): every failure names the offending id (0018 §4's own
 * limits), mirroring `render/art.ts`'s `validateManifest`. Pure structural validation -- like that
 * function, it does not check `rect`/`frames` against the atlas image's real dimensions (no image is
 * loaded yet); `loadSpriteAtlas` does that once `sprites.png` is fetched. */
export function validateSpritesManifest(value: unknown): SpritesManifest {
  if (typeof value !== 'object' || value === null) fail('not an object')
  const m = value as Record<string, unknown>
  if (m.version !== 1) fail(`version must be 1, got ${JSON.stringify(m.version)}`)
  if (typeof m.image !== 'string' || m.image.length === 0) fail('image must be a non-empty string')
  if (!isNonNegInt(m.padding)) fail('padding must be a non-negative integer')
  if (typeof m.sprites !== 'object' || m.sprites === null) fail('sprites must be an object')

  const rawSprites = m.sprites as Record<string, unknown>
  const ids = Object.keys(rawSprites)
  if (ids.length > MAX_SPRITES)
    fail(`${ids.length} sprites declared, over the ${MAX_SPRITES} limit`)
  const sprites: Record<string, SpriteEntry> = {}
  for (const id of ids) {
    const n = Number(id)
    if (!Number.isInteger(n) || n < 0 || n >= MAX_SPRITES) {
      fail(`sprite id '${id}' must be an integer in [0, ${MAX_SPRITES})`)
    }
    sprites[id] = validateSprite(id, rawSprites[id])
  }
  return { version: 1, image: m.image, padding: m.padding as number, sprites }
}

/** The two 64x64 `rgba32float` sprite tables (Planning decisions): `rectBytes` texel `id` is
 * `(rect.x, rect.y, rect.w, rect.h)`; `pivotSizeBytes` texel `id` is `(pivot.x, pivot.y, size.w,
 * size.h)`. Every unused sprite id stays zeroed (never read: nothing addresses it). */
export function buildSpriteTables(manifest: SpritesManifest): {
  rectBytes: Float32Array
  pivotSizeBytes: Float32Array
} {
  const rectBytes = new Float32Array(SPRITE_TABLE_TEXELS * 4)
  const pivotSizeBytes = new Float32Array(SPRITE_TABLE_TEXELS * 4)
  for (const [id, s] of Object.entries(manifest.sprites)) {
    const base = Number(id) * 4
    rectBytes[base + 0] = s.rect[0]
    rectBytes[base + 1] = s.rect[1]
    rectBytes[base + 2] = s.rect[2]
    rectBytes[base + 3] = s.rect[3]
    pivotSizeBytes[base + 0] = s.pivot[0]
    pivotSizeBytes[base + 1] = s.pivot[1]
    pivotSizeBytes[base + 2] = s.size[0]
    pivotSizeBytes[base + 3] = s.size[1]
  }
  return { rectBytes, pivotSizeBytes }
}

export type LoadedSpriteAtlas = {
  readonly atlasTexture: GPUTexture
  readonly rectTexture: GPUTexture
  readonly pivotSizeTexture: GPUTexture
  readonly manifest: SpritesManifest
  /** Sum of every texture byte this call allocated (atlas mip 0 + mip 1, plus the two 64x64
   * `rgba32float` data textures, 128 KiB fixed -- Planning decisions): the GPU-side share of
   * `engine/test`'s `gpuBytes` counter this milestone owns (brief: "the sprite table ... adds 128
   * KiB"). */
  readonly gpuBytes: number
}

/** One-pass mip blit (level 0 -> level 1), reusing `render/mips.ts`'s own shader/technique
 * (`MIPS_WGSL`) rather than its `generateMips` entry point: that function chases a full pyramid to
 * 1x1 through `mipLevelCountFor`, which requires a power-of-two square size -- a sprite atlas is
 * neither (0018 §4 fixes it at exactly 2 mip levels regardless of its own dimensions, ≤ 4096² each
 * axis independently). `texture` must already exist with `mipLevelCount: 2` and `TEXTURE_BINDING |
 * RENDER_ATTACHMENT` usage, declared `2d-array` (a single layer): the same reason `render/mips.ts`'s
 * Deviations give for tile art -- compatibility mode requires a `2d-array` texture *binding* to
 * reference a texture's layers at all, even a texture with exactly one. */
async function blitSpriteMip1(
  device: GPUDevice,
  texture: GPUTexture,
  checkCompilation?: (label: string, module: GPUShaderModule) => Promise<void>,
): Promise<void> {
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const bindGroupLayout = device.createBindGroupLayout({
    label: 'sprite-mip-blit',
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
  const module = device.createShaderModule({ code: MIPS_WGSL, label: 'sprite-mip-blit' })
  if (checkCompilation) await checkCompilation('sprite-mip-blit', module)
  const pipeline = device.createRenderPipeline({
    label: 'sprite-mip-blit',
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  })
  // `mip_layer` (mips.wgsl): one small uniform buffer, layer 0 (the atlas has exactly one).
  const layerBuffer = device.createBuffer({
    label: 'sprite-mip-layer',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(layerBuffer, 0, new Uint32Array([0, 0, 0, 0]))

  const srcView = texture.createView({
    label: 'sprite-mip-src',
    dimension: '2d-array',
    baseMipLevel: 0,
    mipLevelCount: 1,
  })
  const dstView = texture.createView({
    label: 'sprite-mip-dst',
    dimension: '2d',
    baseMipLevel: 1,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  })
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: srcView },
      { binding: 2, resource: { buffer: layerBuffer } },
    ],
  })
  const encoder = device.createCommandEncoder({ label: 'sprite-mip-blit' })
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view: dstView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
    ],
  })
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.draw(3)
  pass.end()
  device.queue.submit([encoder.finish()])
}

/** Fetches `manifestUrl`, validates it, fetches its (relative) `image`, uploads it into a 2-mip
 * atlas, blits mip 1, and builds the two sprite data textures. Mirrors `render/art.ts`'s
 * `loadTileArt` (`manifestRes.url`, not the caller's own `manifestUrl`, resolves `image`: `Response
 * .url` is the final, absolute, redirect-resolved one). */
export async function loadSpriteAtlas(
  device: GPUDevice,
  manifestUrl: string,
  opts?: { checkCompilation?(label: string, module: GPUShaderModule): Promise<void> },
): Promise<LoadedSpriteAtlas> {
  const manifestRes = await fetch(manifestUrl)
  if (!manifestRes.ok) {
    throw new Error(`loadSpriteAtlas: fetching ${manifestUrl}: HTTP ${manifestRes.status}`)
  }
  const manifest = validateSpritesManifest(await manifestRes.json())

  const imageUrl = new URL(manifest.image, manifestRes.url).toString()
  const imageRes = await fetch(imageUrl)
  if (!imageRes.ok)
    throw new Error(`loadSpriteAtlas: fetching ${imageUrl}: HTTP ${imageRes.status}`)
  const bitmap = await createImageBitmap(await imageRes.blob())

  if (bitmap.width > MAX_ATLAS_EDGE || bitmap.height > MAX_ATLAS_EDGE) {
    throw new SpriteManifestError(
      `sprites.json: image ${imageUrl} (${bitmap.width}x${bitmap.height}) exceeds the ` +
        `${MAX_ATLAS_EDGE}px atlas limit`,
    )
  }
  for (const [id, s] of Object.entries(manifest.sprites)) {
    const [x, y, w, h] = s.rect
    const rightEdge = x + w * s.frames
    if (rightEdge > bitmap.width || y + h > bitmap.height) {
      throw new SpriteManifestError(
        `sprites.json: sprite '${id}' (rect [${x}, ${y}, ${w}, ${h}], frames ${s.frames}) ` +
          `exceeds the image (${bitmap.width}x${bitmap.height})`,
      )
    }
  }

  // Captured before `bitmap.close()` below: `ImageBitmap.close()` releases the bitmap's own pixel
  // data and zeroes its `width`/`height` (found by this cut's own gpuBytes measurement reading a
  // near-zero atlas contribution -- every read of the image's own size after this point uses these,
  // never `bitmap.width`/`bitmap.height` again).
  const imageWidth = bitmap.width
  const imageHeight = bitmap.height

  const atlasTexture = device.createTexture({
    label: 'sprite-atlas',
    size: [imageWidth, imageHeight, 1],
    format: 'rgba8unorm',
    mipLevelCount: SPRITE_MIP_LEVEL_COUNT,
    // `COPY_SRC` is not a production need (nothing reads this texture back); it is here so
    // `src/test/render.ts`'s `readTextureMip` can `copyTextureToBuffer` it for `sprite.
    // no_bleed_at_mip1` (docs/plan/17b-sprites-and-frame-budget.md Deviations) -- found by
    // `uncapturederror` on this cut's own first run of that test.
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.RENDER_ATTACHMENT,
    // Compatibility mode (0018 §7), same reasoning as `render/art.ts`'s tile array: a texture's
    // bindable view dimension is fixed at creation and must match every bind-group view of it.
    textureBindingViewDimension: '2d-array',
  })
  device.queue.copyExternalImageToTexture(
    { source: bitmap },
    { texture: atlasTexture, origin: { x: 0, y: 0, z: 0 }, premultipliedAlpha: true },
    { width: imageWidth, height: imageHeight },
  )
  bitmap.close()

  await blitSpriteMip1(device, atlasTexture, opts?.checkCompilation)

  const { rectBytes, pivotSizeBytes } = buildSpriteTables(manifest)
  const rectTexture = device.createTexture({
    label: 'sprite-rect-table',
    size: [SPRITE_TABLE_EDGE, SPRITE_TABLE_EDGE, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const pivotSizeTexture = device.createTexture({
    label: 'sprite-pivot-size-table',
    size: [SPRITE_TABLE_EDGE, SPRITE_TABLE_EDGE, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const tableDataLayout = { bytesPerRow: SPRITE_TABLE_EDGE * SPRITE_TABLE_TEXEL_BYTES }
  const tableSize = { width: SPRITE_TABLE_EDGE, height: SPRITE_TABLE_EDGE }
  device.queue.writeTexture({ texture: rectTexture }, rectBytes, tableDataLayout, tableSize)
  device.queue.writeTexture(
    { texture: pivotSizeTexture },
    pivotSizeBytes,
    tableDataLayout,
    tableSize,
  )

  const mip1W = Math.max(1, imageWidth >> 1)
  const mip1H = Math.max(1, imageHeight >> 1)
  const atlasBytes = imageWidth * imageHeight * 4 + mip1W * mip1H * 4
  const gpuBytes = atlasBytes + SPRITE_TABLE_BYTES * 2

  return { atlasTexture, rectTexture, pivotSizeTexture, manifest, gpuBytes }
}
