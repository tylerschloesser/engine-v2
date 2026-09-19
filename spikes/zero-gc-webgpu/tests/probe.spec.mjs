// Exploration: prints the full measurement for a list of variants (not part of the pass/fail suite).
import { test } from '@playwright/test';
import { measure, verdict } from './harness.mjs';
const variants = (process.env.PROBE ?? '').split(';').filter(Boolean);
for (const v of variants) {
  test(`probe ${v}`, async ({ browser, page }) => {
    const r = await measure(browser, page, { query: v === 'default' ? '' : '?' + v });
    console.log(JSON.stringify({ v, adapter: r.env.adapter, env: { coi: r.env.crossOriginIsolated, gc: r.env.mainGcExposed, wgc: r.env.workerGcExposed, sab: r.env.sharedIsSab }, run: r.run, lit: r.litPixels, bpf: r.bytesPerFrame, byFn: r.byFn, gc: r.gc, outside: r.outside, windowMs: r.windowMs, traceEvents: r.traceEvents, mainThreadName: r.mainThreadName, ms: r.ms, verdict: verdict(r) }));
  });
}
