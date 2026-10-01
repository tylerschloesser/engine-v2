// Ambient `window.__deviceLoss` type (docs/plan/37b-device-loss.md), shared by `device-loss.html`'s
// page script and `device-loss.spec.ts` (same split as `terrain-client-window.d.ts`).
export {}

declare global {
  interface Window {
    /** `gc-device-loss.html` (M37b step 5): loses the device, steps through the outage and the refill, parks. */
    __lossThenGc?: { loseAndRecover(): Promise<{ generation: number; outageFrames: number }> }
    __deviceLoss?: {
      /** A real `createClient()` over `fx-terrain`, a `GpuHost` (art, visual table) and one
       * `createFrameLoop` over it with a manual clock and an offscreen `rgba8unorm` target. */
      init(opts?: { cssSize?: number }): Promise<{
        adapterInfo: {
          vendor: string
          architecture: string
          device: string
          description: string
          isFallbackAdapter: boolean | null
        }
      }>
      setCamera(x: number, y: number, tilesAcross: number): void
      setHalfExtent(x: number, y: number): void
      /** The `FrameUniform` the page writes into whichever renderer is current, every frame (the
       * game's own `onCamera` does the same), so it survives a rebuild. */
      setProbeCamera(v: {
        camTileX: number
        camTileY: number
        camFracX: number
        camFracY: number
        viewportPxW: number
        viewportPxH: number
        tilesPerPx: number
      }): void
      /** `stepFrame` (lockstep with the client worker) then one `FrameLoop.tick()`. */
      step(dtMs: number): { uploadBytes: number; uploadRecords: number }
      idle(): Promise<void>
      /** `engine/test`'s `loseDevice(client)`. */
      loseDevice(): Promise<void>
      /** `engine/test`'s `untilRendererRecovered(client)`: the rebuild count. */
      untilRecovered(): Promise<number>
      /** `engine/test`'s `failNextAdapter(client)`. */
      failNextAdapter(): void
      /** Moves the page's manual clock, which the `GpuHost` repeated-loss window reads. */
      advanceClock(ms: number): void
      /** The `reason` of every `client.onRendererLost` event so far. */
      rendererLostEvents(): string[]
      /** `navigator.gpu.requestAdapter` calls since `init()` finished creating the page's client. */
      adapterRequests(): number
      hasDevice(): boolean
      /** One `tick()` into the real canvas texture, read back at once: the first 64 pixels of row
       * 0 as RGBA bytes (`data`), plus the canvas size; `null` on a fallback (software) adapter, where the
       * page has no canvas path (see `device-loss.ts`'s `init`). */
      canvasRead(): Promise<{ width: number; height: number; data: number[] } | null>
      setDrawablesEnabled(on: boolean): void
      /** `null` when the drawables pass does not exist. */
      drawablesEnabled(): boolean | null
      renderAndRead(
        width: number,
        height: number,
      ): Promise<{ width: number; height: number; data: number[] }>
      uploadBytesTotal(): number
      controlWords(): { ack: number; req: number; cameraSeq: number }
      anchor(x: number, y: number): void
      anchorRect(): { x: number; y: number }
      counters(): { ticks: number; ticksWithoutDevice: number; generation: number }
      errors(): string[]
    }
  }
}
