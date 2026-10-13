// The bench page's URL parameters and the furnace block's geometry (`bench.ts`, M36; `zoom` M39f): pure
// functions, no engine or DOM import, so a unit test can read them. **Bench builds only** through `bench.ts`.

/** `?bench=large-save[&scale=n][&pan=tiles-per-second][&zoom=max|tiles]`: `scale` divides the save (1 = the full
 * 0020 section 9 save, 64 = the 1/64 one the fast test builds), `pan` is the camera's drift speed, `zoom` is
 * how many tiles the view spans: `max` (the default, the camera's maximum zoom-out, 256) or a number. A
 * device walk names `zoom=max` so the zoom-out is scripted, not a person's pinch (M39-frame-shares).
 * M57: `?bench=belts[&scale=n][&pan=..][&zoom=max|mid|tiles]` is the belt field instead (`sim/src/bench.rs`:
 * 48 / `scale` saturated runs written at genesis, the phone pair's caps); `mid` is 64 tiles across. */
export type BenchMode = 'large-save' | 'belts'
export type BenchRequest = {
  mode: BenchMode
  scale: number
  panTilesPerSecond: number
  tilesAcross: number
}

/** The camera's maximum zoom-out, in tiles across (`tilesAcross` limits, `0019`). */
export const MAX_TILES_ACROSS = 256
/** `zoom=mid` (M57): 64 tiles across, 20 px a tile on a 1280 px canvas (the reference items' cut). */
export const MID_TILES_ACROSS = 64

export function benchRequest(search: string): BenchRequest | undefined {
  const p = new URLSearchParams(search)
  const mode = p.get('bench')
  if (mode !== 'large-save' && mode !== 'belts') return undefined
  const scale = Math.max(1, Math.floor(Number(p.get('scale') ?? 1)) || 1)
  const pan = Number(p.get('pan') ?? 12)
  const zoom = p.get('zoom')
  const across =
    zoom === null || zoom === 'max'
      ? MAX_TILES_ACROSS
      : zoom === 'mid'
        ? MID_TILES_ACROSS
        : Number(zoom)
  return {
    mode,
    scale,
    panTilesPerSecond: Number.isFinite(pan) ? pan : 12,
    tilesAcross: Number.isFinite(across) && across > 0 ? across : MAX_TILES_ACROSS,
  }
}

/** The phone pair of transport caps (0079 §21): `?bench=belts` declares them at every scale (the
 * field at scale 1 fills the item cap exactly, `bench_belts.rs`). */
export const PHONE_CAPS = { maxLines: 12_288, maxItems: 98_304 } as const

// `bench.rs`'s belt field: `48 / scale` runs (at least one), one every third row from the origin,
// 256 tiles long.
const FIELD_RUNS = 48
const FIELD_W = 256
const RUN_PITCH = 3
/** The belt field's pan swing at maximum zoom-out (the view is the field: 8 tiles keeps 97 % of it,
 * as `fx-belts`' frame bench). */
const FULL_VIEW_SWING = 8

/** The belt field's centre, in tiles. */
export function beltField(scale: number): { x: number; y: number } {
  const runs = Math.max(1, Math.floor(FIELD_RUNS / scale))
  return { x: FIELD_W / 2, y: (runs * RUN_PITCH) / 2 }
}

/** The camera's `tilesAcross` (long axis) for `req` on a `w` x `h` viewport (M57). `tilesAcross`
 * spans the viewport's long side, so in portrait `zoom=max` (256) would show the belt field only
 * about 118 tiles wide on a phone. For the belt field at `zoom=max` in portrait, the field's 256
 * tiles span the SHORT side instead (the long side then spans `256 * h / w`, rounded up), so every
 * belt is in view in either orientation; the orientation is the one at load. Every other case is
 * `req.tilesAcross` (`mid` stays 64 across the long side). */
export function benchTilesAcross(req: BenchRequest, w: number, h: number): number {
  if (req.mode === 'belts' && req.tilesAcross === MAX_TILES_ACROSS && h > w && w > 0) {
    return Math.ceil((FIELD_W * h) / w)
  }
  return req.tilesAcross
}

/** The client camera's view clamp for a camera `tiles` across the long side (per axis, and the
 * chunk figure the world config carries with a margin of two chunks each way); `undefined` within
 * the defaults (256 tiles, 144 chunks). The host still clamps every camera report to 256 tiles per
 * axis (`host/subs.rs`), so in portrait it subscribes 256 x 256 about the centre, which covers the
 * whole 256 x 144 belt field; only the camera's own clamp is raised here. */
export function benchView(
  tiles: number,
  w: number,
  h: number,
): { maxTilesPerAxis: number; maxChunks: number } | undefined {
  if (tiles <= MAX_TILES_ACROSS) return undefined
  const short = Math.ceil((tiles * Math.min(w, h)) / Math.max(w, h))
  return {
    maxTilesPerAxis: tiles,
    maxChunks: (Math.ceil(tiles / 32) + 4) * (Math.ceil(short / 32) + 4),
  }
}

/** Where the camera is after `d` tiles of pan (`steer` in `bench.ts`), a triangle wave along x.
 * `large-save`: from the left of the swing (M36; the furnace block's middle). `belts`: from the
 * field's centre, swinging `(256 - across) / 2` each way (8 at the maximum zoom-out), so the view never
 * leaves the field; the held position is the centre. */
export function benchCamera(req: BenchRequest, d: number): { x: number; y: number } {
  if (req.mode === 'belts') {
    const c = beltField(req.scale)
    const amp =
      req.tilesAcross >= FIELD_W ? FULL_VIEW_SWING : Math.max(0, (FIELD_W - req.tilesAcross) / 2)
    const p = d % (4 * amp || 1)
    const off = p < amp ? p : p < 3 * amp ? 2 * amp - p : p - 4 * amp
    return { x: c.x + off, y: c.y }
  }
  const block = furnaceBlock(req.scale)
  const amp = Math.max(0, block.halfSpan - 140)
  const p = d % (4 * amp || 1)
  return { x: block.x + (p < 2 * amp ? -amp + p : 3 * amp - p), y: block.y }
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
