// `engine/test`: renders one frame into a caller-supplied offscreen target and reads it back
// (docs/plan/09-renderer-terrain.md Seams: `renderTo`/`readPixels`, `tileCentrePx`, `expectPixel`;
// docs/decisions/0020-testing-strategy.md §6's "semantic pixel probes" gate). Never imported by
// production code; this file is step 2's own (Deviations), so `tileCentrePx`'s camera parameter is a
// small structural type rather than an import of step 4's `render/terrain.ts`.

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

/** Creates a fresh `rgba8unorm` offscreen target (0020 §6) of `width`x`height`, draws one frame of
 * `renderer` into it, and returns the target for `readPixels`. A fresh texture per call is
 * test-only (`src/test/**` is exempt from `.claude/rules/hot-paths.md`); production reuses one
 * target every frame instead. */
export function renderTo(
  renderer: Renderable,
  opts: { width: number; height: number },
): RenderTarget {
  const texture = renderer.device.createTexture({
    label: 'renderTo-target',
    size: [opts.width, opts.height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.TEXTURE_BINDING,
  })
  renderer.draw(texture)
  return { device: renderer.device, texture, width: opts.width, height: opts.height }
}

/** `copyTextureToBuffer` + `mapAsync` (0020 §6), stripping `bytesPerRow` padding so the returned
 * buffer is tightly packed RGBA8 (`(y * width + x) * 4`). */
export async function readPixels(target: RenderTarget): Promise<PixelBuffer> {
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
