// The zero-GC negative-control hook every production worker kind can carry (docs/plan/
// 06b-workers-and-spawn.md, orchestrator decision 2). `src/test/controls.ts` is the harness-worker
// original this mirrors; production code (`src/worker/*.ts`) cannot import `src/test/**` (0017 §2),
// so the same small allocation shapes are duplicated here, read from `CB_TEST_CONTROL`
// (`sab/control.ts`) instead of a message. A kind body calls `applyGcHook` once per real wake only
// when its own setup message carried `test.gcHook`; without that flag the word is never read, so a
// production build that never sets the flag never touches this path at all.
import { CB_TEST_CONTROL, type ControlBlock } from '../sab/control.js'

/** Mirrors `src/test/controls.ts`'s `BURST_COUNT` (0016 §3 step 8). */
const BURST_COUNT = 2000

/** Mirrors `src/test/controls.ts`'s `OBJECT_COUNT` (0016 §3 step 8, as amended by 0028 -- that
 * function's own comment has the reason it is no longer 1). */
const OBJECT_COUNT = 4

/** A `globalThis` property write, not a bare local (`src/test/controls.ts`'s own comment has the
 * story): Rollup's production build tree-shakes an unread local all the way down to nothing, but a
 * write to a property the bundler cannot prove has no outside reader survives. Each isolate that
 * loads this module gets its own global object, so this stays per-isolate. */
type SinkHolder = { __engineWorkerGcSink?: unknown }
const sinkHolder = globalThis as unknown as SinkHolder

/**
 * Applies the negative-control allocation encoded in `CB_TEST_CONTROL`, once, only when it targets
 * `index` (`(enc >>> 8) - 1 === index`). A no-op when no control is armed (`enc === 0`) or it names
 * a different worker.
 */
export function applyGcHook(control: ControlBlock, index: number): void {
  const enc = Atomics.load(control.words, CB_TEST_CONTROL)
  if (enc === 0) return
  if ((enc >>> 8) - 1 !== index) return
  const kind = enc & 0xff
  if (kind === 1) {
    for (let k = 0; k < OBJECT_COUNT; k++) sinkHolder.__engineWorkerGcSink = { index, k }
  } else if (kind === 2) {
    for (let k = 0; k < BURST_COUNT; k++) sinkHolder.__engineWorkerGcSink = { index, k }
  }
}
