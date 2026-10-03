// Dependency-free QR encoder for the walkthrough tool (M39e): byte mode, error correction M,
// versions 1-10 (up to 213 bytes: a long tunnel URL with parameters). Tested by decoding with jsQR.

// Level M per version: [ec codewords per block, group-1 blocks, group-1 data cw, group-2 blocks, group-2 data cw]
const M_TABLE = [
  null,
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
]
const ALIGN = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]
export const MAX_BYTES = 213

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x
  LOG[x] = i
  x <<= 1
  if (x & 0x100) x ^= 0x11d
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0)

function rsRemainder(data, degree) {
  let gen = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(gen.length + 1).fill(0)
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j]
      next[j + 1] ^= mul(gen[j], EXP[i])
    }
    gen = next
  }
  const rem = new Array(degree).fill(0)
  for (const byte of data) {
    const f = byte ^ rem.shift()
    rem.push(0)
    for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i + 1], f)
  }
  return rem
}

const dataCapacity = (v) => {
  const [, b1, d1, b2, d2] = M_TABLE[v]
  return b1 * d1 + b2 * d2
}

function buildCodewords(bytes, v) {
  const bits = []
  const push = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, v < 10 ? 8 : 16)
  for (const b of bytes) push(b, 8)
  const cap = dataCapacity(v) * 8
  push(0, Math.min(4, cap - bits.length))
  while (bits.length % 8) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  for (let pad = 0xec; data.length < dataCapacity(v); pad ^= 0xec ^ 0x11) data.push(pad)
  const [ecLen, b1, d1, b2, d2] = M_TABLE[v]
  const blocks = []
  let at = 0
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2
    const d = data.slice(at, at + len)
    at += len
    blocks.push({ d, ec: rsRemainder(d, ecLen) })
  }
  const out = []
  for (let i = 0; i < Math.max(d1, d2); i++)
    for (const b of blocks) if (i < b.d.length) out.push(b.d[i])
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i])
  return out
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

function penalty(m) {
  const n = m.length
  let p = 0
  const line = (get) => {
    for (let a = 0; a < n; a++) {
      let run = 1
      let s = ''
      for (let b = 0; b < n; b++) {
        const c = get(a, b)
        s += c ? '1' : '0'
        if (b > 0 && c === get(a, b - 1)) {
          run++
          if (run === 5) p += 3
          else if (run > 5) p++
        } else run = 1
      }
      for (const pat of ['10111010000', '00001011101']) {
        for (let i = s.indexOf(pat); i >= 0; i = s.indexOf(pat, i + 1)) p += 40
      }
    }
  }
  line((a, b) => m[a][b])
  line((a, b) => m[b][a])
  let dark = 0
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (m[y][x]) dark++
      if (
        x + 1 < n &&
        y + 1 < n &&
        m[y][x] === m[y][x + 1] &&
        m[y][x] === m[y + 1][x] &&
        m[y][x] === m[y + 1][x + 1]
      )
        p += 3
    }
  return p + 10 * Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5)
}

const bit = (x, i) => ((x >>> i) & 1) !== 0

/** The 15 format bits for level M and `mask` (BCH(15,5), xor 0x5412). */
function formatBits(mask) {
  let rem = mask
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((mask << 10) | rem) ^ 0x5412
}

/** Both copies of the format bits plus the always-dark module. */
function placeFormat(set, bits, size) {
  for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i))
  set(8, 7, bit(bits, 6))
  set(8, 8, bit(bits, 7))
  set(7, 8, bit(bits, 8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i))
  set(8, size - 8, true)
}

/** @returns {{ size: number, version: number, mask: number, dark: boolean[][] }} */
export function encodeQr(text) {
  const bytes = [...new TextEncoder().encode(text)]
  let v = 1
  while (v <= 10 && dataCapacity(v) < bytes.length + (v < 10 ? 2 : 3)) v++
  if (v > 10) throw new Error(`QR: ${bytes.length} bytes do not fit version 10 at level M`)
  const size = 17 + 4 * v
  const cw = buildCodewords(bytes, v)
  const base = Array.from({ length: size }, () => new Array(size).fill(false))
  const fn = Array.from({ length: size }, () => new Array(size).fill(false))
  const setFn = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    base[y][x] = dark
    fn[y][x] = true
  }
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0)
    setFn(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ])
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        setFn(cx + dx, cy + dy, d !== 2 && d !== 4)
      }
  const al = ALIGN[v]
  for (let i = 0; i < al.length; i++)
    for (let j = 0; j < al.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === al.length - 1) ||
        (i === al.length - 1 && j === 0)
      )
        continue
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          setFn(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  placeFormat(setFn, formatBits(0), size)
  if (v >= 7) {
    let rem = v
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (v << 12) | rem
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFn(a, b, bit(bits, i))
      setFn(b, a, bit(bits, i))
    }
  }
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        if (!fn[y][x] && i < cw.length * 8) {
          base[y][x] = bit(cw[i >>> 3], 7 - (i & 7))
          i++
        }
      }
  }
  let best = null
  for (let mask = 0; mask < 8; mask++) {
    const m = base.map((row, y) => row.map((d, x) => (fn[y][x] ? d : d !== MASKS[mask](x, y))))
    const score = penalty(m)
    if (!best || score < best.score) best = { score, mask, m }
  }
  const dark = best.m
  // The format bits depend on the chosen mask: redraw them into the result.
  const final = { size, version: v, mask: best.mask, dark }
  const put = (x, y, d) => {
    dark[y][x] = d
  }
  placeFormat(put, formatBits(best.mask), size)
  return final
}

/** Inline SVG, `quiet` modules of white border (4 is the spec's minimum). */
export function qrSvg(text, { quiet = 4 } = {}) {
  const { size, dark } = encodeQr(text)
  const n = size + 2 * quiet
  let d = ''
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; ) {
      if (!dark[y][x]) {
        x++
        continue
      }
      let run = 1
      while (x + run < size && dark[y][x + run]) run++
      d += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`
      x += run
    }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

/** Terminal rendering for a dark background: light modules (and the quiet zone) are drawn as blocks. */
export function qrTerminal(text, { quiet = 2 } = {}) {
  const { size, dark } = encodeQr(text)
  const at = (x, y) => x < 0 || y < 0 || x >= size || y >= size || !dark[y][x] // true = light
  const rows = []
  for (let y = -quiet; y < size + quiet; y += 2) {
    let row = ''
    for (let x = -quiet; x < size + quiet; x++) {
      const t = at(x, y)
      const b = at(x, y + 1)
      row += t && b ? '█' : t ? '▀' : b ? '▄' : ' '
    }
    rows.push(row)
  }
  return rows.join('\n')
}
