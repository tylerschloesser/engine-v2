#!/usr/bin/env node

// `scripts/gen-assets.mjs` (M20 Scope): plain Node, no npm
// dependency (PNG written with `node:zlib`), deterministic, byte-reproducible. Emits
// `assets/tiles.png` + `tiles.json` (16 px tiles, 4 variants per terrain, dither priority and band
// per visual) and `assets/sprites.png` + `sprites.json` (sprite 0: the furnace, M33; 1-15 the belt
// sprites and 16-21 the item squares, M51; the player circle and DOM UI are not sprites).
//
// Ids here must match `sim/src/content.rs` exactly (terrain ids 0-4; a resource id doubles as its
// own "full" depletion-stage visual id, +1/+2 are the half/low stages -- see that file's own doc
// comment and this brief's Deviations for the full reasoning).
//
// Per-tile visual variety ("slight per-tile randomness ... dithering", Requirements) comes from
// the *engine's* own shader-level PCG brightness jitter and edge dithering (0018 §3), not from
// hand-authored per-variant pixel noise here: each terrain's 4 variant cells are the same flat
// colour -- simple and exactly reproducible without a seeded PRNG (Deviations).
//
// Usage: `node gen-assets.mjs` writes `assets/`; `--out <dir>` writes elsewhere (the
// `gen_assets_reproducible` test's own two-temp-dir run); `--check` generates in memory and diffs
// against the committed `assets/` files instead of writing, exiting 1 on any drift (this brief's
// own verification command).

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const DEFAULT_OUT_DIR = fileURLToPath(new URL('../assets/', import.meta.url))
const TILE_PX = 16
const COLUMNS = 8

// --- terrain + resource content (must match sim/src/content.rs's ids) ---------------------------
const TERRAINS = [
  { id: 0, color: [20, 40, 110], priority: 0, band: 0 }, // deep water
  { id: 1, color: [40, 100, 200], priority: 1, band: 2 }, // water
  { id: 2, color: [215, 195, 140], priority: 2, band: 2 }, // sand
  { id: 3, color: [70, 150, 60], priority: 3, band: 2 }, // grass
  { id: 4, color: [120, 85, 55], priority: 4, band: 2 }, // dirt
]
const VARIANTS_PER_TERRAIN = 4

// Depletion stages, in order (`content::RESOURCE_STAGE_{FULL,HALF,LOW}` = 0/1/2), each resource's
// own `id + stage`.
const RESOURCES = [
  {
    id: 16,
    colors: [
      [230, 140, 60],
      [180, 110, 50],
      [120, 80, 40],
    ],
  }, // iron
  {
    id: 19,
    colors: [
      [150, 110, 40],
      [110, 80, 30],
      [70, 55, 25],
    ],
  }, // wood
  {
    id: 22,
    colors: [
      [170, 170, 170],
      [130, 130, 130],
      [90, 90, 90],
    ],
  }, // stone
  {
    id: 25,
    colors: [
      [50, 50, 55],
      [35, 35, 38],
      [20, 20, 22],
    ],
  }, // coal
]

// --- sprites (must match sim/src/content.rs's SPRITE_* ids) ------------------------------------
// Each sprite is one strip of frames laid left to right (the game passes the frame in
// `Draw.param`), with 2 px extruded padding around the whole strip (0018 section 4), one strip per
// atlas row. Id 0, the 2x2-tile furnace: two frames (idle, lit). Ids 1-15 (M51), the belts: five
// families (straight, curve left, curve right, spawner, despawner) of three facings (east, south,
// north; the game mirrors east for west), 1 x 1 tile, 8 frames whose lane marks advance 1/8 tile a
// frame. Ids 16-21 (M51), the item squares (`ItemId` order), half a tile, centred. Ids 22-24 (M54),
// the splitter facing east (1 x 2 tiles), south and north (2 x 1): two straight belt halves under a
// housing across the midline, 8 frames, pivot at the footprint's min corner; symmetric between the
// halves, so west is east mirrored. Ids 25-30 (M55), the underground entrance (25-27) and exit (28-30)
// facing east, south and north, 1 x 1 tile, 8 frames: a straight belt half and a hood over the other
// half (the entrance's front half, the exit's back half), west the east mirrored. All art is fully
// opaque (the sprite pipeline's blend is straight alpha over a premultiplied atlas, which is only
// exact for alpha 255: M17b Deviations).
const SPRITE_PAD_PX = 2
const FURNACE_PX = 32 // one frame, 2 tiles x 16 px
const FURNACE_FRAMES = 2
const BELT_PX = TILE_PX
const BELT_FRAMES = 8
const ITEM_PX = TILE_PX / 2
// Sprite ids (content.rs `SPRITE_BELT_*`, `SPRITE_ITEM_FIRST`).
const BELT_FAMILIES = ['straight', 'curveLeft', 'curveRight', 'spawner', 'despawner']
const BELT_FACINGS = ['east', 'south', 'north']
const SPRITE_BELT_FIRST = 1
const SPRITE_ITEM_FIRST = 16
const SPRITE_SPLITTER_FIRST = 22
const SPLITTER_FACINGS = ['east', 'south', 'north']
const SPRITE_UNDERGROUND_FIRST = 25
const UNDERGROUND_ENDS = ['in', 'out']
const UNDERGROUND_FACINGS = ['east', 'south', 'north']
// Item names and square colours in `ItemId` order.
const ITEM_NAMES = ['stone', 'iron', 'wood', 'coal', 'furnace', 'ingot']
const ITEM_COLORS = [
  [170, 170, 170],
  [230, 140, 60],
  [150, 110, 40],
  [50, 50, 55],
  [200, 80, 60],
  [205, 215, 235],
]

