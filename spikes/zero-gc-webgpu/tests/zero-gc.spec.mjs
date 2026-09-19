// The spike's actual suite: clean variants must pass A and B on every isolate;
// every negative control must fail exactly where expected (and nowhere else).
import { test, expect } from '@playwright/test';
import { measure, verdict, BUDGET } from './harness.mjs';

const P = true, F = false;
const variants = [
  // name, query, expected verdict { A: {main, worker}, B: {main, worker} }
  ['clean', '', { A: { main: P, worker: P }, B: { main: P, worker: P } }],
  ['clean-shared-wasm-memory', '?src=shared', { A: { main: P, worker: P }, B: { main: P, worker: P } }],
  ['neg-main-1-object', '?alloc=main-obj', { A: { main: P, worker: P }, B: { main: F, worker: P } }],
  ['neg-main-0.7KB', '?alloc=main-700', { A: { main: P, worker: P }, B: { main: F, worker: P } }], // A is blind to this one
  ['neg-worker-1-object', '?alloc=worker-obj', { A: { main: P, worker: P }, B: { main: P, worker: F } }],
  ['neg-postmessage-per-frame', '?comm=postmessage', { A: { main: P, worker: P }, B: { main: F, worker: F } }], // both isolates receive a MessageEvent per frame
  ['neg-main-2000-objects', '?alloc=main-2000', { A: { main: F, worker: P }, B: { main: F, worker: P } }],
  ['neg-worker-2000-objects', '?alloc=worker-2000', { A: { main: P, worker: F }, B: { main: P, worker: F } }],
];

for (const [name, query, expected] of variants) {
  test(name, async ({ browser, page }) => {
    const r = await measure(browser, page, { query, name });
    // environment sanity: real GPU, cross-origin isolated, sim really ticked, GPU really drew, no validation errors
    expect(r.env.adapter, 'WebGPU adapter').not.toBeNull();
    if (!process.env.ALLOW_FALLBACK) expect(r.env.adapter.isFallbackAdapter).toBe(false);
    expect(r.env.crossOriginIsolated).toBe(true);
    expect(r.env.mainGcExposed && r.env.workerGcExposed).toBe(true);
    expect(r.run.errors).toEqual([]);
    expect(r.run.simAck === r.run.frameNo || query.includes('postmessage')).toBe(true);
    expect(r.litPixels).toBeGreaterThan(0);
    expect(r.mainThreadName).toBe('CrRendererMain');
    const detail = JSON.stringify({ bytesPerFrame: r.bytesPerFrame, budget: BUDGET, gc: r.gc, byFn: r.byFn });
    expect(verdict(r), detail).toEqual(expected);
  });
}
