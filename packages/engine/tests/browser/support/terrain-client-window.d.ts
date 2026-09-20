// Ambient `window.__terrainClient` type (docs/plan/09-renderer-terrain.md, step 5), shared by
// `terrain-client.html`'s page script and `terrain-readback.spec.ts`, the same split
// `terrain-window.d.ts` already uses for the hand-filled `window.__terrain`.
export {}

declare global {
  interface Window {
    __terrainClient?: {
      /** Real `createClient()` over `fx-terrain` (Gen + Client roles), device init, tile art
       * loaded from `/terrain/tiles.json`, and `attachRenderer` -- the whole worker -> ring ->
       * drain data path, no hand-filled textures. */
      init(): Promise<{
        adapterInfo: {
          vendor: string
          architecture: string
          device: string
          description: string
          isFallbackAdapter: boolean | null
        }
        /** `RendererDevice.sabWriteTextureOk` (Planning decisions "`writeTexture` from a SAB view
         * is unverified"): recorded so `terrain.probe_tile_colours`'s WebKit `@slow` run shows
         * whether Safari took the same path as Chromium. */
        sabWriteTextureOk: boolean
      }>
      setCamera(x: number, y: number, tilesAcross: number): void
      setHalfExtent(x: number, y: number): void
      setVelocity(x: number, y: number): void
      /** Writes the terrain shader's `FrameUniform` directly (0018 §5): the real client's own
       * camera (`setCamera`) drives worldgen/upload residency, not what the shader draws -- a
       * probe scene sets both independently, the same split `terrain-readback.spec.ts`'s
       * hand-filled tests already use. */
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
      /** `engine/test.stepFrame`'s own lockstep: advances the manual clock, writes the camera
       * block, wakes the client worker and spins on its ack. */
      stepFrame(dtMs: number): void
      /** `engine/test.gen.idle`: steps frames until the gen queue is empty and idle, then waits
       * for every ring to drain. */
      idle(): Promise<void>
      /** One `stepFrame` plus one upload-ring drain under `budgetBytes`, with no draw (the
       * `terrain.upload_budget_while_panning` scripted-pan loop; production's own `frame-loop.ts`
       * bundles this differently, Deviations). */
      driveFrame(dtMs: number, budgetBytes: number): { uploadBytes: number; uploadRecords: number }
      /** `terrain.upload_budget_while_panning` (Tests added): `frames` steps, each nudging the
       * camera by `panPerFrameX`/`panPerFrameY` tiles first (`frame-loop.ts`'s own "camera" phase
       * is a no-op in this milestone, Non-scope -- a scripted pan writes `cameraState` directly the
       * same way `engine/test.setCamera` does), then one `stepFrame` + one budgeted drain. Returns
       * every frame's own `uploadBytes` so the caller can assert each one individually. */
      panAndDrive(
        frames: number,
        dtMs: number,
        panPerFrameX: number,
        panPerFrameY: number,
        budgetBytes: number,
      ): { uploadBytesPerFrame: number[] }
      /** Fully drains the ring (test convenience, no budget), draws once, and reads the pixels
       * back. */
      renderAndRead(
        width: number,
        height: number,
      ): Promise<{
        width: number
        height: number
        data: number[]
      }>
      drawCalls(): number
      pageSlotsUsed(): number
      /** `null` when `(cx, cy)` is not cached (`gen.chunkHash`'s own `Status.NotCached` mapping). */
      chunkHash(cx: number, cy: number): Promise<string | null>
      errors(): string[]
    }
  }
}
