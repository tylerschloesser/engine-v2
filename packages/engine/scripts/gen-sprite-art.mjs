// `node scripts/gen-sprite-art.mjs`: the `drawables` browser-suite fixture's own sprite asset script
// (0018 §4: "the game's asset script (no engine tool, no npm dependency)"), run once by hand and its
// output checked in like any other art asset -- mirrors `scripts/gen-terrain-art.mjs`'s own precedent
// (docs/plan/09b-terrain-art-and-lifecycle.md), including where it writes: `tests/browser/pages/
// public/drawables/`, Vite's `publicDir` for the browser-suite fixture app, so `drawables.html`
// fetches `sprites.json`/`sprites.png` at `/drawables/*` under both `vite dev` and the built `vite
// preview` the browser suite runs against (docs/plan/17b-sprites-and-frame-budget.md, Files touched
// names `packages/engine/fixtures/drawables/` for "generated sprites.png" -- the Rust fixture crate
// there has no `public/` of its own, the same way `fixtures/terrain/` never held `tiles.png`; this
// cut reads that line as "the art the `fx-drawables` game owns", served from the page's own public
// dir, and records the deviation).
//
// Four sprites (docs/plan/17b-sprites-and-frame-budget.md Tests added), each with a fixed,
// hand-computable purpose:
//   id 0 "quad": an 8x8 four-quadrant flat-colour cell (red/green/blue/yellow, TL/TR/BL/BR), pivot
//     [0.25, 0.75] (off-centre on both axes) and size [2, 1] tiles (non-square) -- proves pivot
//     placement and independent w/h scaling (`sprite.pivot_and_size_probe`) and, since the quadrant
//     pattern is asymmetric left/right, `FLIP_X` mirroring the sampled texture without moving the
//     sprite's own world footprint (`sprite.flip_x`).
//   id 1 "strip": three 8x8 frames laid left to right (cyan, magenta, orange) -- `frames_by_param`
//     (frame index = `floor(param)`, offsetting the rect's own x by `frame * rect.w`).
//   id 2 "bleed" (red) sits immediately next to a same-sized, unlisted blue block in the atlas image,
//     separated only by each side's own 2px extruded padding (a 4px total gap of matching flat
//     colour) -- `sprite.no_bleed_at_mip1` samples right at bleed's own edge, heavily minified (mip
//     level 1), and must read pure red; removing the padding (this script's own `EXTRUDE_PX`, set to
//     0 and rerun) lets mip 1's box filter blend in the neighbouring blue, which is how this test's
//     own failability was proven (docs/plan/17b-sprites-and-frame-budget.md Deviations).
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodePNG } from './lib/png.mjs'

const outDir = fileURLToPath(new URL('../tests/browser/pages/public/drawables/', import.meta.url))
mkdirSync(outDir, { recursive: true })

// 2px extruded padding around every sprite's own bounding box (0018 §4; Planning decisions
// "Sprite sampling" binding rule -- padding protects the fat-pixel/mip sampling from bleeding into a
// neighbouring atlas cell). Exported as a named constant so a temporary `EXTRUDE_PX = 0` rerun (the
// no-bleed test's own failability proof) is a one-line, reverted edit, never structural surgery.
export const EXTRUDE_PX = 2

const WIDTH = 96
const HEIGHT = 64
const rgba = new Uint8Array(WIDTH * HEIGHT * 4)

function setPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return
  const i = (y * WIDTH + x) * 4
  rgba[i] = color[0]
  rgba[i + 1] = color[1]
  rgba[i + 2] = color[2]
  rgba[i + 3] = color[3]
}

/** Fills `[x, y, w, h)` with `color`, then extrudes `EXTRUDE_PX` of that same flat colour outward on
 * every side -- the padded-atlas technique 0018 §4 names ("2 px extruded padding"). Only correct for
 * a flat-colour block (every sprite in this fixture is one); a real game's art script would replicate
 * each edge's own pixel row/column instead of a constant, which this fixture's flat cells make
 * unnecessary to build. */
function fillPaddedFlat(x, y, w, h, color) {
  for (let py = -EXTRUDE_PX; py < h + EXTRUDE_PX; py++) {
    for (let px = -EXTRUDE_PX; px < w + EXTRUDE_PX; px++) {
      setPixel(x + px, y + py, color)
    }
  }
}

