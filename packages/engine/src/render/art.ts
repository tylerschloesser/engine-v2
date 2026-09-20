// Tile art (docs/decisions/0018-renderer.md §4; docs/plan/09-renderer-terrain.md Scope, Planning
// decisions "tiles.json schema v1", "Visual table comes from tiles.json on main"): fetches and
// validates `tiles.json`, loads `tiles.png` with `createImageBitmap` + `copyExternalImageToTexture`
// (`premultipliedAlpha: true`) into one `texture_2d_array<f32>` layer per sheet cell (no mips yet:
// M09b), and builds the 16 KiB visual-table buffer `render/terrain.ts` uploads once.
export type VisualFlag = 'flip_x' | 'flip_y' | 'rotate'

export type VisualEntry = {
  first: number
  variants: number
  flags: VisualFlag[]
  priority: number
  band: number
}

/** `tiles.json` schema v1 (Planning decisions): `image` is relative to the manifest URL; cells are
 * numbered row-major; a visual's variants are consecutive cells. */
export type TilesManifest = {
  version: 1
  image: string
  tile_px: number
  columns: number
  visuals: Record<string, VisualEntry>
}

/** 0018 §4: "At most 256 tile images (the guaranteed `maxTextureArrayLayers`) and 1,024 visuals." */
export const MAX_VISUALS = 1024
export const MAX_CELLS = 256
/** The visual table's own sizing (0018 §3: "uniform buffer of 1,024 x 16 B, the compatibility-mode
 * binding limit"). Owned here, not `render/terrain.ts`, since `buildVisualTable` is what actually
 * lays the bytes out; `terrain.ts` imports it back for its uniform buffer's size (docs/plan/
 * 09-renderer-terrain.md Deviations: step 3's art.ts precedes step 4's terrain.ts). */
export const VISUAL_TABLE_ENTRIES = MAX_VISUALS
export const VISUAL_TABLE_BYTES = VISUAL_TABLE_ENTRIES * 16

const VALID_FLAGS: readonly VisualFlag[] = ['flip_x', 'flip_y', 'rotate']
/** Bit assignment for the visual table's packed `flags` field (Planning decisions "Visual table
 * comes from tiles.json on main": "flags" is a bitmask; the exact bit-per-flag choice is this
 * milestone's own, since 0018 §3 fixes only the field's existence -- docs/plan/09-renderer-terrain.md
 * Deviations). */
const FLAG_BITS: Record<VisualFlag, number> = { flip_x: 1, flip_y: 2, rotate: 4 }

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

