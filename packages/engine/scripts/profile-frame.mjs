// The `profile-frame` skill's own command (`.claude/skills/profile-frame/SKILL.md`; docs/plan/
// 17b-sprites-and-frame-budget.md Planning decisions "profile-frame skill contents"). Rebuilds the
// engine + fixtures + browser-suite pages, serves them, launches Chromium with the same
// `--disable-frame-rate-limit --disable-gpu-vsync` flags `frame-bench.spec.ts`'s own Playwright
// project uses, and runs the identical park/install/resume/start/warm-up/timed-window sequence
// against `frame-bench.html` (docs/plan/17b, Deviations: a worker blocked in its normal
// `Atomics.wait` loop never processes a CDP `Runtime.evaluate`, so the client worker's own `call1`
// wrapper is installed while every worker is parked, before the real rAF loop ever starts) -- but
// adds a CPU profile (`Profiler.start`/`stop`) on both isolates over the same window, so it can
// print the top five self-time functions per thread instead of only a pass/fail verdict. Writes the
// raw CDP trace to `test-results/profile-frame/trace.json` and exits 0 regardless of the numbers: a
// diagnostic tool, not a gate (`bench.frame_worstcase`, the Playwright test, is the gate).
//
// Usage: `node packages/engine/scripts/profile-frame.mjs [--fixture drawables] [--frames 300]`.
// Only `--fixture drawables` (the one wired scene, `frame-bench.html`) is supported today; a later
// milestone wiring a second fixture's own frame-bench page extends the `--fixture` switch below,
// not this comment (M36's own "re-points the benchmark at the reference game", brief Consumes).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../../..', import.meta.url))

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1]
}

const fixture = argValue('fixture', 'drawables')
if (fixture !== 'drawables') {
  console.error(`profile-frame: only --fixture drawables is wired today (got '${fixture}')`)
  process.exit(2)
}
const TIMED_FRAMES = Number(argValue('frames', '300'))
const WARMUP_FRAMES = 120
const PORT = 4520
const RECORD_COUNT = 65_536
const EXPECTED_WORKERS = 3 // client, sim, gen0 (frame-bench.ts's own topology)
const TRACE_CATEGORIES = ['v8', 'devtools.timeline', 'blink.user_timing']
const SAMPLING_INTERVAL_US = 100

// 0018 §9: "one third of each CPU share (main <= 1.3 ms, worker <= 2.7 ms at the reference game's
// worst-case view)". Mirrors `frame-bench.spec.ts`'s own constants -- the twin implementation, not
// a shared import: a plain Node script cannot import a `.ts` module, so the two are kept in sync by
// hand (`DRAW_BYTES`'s own precedent, `render/drawables.ts`: "an owning milestone may revise its
// row" duplicated-constant discipline).
const MAIN_BUDGET_MS = 1.3
const WORKER_BUDGET_MS = 2.7
const BASELINE_TOLERANCE = 0.25

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' })
  if (res.status !== 0) {
    console.error(`profile-frame: '${cmd} ${args.join(' ')}' exited ${res.status}`)
    process.exit(res.status ?? 1)
  }
}

function percentile(vals, p) {
  if (vals.length === 0) return 0
  const sorted = [...vals].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

/** Twin of `frame-bench.spec.ts`'s own `frameDurationsMs`. */
function frameDurationsMs(events, startPrefix, endPrefix) {
  const starts = new Map()
  for (const e of events) {
    if (!e.cat?.includes('blink.user_timing')) continue
    if (e.name.startsWith(startPrefix)) starts.set(e.name.slice(startPrefix.length), e.ts)
  }
  const durations = []
  for (const e of events) {
    if (!e.cat?.includes('blink.user_timing')) continue
    if (!e.name.startsWith(endPrefix)) continue
    const n = e.name.slice(endPrefix.length)
    const s = starts.get(n)
    if (s !== undefined) durations.push((e.ts - s) / 1000)
  }
  return durations
}

/** A CDP `Profiler.stop()` result's `profile` (`{ nodes, startTime, endTime, samples, timeDeltas }`,
 * all times microseconds): self time per sample, attributed to the node id each sample names,
 * summed by `functionName@file:line` and sorted -- the same shape `tests/browser/gc/analyse.ts`'s
 * `sumProfile` uses for a *heap* profile's `selfSize`, adapted for a *CPU* profile's own
 * `samples`/`timeDeltas` pair (no `selfSize` field exists on a CPU profile's nodes). */
function sumCpuProfile(profile) {
  const nodeById = new Map((profile.nodes ?? []).map((n) => [n.id, n]))
  const selfUs = new Map()
  const samples = profile.samples ?? []
  const timeDeltas = profile.timeDeltas ?? []
  let total = 0
  for (let i = 0; i < samples.length; i++) {
    const dt = timeDeltas[i] ?? 0
    if (dt <= 0) continue
    selfUs.set(samples[i], (selfUs.get(samples[i]) ?? 0) + dt)
    total += dt
  }
  const byFn = []
  for (const [id, us] of selfUs) {
    const node = nodeById.get(id)
    if (!node) continue
    const cf = node.callFrame
    byFn.push([
      `${cf.functionName || '(anonymous)'}@${(cf.url || '').split('/').pop()}:${cf.lineNumber + 1}`,
      us / 1000,
    ])
  }
  byFn.sort((a, b) => b[1] - a[1])
  return { totalMs: total / 1000, top5: byFn.slice(0, 5) }
}

/** Non-flattened CDP tunnel to a worker (spike precedent, `spikes/zero-gc-webgpu/tests/harness.mjs`;
 * `tests/browser/gc/sessions.ts`'s own `TunnelSession`, duplicated here for the same TS/plain-Node
 * boundary reason `frameDurationsMs` above is). */
class TunnelSession {
  constructor(name, parent, sessionId) {
    this.name = name
    this.parent = parent
    this.sessionId = sessionId
    this.nextId = 1
    this.pending = new Map()
    parent.on('Target.receivedMessageFromTarget', (ev) => {
      if (ev.sessionId !== sessionId) return
      const msg = JSON.parse(ev.message)
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result)
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    const done = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }))
    this.parent
      .send('Target.sendMessageToTarget', {
        sessionId: this.sessionId,
        message: JSON.stringify({ id, method, params }),
      })
      .catch(() => {})
    return done
  }
}

