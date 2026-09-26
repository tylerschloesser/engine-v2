// `opfs-latency.html`'s script (docs/plan/23-persistence-opfs-and-lifecycle.md step 7): spawns
// `opfs-latency-worker.ts` (all OPFS access happens there, matching where the real adapter runs) and
// renders its result table for Tyler to read and copy (`M23-opfs-latency`,
// `docs/plan/device-checks.md`). `window.__opfsLatencyResult` mirrors the same object for an
// automated confirmation of the page's own shape (`playwright-cli`/a quick fetch), never for the
// pass/fail judgement itself -- that call is Tyler's, on a real iPhone (0005 Consequences: deferred
// to Phase 2, needs a device).
type Percentiles = { p50: number; p95: number; max: number }
type Result = {
  append: Percentiles
  flush: Percentiles
  scratchWrite1MiB: Percentiles
  scratchWrite8MiB: Percentiles
  moveAvailable: boolean
  locksAvailable: boolean
  error?: string
}

declare global {
  interface Window {
    __opfsLatencyResult?: Result
    __pageReady?: true
  }
}

const statusEl = document.createElement('p')
statusEl.id = 'status'
statusEl.textContent = 'running (1,200 appends, 30 scratch writes)...'
document.body.appendChild(statusEl)

const worker = new Worker(new URL('./opfs-latency-worker.js', import.meta.url), { type: 'module' })
const result = await new Promise<Result>((resolve) => {
  worker.onmessage = (ev: MessageEvent<Result>) => resolve(ev.data)
})
window.__opfsLatencyResult = result

function row(name: string, p: Percentiles): string {
  return `${name.padEnd(18)} p50 ${p.p50.toFixed(2).padStart(8)} ms  p95 ${p.p95.toFixed(2).padStart(8)} ms  max ${p.max.toFixed(2).padStart(8)} ms`
}

statusEl.textContent = result.error ? `error: ${result.error}` : 'done'

const pre = document.createElement('pre')
pre.id = 'result'
pre.style.font = '13px monospace'
pre.textContent = [
  row('append (64 B)', result.append),
  row('flush', result.flush),
  row('scratch 1 MiB', result.scratchWrite1MiB),
  row('scratch 8 MiB', result.scratchWrite8MiB),
  `move() available:          ${result.moveAvailable}`,
  `navigator.locks available: ${result.locksAvailable}`,
].join('\n')
document.body.appendChild(pre)

window.__pageReady = true
