// Reports cross-origin-isolation facts to window.__result for the Playwright script.
const ASSET = 'http://127.0.0.1:5999' // cross-origin AND cross-site relative to http://localhost:<port>

function img(src: string, crossorigin: boolean): Promise<string> {
  return new Promise((res) => {
    const el = new Image()
    if (crossorigin) el.crossOrigin = 'anonymous'
    const t = setTimeout(() => res('timeout'), 4000)
    el.onload = () => (clearTimeout(t), res('loaded'))
    el.onerror = () => (clearTimeout(t), res('blocked'))
    el.src = src + '?' + Math.random()
  })
}

function tryCall<T>(f: () => T): T | string {
  try {
    return f()
  } catch (e) {
    return 'threw: ' + (e as Error).message
  }
}

async function workerCheck(): Promise<unknown> {
  return new Promise((res) => {
    let w: Worker
    try {
      w = new Worker(new URL('./isolation-worker.ts', import.meta.url), { type: 'module' })
    } catch (e) {
      return res({ loaded: false, error: String(e) })
    }
    const t = setTimeout(() => res({ loaded: false, error: 'timeout (no message from worker)' }), 5000)
    w.onerror = (e) => (clearTimeout(t), res({ loaded: false, error: 'worker error event: ' + (e.message ?? '') }))
    let shared: Int32Array | null = null
    w.onmessage = (e) => {
      if (e.data.type === 'report') {
        const report = e.data
        // round-trip a SAB main -> worker, worker writes with Atomics, main reads
        const posted = tryCall(() => {
          shared = new Int32Array(new SharedArrayBuffer(8))
          w.postMessage({ type: 'sab', sab: shared.buffer })
          return 'posted'
        })
        if (posted !== 'posted') {
          clearTimeout(t)
          res({ loaded: true, ...report, sharedRoundTrip: posted })
        } else {
          ;(w as any).__report = report
        }
      } else if (e.data.type === 'sab-done') {
        clearTimeout(t)
        res({ loaded: true, ...(w as any).__report, sharedRoundTrip: Atomics.load(shared!, 1) === 42 ? 'ok' : 'wrong value' })
      }
    }
  })
}

async function run() {
  const result: Record<string, unknown> = {
    ua: navigator.userAgent,
    main: {
      crossOriginIsolated: self.crossOriginIsolated,
      sabDefined: typeof SharedArrayBuffer !== 'undefined',
      sabConstruct: tryCall(() => new SharedArrayBuffer(16).byteLength),
      waitAsyncDefined: typeof (Atomics as any).waitAsync === 'function',
    },
    worker: await workerCheck(),
    images: {
      'plain, no crossorigin attr': await img(ASSET + '/plain.png', false),
      'CORP: cross-origin, no attr': await img(ASSET + '/corp.png', false),
      'ACAO:*, crossorigin attr': await img(ASSET + '/cors.png', true),
      'plain, crossorigin attr': await img(ASSET + '/plain.png', true),
    },
    fetchNoCorsPlain: await fetch(ASSET + '/plain.png', { mode: 'no-cors' }).then(
      (r) => 'ok (' + r.type + ')',
      (e) => 'rejected: ' + e.message,
    ),
  }
  document.getElementById('out')!.textContent = JSON.stringify(result, null, 2)
  ;(window as any).__result = result
}
run()