function fail(message: string): never {
  throw new ManifestError(`tiles.json: ${message}`)
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function validateVisual(id: string, raw: unknown): VisualEntry {
  if (typeof raw !== 'object' || raw === null) fail(`visual '${id}': not an object`)
  const v = raw as Record<string, unknown>
  if (!isNonNegInt(v.first)) fail(`visual '${id}': first must be a non-negative integer`)
  if (!isNonNegInt(v.variants) || v.variants === 0) fail(`visual '${id}': variants must be >= 1`)
  const first = v.first as number
  const variants = v.variants as number
  if (first + variants > MAX_CELLS) {
    fail(`visual '${id}': first (${first}) + variants (${variants}) exceeds ${MAX_CELLS} cells`)
  }
  if (!Array.isArray(v.flags)) fail(`visual '${id}': flags must be an array`)
  for (const f of v.flags) {
    if (!VALID_FLAGS.includes(f as VisualFlag)) fail(`visual '${id}': invalid flag '${String(f)}'`)
  }
  if (!isNonNegInt(v.priority)) fail(`visual '${id}': priority must be a non-negative integer`)
  if (!isNonNegInt(v.band)) fail(`visual '${id}': band must be a non-negative integer`)
  return {
    first,
    variants,
    flags: [...(v.flags as VisualFlag[])],
    priority: v.priority as number,
    band: v.band as number,
  }
}

/** `manifest.schema_errors` (Tests added): every failure names the offending id (0018 §4's own
 * limits). Throws `ManifestError`, never returns a partially-valid manifest. */
export function validateManifest(value: unknown): TilesManifest {
  if (typeof value !== 'object' || value === null) fail('not an object')
  const m = value as Record<string, unknown>
  if (m.version !== 1) fail(`version must be 1, got ${JSON.stringify(m.version)}`)
  if (typeof m.image !== 'string' || m.image.length === 0) fail('image must be a non-empty string')
  if (!isNonNegInt(m.tile_px) || m.tile_px === 0) fail('tile_px must be a positive integer')
  if (!isNonNegInt(m.columns) || m.columns === 0) fail('columns must be a positive integer')
  if (typeof m.visuals !== 'object' || m.visuals === null) fail('visuals must be an object')

  const rawVisuals = m.visuals as Record<string, unknown>
  const ids = Object.keys(rawVisuals)
  if (ids.length > MAX_VISUALS)
    fail(`${ids.length} visuals declared, over the ${MAX_VISUALS} limit`)
  const visuals: Record<string, VisualEntry> = {}
  for (const id of ids) {
    const n = Number(id)
    if (!Number.isInteger(n) || n < 0 || n >= MAX_VISUALS) {
      fail(`visual id '${id}' must be an integer in [0, ${MAX_VISUALS})`)
    }
    visuals[id] = validateVisual(id, rawVisuals[id])
  }
  return {
    version: 1,
    image: m.image,
    tile_px: m.tile_px as number,
    columns: m.columns as number,
    visuals,
  }
}

/** The 1,024 x 16 B visual table `terrain.wgsl`'s `VisualTable` reads (Planning decisions): per
 * entry, `x = first | variants << 16`, `y = flags | priority << 16`, `z = band`, `w` reserved (0). */
export function buildVisualTable(manifest: TilesManifest): Uint8Array {
  const bytes = new Uint8Array(VISUAL_TABLE_BYTES)
  const view = new DataView(bytes.buffer)
  for (const [id, v] of Object.entries(manifest.visuals)) {
    const base = Number(id) * 16
    let flags = 0
    for (const f of v.flags) flags |= FLAG_BITS[f]
    view.setUint32(base + 0, (v.first & 0xffff) | ((v.variants & 0xffff) << 16), true)
    view.setUint32(base + 4, (flags & 0xffff) | ((v.priority & 0xffff) << 16), true)
    view.setUint32(base + 8, v.band >>> 0, true)
    view.setUint32(base + 12, 0, true)
  }
  return bytes
}

export type LoadedArt = {
  readonly texture: GPUTexture
  readonly manifest: TilesManifest
  readonly visualTableBytes: Uint8Array
  readonly cellCount: number
}

/** Fetches `manifestUrl`, validates it, fetches its (relative) `image`, and loads every sheet cell
 * into its own array layer. No mips (M09b). */
export async function loadTileArt(device: GPUDevice, manifestUrl: string): Promise<LoadedArt> {
  const manifestRes = await fetch(manifestUrl)
  if (!manifestRes.ok) {
    throw new Error(`loadTileArt: fetching ${manifestUrl}: HTTP ${manifestRes.status}`)
  }
  const manifest = validateManifest(await manifestRes.json())

  // `manifestRes.url`, not the caller's (possibly relative) `manifestUrl`: `URL`'s second argument
  // must itself be absolute, and `Response.url` is the final, absolute, redirect-resolved one
  // (docs/plan/09-renderer-terrain.md Deviations).
  const imageUrl = new URL(manifest.image, manifestRes.url).toString()
  const imageRes = await fetch(imageUrl)
  if (!imageRes.ok) throw new Error(`loadTileArt: fetching ${imageUrl}: HTTP ${imageRes.status}`)
  const bitmap = await createImageBitmap(await imageRes.blob())

  if (bitmap.width % manifest.tile_px !== 0 || bitmap.height % manifest.tile_px !== 0) {
    throw new ManifestError(
      `tiles.json: image ${imageUrl} (${bitmap.width}x${bitmap.height}) is not a whole number of ` +
        `${manifest.tile_px}px tiles`,
    )
  }
  const rows = bitmap.height / manifest.tile_px
  const cellCount = manifest.columns * rows
  if (cellCount > MAX_CELLS) {
    throw new ManifestError(`tiles.json: image has ${cellCount} cells, over the ${MAX_CELLS} limit`)
  }

  const texture = device.createTexture({
    label: 'tile-art',
    size: [manifest.tile_px, manifest.tile_px, cellCount],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
    // Compatibility mode (0018 §7): must match the `2d-array` view `render/terrain.ts`'s bind
    // group creates of this texture (docs/plan/09-renderer-terrain.md Deviations).
    textureBindingViewDimension: '2d-array',
  })
  for (let cell = 0; cell < cellCount; cell++) {
    const col = cell % manifest.columns
    const row = Math.floor(cell / manifest.columns)
    device.queue.copyExternalImageToTexture(
      { source: bitmap, origin: { x: col * manifest.tile_px, y: row * manifest.tile_px } },
      { texture, origin: { x: 0, y: 0, z: cell }, premultipliedAlpha: true },
      { width: manifest.tile_px, height: manifest.tile_px },
    )
  }
  bitmap.close()

  return { texture, manifest, visualTableBytes: buildVisualTable(manifest), cellCount }
}
