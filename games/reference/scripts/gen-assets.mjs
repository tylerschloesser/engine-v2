#!/usr/bin/env node

// `scripts/gen-assets.mjs` (docs/plan/20-reference-game-v0.md Scope): plain Node, no npm
// dependency (PNG written with `node:zlib`), deterministic, byte-reproducible. Emits
// `assets/tiles.png` + `tiles.json` (16 px tiles, 4 variants per terrain, dither priority and band
// per visual) and an empty-but-valid `assets/sprites.png` + `sprites.json` (no sprites yet: the
// player circle and DOM UI are M20b's, crafting/building is M32's).
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

  // Empty-but-valid sprite atlas: 1x1 fully transparent pixel, no sprites declared yet.
  const spritesPng = encodePNG(1, 1, new Uint8Array([0, 0, 0, 0]))
  const spritesJson = `${JSON.stringify(
    { version: 1, image: 'sprites.png', padding: 2, sprites: {} },
    null,
    2,
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