/** One 32x32 furnace frame as an array of [r, g, b] rows; `lit` swaps the mouth from cold to glowing. */
function furnaceFrame(lit) {
  const px = []
  for (let y = 0; y < FURNACE_PX; y++) {
    const row = []
    for (let x = 0; x < FURNACE_PX; x++) {
      let c = [112, 106, 100] // stone body
      if ((y % 8 === 0 && y > 0) || ((x + (Math.floor(y / 8) % 2) * 8) % 16 === 0 && x > 0)) {
        c = [92, 86, 82] // brick mortar
      }
      if (x < 2 || y < 2 || x >= FURNACE_PX - 2 || y >= FURNACE_PX - 2) c = [48, 44, 44] // rim
      if (x >= 9 && x < 23 && y >= 14 && y < 26) {
        c = lit ? (y < 20 ? [255, 214, 90] : [255, 140, 30]) : [26, 22, 22] // mouth
      }
      row.push(c)
    }
    px.push(row)
  }
  return px
}

// Belt colours.
const BELT_BASE = [96, 96, 104]
const BELT_RAIL = [44, 44, 50]
const BELT_DIVIDER = [70, 70, 78]
const BELT_MARK = [210, 200, 120]
const BELT_CORNER = [60, 60, 66] // a curve's tile outside its arc
const SPAWNER_MARK = [70, 200, 90]
const DESPAWNER_MARK = [220, 70, 60]
const SPLITTER_HOUSING = [64, 92, 140]
const SPLITTER_EDGE = [36, 52, 84]
const HOOD = [120, 84, 48]
const HOOD_EDGE = [70, 46, 26]
const HOOD_MOUTH = [24, 20, 18]

// A belt pixel in the belt's own travel frame: `along` (0..16, the back edge to the front edge) and
// `across` (0..16, the left side of travel to the right), or `null` outside a curve's arc.
// Straight: travel along +u. A left curve's input is on its left side (`v = 0`): items enter moving
// across and turn left round the arc centred on the front-left corner `(16, 0)`; a right curve is
// its mirror (`v -> 16 - v`).
function travelFrame(family, u, v) {
  if (family !== 'curveLeft' && family !== 'curveRight') return { along: u, across: v }
  const vv = family === 'curveLeft' ? v : BELT_PX - v
  const du = u - BELT_PX
  const r = Math.sqrt(du * du + vv * vv)
  if (r >= BELT_PX) return null
  // From the input edge (angle pi) to the output edge (pi / 2), as a 0..16 distance.
  const phi = Math.atan2(vv, du)
  const along = ((Math.PI - phi) / (Math.PI / 2)) * BELT_PX
  return { along, across: family === 'curveLeft' ? r : BELT_PX - r }
}

