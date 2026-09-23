// `drawables.html`: the readback probe scene host for `draw.*.spec.ts` (docs/plan/
// 17-drawlist-and-sprites.md Tests added). Scenes hand-fill the DrawList header/body directly
// through `window.__drawables.acquireFromBytes` (no worker, no ABI instance, no SAB triple buffer --
// the real production path, driven by a real client, is the `drawables` zero-GC page and `draw.
// triple_newest_wins`), mirroring `terrain.ts`'s own steps-2-4 precedent (M09).

import type { RendererDevice } from '../../../../src/render/device.ts'
import { initDevice } from '../../../../src/render/device.ts'
import type { DrawablesRenderer, DrawFrameUniformValues } from '../../../../src/render/drawables.ts'
import { createDrawablesRenderer } from '../../../../src/render/drawables.ts'
import { readPixels, renderTo } from '../../../../src/test/render.ts'

declare global {
  interface Window {
    __pageReady?: true
  }
}

let device: RendererDevice | undefined
let renderer: DrawablesRenderer | undefined

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
}

window.__pageReady = true
