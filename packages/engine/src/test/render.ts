// `engine/test`: renders one frame into a caller-supplied offscreen target and reads it back
// (docs/plan/09-renderer-terrain.md Seams: `renderTo`/`readPixels`, `tileCentrePx`, `expectPixel`;
// docs/decisions/0020-testing-strategy.md §6's "semantic pixel probes" gate). Never imported by
// production code; this file is step 2's own (Deviations), so `tileCentrePx`'s camera parameter is a
// small structural type rather than an import of step 4's `render/terrain.ts`.
//
// Step 5 (Deviations "Steps 5-7"): `renderTo`/`readPixels` are overloaded to also take a `Client`
// (the brief's own Provides shape), paired with the `TerrainRenderer` a test built around it via
// `attachRenderer` -- the two-argument `renderTo(renderer, opts)` shape from steps 2-4 stays for the
// three tests that still hand-fill the renderer's textures directly (no client, no worker).
import type { Client } from '../client.js'
import type { DrawablesRenderer } from '../render/drawables.js'
import type { TerrainRenderer } from '../render/terrain.js'
import { createUploadDrain, type UploadDrain } from '../render/upload.js'
import { RingConsumer } from '../sab/ring.js'

/** The subset of `render/terrain.ts`'s `FrameUniformValues` (0018 §5) `tileCentrePx` needs; a
 * structural type, not an import, so this file has no dependency on `render/terrain.ts`. */
export type CameraFrame = {
  camTileX: number
  camTileY: number
  camFracX: number
  camFracY: number
  viewportPxW: number
  viewportPxH: number
  tilesPerPx: number
}

/** Anything that can draw one frame into a target: `TerrainRenderer` today, a fuller
 * `frame-loop.ts`-owned renderer once M17 adds sprites (docs/plan/09-renderer-terrain.md
 * Deviations: the brief's `renderTo(client, ...)` names a "client" that doesn't exist in this
 * milestone's scope -- rendering is main-thread-only and no worker is involved in a hand-filled
 * probe scene, so this takes the renderer object directly instead). */
export type Renderable = {
  readonly device: GPUDevice
  draw(target: GPUTexture): void
}

export type RenderTarget = {
  readonly device: GPUDevice
  readonly texture: GPUTexture
  readonly width: number
  readonly height: number
}

/** `readPixels`'s return shape (docs/plan/09-renderer-terrain.md Deviations: the brief says
 * `Promise<Uint8Array>`; `expectPixel`/`tileCentrePx` need the width to index a pixel, and there is
 * no separate place to carry it once the bytes leave the target, so this small struct carries it
 * instead of a bare buffer). */
