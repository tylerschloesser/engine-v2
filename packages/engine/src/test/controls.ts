// Test-only allocation controls (docs/decisions/0016 §3 step 8; the negative-control mechanics
// ported from spikes/zero-gc-webgpu/public/{main,worker}.js's `dirty`/`doTick`). Each isolate that
// imports this module gets its own module-level `sink`: a plain variable, assigned but never read
// back, keeps the allocation observable and defeats escape analysis (the spike's own comment).
// Never imported by production code.
import { StepControl } from './step-block.js'

/** `docs/plan/04-zero-gc-harness.md`, Seams. `null` is the clean run (no control armed). */
export type NegativeControl = { isolate: string; kind: 'object' | 'burst' | 'post-message' } | null

/** The spike's coarse control: enough to trip both `MinorGC` events and the byte budget (0016 §3
 * step 8, "2000 objects per frame"). */
const BURST_COUNT = 2000

let sink: unknown = null

/** One small retained object. */
export function allocateObject(n: number): void {
  sink = { n }
}

/** `BURST_COUNT` small retained objects. */
export function allocateBurst(n: number): void {
  for (let k = 0; k < BURST_COUNT; k++) sink = { n, k }
}

/** Applies the `StepControl` encoded in a worker's step block, once, for tick/frame number `n`.
 * `StepControl.None` (a fresh `SharedArrayBuffer`'s default) is a no-op. */
export function applyStepControl(control: number, n: number): void {
  if (control === StepControl.Object) allocateObject(n)
  else if (control === StepControl.Burst) allocateBurst(n)
}

/** Test-only: lets a unit test observe that `sink` really was assigned. */
export function readControlSink(): unknown {
  return sink
}