const INSTALL_WORKER_WRAP = `(() => {
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

console.log('profile-frame: building engine + fixtures + pages…')
run('pnpm', ['--silent', '--filter', 'engine', 'build'])
run('node', ['packages/engine/scripts/build-fixtures.mjs'])
run('pnpm', [
  'exec',
  'vite',
  'build',
  '--config',
  'packages/engine/tests/browser/pages/vite.config.ts',
])

console.log(`profile-frame: serving on 127.0.0.1:${PORT}…`)
const preview = spawn(
  'pnpm',
  [
    'exec',
    'vite',
    'preview',
    '--config',
    'packages/engine/tests/browser/pages/vite.config.ts',
    '--host',
    '127.0.0.1',
  ],
  {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ENGINE_TEST_PORT: String(PORT) },
  },
)
await new Promise((resolve, reject) => {
  preview.stdout.on('data', function onData(d) {
    if (String(d).includes(`:${PORT}`)) {
      preview.stdout.off('data', onData)
      resolve()
    }
  })
  preview.on('error', reject)
  preview.on('close', (code) => reject(new Error(`vite preview exited ${code}`)))
})

let exitCode = 0
const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
})
try {
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.error(`profile-frame: page error: ${e.message}`))
  await page.goto(`http://127.0.0.1:${PORT}/frame-bench.html`)
  await page.waitForFunction(() => window.__pageReady === true, { timeout: 60_000 })

  const setup = await page.evaluate(() => ({
    adapter: window.__frameBench?.adapterInfo ?? null,
    recordCount: window.__frameBench?.recordCount ?? 0,
  }))
  console.log(
    `profile-frame: adapter=${JSON.stringify(setup.adapter)} recordCount=${setup.recordCount}`,
  )
  if (setup.recordCount !== RECORD_COUNT) {
    console.error(
      `profile-frame: expected ${RECORD_COUNT} entities, page reports ${setup.recordCount}`,
    )
    exitCode = 1
  }

  await page.evaluate(() => window.__frameBench?.park())

  const pageSession = await page.context().newCDPSession(page)
  const workers = []
  pageSession.on('Target.attachedToTarget', (ev) => {
    if (ev.targetInfo.type === 'worker') {
      workers.push(new TunnelSession(`worker#${workers.length}`, pageSession, ev.sessionId))
    }
  })
  await pageSession.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  })
  while (workers.length < EXPECTED_WORKERS) await new Promise((r) => setTimeout(r, 20))
  for (const w of workers) {
    const evaluated = await w.send('Runtime.evaluate', { expression: 'self.__engineIsolateName' })
    w.name = evaluated.result.value
  }
  const clientWorker = workers.find((w) => w.name === 'client')
  if (!clientWorker) throw new Error('profile-frame: no client-isolate worker attached')

  await clientWorker.send('Runtime.evaluate', {
    expression: INSTALL_WORKER_WRAP,
    returnByValue: true,
  })

  await page.evaluate(() => window.__frameBench?.resume())
  await page.evaluate(() => window.__frameBench?.start())

  await page.waitForFunction(
    (n) => (window.__frameBench?.framesRendered() ?? 0) >= n,
    WARMUP_FRAMES,
    { timeout: 60_000 },
  )

  const browserSession = await browser.newBrowserCDPSession()
  const events = []
  browserSession.on('Tracing.dataCollected', (ev) => events.push(...ev.value))
  const traceDone = new Promise((resolve) =>
    browserSession.once('Tracing.tracingComplete', resolve),
  )
  await browserSession.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { recordMode: 'recordUntilFull', includedCategories: TRACE_CATEGORIES },
  })

  await pageSession.send('Profiler.enable')
  await pageSession.send('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US })
  await clientWorker.send('Profiler.enable')
  await clientWorker.send('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US })
  await pageSession.send('Profiler.start')
  await clientWorker.send('Profiler.start')

  const startFrames = await page.evaluate(() => {
    window.__frameBench?.startMarking()
    return window.__frameBench?.framesRendered() ?? 0
  })

  await page.waitForFunction(
    (n) => (window.__frameBench?.framesRendered() ?? 0) >= n,
    startFrames + TIMED_FRAMES,
    { timeout: 60_000 },
  )

  await page.evaluate(() => window.__frameBench?.stopMarking())
  const { profile: mainProfile } = await pageSession.send('Profiler.stop')
  const { profile: workerProfile } = await clientWorker.send('Profiler.stop')
  await browserSession.send('Tracing.end')
  await traceDone
  await browserSession.detach()

  const gpuErrors = await page.evaluate(() => window.__frameBench?.errors() ?? [])
  if (gpuErrors.length > 0) {
    console.error(`profile-frame: uncapturederror: ${JSON.stringify(gpuErrors)}`)
    exitCode = 1
  }

  const outDir = new URL('../../../test-results/profile-frame/', import.meta.url)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(new URL('trace.json', outDir), JSON.stringify(events))

  const mainMs = frameDurationsMs(events, 'mf-s-', 'mf-e-')
  const workerMs = frameDurationsMs(events, 'wf-s-', 'wf-e-')
  const mainP50 = percentile(mainMs, 0.5)
  const mainP95 = percentile(mainMs, 0.95)
  const workerP50 = percentile(workerMs, 0.5)
  const workerP95 = percentile(workerMs, 0.95)
  const mainCpu = sumCpuProfile(mainProfile)
  const workerCpu = sumCpuProfile(workerProfile)

  const baselineUrl = new URL('../baselines/frame.json', import.meta.url)
  const baseline = existsSync(baselineUrl) ? JSON.parse(readFileSync(baselineUrl, 'utf8')) : null

  console.log('')
  console.log(
    `bench.frame_worstcase profile: records=${RECORD_COUNT} frames main=${mainMs.length} worker=${workerMs.length} warmup=${WARMUP_FRAMES}`,
  )
  console.log(
    `  main   p50=${mainP50.toFixed(3)}ms p95=${mainP95.toFixed(3)}ms  budget<=${MAIN_BUDGET_MS}ms` +
      (baseline
        ? `  baseline.p50=${baseline.mainMs.p50}ms (+${(BASELINE_TOLERANCE * 100).toFixed(0)}%=${(baseline.mainMs.p50 * (1 + BASELINE_TOLERANCE)).toFixed(3)}ms)`
        : ''),
  )
  console.log(`    top self-time (${mainCpu.totalMs.toFixed(2)}ms sampled):`)
  for (const [name, ms] of mainCpu.top5) console.log(`      ${ms.toFixed(3)}ms  ${name}`)
  console.log(
    `  worker p50=${workerP50.toFixed(3)}ms p95=${workerP95.toFixed(3)}ms  budget<=${WORKER_BUDGET_MS}ms` +
      (baseline
        ? `  baseline.p50=${baseline.workerMs.p50}ms (+${(BASELINE_TOLERANCE * 100).toFixed(0)}%=${(baseline.workerMs.p50 * (1 + BASELINE_TOLERANCE)).toFixed(3)}ms)`
        : ''),
  )
  console.log(`    top self-time (${workerCpu.totalMs.toFixed(2)}ms sampled):`)
  for (const [name, ms] of workerCpu.top5) console.log(`      ${ms.toFixed(3)}ms  ${name}`)
  console.log('')
  console.log('trace written to test-results/profile-frame/trace.json')

  if (mainP50 > MAIN_BUDGET_MS)
    console.warn(`warn: main p50 exceeds the 0018 §9 desktop proxy (${MAIN_BUDGET_MS}ms)`)
  if (workerP50 > WORKER_BUDGET_MS)
    console.warn(`warn: worker p50 exceeds the 0018 §9 desktop proxy (${WORKER_BUDGET_MS}ms)`)
} finally {
  await browser.close()
  preview.kill()
}

process.exit(exitCode)
