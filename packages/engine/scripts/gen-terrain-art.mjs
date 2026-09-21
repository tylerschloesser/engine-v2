// `node scripts/gen-terrain-art.mjs`: the terrain fixture's own asset script (0018 §4: "the game's
// asset script (no engine tool, no npm dependency)"), run once by hand and its output checked in
// like any other art asset (docs/plan/09-renderer-terrain.md Scope: "a generated flat-colour
// tiles.png"). Writes `tiles.png`/`tiles.json` into `tests/browser/pages/public/terrain/`, Vite's
// `publicDir` for the browser-suite fixture app, so `terrain.html` fetches them at `/terrain/*`
// under both `vite dev` and the built `vite preview` the browser suite runs against.
//
// M09b (docs/plan/09b-terrain-art-and-lifecycle.md Planning decisions "Probe-friendly fixture
// art"): extends M09's four cells rather than replacing them (`tile_px` shrunk from 16 to 4 --
// M09's own probes only ever assert flat cell *colours*, never a size, and every cell stays
// uniformly coloured under any mip/filter, so this is colour-preserving for every M09 test) and
// appends a 3-variant visual plus two differing-priority, 2-texel-band visuals for M09b's own
// hash/dither probes.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodePNG } from './lib/png.mjs'

const outDir = fileURLToPath(new URL('../tests/browser/pages/public/terrain/', import.meta.url))
mkdirSync(outDir, { recursive: true })

const TILE_PX = 4
const COLUMNS = 4

// Cell index -> flat RGBA colour. Visual ids (below) are independent of cell index: `tiles.json`'s
// `first` is what maps one to the other (docs/plan/09-renderer-terrain.md Planning decisions
// "tiles.json schema v1").
const CELLS = [
  [0, 0, 0, 255], // cell 0: black -- visual 0, the "nothing drawn here" sentinel colour
  [34, 139, 34, 255], // cell 1: grass green -- visual 1 (a base terrain)
  [30, 80, 200, 255], // cell 2: water blue -- visual 2 (a base terrain, for the chunk-border probe)
  [230, 140, 20, 255], // cell 3: ore orange -- visual 5 (a resource, drawn over its base)
  [255, 0, 255, 255], // cell 4: variant 0 (magenta) -- visual 6's first variant
  [0, 255, 255, 255], // cell 5: variant 1 (cyan) -- visual 6's second variant
  [255, 255, 0, 255], // cell 6: variant 2 (yellow) -- visual 6's third variant
  [90, 90, 90, 255], // cell 7: dark grey -- visual 7, priority 1, band 2 (the dithering "loser")
  [220, 20, 60, 255], // cell 8: crimson -- visual 8, priority 2, band 2 (the dithering "winner")
]

const rows = Math.ceil(CELLS.length / COLUMNS)
const width = COLUMNS * TILE_PX
const height = rows * TILE_PX
const rgba = new Uint8Array(width * height * 4)
for (let cell = 0; cell < CELLS.length; cell++) {
  const [r, g, b, a] = CELLS[cell]
  const col = cell % COLUMNS
  const row = Math.floor(cell / COLUMNS)
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      const px = col * TILE_PX + x
      const py = row * TILE_PX + y
      const i = (py * width + px) * 4
      rgba[i] = r
      rgba[i + 1] = g
      rgba[i + 2] = b
      rgba[i + 3] = a
    }
  }
}

writeFileSync(`${outDir}tiles.png`, encodePNG(width, height, rgba))

const manifest = {
  version: 1,
  image: 'tiles.png',
  tile_px: TILE_PX,
  columns: COLUMNS,
  visuals: {
    0: { first: 0, variants: 1, flags: [], priority: 0, band: 0 },
    1: { first: 1, variants: 1, flags: [], priority: 0, band: 0 },
    2: { first: 2, variants: 1, flags: [], priority: 0, band: 0 },
    5: { first: 3, variants: 1, flags: [], priority: 0, band: 0 },
    // M09b additions (Planning decisions "Probe-friendly fixture art"):
    6: { first: 4, variants: 3, flags: [], priority: 0, band: 0 }, // variant selection
    7: { first: 7, variants: 1, flags: [], priority: 1, band: 2 }, // dithering "loser"
    8: { first: 8, variants: 1, flags: [], priority: 2, band: 2 }, // dithering "winner"
  },
}
writeFileSync(`${outDir}tiles.json`, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`wrote ${outDir}tiles.png (${width}x${height}) and tiles.json`)
