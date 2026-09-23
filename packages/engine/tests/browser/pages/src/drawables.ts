// `drawables.html`: the readback probe scene host for `draw.*.spec.ts`/`sprite.*.spec.ts` (docs/plan/
// 17-drawlist-and-sprites.md Tests added; docs/plan/17b-sprites-and-frame-budget.md Tests added:
// `loadSprites()` fetches the real `/drawables/sprites.json` fixture, `scripts/gen-sprite-art.mjs`'s
// own output). Scenes hand-fill the DrawList header/body directly through `window.__drawables.
// acquireFromBytes` (no worker, no ABI instance, no SAB triple buffer -- the real production path,
// driven by a real client, is the `drawables` zero-GC page and `draw.triple_newest_wins`), mirroring
// `terrain.ts`'s own steps-2-4 precedent (M09).

import { type LoadedSpriteAtlas, loadSpriteAtlas } from '../../../../src/render/atlas.ts'
import type { RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import type { DrawablesRenderer, DrawFrameUniformValues } from '../../../../src/render/drawables.ts'
import { createDrawablesRenderer } from '../../../../src/render/drawables.ts'
import { readPixels, readTextureMip, renderTo } from '../../../../src/test/render.ts'

declare global {
  interface Window {
    __pageReady?: true
  }
}

let device: RendererDevice | undefined
let renderer: DrawablesRenderer | undefined
let spriteAtlas: LoadedSpriteAtlas | undefined

function requireRenderer(): DrawablesRenderer {
  if (!renderer) throw new Error('__drawables.init() must be called first')
  return renderer
}

window.__drawables = {
  async init() {
    device = await initDevice()
    renderer = await createDrawablesRenderer(device.device, {
      colorFormat: 'rgba8unorm',
      checkCompilation: device.checkCompilation,
    })
    return { adapterInfo: device.adapterInfo }
  },

  writeFrameUniform(v: DrawFrameUniformValues) {
    requireRenderer().writeFrameUniform(v)
  },

  acquireFromBytes(header, body) {
    requireRenderer().acquireFromBytes(new Uint8Array(header), new Uint8Array(body))
  },

  async renderAndRead(width, height) {
    const target = renderTo(requireRenderer(), { width, height })
    const pixels = await readPixels(target)
    return { width: pixels.width, height: pixels.height, data: Array.from(pixels.data) }
  },

  errors() {
    return device ? device.errors() : []
  },

  drawCalls() {
    return requireRenderer().drawCalls()
  },

  pipelineSwitches() {
    return requireRenderer().pipelineSwitches()
  },

  instanceBytes() {
    return requireRenderer().instanceBytes()
  },

  drawListDropped() {
    return requireRenderer().drawListDropped()
  },

  async loadSprites() {
    const d = device
    if (!d) throw new Error('__drawables.init() must be called first')
    const atlas = await loadSpriteAtlas(d.device, '/drawables/sprites.json', {
      checkCompilation: d.checkCompilation,
    })
    spriteAtlas = atlas
    requireRenderer().setSpriteAtlas(atlas)
  },

  gpuBytes() {
    return requireRenderer().gpuBytes()
  },

  async readAtlasMip1() {
    if (!spriteAtlas) throw new Error('__drawables.loadSprites() must be called first')
    const d = device
    if (!d) throw new Error('__drawables.init() must be called first')
    const mip1W = Math.max(1, spriteAtlas.atlasTexture.width >> 1)
    const mip1H = Math.max(1, spriteAtlas.atlasTexture.height >> 1)
    const pixels = await readTextureMip(d.device, spriteAtlas.atlasTexture, 1, mip1W, mip1H)
    return { width: pixels.width, height: pixels.height, data: Array.from(pixels.data) }
  },
}

window.__pageReady = true
