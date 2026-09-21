// Ambient `window.__viewport` type (docs/plan/09b-terrain-art-and-lifecycle.md, steps 4-5), shared
// by `viewport.html`'s page script and `viewport.spec.ts`, the same split `terrain-window.d.ts`
// already uses for `window.__terrain`.
export {}

declare global {
  interface Window {
    __viewport?: {
      /** Real device + `TerrainRenderer` (no tile art: these tests assert canvas size/DPR/render-
       * scale/draw-call timing, never pixel content) + a real `createClient()` over `fx-terrain`,
       * wired through `frame-loop.ts`'s `createRealFrameLoop`. `maxTextureDimension2D` defaults to a
       * real-looking limit; a clamp test passes a small one so it never allocates a huge texture. */
      init(opts?: {
        maxTextureDimension2D?: number
        render?: { scale?: number; scaleCap?: number; neighbourCutoffPx?: number }
      }): Promise<{
        adapterInfo: {
          vendor: string
          architecture: string
          device: string
          description: string
          isFallbackAdapter: boolean | null
        }
      }>
      /** `engine/test.setViewport`: queues a CSS size/DPR override, applied at the next `tick()`. */
      setViewport(cssWidth: number, cssHeight: number, dpr: number): void
      /** One synchronous `FrameLoop.tick()`. */
      tick(): { uploadBytes: number; uploadRecords: number }
      /** `setViewport` + `tick()` in one call (no `page.evaluate` round trip between them, so the
       * real `ResizeObserver`/`matchMedia` this page also has live can never race the forced
       * override -- both run in the same task). */
      setViewportAndTick(
        cssWidth: number,
        cssHeight: number,
        dpr: number,
      ): { uploadBytes: number; uploadRecords: number }
      /** Advances the manual clock and runs whichever `FrameLoop` phase callback the injected
       * `Scheduler`'s own `requestFrame` is currently holding (0018 §8: exercising the real
       * `resume()`/`pause()` -> `Scheduler.requestFrame`/`cancelFrame` wiring, not just `tick()`). */
      frame(dtMs: number): void
      setVisibility(state: 'hidden' | 'visible'): void
      rebaseFlagSet(): boolean
      clearRebaseFlag(): void
      canvasSize(): { width: number; height: number }
      viewport(): { widthPx: number; heightPx: number; dpr: number; renderScale: number }
      drawCalls(): number
      /** How many times the injected `Scheduler.requestFrame` was called since `init()` -- 0018 §8's
       * "on hidden, stop rAF" shows up as this count no longer growing. */
      requestFrameCalls(): number
      neighbourCutoffPx(): number
      errors(): string[]
    }
  }
}