// One belt pixel (centre `(x + 0.5, y + 0.5)`) of `family` facing `facing`, frame `frame`.
function beltPixel(family, facing, frame, x, y) {
  const px = x + 0.5
  const py = y + 0.5
  // The sprite's pixel in the east-facing frame `(u, v)`: south and north are east turned.
  let u = px
  let v = py
  if (facing === 'south') {
    u = py
    v = BELT_PX - px
  } else if (facing === 'north') {
    u = BELT_PX - py
    v = px
  }
  const t = travelFrame(family, u, v)
  if (t === null) return BELT_CORNER
  const { along, across } = t
  if (across < 1.5 || across > BELT_PX - 1.5) return BELT_RAIL
  if (family === 'spawner' && along < 3) return SPAWNER_MARK
  if (family === 'despawner' && along > BELT_PX - 3) return DESPAWNER_MARK
  // Lane marks: one dash every 8 px of each lane (centres 4 and 12 across), moving 2 px a frame.
  const phase = (((along - 2 * frame) % 8) + 8) % 8
  for (const centre of [4, 12]) {
    if (Math.abs(across - centre) < 2.5 && phase < 2) return BELT_MARK
  }
  if (Math.abs(across - BELT_PX / 2) < 0.5) return BELT_DIVIDER
  return BELT_BASE
}

// One splitter pixel facing `facing` (frame `frame`), in its own east-facing frame `(u, v)`: `u`
// along travel (0..16), `v` across both halves (0..32, the left half first). Each half is a
// straight belt; a housing bar crosses both halves at the midline (`u` 6..10), its rim darker.
function splitterPixel(facing, frame, x, y) {
  const W = 2 * BELT_PX
  const px = x + 0.5
  const py = y + 0.5
  let u = px
  let v = py
  if (facing === 'south') {
    u = py
    v = W - px
  } else if (facing === 'north') {
    u = BELT_PX - py
    v = px
  }
  if (u >= 6 && u < 10) {
    return u < 7 || u >= 9 || v < 1 || v >= W - 1 ? SPLITTER_EDGE : SPLITTER_HOUSING
  }
  // The half's own across (0..16): the lanes, rails and divider of a straight belt.
  const across = v < BELT_PX ? v : v - BELT_PX
  return beltPixel('straight', 'east', frame, Math.floor(u), Math.floor(across))
}

// One underground pixel of end `end` ('in' or 'out') facing `facing` (frame `frame`), in the
// east-facing frame `(u, v)` (`u` along travel, back edge 0 to front edge 16). The entrance's hood
// covers its front half (`u >= 8`), the exit's its back half (`u < 8`); the other half is a straight
// belt. The hood's mouth (a dark band) faces the visible half.
function undergroundPixel(end, facing, frame, x, y) {
  const px = x + 0.5
  const py = y + 0.5
  let u = px
  let v = py
  if (facing === 'south') {
    u = py
    v = BELT_PX - px
  } else if (facing === 'north') {
    u = BELT_PX - py
    v = px
  }
  const half = BELT_PX / 2
  const hooded = end === 'in' ? u >= half : u < half
  if (!hooded) return beltPixel('straight', 'east', frame, Math.floor(u), Math.floor(v))
  // Distance into the hood from its mouth (0 at the midline).
  const depth = end === 'in' ? u - half : half - u
  if (v < 1 || v >= BELT_PX - 1 || depth >= half - 1) return HOOD_EDGE
  if (depth < 1.5) return HOOD_MOUTH
  return HOOD
}

/** A bordered flat item square, `ITEM_PX` on a side. */
function itemPixel(color, x, y) {
  const edge = x === 0 || y === 0 || x === ITEM_PX - 1 || y === ITEM_PX - 1
  return edge ? color.map((c) => Math.floor(c / 2)) : color
}

/** Every sprite as `{ id, name, frameW, frameH, frames, pixel(frame, x, y), pivot, size }`. The
 * `name` (`furnace`, `belt/<family>/<facing>`, `item/<item>`, `splitter/<facing>`, `underground/<end>/<facing>`) goes into `sprites.json`, which the
 * engine's loader ignores, so `sprites_manifest.rs` can check each `content.rs` id's art. */
