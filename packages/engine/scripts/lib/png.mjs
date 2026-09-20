// Minimal 8-bit RGBA PNG encoder (repo-only script utility; no npm dependency, 0017 §7's "npm: zero
// runtime dependencies" spirit extended to scripts too): used by `scripts/gen-terrain-art.mjs` to
// write the terrain fixture's flat-colour `tiles.png`, and importable by a browser spec that wants
// to dump a failing readback as a PNG next to its expected image (docs/plan/09-renderer-terrain.md
// Context artifacts: ".claude/skills/run-tests/SKILL.md" names where those land).
import { deflateSync } from 'node:zlib'

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

/** Encodes `rgba` (a `Uint8Array`/`Buffer` of `width * height * 4` bytes, row-major, no padding) as
 * an 8-bit RGBA PNG with no interlacing and a `none` filter on every row. Returns a `Buffer`. */
export function encodePNG(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new RangeError(`encodePNG: expected ${width * height * 4} bytes, got ${rgba.length}`)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // compression method
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace method: none

  const rowBytes = width * 4
  const raw = Buffer.alloc((rowBytes + 1) * height)
  const src = Buffer.from(rgba.buffer ?? rgba, rgba.byteOffset ?? 0, rgba.length ?? rgba.byteLength)
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
