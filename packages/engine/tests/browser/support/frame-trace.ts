// Shared by the frame-time benchmarks (`frame-bench.spec.ts`, `frame-bench-reference.spec.ts`): the
// trace reader and the client-worker `frame()` wrapper M17b wrote, moved here unchanged so the
// reference-game benchmark measures exactly the way the worst-case one does.
import type { TraceEvent } from '../gc/analyse.ts'

export const TRACE_CATEGORIES = ['v8', 'devtools.timeline', 'blink.user_timing']

export function percentile(vals: readonly number[], p: number): number {
  if (vals.length === 0) return 0
  const sorted = [...vals].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx] as number
}

/** Every `<startPrefix><n>`/`<endPrefix><n>` mark pair's own duration, ms -- `ts` is microseconds
 * (Chrome trace convention), so the difference is divided by 1000. Marks are matched by name alone
 * (never by pid/tid): `mf-*`/`wf-*` are each emitted by exactly one thread in this whole trace. */
export function frameDurationsMs(
  events: readonly TraceEvent[],
  startPrefix: string,
  endPrefix: string,
): number[] {
  const starts = new Map<string, number>()
  for (const e of events) {
    if (!e.cat?.includes('blink.user_timing')) continue
    if (e.name.startsWith(startPrefix)) starts.set(e.name.slice(startPrefix.length), e.ts)
  }
  const durations: number[] = []
  for (const e of events) {
    if (!e.cat?.includes('blink.user_timing')) continue
    if (!e.name.startsWith(endPrefix)) continue
    const n = e.name.slice(endPrefix.length)
    const s = starts.get(n)
    if (s !== undefined) durations.push((e.ts - s) / 1000)
  }
  return durations
}

/** Installed once, before the real rAF loop ever starts, over the client worker's own
 * `Runtime.evaluate` session -- wraps `EngineInstance.call1` (`self.__engineInstance`, exposed only
 * because `frame-bench.ts` passes `test: { flags: {} }`) so every call whose `fn` is `inst.x.frame`
 * (the client role's own `frame(t_ms)` export, `worker/client.ts`'s `body()`) is bracketed by a
 * `wf-s-<n>`/`wf-e-<n>` mark pair, unconditionally, for the rest of the worker's life -- cheap
 * enough (one extra property check plus two marks per frame) that there is no need to ever remove
 * it, and removing it would mean parking the worker a second time, mid-benchmark, which is exactly
 * what this sequence is designed to avoid (below). Only marks that land inside the `Tracing.start`/
 * `Tracing.end` window are ever read back (`frameDurationsMs`), so warm-up frames' own marks are
 * simply never collected, not specially suppressed. */
export const INSTALL_WORKER_WRAP = `(() => {
  const inst = self.__engineInstance;
  if (!inst || inst.__frameBenchWrapped) return 'skip';
  const orig = Object.getPrototypeOf(inst).call1;
  const frameFn = inst.x.frame;
  let n = 0;
  inst.call1 = function (fn, a) {
    if (fn === frameFn) {
      self.performance.mark('wf-s-' + n);
      const r = orig.call(inst, fn, a);
      self.performance.mark('wf-e-' + n);
      n += 1;
      return r;
    }
    return orig.call(inst, fn, a);
  };
  inst.__frameBenchWrapped = true;
  return 'installed';
})()`
