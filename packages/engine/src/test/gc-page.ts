// `engine/test`: wraps an already-created `Harness` with the API `tests/browser/gc/instrument.ts`
// drives over `page.evaluate` (docs/plan/04-zero-gc-harness.md, Seams). A page also keeps
// `window.__harness` (the M03 convention): `instrument.ts` still calls `park()`/`resume()` on it
// directly around the CDP heap-profiler/tracing calls (Planning decisions "Sequence"); `window.__gc`
// only adds what a plain `Harness` cannot do (windowed `run`, isolate marks, the negative-control
// hook). Never imported by production code.
import { allocateBurst, allocateObject, type NegativeControl } from './controls.js'
import type { Harness } from './harness.js'
import { StepControl } from './step-block.js'

export type { NegativeControl } from './controls.js'

export type GcPageReady = {
  isolates: string[]
  crossOriginIsolated: boolean
  /** No page built by this milestone has a WebGPU adapter (docs/plan/04-zero-gc-harness.md,
   * Planning decisions "No WebGPU on this page"); a later page's script fills this in. */
  adapter: object | null
  gcExposed: Record<string, boolean>
}

export type GcRunResult = { frames: number; acks: Record<string, number>; errors: string[] }

export type GcPageApi = {
  ready: Promise<GcPageReady>
  run(frames: number, marked: boolean): Promise<GcRunResult>
  markIsolates(): Promise<void>
  setControl(c: NegativeControl): Promise<void>
  memoryBytes(): Promise<Record<string, number>>
  /** Not in the Seams listing for `GcPageApi`, added for the WASM-memory assertion of 0016 §1's
   * last row ("Planning decisions", "WASM memory"): same shape as `Harness.memGrows()`. */
  memGrows(): Promise<Record<string, number>>
}

declare global {
  interface Window {
    __gc?: GcPageApi
    /** `--js-flags=--expose-gc` (0016 §3), main thread's own. */
    gc?: () => void
  }
}

const FRAME_MS = 1000 / 60

/**
 * Installs `window.__gc`. `opts.drive` is the page's normal per-frame work (default: `stepFrame`
 * then `stepTick`); it is bypassed for a frame under the `post-message` control, which instead
 * drives the named worker by a message round trip (`Harness.messageTick`) -- that worker must never
 * be armed for the run, which is why `instrument.ts` resumes with `{ except: [isolate] }` whenever
 * that control is active (Planning decisions "Sequence").
 */
export function installGcPage(harness: Harness, opts: { drive?(frame: number): void } = {}): void {
  let control: NegativeControl = null
  const drive =
    opts.drive ??
    ((): void => {
      harness.stepFrame(FRAME_MS)
      harness.stepTick()
    })

  async function run(frames: number, marked: boolean): Promise<GcRunResult> {
    const errorsBefore = harness.errors().length
    const pmIsolate = control?.kind === 'post-message' ? control.isolate : undefined
    await harness.resume(pmIsolate ? { except: [pmIsolate] } : undefined)

    if (marked) performance.mark('window-start')
    for (let f = 1; f <= frames; f++) {
      if (control && control.kind !== 'post-message' && control.isolate === 'main') {
        if (control.kind === 'object') allocateObject(f)
        else allocateBurst(f)
      }
      if (pmIsolate) {
        harness.stepFrame(FRAME_MS)
        await harness.messageTick(pmIsolate)
      } else {
        drive(f)
      }
    }
    if (marked) performance.mark('window-end')

    await harness.park()
    // Indexed loop, not `for...of` (fix round 2, docs/plan/06b-workers-and-spawn.md, Deviations):
    // a `for...of` over `workerNames` goes through the array iterator protocol, which under an
    // unoptimised JIT tier allocates a `{value, done}` result object per `.next()` call -- the same
    // class of cost `src/test/harness.ts`'s own `stepAll` comment already flags for `for...of`.
    const acks: Record<string, number> = {}
    const names = harness.workerNames
    for (let i = 0; i < names.length; i++) acks[names[i] as string] = frames
    return { frames, acks, errors: harness.errors().slice(errorsBefore) }
  }

  async function markIsolates(): Promise<void> {
    performance.mark('gc-isolate:main')
    await harness.markIsolates()
  }

  async function setControl(c: NegativeControl): Promise<void> {
    control = c
    if (c && c.kind !== 'post-message' && harness.workerNames.includes(c.isolate)) {
      harness.setWorkerControl(
        c.isolate,
        c.kind === 'object' ? StepControl.Object : StepControl.Burst,
      )
    }
  }

  window.__gc = {
    ready: Promise.resolve({
      isolates: ['main', ...harness.workerNames],
      crossOriginIsolated: window.crossOriginIsolated,
      adapter: null,
      gcExposed: { main: typeof window.gc === 'function', ...harness.workerGcExposed() },
    }),
    run,
    markIsolates,
    setControl,
    memoryBytes: () => harness.memoryBytes(),
    memGrows: () => harness.memGrows(),
  }
}