export type PixelBuffer = {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

const BYTES_PER_PIXEL = 4

function align256(bytes: number): number {
  return Math.ceil(bytes / 256) * 256
}

function isClient(v: Renderable | Client | RenderTarget): v is Client {
  return typeof (v as Client).writeCameraAndWake === 'function'
}

/** `renderTo(client, opts)`'s own bookkeeping: which `TerrainRenderer` a test built around a given
 * client (`attachRenderer`), and the `RenderTarget` its last `renderTo` call produced (so
 * `readPixels(client)` needs no target argument either). */
const clientRenderers = new WeakMap<Client, TerrainRenderer>()
const clientTargets = new WeakMap<Client, RenderTarget>()

/** Pairs `client` with the `TerrainRenderer` a test built around it, so `renderTo(client, opts)`/
 * `readPixels(client)` need no renderer argument (docs/plan/09-renderer-terrain.md Seams,
 * Provides). Call once, before the first `renderTo(client, ...)`. */
export function attachRenderer(client: Client, renderer: TerrainRenderer): void {
  clientRenderers.set(client, renderer)
}

function rendererOf(client: Client): TerrainRenderer {
  const r = clientRenderers.get(client)
  if (!r) throw new Error('renderTo(client, ...): call attachRenderer(client, renderer) first')
  return r
}

function newTarget(
  renderer: TerrainRenderer | Renderable,
  width: number,
  height: number,
): RenderTarget {
  const texture = renderer.device.createTexture({
    label: 'renderTo-target',
    size: [width, height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.TEXTURE_BINDING,
  })
  return { device: renderer.device, texture, width, height }
}

/** Creates a fresh `rgba8unorm` offscreen target (0020 §6) of `width`x`height`, draws one frame of
 * `renderer` into it, and returns the target for `readPixels`. A fresh texture per call is
 * test-only (`src/test/**` is exempt from `.claude/rules/hot-paths.md`); production reuses one
 * target every frame instead. */
export function renderTo(
  renderer: Renderable,
  opts: { width: number; height: number },
): RenderTarget
/** `renderTo(client, opts)` (Seams, Provides): drains `client.uploadRing` fully -- not under a
 * per-frame budget, a test convenience `src/test/**`'s own exemption from `.claude/rules/
 * hot-paths.md` allows -- into the renderer `attachRenderer` paired with `client`, then draws.
 * `renderer.writeFrameUniform`/camera state are the caller's own job first, same as the
 * renderer-only overload above. */
export function renderTo(client: Client, opts: { width: number; height: number }): RenderTarget
export function renderTo(
  target: Renderable | Client,
  opts: { width: number; height: number },
): RenderTarget {
  if (isClient(target)) {
    const renderer = rendererOf(target)
    const consumer = new RingConsumer(target.uploadRing)
    const drain = createUploadDrain(consumer, renderer)
    for (;;) {
      const { records } = drain.drain(Number.MAX_SAFE_INTEGER)
      if (records === 0) break
    }
    const result = newTarget(renderer, opts.width, opts.height)
    renderer.draw(result.texture)
    clientTargets.set(target, result)
    return result
  }
  const renderer = target
  const result = newTarget(renderer, opts.width, opts.height)
  renderer.draw(result.texture)
  return result
}

/** `copyTextureToBuffer` + `mapAsync` (0020 §6), stripping `bytesPerRow` padding so the returned
 * buffer is tightly packed RGBA8 (`(y * width + x) * 4`). */
export function readPixels(target: RenderTarget): Promise<PixelBuffer>
/** `readPixels(client)` (Seams, Provides): reads back whatever the last `renderTo(client, ...)`
 * call for this client drew. */
export function readPixels(client: Client): Promise<PixelBuffer>
export async function readPixels(arg: RenderTarget | Client): Promise<PixelBuffer> {
  const target = isClient(arg) ? clientTargets.get(arg) : arg
  if (!target) throw new Error('readPixels(client): call renderTo(client, ...) first')
  return readPixelsFromTarget(target)
}

async function readPixelsFromTarget(target: RenderTarget): Promise<PixelBuffer> {
  const bytesPerRow = align256(target.width * BYTES_PER_PIXEL)
  const buffer = target.device.createBuffer({
    size: bytesPerRow * target.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = target.device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture: target.texture }, { buffer, bytesPerRow }, [
    target.width,
    target.height,
  ])
  target.device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const mapped = new Uint8Array(buffer.getMappedRange())
  const data = new Uint8Array(target.width * target.height * BYTES_PER_PIXEL)
  const tightRowBytes = target.width * BYTES_PER_PIXEL
  for (let y = 0; y < target.height; y++) {
    data.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + tightRowBytes), y * tightRowBytes)
  }
  buffer.unmap()
  buffer.destroy()
  return { width: target.width, height: target.height, data }
}

/** Reads one mip level of an arbitrary `rgba8unorm` texture back to CPU (docs/plan/
 * 17b-sprites-and-frame-budget.md, `sprite.no_bleed_at_mip1`): the same `copyTextureToBuffer` +
 * `mapAsync` shape `readPixelsFromTarget` uses for a render target, generalised with an explicit mip
 * level and caller-supplied `width`/`height` (that level's own dimensions -- the JS `GPUTexture`
 * object exposes only the base level's). Lets a test inspect what the mip chain actually generated
 * (here, whether a sprite's own extruded padding survived into mip 1) directly, instead of reasoning
 * through the vertex/fragment sampling math's own texel-centre bias to find a screen pixel that
 * exercises it -- the same trap the brief's own binding rule warns about ("every readback probe
 * sits off texel centres"), rediscovered here one level removed: a *screen* pixel chosen to avoid a
 * geometry texel centre can still land exactly on a *mip* texel centre by the sampler's own -0.5
 * bias, sampling one full, unblended source texel with no way to tell from outside whether the mip
 * chain blended correctly. */
export async function readTextureMip(
  device: GPUDevice,
  texture: GPUTexture,
  mipLevel: number,
  width: number,
  height: number,
): Promise<PixelBuffer> {
  const bytesPerRow = align256(width * BYTES_PER_PIXEL)
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture, mipLevel }, { buffer, bytesPerRow }, [width, height])
  device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const mapped = new Uint8Array(buffer.getMappedRange())
  const data = new Uint8Array(width * height * BYTES_PER_PIXEL)
  const tightRowBytes = width * BYTES_PER_PIXEL
  for (let y = 0; y < height; y++) {
    data.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + tightRowBytes), y * tightRowBytes)
  }
  buffer.unmap()
  buffer.destroy()
  return { width, height, data }
}