function spriteDefs() {
  const defs = [
    {
      id: 0,
      name: 'furnace',
      frameW: FURNACE_PX,
      frameH: FURNACE_PX,
      frames: FURNACE_FRAMES,
      pixel: (() => {
        const art = [furnaceFrame(false), furnaceFrame(true)]
        return (f, x, y) => art[f][y][x]
      })(),
      // pivot [0, 0]: the sprite's top-left is its `pos`, the furnace's min-corner tile.
      pivot: [0, 0],
      size: [2, 2],
    },
  ]
  BELT_FAMILIES.forEach((family, fi) => {
    BELT_FACINGS.forEach((facing, di) => {
      defs.push({
        id: SPRITE_BELT_FIRST + fi * BELT_FACINGS.length + di,
        name: `belt/${family}/${facing}`,
        frameW: BELT_PX,
        frameH: BELT_PX,
        frames: BELT_FRAMES,
        pixel: (f, x, y) => beltPixel(family, facing, f, x, y),
        // The belt's own tile.
        pivot: [0, 0],
        size: [1, 1],
      })
    })
  })
  ITEM_COLORS.forEach((color, i) => {
    defs.push({
      id: SPRITE_ITEM_FIRST + i,
      name: `item/${ITEM_NAMES[i]}`,
      frameW: ITEM_PX,
      frameH: ITEM_PX,
      frames: 1,
      pixel: (_f, x, y) => itemPixel(color, x, y),
      // Centred on the lane point the engine draws an item at (`transport::draw::draw_items`).
      pivot: [0.5, 0.5],
      size: [0.5, 0.5],
    })
  })
  SPLITTER_FACINGS.forEach((facing, di) => {
    const across = facing === 'east'
    defs.push({
      id: SPRITE_SPLITTER_FIRST + di,
      name: `splitter/${facing}`,
      frameW: across ? BELT_PX : 2 * BELT_PX,
      frameH: across ? 2 * BELT_PX : BELT_PX,
      frames: BELT_FRAMES,
      pixel: (f, x, y) => splitterPixel(facing, f, x, y),
      // The footprint's min corner (`Belt::origin`).
      pivot: [0, 0],
      size: across ? [1, 2] : [2, 1],
    })
  })
  UNDERGROUND_ENDS.forEach((end, ei) => {
    UNDERGROUND_FACINGS.forEach((facing, di) => {
      defs.push({
        id: SPRITE_UNDERGROUND_FIRST + ei * UNDERGROUND_FACINGS.length + di,
        name: `underground/${end}/${facing}`,
        frameW: BELT_PX,
        frameH: BELT_PX,
        frames: BELT_FRAMES,
        pixel: (f, x, y) => undergroundPixel(end, facing, f, x, y),
        // The end's own tile.
        pivot: [0, 0],
        size: [1, 1],
      })
    })
  })
  return defs
}

function buildSprites() {
  const defs = spriteDefs()
  // Layout: one strip per row, except that the item squares share the last row.
  const cells = []
  let y0 = 0
  let x0 = 0
  let rowH = 0
  for (const d of defs) {
    const w = d.frames * d.frameW + 2 * SPRITE_PAD_PX
    const h = d.frameH + 2 * SPRITE_PAD_PX
    const sharesRow = d.frames === 1 && cells.length > 0 && cells.at(-1).def.frames === 1
    if (!sharesRow) {
      y0 += rowH
      x0 = 0
      rowH = 0
    }
    cells.push({ def: d, x: x0, y: y0, w, h })
    x0 += w
    rowH = Math.max(rowH, h)
  }
  const width = Math.max(...cells.map((c) => c.x + c.w))
  const height = y0 + rowH
  const rgba = new Uint8Array(width * height * 4)
  const sprites = {}
  for (const { def, x, y, w, h } of cells) {
    const stripW = def.frames * def.frameW
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        // Clamp into the strip: the padding replicates each edge pixel outward (extrusion).
        const sx = Math.min(Math.max(px - SPRITE_PAD_PX, 0), stripW - 1)
        const sy = Math.min(Math.max(py - SPRITE_PAD_PX, 0), def.frameH - 1)
        const [r, g, b] = def.pixel(Math.floor(sx / def.frameW), sx % def.frameW, sy)
        const o = ((y + py) * width + (x + px)) * 4
        rgba[o] = r
        rgba[o + 1] = g
        rgba[o + 2] = b
        rgba[o + 3] = 255
      }
    }
    sprites[def.id] = {
      name: def.name,
      rect: [x + SPRITE_PAD_PX, y + SPRITE_PAD_PX, def.frameW, def.frameH],
      pivot: def.pivot,
      size: def.size,
      frames: def.frames,
    }
  }
  const manifest = { version: 1, image: 'sprites.png', padding: SPRITE_PAD_PX, sprites }
  return { rgba, width, height, manifest }
}

// --- cell layout: row-major at COLUMNS, terrains first (4 variants each), then one cell per
// resource depletion stage ------------------------------------------------------------------
function buildLayout() {
  const cells = []
  const visuals = {}
  for (const t of TERRAINS) {
    const first = cells.length
    for (let v = 0; v < VARIANTS_PER_TERRAIN; v++) cells.push(t.color)
    visuals[t.id] = {
      first,
      variants: VARIANTS_PER_TERRAIN,
      flags: [],
      priority: t.priority,
      band: t.band,
    }
  }
  for (const r of RESOURCES) {
    for (let stage = 0; stage < 3; stage++) {
      const first = cells.length
      cells.push(r.colors[stage])
      visuals[r.id + stage] = { first, variants: 1, flags: [], priority: 0, band: 0 }
    }
  }
  return { cells, visuals }
}

