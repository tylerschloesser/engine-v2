// The assertion harness: raw CDP over Playwright sessions.
//  A) Tracing: MinorGC/MajorGC events inside the performance.mark window, attributed per thread.
//  B) Sampling heap profiler: bytes allocated per frame, per isolate (page main + dedicated worker).
import { appendFileSync, mkdirSync } from 'node:fs';

const TRACE_CATEGORIES = (process.env.TRACE_CATS ?? 'v8,devtools.timeline,blink.user_timing').split(',');
export const SAMPLING_INTERVAL = Number(process.env.SAMPLING_INTERVAL ?? 1);

// Playwright's CDPSession cannot address flattened child sessions, so the worker is driven
// through the (deprecated but working) non-flattened Target.sendMessageToTarget tunnel.
class TunnelSession {
  constructor(parent, sessionId) {
    this.parent = parent; this.sessionId = sessionId; this.nextId = 1; this.pending = new Map();
    parent.on('Target.receivedMessageFromTarget', (ev) => {
      if (ev.sessionId !== sessionId) return;
      const msg = JSON.parse(ev.message);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    const done = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
    this.parent.send('Target.sendMessageToTarget', { sessionId: this.sessionId, message: JSON.stringify({ id, method, params }) }).catch(() => {});
    return done;
  }
}

function sumProfile(profile) {
  let total = 0;
  const byFn = new Map();
  const walk = (node) => {
    if (node.selfSize) {
      total += node.selfSize;
      const cf = node.callFrame;
      const key = `${cf.functionName || '(anonymous)'}@${(cf.url || '').split('/').pop()}:${cf.lineNumber + 1}`;
      byFn.set(key, (byFn.get(key) ?? 0) + node.selfSize);
    }
    node.children?.forEach(walk);
  };
  walk(profile.head);
  return { total, byFn: Object.fromEntries([...byFn].sort((a, b) => b[1] - a[1]).slice(0, 8)) };
}

function analyseTrace(events) {
  const threadNames = new Map();
  let start, end;
  for (const e of events) {
    if (e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, e.args?.name);
    if (e.cat?.includes('blink.user_timing')) {
      if (e.name === 'window-start') start = e;
      if (e.name === 'window-end') end = e;
    }
  }
  if (!start || !end) throw new Error('window marks not found in trace');
  const gc = { main: { MinorGC: 0, MajorGC: 0 }, worker: { MinorGC: 0, MajorGC: 0 }, other: { MinorGC: 0, MajorGC: 0 } };
  const outside = { MinorGC: 0, MajorGC: 0 };
  for (const e of events) {
    if (e.name !== 'MinorGC' && e.name !== 'MajorGC') continue;
    if (e.ph === 'E') continue; // count each GC once (B or X)
    if (e.pid !== start.pid) continue;
    if (e.ts < start.ts || e.ts > end.ts) { outside[e.name]++; continue; }
    const tn = threadNames.get(`${e.pid}:${e.tid}`) ?? '';
    const who = e.tid === start.tid ? 'main' : tn.startsWith('DedicatedWorker') ? 'worker' : 'other';
    gc[who][e.name]++;
  }
  return { gc, outside, windowMs: (end.ts - start.ts) / 1000, traceEvents: events.length, mainThreadName: threadNames.get(`${start.pid}:${start.tid}`) };
}

export async function measure(browser, page, { query = '', name = query, warmup = Number(process.env.WARMUP ?? 120), frames = Number(process.env.FRAMES ?? 600) } = {}) {
  const t0 = performance.now();
  await page.goto('/index.html' + query);
  const env = await page.evaluate(() => window.spike.ready);

  const pageSession = await page.context().newCDPSession(page);
  const attached = new Promise((resolve) => pageSession.on('Target.attachedToTarget', (ev) => { if (ev.targetInfo.type === 'worker') resolve(ev); }));
  await pageSession.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  const workerSession = new TunnelSession(pageSession, (await attached).sessionId);
  const browserSession = await browser.newBrowserCDPSession();
  const isolates = { main: pageSession, worker: workerSession };

  // warm-up: JIT tiers, inline caches, lazily created GPU state
  await page.evaluate((n) => window.spike.run(n), warmup);
  const tWarm = performance.now();

  for (const s of Object.values(isolates)) { await s.send('HeapProfiler.enable'); await s.send('HeapProfiler.collectGarbage'); }

  const tGc = performance.now();
  const events = [];
  browserSession.on('Tracing.dataCollected', (ev) => events.push(...ev.value));
  const traceDone = new Promise((resolve) => browserSession.once('Tracing.tracingComplete', resolve));
  await browserSession.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordUntilFull', includedCategories: TRACE_CATEGORIES } });
  const tracingStartMs = performance.now() - tGc;
  for (const s of Object.values(isolates)) {
    await s.send('HeapProfiler.startSampling', { samplingInterval: SAMPLING_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  }

  const tRun = performance.now();
  const startMs = tRun - tGc;
  const run = await page.evaluate((n) => window.spike.run(n, 'window'), frames);
  const runMs = performance.now() - tRun;

  const tStop = performance.now();
  const profiles = {};
  for (const [name, s] of Object.entries(isolates)) profiles[name] = sumProfile((await s.send('HeapProfiler.stopSampling')).profile);
  const tTraceEnd = performance.now();
  await browserSession.send('Tracing.end');
  await traceDone;
  const tTraceDone = performance.now();
  const trace = analyseTrace(events);
  const lit = env.adapter && query.includes('canvas') === false ? await page.evaluate(() => window.spike.readback()) : null;
  await browserSession.detach();

  const result = {
    query: name, frames, env, run, litPixels: lit,
    bytesPerFrame: { main: profiles.main.total / frames, worker: profiles.worker.total / frames },
    totalBytes: { main: profiles.main.total, worker: profiles.worker.total },
    byFn: { main: profiles.main.byFn, worker: profiles.worker.byFn },
    ...trace,
    ms: { total: performance.now() - t0, warmupAndLoad: tWarm - t0, measuredRun: runMs, collectGarbage: tGc - tWarm, startTraceAndSampling: startMs, tracingStart: tracingStartMs, stopSampling: tTraceEnd - tStop, traceEnd: tTraceDone - tTraceEnd, readbackEtc: performance.now() - tTraceDone },
  };
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  appendFileSync(new URL(`../results/${process.env.RESULTS ?? 'results'}.jsonl`, import.meta.url), JSON.stringify(result) + '\n');
  return result;
}

// The two assertions, evaluated per isolate. Budgets in bytes per frame.
export const BUDGET = { main: Number(process.env.BUDGET_MAIN ?? 110), worker: Number(process.env.BUDGET_WORKER ?? 8) };
export function verdict(r) {
  return {
    A: { main: r.gc.main.MinorGC + r.gc.main.MajorGC === 0, worker: r.gc.worker.MinorGC + r.gc.worker.MajorGC === 0 },
    B: { main: r.bytesPerFrame.main <= BUDGET.main, worker: r.bytesPerFrame.worker <= BUDGET.worker },
  };
}