// id 0 "quad": 8x8 at (4, 4), four 4x4 flat quadrants.
const QUAD_X = 4
const QUAD_Y = 4
const QUAD_SIZE = 8
fillPaddedFlat(QUAD_X, QUAD_Y, QUAD_SIZE, QUAD_SIZE, [0, 0, 0, 255]) // pad base colour (overwritten below)
const QUAD_COLORS = {
  tl: [255, 0, 0, 255], // red
  tr: [0, 255, 0, 255], // green
  bl: [0, 0, 255, 255], // blue
  br: [255, 255, 0, 255], // yellow
}
for (let y = 0; y < QUAD_SIZE; y++) {
  for (let x = 0; x < QUAD_SIZE; x++) {
    const half = QUAD_SIZE / 2
    const key = `${y < half ? 't' : 'b'}${x < half ? 'l' : 'r'}`
    setPixel(QUAD_X + x, QUAD_Y + y, QUAD_COLORS[key])
  }
}
// Extrude each quadrant's own edge outward into the padding independently (so the fat-pixel formula
// never blends across a *quadrant* boundary from outside the cell either -- though no test in this
// cut samples the padding of an inner boundary, only the cell's own outer edge, which every quadrant
// pixel already extends past via its own outer-edge copy below).
for (let i = 1; i <= EXTRUDE_PX; i++) {
  for (let y = 0; y < QUAD_SIZE; y++) {
    setPixel(QUAD_X - i, QUAD_Y + y, y < QUAD_SIZE / 2 ? QUAD_COLORS.tl : QUAD_COLORS.bl)
    setPixel(
      QUAD_X + QUAD_SIZE - 1 + i,
      QUAD_Y + y,
      y < QUAD_SIZE / 2 ? QUAD_COLORS.tr : QUAD_COLORS.br,
    )
  }
  for (let x = 0; x < QUAD_SIZE; x++) {
    setPixel(QUAD_X + x, QUAD_Y - i, x < QUAD_SIZE / 2 ? QUAD_COLORS.tl : QUAD_COLORS.tr)
    setPixel(
      QUAD_X + x,
      QUAD_Y + QUAD_SIZE - 1 + i,
      x < QUAD_SIZE / 2 ? QUAD_COLORS.bl : QUAD_COLORS.br,
    )
  }
}

// id 1 "strip": 3 frames, 8x8 each, contiguous (no gap between frames -- only the whole block's own
// outer edge is padded, matching a normal animation strip).
const STRIP_X = 20
const STRIP_Y = 4
const FRAME_SIZE = 8
const FRAME_COLORS = [
  [0, 255, 255, 255], // frame 0: cyan
  [255, 0, 255, 255], // frame 1: magenta
  [255, 165, 0, 255], // frame 2: orange
]
for (let i = 1; i <= EXTRUDE_PX; i++) {
  for (let y = 0; y < FRAME_SIZE; y++) {
    setPixel(STRIP_X - i, STRIP_Y + y, FRAME_COLORS[0])
    setPixel(STRIP_X + 3 * FRAME_SIZE - 1 + i, STRIP_Y + y, FRAME_COLORS[2])
  }
}
for (let f = 0; f < 3; f++) {
  for (let y = -EXTRUDE_PX; y < FRAME_SIZE + EXTRUDE_PX; y++) {
    for (let x = 0; x < FRAME_SIZE; x++) {
      setPixel(STRIP_X + f * FRAME_SIZE + x, STRIP_Y + y, FRAME_COLORS[f])
    }
  }
}

// id 2 "bleed" (red) and its unlisted neighbour (blue): each 32x32 (bigger than the other cells so
// the `no_bleed_at_mip1` probe's own minified footprint is large enough on screen to target reliably
// -- a 8x8 cell would need to be minified all the way down to a few screen pixels before mip 1 even
// applies), each padded `EXTRUDE_PX` on every side, so the gap between their own content rects is
// `2 * EXTRUDE_PX` of matching flat colour.
const BLEED_X = 4
const BLEED_Y = 20
const BLEED_SIZE = 32
const RED = [255, 0, 0, 255]
const BLUE = [0, 0, 255, 255]
fillPaddedFlat(BLEED_X, BLEED_Y, BLEED_SIZE, BLEED_SIZE, RED)
const NEIGHBOR_X = BLEED_X + BLEED_SIZE + 2 * EXTRUDE_PX
fillPaddedFlat(NEIGHBOR_X, BLEED_Y, BLEED_SIZE, BLEED_SIZE, BLUE)

writeFileSync(`${outDir}sprites.png`, encodePNG(WIDTH, HEIGHT, rgba))

const manifest = {
  version: 1,
  image: 'sprites.png',
  padding: EXTRUDE_PX,
  sprites: {
    0: {
      rect: [QUAD_X, QUAD_Y, QUAD_SIZE, QUAD_SIZE],
      pivot: [0.25, 0.75],
      size: [2, 1],
      frames: 1,
    },
    1: {
      rect: [STRIP_X, STRIP_Y, FRAME_SIZE, FRAME_SIZE],
      pivot: [0.5, 0.5],
      size: [1, 1],
      frames: 3,
    },
    2: {
      rect: [BLEED_X, BLEED_Y, BLEED_SIZE, BLEED_SIZE],
      pivot: [0.5, 0.5],
      size: [1, 1],
      frames: 1,
    },
  },
}
writeFileSync(`${outDir}sprites.json`, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`wrote ${outDir}sprites.png (${WIDTH}x${HEIGHT}) and sprites.json`)
