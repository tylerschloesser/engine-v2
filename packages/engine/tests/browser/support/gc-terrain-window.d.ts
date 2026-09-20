// Ambient `window.__terrainGcCounters` type (Open gate failures item 3, gate round 1: docs/plan/
// 09-renderer-terrain.md Deviations "Gate fix round 1"), shared by two separate `tsc` programs:
// `gc-terrain.html`'s page script (`tests/browser/pages/tsconfig.json`) and `gc-terrain.spec.ts`
// (`tests/tsconfig.json`) -- written once here and included by both, the same split
// `terrain-window.d.ts` already uses.
export {}

declare global {
  interface Window {
    /** Read at both marks of the same measured window `window.__gc.run(...)` drives: proves
     * generation, upload and eviction all happen *inside* it, not just once at the end. */
    __terrainGcCounters?(): Promise<{ generated: number; uploadedChunks: number; evicted: number }>
  }
}
