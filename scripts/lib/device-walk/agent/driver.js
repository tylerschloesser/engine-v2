// The walk driver (M39f steps 5-6, docs/plan/39f-device-auto-runner.md). Plain JS, no build step. The agent
// loads it (`/__walk/driver.js`) once a step of `kind: 'walk'` is running; it is the phone's half of an
// auto round: go to the page the service names, collect what that check's `plan` says, send the data
// as one `series` message, and let the service judge it (checks.mjs; a page or this file never decides
// pass or fail). Observer only: it reads `window.__*` hooks and `window.__check`, it never steers a page.
//
// One attempt per document: a new attempt of the same page navigates to it again (`_walk=<n>`). A boot nonce in sessionStorage
// (`col`) marks "an attempt is being collected here"; a document that finds the mark of its own attempt
// is a reload (a tab Safari killed, or the person pulling down): a probe that must not reload (the
// memory probe) reports it as the failure it is, anything else reports the attempt interrupted and the
// service retries. A measuring window (`beginMeasure`) that sees the page hidden is interrupted, never
// failed: the data is dropped here and the person is offered "Redo this check".
;(() => {
  const A = window.__walkAgent
  if (!A || window.__walkDriverOn) return
  window.__walkDriverOn = true
  const K = '__walk_'
  const get = (k) => {
    try {
      return sessionStorage.getItem(K + k)
    } catch {
      return null
    }
  }
  const set = (k, v) => {
    try {
      if (v === null) sessionStorage.removeItem(K + k)
      else sessionStorage.setItem(K + k, v)
    } catch {}
  }
  const json = (s, d) => {
    try {
      return s ? JSON.parse(s) : d
    } catch {
      return d
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function waitFor(fn, ms, every = 100) {
    const t0 = Date.now()
    for (;;) {
      let v = false
      try {
        v = fn()
      } catch {}
      if (v) return v
      if (Date.now() - t0 > ms) return false
      await sleep(every)
    }
  }
  const clone = (v) => JSON.parse(JSON.stringify(v ?? null))
  const orientation = () => (window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait')
  const check = () => window.__check
  const readings = () => {
    try {
      return clone(check().readings())
    } catch {
      return {}
    }
  }

  let served = false // this document has already run (or started) an attempt
  let navigating = false
  let running = ''
  let judged = ''

  /** Is this document the page of `item` (origin, path, and exactly its own query parameters)? */
  function here(item) {
    if (!item.origin || location.origin !== item.origin) return false
    const [path, query = ''] = item.page.split('?')
    if (location.pathname !== `/${path}`) return false
    const want = [...new URLSearchParams(query)]
    const have = new URLSearchParams(location.search)
    have.delete('_walk') // the cache-buster of a fresh attempt (below)
    if (want.some(([k, v]) => have.get(k) !== v)) return false
    return [...have].length === want.length
  }

  // --- collectors: what each check's `plan.collector` reads from its page -------------------------
  const collectors = {
    /** Static pages: wait for `__pageReady` and the named globals, snapshot them and the named DOM text. */
    async global(item) {
      const names = item.plan.globals || []
      const ok = await waitFor(
        () => window.__pageReady && names.every((n) => window[n] !== undefined),
        item.opts.timeoutMs,
      )
      const data = { ready: !!ok, g: {}, dom: {} }
      for (const n of names) data.g[n] = clone(window[n])
      for (const [k, sel] of Object.entries(item.plan.dom || {}))
        data.dom[k] = document.querySelector(sel)?.textContent ?? null
      return data
    },
    /** `device.html` boot: `__check.ready`, then one reading. */
    async check(item) {
      const ok = await waitFor(() => check()?.ready, item.opts.timeoutMs)
      if (ok) await sleep(500)
      return { ready: !!ok, final: readings(), errors: check() ? clone(check().errors()) : [] }
    },
    /** Fill rate: a window per orientation (sampling `__check.readings()` once a second), a rotate prompt between. */
    async 'fill-rate'(item) {
      const o = item.opts
      if (!(await waitFor(() => check()?.ready, o.timeoutMs)))
        return { ready: false, windows: [], steady: [] }
      const first = orientation()
      const windows = []
      const steady = []
      for (let w = 0; w < 2; w++) {
        if (w === 1 && !(await rotate(item, first))) break
        const m = await measureWindow(item)
        if (!m) return null // interrupted by a hide: the service has the interrupted attempt
        windows.push(m.window)
        steady.push(...m.steady)
      }
      return { ready: true, windows, steady, errors: clone(check().errors()) }
    },
    /** `?probe=memory`: follow the probe's own progress lines until it says it is complete. */
    async memory(item) {
      const o = item.opts
      A.beginMeasure(item.id, item.n)
      const t0 = Date.now()
      let steps = []
      let complete = false
      while (!complete && Date.now() - t0 < o.memoryTimeoutMs) {
        await sleep(1000)
        if (A.measure().interrupted) {
          A.endMeasure()
          return null
        }
        steps = readings().steps || steps
        set('steps', JSON.stringify(steps))
        complete = steps.some((l) => l.includes(item.plan.completeSteps))
      }
      if (A.endMeasure().interrupted) return null
      return { ready: true, final: { steps }, reloads: 0, timedOut: !complete, ms: Date.now() - t0 }
    },
  }

  /** One measuring window: the bar is gone, the rAF recorder is reset, a hide interrupts. */
  async function measureWindow(item) {
    const o = item.opts
    let last = null
    for (let tries = 0; tries < 3; tries++) {
      const orient = orientation()
      const t0 = Date.now()
      const samples = []
      let turned = false
      A.beginMeasure(item.id, item.n)
      while (Date.now() - t0 < o.windowMs) {
        await sleep(Math.max(0, 1000 * (samples.length + 1) - (Date.now() - t0)))
        if (A.measure().interrupted) {
          A.endMeasure()
          return null
        }
        const r = readings()
        if (r.orientation !== orient) turned = true
        samples.push(Object.assign({ t: Date.now() - t0 }, r))
      }
      const raf = A.rafStats()
      if (A.endMeasure().interrupted) return null
      last = {
        window: {
          orientation: orient,
          windowMs: o.windowMs,
          samples,
          raf,
          ...(turned ? { turned } : {}),
        },
        steady: samples.filter((s) => s.t >= (o.warmupMs || 0)),
      }
      if (!turned) return last // rotated mid-window: measured again in the new orientation
    }
    return last
  }

  /** The act prompt between two windows: live "detected" tick, up to `actTimeoutMs`. */
  async function rotate(item, first) {
    const want = first === 'portrait' ? 'landscape' : 'portrait'
    A.bar.show({
      kind: 'act',
      id: item.id,
      n: item.n,
      text: `Rotate the phone to ${want}.`,
      detected: { rotated: false },
    })
    const ok = await waitFor(() => orientation() !== first, item.opts.actTimeoutMs, 250)
    if (ok) {
      A.bar.tick('rotated', true)
      await sleep(1500) // the layout and the canvas settle before the next window
    }
    A.bar.hide()
    return !!ok
  }

  // --- one attempt --------------------------------------------------------------------------------
  async function finish(item, data) {
    set('col', null)
    const body = Object.assign({ page: location.pathname + location.search, gpu: A.gpu }, data)
    await A.sendAndWait('series', { id: item.id, n: item.n, data: body }, 15000)
  }

  async function go(item) {
    const key = `${item.id}:${item.n}`
    if (running === key || navigating) return
    if (!here(item)) {
      navigating = true
      if (!item.origin) return
      if (item.origin !== location.origin) return A.hop(item.origin, item.page)
      return location.assign(new URL(item.page, location.origin).href)
    }
    if (served) {
      // A fresh document for every attempt. Not `location.reload()`: a reload revalidates every
      // subresource, and WebKit then sometimes refuses a worker script ("blocked by Cross-Origin-
      // Embedder-Policy", seen on the second `worldgen-bench.html` load); a plain navigation does not.
      navigating = true
      const u = new URL(location.href)
      u.searchParams.set('_walk', String(item.n))
      return location.assign(u.href)
    }
    served = true
    running = key
    A.bar.hide()
    const prior = json(get('col'), null)
    if (prior && prior.key === key) {
      // This document is a reload of an attempt that never finished.
      const reloads = (prior.reloads || 0) + 1
      set('col', JSON.stringify({ key, reloads }))
      if (item.plan.reloadIsFail)
        return finish(item, {
          ready: false,
          reloaded: true,
          reloads,
          final: { steps: json(get('steps'), []) },
        })
      A.send('attempt', { id: item.id, n: item.n, status: 'interrupted', reason: 'reload' })
      return
    }
    set('col', JSON.stringify({ key, reloads: 0 }))
    set('steps', null)
    const collect = collectors[item.plan.collector]
    let data
    try {
      data = collect ? await collect(item) : { error: `no collector ${item.plan.collector}` }
    } catch (e) {
      data = { error: String((e && e.message) || e) }
    }
    if (data === null) return // interrupted: wait for the person's Redo
    await finish(item, data)
  }

  function onStep(s) {
    if (!s || s.kind !== 'walk') return
    if (judged && s.phase !== 'judge') {
      judged = ''
      A.bar.hide()
    }
    if (s.phase === 'judge' && s.judge) {
      const key = `${s.judge.id}:${s.judge.n}`
      if (judged === key) return
      judged = key
      A.bar.show({ kind: 'judge', id: s.judge.id, n: s.judge.n, text: s.judge.text })
    } else if (s.phase === 'run' && s.item) go(s.item)
    else if (s.phase === 'redo' && s.item && !served) {
      // A reload looks like a hide to the service until this new document says it found its attempt's mark.
      const mark = json(get('col'), null)
      if (mark && mark.key === `${s.item.id}:${s.item.n}`) go(s.item)
    } else if (
      s.phase === 'done' &&
      !/runner\.html$/.test(location.pathname) &&
      !running.endsWith('done')
    ) {
      running = 'walk:done'
      A.bar.show({
        kind: 'act',
        id: 'walk',
        n: 0,
        text: 'The round is finished. You can close this tab.',
        detected: {},
      })
    }
  }

  A.on('step', onStep)
  if (A.step) onStep(A.step)
})()
