// Ambient `window.__drawables` type (docs/plan/17-drawlist-and-sprites.md, steps 4-6; docs/plan/
// 17b-sprites-and-frame-budget.md steps 1-3: `loadSprites`/`gpuBytes`), shared by `drawables.html`'s
// page script and `draw.*.spec.ts`/`sprite.*.spec.ts` -- same shape as `terrain-window.d.ts`'s own
// precedent (M09): a hand-filled scene, no worker, no ABI instance.
export {}

declare global {
  interface Window {
    __drawables?: {
      init(): Promise<{
        adapterInfo: {
          vendor: string
          architecture: string
          device: string
          description: string
          isFallbackAdapter: boolean | null
        }
      }>
      writeFrameUniform(v: {
        camTileX: number
        camTileY: number
        camFracX: number
        camFracY: number
        windowOriginX: number
        windowOriginY: number
        cursorTileX: number
        cursorTileY: number
        viewportPxW: number
        viewportPxH: number
        tilesPerPx: number
        cursorValid: number
      }): void
      /** `header.length === 1024`, `body.length` a multiple of 32: the exact `RegionId::DrawList`
       * slot wire format (`client/drawlist.rs`), built by the spec (`tests/browser/support/
       * draw-scene.ts`). */
      acquireFromBytes(header: number[], body: number[]): void
      renderAndRead(
        width: number,
        height: number,
      ): Promise<{ width: number; height: number; data: number[] }>
      errors(): string[]
      drawCalls(): number
      pipelineSwitches(): number
      instanceBytes(): number
      drawListDropped(): number
      /** Fetches and installs `/drawables/sprites.json` (`render/atlas.ts`'s `loadSpriteAtlas`);
       * `init()` must be called first. */
      loadSprites(): Promise<void>
      /** `engine/test`'s `gpuBytes` counter (docs/plan/17b-sprites-and-frame-budget.md). */
      gpuBytes(): number
      /** Reads the sprite atlas's own mip level 1 back to CPU (`sprite.no_bleed_at_mip1`);
       * `loadSprites()` must be called first. */
      readAtlasMip1(): Promise<{ width: number; height: number; data: number[] }>
    }
  }
}
