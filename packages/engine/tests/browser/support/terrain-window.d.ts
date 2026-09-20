// Ambient `window.__terrain` type (docs/plan/09-renderer-terrain.md), shared by two separate `tsc`
// programs: `terrain.html`'s page script (`tests/browser/pages/tsconfig.json`) and
// `terrain-readback.spec.ts` (`tests/tsconfig.json`) -- written once here and included by both
// (`tests/browser/pages/tsconfig.json`'s own `include`), rather than duplicated `declare global`
// blocks that could drift apart.
export {}

declare global {
  interface Window {
    __terrain?: {
      init(opts?: { forceViewProbe?: boolean }): Promise<{
        adapterInfo: {
          vendor: string
          architecture: string
          device: string
          description: string
          isFallbackAdapter: boolean | null
        }
        viewProbePasses: boolean
      }>
      loadArt(url: string): Promise<void>
      writeFrameUniform(v: {
        camTileX: number
        camTileY: number
        camFracX: number
        camFracY: number
        viewportPxW: number
        viewportPxH: number
        tilesPerPx: number
        seed?: number
        cursorTileX?: number
        cursorTileY?: number
        cursorValid?: number
        neighbourCutoffPx?: number
      }): void
      /** `texels`: flat `[base0, resource0, base1, resource1, ...]`, length 2048 (1,024 tiles). */
      writePageChunk(slot: number, texels: number[]): void
      writePageTexel(slot: number, index: number, base: number, resource: number): void
      writeIndir(entries: { x: number; y: number; value: number }[]): void
      renderAndRead(
        width: number,
        height: number,
      ): Promise<{ width: number; height: number; data: number[] }>
      errors(): string[]
      /** `terrain.patch_one_texel` (Tests added): a real `uploadRing`-shaped SAB driven by
       * hand-built records, not a worker (docs/plan/09-renderer-terrain.md Deviations
       * "Steps 5-7") -- proves `render/upload.ts`'s CHUNK/PATCH handling directly. */
      createTestRing(): void
      /** `bytes.length` must be exactly 4,112 (`RECORD_BYTES`): a whole record, little-endian,
       * `client::upload::write_header`'s own layout. */
      stageRecord(bytes: number[]): void
      drainRing(budgetBytes: number): { bytes: number; records: number }
    }
  }
}