/** Asserts pixel `(x, y)` of `pixels` is `rgba` within `tol` per channel (0020 §6's own tolerance
 * language: "≤ 2/255 per channel"). Throws a descriptive `Error` naming the pixel, channel and
 * values on the first mismatch. */
export function expectPixel(
  pixels: PixelBuffer,
  x: number,
  y: number,
  rgba: readonly [number, number, number, number],
  tol: number,
): void {
  if (x < 0 || x >= pixels.width || y < 0 || y >= pixels.height) {
    throw new RangeError(
      `expectPixel: (${x}, ${y}) is outside the ${pixels.width}x${pixels.height} buffer`,
    )
  }
  const i = (y * pixels.width + x) * 4
  const channels = ['r', 'g', 'b', 'a'] as const
  for (let c = 0; c < 4; c++) {
    const got = pixels.data[i + c] as number
    const want = rgba[c] as number
    if (Math.abs(got - want) > tol) {
      throw new Error(
        `expectPixel(${x}, ${y}) channel ${channels[c]}: got ${got}, want ${want} (tol ${tol})`,
      )
    }
  }
}

// Open gate failures item 7, gate round 1: Seams' Provides names these four as `engine/test`
// counters, but `drawCalls`/`pageSlotsUsed` lived only as `TerrainRenderer` methods and
// `uploadBytes`/`uploadRecords` only as a `drain()` call's own per-call return value -- every page
// read them straight off the renderer/drain object instead of importing from `engine/test`. These
// are thin pass-throughs (`Pick<...>` rather than the full interface, so a fake needs only the one
// method a test actually exercises) reading each object's own in-place counter; M17/M17b are meant
// to consume them from here rather than reaching into the renderer/drain themselves.

/** `engine/test`'s `drawCalls` counter (Seams, Provides): total `draw()` calls since `renderer` was
 * created. */
export function drawCalls(renderer: Pick<TerrainRenderer, 'drawCalls'>): number {
  return renderer.drawCalls()
}

/** `engine/test`'s `pageSlotsUsed` counter (Seams, Provides): total distinct page slots written
 * since `renderer` was created. */
export function pageSlotsUsed(renderer: Pick<TerrainRenderer, 'pageSlotsUsed'>): number {
  return renderer.pageSlotsUsed()
}

/** `engine/test`'s `uploadBytes` counter (Seams, Provides): cumulative bytes drained since `drain`
 * was created, across every `drain.drain(...)` call -- not one call's own return value. */
export function uploadBytes(drain: Pick<UploadDrain, 'bytesTotal'>): number {
  return drain.bytesTotal()
}

/** `engine/test`'s `uploadRecords` counter (Seams, Provides): cumulative records drained since
 * `drain` was created. */
export function uploadRecords(drain: Pick<UploadDrain, 'recordsTotal'>): number {
  return drain.recordsTotal()
}

// docs/plan/17-drawlist-and-sprites.md, `engine/test` (steps 4-6): pass-throughs for `render/
// drawables.ts`'s own counters, same shape as `drawCalls`/`pageSlotsUsed` above.

/** `engine/test`'s `instanceBytes` counter: cumulative bytes copied into the drawables instance
 * buffer since `renderer` was created. */
export function instanceBytes(renderer: Pick<DrawablesRenderer, 'instanceBytes'>): number {
  return renderer.instanceBytes()
}

/** `engine/test`'s `pipelineSwitches` counter: cumulative uber-quad `setPipeline` calls since
 * `renderer` was created. */
export function pipelineSwitches(renderer: Pick<DrawablesRenderer, 'pipelineSwitches'>): number {
  return renderer.pipelineSwitches()
}

/** `engine/test`'s `drawListDropped` counter: the last-acquired DrawList slot's own header
 * `dropped` field. */
export function drawListDropped(renderer: Pick<DrawablesRenderer, 'drawListDropped'>): number {
  return renderer.drawListDropped()
}

/** The pixel centre of tile `(tx, ty)` under `camera`'s frame-uniform values (0018 §5's own formula,
 * inverted): `out.x`/`out.y` are set in place (no allocation; `src/test/**` still avoids it here
 * since a probe scene calls this once per assertion, not per frame). */
export function tileCentrePx(
  camera: CameraFrame,
  tx: number,
  ty: number,
  out: { x: number; y: number },
): void {
  const relX = tx + 0.5 - camera.camTileX - camera.camFracX
  const relY = ty + 0.5 - camera.camTileY - camera.camFracY
  out.x = camera.viewportPxW / 2 + relX / camera.tilesPerPx
  out.y = camera.viewportPxH / 2 + relY / camera.tilesPerPx
}
