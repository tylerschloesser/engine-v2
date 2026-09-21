// Test-only allocation controls (docs/decisions/0016 §3 step 8; the negative-control mechanics
// ported from spikes/zero-gc-webgpu/public/{main,worker}.js's `dirty`/`doTick`). Never imported by
// production code.
import { StepControl } from './step-block.js'

/** `docs/plan/04-zero-gc-harness.md`, Seams. `null` is the clean run (no control armed). */
export type NegativeControl = { isolate: string; kind: 'object' | 'burst' | 'post-message' } | null

/** The spike's coarse control: enough to trip both `MinorGC` events and the byte budget (0016 §3
 * step 8, "2000 objects per frame"). */
const BURST_COUNT = 2000

/**
 * A plain module-level `let sink` (the spike's own shape: assigned but never read, "keeps dirty
 * allocations observable, defeats escape analysis") is not enough once the page is bundled: Vite's
 * production build runs Rollup, which tree-shakes an unread local all the way down to an empty `for`
 * body -- measured here (`neg object`/`neg burst` read ~1 B/frame, unchanged from clean, until this
 * fix). The spike's own pages were served unbundled, so it never hit this. A property write on
 * `globalThis` is a write to an object the bundler cannot prove has no outside reader, so it survives
 * tree-shaking; each isolate that imports this module gets its own global object, so this is still
 * per-isolate.
 */
type SinkHolder = { __gcControlSink?: unknown }
const sinkHolder = globalThis as unknown as SinkHolder

/**
 * One small retained object -- 16 B/frame, the byte-budget control of 0016 §3 step 8.
 *
 * Briefly four objects (64 B/frame) between M11 fix rounds 3 and 4. 0028's two-window minimum made
 * every page's `main` reading drop by the one-off JIT burst it used to carry, which left this
 * control unable to clear budgets derived from the older, higher readings; fix round 4 re-derived
 * those budgets downward instead (0028, Amendment), so one object clears again by construction --
 * a budget is `ceil(clean) + 8 B`, so a `clean + 16` reading beats it by 7-8 B/frame, measured on
 * every page. Kept at one deliberately: a bigger control would only prove detection at a coarser
 * threshold than the budget it has to trip.
 */
export function allocateObject(n: number): void {
  sinkHolder.__gcControlSink = { n }
}

/** `BURST_COUNT` small retained objects. */
export function allocateBurst(n: number): void {
  for (let k = 0; k < BURST_COUNT; k++) sinkHolder.__gcControlSink = { n, k }
}

/** Applies the `StepControl` encoded in a worker's step block, once, for tick/frame number `n`.
 * `StepControl.None` (a fresh `SharedArrayBuffer`'s default) is a no-op. */
export function applyStepControl(control: number, n: number): void {
  if (control === StepControl.Object) allocateObject(n)
  else if (control === StepControl.Burst) allocateBurst(n)
}

/** Test-only: lets a unit test observe that the sink really was assigned. */
export function readControlSink(): unknown {
  return sinkHolder.__gcControlSink
}
