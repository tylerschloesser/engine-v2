// Main-thread JS heap measurement per variant, headless Chromium, production build served by `vite preview`.
// Pass A: forced GC -> Runtime.getHeapUsage before/after a ~10 s (~600 frame) window + trace GC events.
// Pass B: HeapProfiler sampling (incl. objects already collected) to attribute allocations.
import { preview, build } from 'vite'
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const VARIANTS = (process.env.VARIANTS ?? 'none,raf,sab,waitasync,pm-object,pm-transfer,pm-transfer-pool,garbage').split(',')
const WARMUP_MS = Number(process.env.WARMUP_MS ?? 8000)
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 10000)
const RUNS = Number(process.env.RUNS ?? 1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

process.env.COEP = 'require-corp'
process.env.HEADER_SCOPE = 'all'
await build({ logLevel: 'error' })
const srv = await preview({ preview: { port: 4173, strictPort: true }, logLevel: 'error' })
const browser = await chromium.launch({
  headless: true,
  args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
})
console.log('chromium', browser.version())

const readStats = (page) =>
  page.evaluate(() => ({ stats: Array.from(window.__stats), drops: window.__ctrl ? Atomics.load(window.__ctrl, 2) : 0 }))

async function passA(variant) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const cdp = await ctx.newCDPSession(page)
  await page.goto(`http://localhost:4173/bench.html?variant=${variant}`)
  await sleep(WARMUP_MS)
  await page.evaluate(() => { gc(); gc() })
  await cdp.send('HeapProfiler.collectGarbage')
  await sleep(300)
  await browser.startTracing(page, { categories: ['v8', 'v8.gc', 'devtools.timeline', 'disabled-by-default-v8.gc', '__metadata'] })
  await sleep(200)
  const s0 = await readStats(page) // its garbage lands before u0, so it is in the baseline
  // ---- measurement window: nothing below touches the page's JS until u1 is read ----
  const u0 = await cdp.send('Runtime.getHeapUsage')
  const t0 = Date.now()
  let prev = u0.usedSize, decreases = 0
  const series = [u0.usedSize]
  while (Date.now() - t0 < WINDOW_MS) {
    await sleep(500)
    const u = await cdp.send('Runtime.getHeapUsage')
    if (u.usedSize < prev) decreases++
    prev = u.usedSize
    series.push(u.usedSize)
  }
  const u1 = await cdp.send('Runtime.getHeapUsage')
  const elapsed = Date.now() - t0
  // ---- end window ----
  const s1 = await readStats(page)
  const traceBuf = await browser.stopTracing()
  const trace = JSON.parse(traceBuf.toString())
  const events = trace.traceEvents ?? trace
  const threadNames = new Map()
  for (const e of events) if (e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, e.args?.name)
  const gc = { main: {}, worker: {}, other: {} }
  for (const e of events) {
    if (!/^(MinorGC|MajorGC|V8\.GC_SCAVENGER$|V8\.GC_MARK_COMPACTOR$|V8\.GCScavenger|V8\.GCCompactor|V8\.GCFinalizeMC|V8\.GCIncrementalMarking$)/.test(e.name)) continue
    if (e.ph === 'E') continue
    const tn = threadNames.get(`${e.pid}:${e.tid}`) ?? '?'
    const bucket = tn === 'CrRendererMain' ? 'main' : /Worker/i.test(tn) ? 'worker' : 'other'
    gc[bucket][e.name] = (gc[bucket][e.name] ?? 0) + 1
  }
  const frames = s1.stats[0] - s0.stats[0]
  const wakes = s1.stats[5] - s0.stats[5]
  const msgs = s1.stats[1] - s0.stats[1]
  await ctx.close()
  return {
    variant, elapsedMs: elapsed, frames, wakes, msgs,
    seqErrors: s1.stats[2], maxDrainPerFrame: s1.stats[4], ringDrops: s1.drops,
    heapUsedBefore: u0.usedSize, heapUsedAfter: u1.usedSize,
    heapGrowthBytes: u1.usedSize - u0.usedSize,
    bytesPerFrame: frames ? +((u1.usedSize - u0.usedSize) / frames).toFixed(1) : null,
    bytesPerMsg: msgs ? +((u1.usedSize - u0.usedSize) / msgs).toFixed(1) : null,
    heapDecreasesSeen: decreases,
    mainThreadGC: gc.main, workerThreadGC: gc.worker, otherGC: gc.other,
    series, errors,
  }
}

async function passB(variant) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await page.goto(`http://localhost:4173/bench.html?variant=${variant}`)
  await sleep(WARMUP_MS)
  await page.evaluate(() => { gc(); gc() })
  await cdp.send('HeapProfiler.enable')
  await cdp.send('HeapProfiler.startSampling', {
    samplingInterval: 64,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  })
  await sleep(WINDOW_MS)
  const { profile } = await cdp.send('HeapProfiler.stopSampling')
  const by = new Map()
  let total = 0
  ;(function walk(n, stack) {
    const cf = n.callFrame
    const label = `${cf.functionName || '(anonymous)'} @ ${cf.url.split('/').pop() || '(native)'}:${cf.lineNumber}`
    if (n.selfSize) {
      by.set(label, (by.get(label) ?? 0) + n.selfSize)
      total += n.selfSize
    }
    for (const c of n.children ?? []) walk(c, stack)
  })(profile.head)
  await ctx.close()
  const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${v} B  ${k}`)
  return { sampledTotalBytes: total, top }
}

const out = []
for (const variant of VARIANTS) {
  for (let run = 0; run < RUNS; run++) {
    const a = await passA(variant)
    const b = await passB(variant)
    const row = { ...a, sampling: b }
    out.push(row)
    const { series, ...print } = row
    console.log(JSON.stringify(print, null, 1))
    // write after every row so a mid-run crash cannot lose completed variants
    writeFileSync(new URL('../' + (process.env.OUT ?? 'results-gc.json'), import.meta.url), JSON.stringify({ chromium: browser.version(), WARMUP_MS, WINDOW_MS, partial: true, out }, null, 2))
  }
}
writeFileSync(new URL('../' + (process.env.OUT ?? 'results-gc.json'), import.meta.url), JSON.stringify({ chromium: browser.version(), WARMUP_MS, WINDOW_MS, out }, null, 2))
await browser.close()
srv.httpServer.close()
process.exit(0)
