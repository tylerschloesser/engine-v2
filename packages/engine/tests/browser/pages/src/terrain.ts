// `terrain.html`: the readback probe scene host for `tests/browser/terrain-readback.spec.ts`
// (docs/plan/09-renderer-terrain.md Tests added). Steps 2-4 of this milestone: device init, the
// shader and bind groups, a hand-filled page/indirection texture -- no worker, no ABI instance
// (Deviations: the real ring-driven data path is step 5's).

import { loadTileArt } from '../../../../src/render/art.ts'
import type { RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import type { TerrainRenderer } from '../../../../src/render/terrain.ts'
import { createTerrainRenderer } from '../../../../src/render/terrain.ts'
import { readPixels, renderTo } from '../../../../src/test/render.ts'

// `window.__terrain`'s type comes from `../support/terrain-window.d.ts` (shared with the spec
// file): that file is in this project's `tsconfig.json` `include`, so its global augmentation
// applies here with no import (ambient declarations need no reference; an `import` of a `.d.ts`
// file would also break at runtime, since Vite has nothing to serve for it).

declare global {
  interface Window {
    __pageReady?: true
  }
}

let device: RendererDevice | undefined
let renderer: TerrainRenderer | undefined

function requireRenderer(): TerrainRenderer {
  if (!renderer) throw new Error('__terrain.init() must be called first')
  return renderer
}

window.__terrain = {
  async init(opts) {
    device = await initDevice(
      opts?.forceViewProbe !== undefined
        ? { test: { forceViewProbe: opts.forceViewProbe } }
        : undefined,
    )
    renderer = createTerrainRenderer(device.device, {
      colorFormat: 'rgba8unorm',
      viewProbePasses: device.viewProbePasses,
    })
    return { adapterInfo: device.adapterInfo, viewProbePasses: device.viewProbePasses }
  },

  async loadArt(url) {
    const r = requireRenderer()
    const art = await loadTileArt(r.device, url)
    r.setTileArray(art.texture)
    r.writeVisualTable(art.visualTableBytes)
  },

  writeFrameUniform(v) {
    requireRenderer().writeFrameUniform({
      camTileX: v.camTileX,
      camTileY: v.camTileY,
      camFracX: v.camFracX,
      camFracY: v.camFracY,
      viewportPxW: v.viewportPxW,
      viewportPxH: v.viewportPxH,
      tilesPerPx: v.tilesPerPx,
      seed: v.seed ?? 0,
      cursorTileX: v.cursorTileX ?? 0,
      cursorTileY: v.cursorTileY ?? 0,
      cursorValid: v.cursorValid ?? 0,
      neighbourCutoffPx: v.neighbourCutoffPx ?? 0,
    })
  },

  writePageChunk(slot, texels) {
    const out: { base: number; resource: number }[] = []
    for (let i = 0; i < texels.length; i += 2) {
      out.push({ base: texels[i] as number, resource: texels[i + 1] as number })
    }
    requireRenderer().writePageChunk(slot, out)
  },

  writePageTexel(slot, index, base, resource) {
    requireRenderer().writePageTexel(slot, index, { base, resource })
  },

  writeIndir(entries) {
    requireRenderer().writeIndir(entries)
  },

  async renderAndRead(width, height) {
    const target = renderTo(requireRenderer(), { width, height })
    const pixels = await readPixels(target)
    return { width: pixels.width, height: pixels.height, data: Array.from(pixels.data) }
  },

  errors() {
    return device ? device.errors() : []
  },
}

window.__pageReady = true