function renderTilesRGBA(cells) {
  const rows = Math.ceil(cells.length / COLUMNS)
  const width = COLUMNS * TILE_PX
  const height = rows * TILE_PX
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < cells.length; i++) {
    const [r, g, b] = cells[i]
    const cellX = (i % COLUMNS) * TILE_PX
    const cellY = Math.floor(i / COLUMNS) * TILE_PX
    for (let py = 0; py < TILE_PX; py++) {
      for (let px = 0; px < TILE_PX; px++) {
        const o = ((cellY + py) * width + (cellX + px)) * 4
        rgba[o] = r
        rgba[o + 1] = g
        rgba[o + 2] = b
        rgba[o + 3] = 255
      }
    }
  }
  return { rgba, width, height }
}

// --- minimal 8-bit RGBA PNG encoder (no npm dependency; node:zlib only) --------------------------
let crcTable
function crcTableOf() {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  return crcTable
}

function crc32(buf) {
  const table = crcTableOf()
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = (table[(crc ^ buf[i]) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Encodes `rgba` (`width * height * 4` bytes, row-major) as an 8-bit RGBA PNG, no interlacing,
 * `none` filter on every row. */
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const rowBytes = width * 4
  const raw = Buffer.alloc((rowBytes + 1) * height)
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1)
    raw[rowStart] = 0 // filter type: none
    src.copy(raw, rowStart + 1, y * rowBytes, (y + 1) * rowBytes)
  }
  const idat = deflateSync(raw)

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- build outputs ---------------------------------------------------------
function buildOutputs() {
  const { cells, visuals } = buildLayout()
  const { rgba, width, height } = renderTilesRGBA(cells)
  const tilesPng = encodePNG(width, height, rgba)
  const tilesJson = `${JSON.stringify(
    { version: 1, image: 'tiles.png', tile_px: TILE_PX, columns: COLUMNS, visuals },
    null,
    2,
  )}\n`

  const sprites = buildSprites()
  const spritesPng = encodePNG(sprites.width, sprites.height, sprites.rgba)
  // Number arrays on one line, the layout `pnpm format` (Biome) writes, so a format run never
  // leaves the committed file differing from a fresh generation.
  const spritesJson = `${JSON.stringify(sprites.manifest, null, 2).replace(
    /\[([^[\]{}]*)\]/g,
    (_, inner) =>
      `[${inner
        .split(',')
        .map((x) => x.trim())
        .join(', ')}]`,
  )}\n`

  return {
    'tiles.png': tilesPng,
    'tiles.json': Buffer.from(tilesJson, 'utf8'),
    'sprites.png': spritesPng,
    'sprites.json': Buffer.from(spritesJson, 'utf8'),
  }
}

async function writeOutputs(dir, outputs) {
  await mkdir(dir, { recursive: true })
  for (const [name, bytes] of Object.entries(outputs)) {
    await writeFile(join(dir, name), bytes)
  }
}

async function checkOutputs(dir, outputs) {
  const problems = []
  for (const [name, bytes] of Object.entries(outputs)) {
    const path = join(dir, name)
    let committed
    try {
      committed = await readFile(path)
    } catch (e) {
      problems.push(`${name}: cannot read committed file (${e.message})`)
      continue
    }
    if (!committed.equals(bytes)) {
      problems.push(`${name}: committed bytes differ from freshly generated bytes`)
    }
  }
  return problems
}

async function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const outIndex = args.indexOf('--out')
  const outArg = outIndex >= 0 ? args[outIndex + 1] : undefined
  const dir = outArg ? outArg : DEFAULT_OUT_DIR

  const outputs = buildOutputs()

  if (check) {
    const problems = await checkOutputs(dir, outputs)
    if (problems.length > 0) {
      console.error('gen-assets.mjs --check: drift found:')
      for (const p of problems) console.error(`  ${p}`)
      process.exitCode = 1
      return
    }
    console.log('gen-assets.mjs --check: committed assets match a fresh generation.')
    return
  }

  await writeOutputs(dir, outputs)
  console.log(`gen-assets.mjs: wrote ${Object.keys(outputs).length} files to ${dir}`)
}

await main()
