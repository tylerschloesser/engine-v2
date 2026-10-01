// `attachClientDrawables` (docs/plan/33c-drawables-on-real-pages.md Scope 1): the one public way a
// game page draws its client's DrawList. Builds the drawables renderer over the client's own
// `DrawListSlot`, loads the sprite atlas named by `ClientOptions.assets.sprites` (when present) and
// attaches the renderer to the terrain renderer's pass (`attachDrawables`, one shared render pass,
// 0018). Per frame, inside `TerrainRenderer.draw()`'s own pass callback, it then uploads the slot
// `Client.pick.acquire()` last took (`drawables.acquire()`) and writes the DrawFrame uniform: the
// camera fields as raw bytes from the terrain's staged uniform (no double read per field, which
// allocates in unoptimised code), the cursor from `client.cameraState`, so a page needs no other per-frame call beyond
// the `acquire` phase `createRealFrameLoop` already runs (a hand-rolled loop calls
// `client.pick.acquire()` before `renderer.draw`). Allocation-free per frame
// (`.claude/rules/hot-paths.md`): no object or closure created in `encodeInto`.
import type { Client } from '../client.js'
import { loadSpriteAtlas } from './atlas.js'
import type { RendererDevice } from './device.js'
import { attachDrawables, createDrawablesRenderer, type DrawablesRenderer } from './drawables.js'
import type { TerrainRenderer } from './terrain.js'

export type AttachedDrawables = {
  readonly drawables: DrawablesRenderer
  /** `true` when `client.assets.sprites` named an atlas and it is installed. */
  readonly spriteAtlasLoaded: boolean
  /** Turns the drawables pass off and on (default on), keeping everything wired: a pixel test
   * compares a frame with the pass on against the same frame with it off. */
  setEnabled(on: boolean): void
  /** The current `setEnabled` state (carried across a device rebuild by `GpuHost`). */
  isEnabled(): boolean
}

export async function attachClientDrawables(
  client: Client,
  device: RendererDevice,
  renderer: TerrainRenderer,
  opts: { colorFormat: GPUTextureFormat },
): Promise<AttachedDrawables> {
  const drawables = await createDrawablesRenderer(device.device, {
    colorFormat: opts.colorFormat,
    drawListSlot: client.drawListSlot,
    checkCompilation: device.checkCompilation,
  })
  const spritesUrl = client.assets?.sprites
  if (spritesUrl !== undefined) {
    const atlas = await loadSpriteAtlas(device.device, spritesUrl, {
      checkCompilation: device.checkCompilation,
    })
    drawables.setSpriteAtlas(atlas)
    client.pick.setSpriteTable(atlas.pivotSize)
  }

  const slot = client.drawListSlot
  const cam = client.cameraState
  drawables.bindTerrainFrame(renderer.stagedFrameUniform)
  let enabled = true
  const prepared: DrawablesRenderer = {
    ...drawables,
    encodeInto(pass) {
      if (!enabled) return 0
      drawables.acquire()
      drawables.writeFrameUniformFromTerrain(
        slot.windowOriginX,
        slot.windowOriginY,
        cam.cursorTileX,
        cam.cursorTileY,
        cam.cursorValid ? 1 : 0,
      )
      return drawables.encodeInto(pass)
    },
  }
  attachDrawables(renderer, prepared)
  return {
    drawables,
    spriteAtlasLoaded: spritesUrl !== undefined,
    setEnabled(on) {
      enabled = on
    },
    isEnabled() {
      return enabled
    },
  }
}
