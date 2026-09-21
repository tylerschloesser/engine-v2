// Ambient `window.__device` type (docs/plan/09b-terrain-art-and-lifecycle.md, step 7), shared by
// `device.html`'s page script and `canvas.spec.ts`, the same split every other real-client page's
// `.d.ts` in this directory already uses.
export {}

declare global {
  interface Window {
    __device?: {
      /** `RendererDevice.adapterInfo`, recorded once at page load (0020 §6: every GPU test
       * annotates it and fails, never skips, on a null adapter). */
      adapterInfo(): {
        vendor: string
        architecture: string
        device: string
        description: string
        isFallbackAdapter: boolean | null
      }
      /** Count of whole `FrameLoop.tick()` calls completed since the page started its (production,
       * real-`requestAnimationFrame`) loop. */
      framesRendered(): number
      /** `frame-loop.ts`'s `onPhase` hook, in call order, since page load (capped: see
       * `device.ts`'s own `PHASE_LOG_CAP`) -- every 6 consecutive entries are one `tick()`'s worth of
       * `FRAME_PHASES`. */
      phaseLog(): readonly string[]
      errors(): string[]
    }
  }
}
