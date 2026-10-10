// `GpuResources` (M37b Scope; docs/decisions/0018-renderer.md §8): every
// object created from a `GPUDevice` -- the device and its probes, the terrain pipeline, page/
// indirection textures and visual table, the tile-art array and its mips, and (when a client is
// given) the drawables pass with its sprite atlas, instance buffer and bind groups -- hangs off one
// object built by this one function. Handling a device loss is "drop it, build another"
// (`gpu-host.ts`); nothing else may hold a GPU handle for longer than one call.
//
// Not covered: `tests/browser/pages/src/*` build their pieces by hand on purpose (each page tests
// one renderer in isolation) and `engine/test`'s `renderTo` targets are per-call textures.
import type { Client } from '../client.js'
import { type LoadedArt, loadTileArt } from './art.js'
import { type AttachedDrawables, attachClientDrawables } from './client-drawables.js'
import { initDevice, type RendererDevice } from './device.js'
import { createTerrainRenderer, type TerrainRenderer } from './terrain.js'

export type GpuResourcesOptions = {
  /** The one colour-target format every pipeline here is built for (the canvas's preferred format,
   * or `rgba8unorm` for an offscreen probe page). */
  colorFormat: GPUTextureFormat
  /** URL of `tiles.json` (`ClientOptions.assets.tiles`): fetched again on every rebuild (HTTP
   * cache); the visual table is rewritten from it. */
  tilesUrl: string
  /** When given, the client's DrawList is drawn in the terrain pass (`attachClientDrawables`, which
   * also loads `client.assets.sprites`). Omitted: terrain only. */
  client?: Client
  /** `ClientOptions.render.gpuTiming`: default off (nothing changes). */
  gpuTiming?: boolean
  /** Test-only, forwarded to `initDevice`. */
  test?: { forceViewProbe?: boolean }
}

export type GpuResources = {
  readonly device: RendererDevice
  readonly renderer: TerrainRenderer
  readonly art: LoadedArt
  /** `null` when `GpuResourcesOptions.client` was omitted. */
  readonly drawables: AttachedDrawables | null
  readonly colorFormat: GPUTextureFormat
}

/** The one constructor. Rejects with `NoAdapterError` (`device.ts`) when there is no adapter. */
export async function createGpuResources(opts: GpuResourcesOptions): Promise<GpuResources> {
  const device = await initDevice(
    opts.test || opts.gpuTiming
      ? {
          ...(opts.test ? { test: opts.test } : {}),
          ...(opts.gpuTiming ? { gpuTiming: true } : {}),
        }
      : undefined,
  )
  const renderer = await createTerrainRenderer(device.device, {
    colorFormat: opts.colorFormat,
    viewProbePasses: device.viewProbePasses,
    checkCompilation: device.checkCompilation,
    ...(opts.gpuTiming ? { gpuTiming: true } : {}),
  })
  const art = await loadTileArt(device.device, opts.tilesUrl, {
    checkCompilation: device.checkCompilation,
  })
  renderer.setTileArray(art.texture, art.gpuBytes)
  renderer.writeVisualTable(art.visualTableBytes)
  const drawables = opts.client
    ? await attachClientDrawables(opts.client, device, renderer, { colorFormat: opts.colorFormat })
    : null
  return { device, renderer, art, drawables, colorFormat: opts.colorFormat }
}
