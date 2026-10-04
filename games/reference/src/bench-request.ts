// The bench page's URL parameters and the furnace block's geometry (`bench.ts`, M36; `zoom` M39f): pure
// functions, no engine or DOM import, so a unit test can read them. **Bench builds only** through `bench.ts`.

/** `?bench=large-save[&scale=n][&pan=tiles-per-second][&zoom=max|tiles]`: `scale` divides the save (1 = the full
 * 0020 section 9 save, 64 = the 1/64 one the fast test builds), `pan` is the camera's drift speed, `zoom` is
 * how many tiles the view spans: `max` (the default, the camera's maximum zoom-out, 256) or a number. A
 * device walk names `zoom=max` so the zoom-out is scripted, not a person's pinch (M39-frame-shares). */
export type BenchRequest = { scale: number; panTilesPerSecond: number; tilesAcross: number }

/** The camera's maximum zoom-out, in tiles across (`tilesAcross` limits, `0019`). */
export const MAX_TILES_ACROSS = 256

export function benchRequest(search: string): BenchRequest | undefined {
  const p = new URLSearchParams(search)
  if (p.get('bench') !== 'large-save') return undefined
  const scale = Math.max(1, Math.floor(Number(p.get('scale') ?? 1)) || 1)
  const pan = Number(p.get('pan') ?? 12)
  const zoom = p.get('zoom')
  const across = zoom === null || zoom === 'max' ? MAX_TILES_ACROSS : Number(zoom)
  return {
    scale,
    panTilesPerSecond: Number.isFinite(pan) ? pan : 12,
    tilesAcross: Number.isFinite(across) && across > 0 ? across : MAX_TILES_ACROSS,
  }
}

// `bench.rs`'s shape: 262,144 / scale furnaces, 200 a chunk, chunks of 32 tiles in a square-ish
// block from the origin (`cols` wide, row-major).
const CHUNK_TILES = 32
const FURNACES_PER_CHUNK = 200

/** The centre of the furnace block and half of its shorter side, in tiles. */
export function furnaceBlock(scale: number): { x: number; y: number; halfSpan: number } {
  const chunks = Math.ceil(Math.floor(262_144 / scale) / FURNACES_PER_CHUNK)
  let cols = 1
  while (cols * cols < chunks) cols++
  const rows = Math.ceil(chunks / cols)
  return {
    x: (cols * CHUNK_TILES) / 2,
    y: (rows * CHUNK_TILES) / 2,
    halfSpan: (Math.min(cols, rows) * CHUNK_TILES) / 2,
  }
}
