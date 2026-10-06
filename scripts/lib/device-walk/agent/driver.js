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
  const ROLLING_MS = 10_000 // the length of the page's rolling statistics (device.ts, the bench HUD)
  const MIN_STEADY_FRAMES = 10
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

  // A collector's return value for a helper tab (a second tab, a Private tab): it did its part (and may
  // carry the attempt's data); the first tab walks on and this one stays out of the walk.
  const helperDone = (data) => ({ __walkHelper: true, data: data || null })
  let served = false // this document has already run (or started) an attempt
  let navigating = false
  let running = ''
  let judged = ''

  const isHelperTab = () => /-h[a-z0-9]{2,3}$/.test(A.id.tab)

  /** Is this document the page of `item` (origin, path, and exactly its own query parameters)? */
  function here(item) {
    if (!item.origin || location.origin !== item.origin) return false
    const [path, query = ''] = item.page.split('#')[0].split('?') // `#k=` (an invite) is the page's own
    if (location.pathname !== `/${path}`) return false
    // Knobs a helper tab's link may carry or change (`-h...` tab ids: `linkFor`). The first tab is strict: the
    // page of the previous check (same path, another `world=`) is not the page of this one.
    const tol = new Set(isHelperTab() ? item.plan.tolerate || [] : [])
    const want = [...new URLSearchParams(query)].filter(([k]) => !tol.has(k))
    const have = new URLSearchParams(location.search)
    have.delete('_walk') // the cache-buster of a fresh attempt (below)
    have.delete('_fresh')
    for (const k of tol) have.delete(k)
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
      if (item.plan.sweep) await check().act.sweep({ on: true }) // the scripted pan and zoom of M18
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
      A.beginMeasure(item.id, item.n, o.memoryTimeoutMs)
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

  /**
   * One measuring window: the bar is gone, the rAF recorder is reset, a hide interrupts. `each(i, t)` runs
   * once a second inside the window (scripted paints, a pan: whatever the check drives), never per frame.
   */
  async function measureWindow(item, each) {
    const o = item.opts
    const warm = o.warmupMs || 0
    const roll = o.rollingMs ?? ROLLING_MS
    // The page's HUD statistics (p95 and the rest of `readings()`) are rolling 10 s windows that still hold the
    // frames before the warm-up ended (the load, a rotation's relayout). A steady sample therefore starts one rolling
    // window after the warm-up when the window is long enough to spare it; the rAF fields are recomputed from the
    // agent's own window-local ring and cover only frames after the warm-up (M39p).
    const steadyFrom = o.windowMs - warm >= 3 * roll ? warm + roll : warm
    let last = null
    for (let tries = 0; tries < 3; tries++) {
      const orient = orientation()
      const t0 = Date.now()
      const samples = []
      let turned = false
      A.beginMeasure(item.id, item.n, o.windowMs)
      while (Date.now() - t0 < o.windowMs) {
        await sleep(Math.max(0, 1000 * (samples.length + 1) - (Date.now() - t0)))
        if (A.measure().interrupted) {
          A.endMeasure()
          return null
        }
        const r = readings()
        const wt = A.windowT()
        const w = A.rafWindow(Math.max(warm, wt - roll), wt)
        if (r.orientation !== orient) turned = true
        samples.push(
          Object.assign({ t: Date.now() - t0 }, r, {
            page_raf_p95_ms: r.raf_p95_ms,
            page_raf_over20: r.raf_over20,
            raf_p50_ms: w.p50,
            raf_p95_ms: w.p95,
            raf_worst_ms: w.max,
            raf_n: w.n,
            raf_over20: w.over20,
            raf_over25: w.over25,
          }),
        )
        if (each) await each(samples.length, Date.now() - t0)
      }
      const raf = A.rafStats()
      const gaps = A.rafGaps()
      if (A.endMeasure().interrupted) return null
      last = {
        window: {
          orientation: orient,
          windowMs: o.windowMs,
          samples,
          raf,
          gaps,
          ...(turned ? { turned } : {}),
        },
        // A sample counts once it has more than a second of frames after the warm-up.
        steady: samples.filter((s) => s.t >= steadyFrom && s.raf_n >= MIN_STEADY_FRAMES),
      }
      if (!turned) return last // rotated mid-window: measured again in the new orientation
    }
    return last
  }

  /**
   * An act prompt with live "detected" ticks. `detect`: `{ name: () => boolean }` polled every 250 ms (a
   * name that turns true stays true); `buttons`: `[{ label, fn }]` on the sheet. Resolves with the detected
   * map when every name is true, or `null` after `timeoutMs`. The sheet is removed on the way out.
   */
  async function ask(item, { text, detect, buttons, timeoutMs, settleMs = 0 }) {
    const names = Object.keys(detect || {})
    const seen = {}
    for (const k of names) seen[k] = false
    A.bar.show({ kind: 'act', id: item.id, n: item.n, text, detected: { ...seen }, buttons })
    const ok = await waitFor(
      () => {
        for (const k of names)
          if (!seen[k]) {
            let v = false
            try {
              v = !!detect[k]()
            } catch {}
            if (v) {
              seen[k] = true
              A.bar.tick(k, true)
            }
          }
        return names.every((k) => seen[k])
      },
      timeoutMs ?? item.opts.actTimeoutMs,
      250,
    )
    if (ok && settleMs) await sleep(settleMs)
    A.bar.hide()
    return ok ? seen : null
  }

  /** The act prompt between two windows: live "detected" tick, up to `actTimeoutMs`. */
  async function rotate(item, first) {
    const want = first === 'portrait' ? 'landscape' : 'portrait'
    const ok = await ask(item, {
      text: `Rotate the phone to ${want}.`,
      detect: { rotated: () => orientation() !== first },
      settleMs: 1500, // the layout and the canvas settle before the next window
    })
    return !!ok
  }

  // --- one attempt --------------------------------------------------------------------------------
  async function finish(item, data) {
    set('col', null)
    const body = Object.assign({ page: location.pathname + location.search, gpu: A.gpu }, data)
    await A.sendAndWait('series', { id: item.id, n: item.n, data: body }, 15000)
  }

  /** The newest step's item for the attempt a collector is running (its `state` changes as readings arrive). */
  const live = (item) => {
    const s = A.step
    return s && s.kind === 'walk' && s.item && s.item.id === item.id && s.item.n === item.n
      ? s.item
      : item
  }

  // Collectors that need more than a page's globals live in two further public files (`/__walk/*.js`),
  // loaded the first time a check asks for one; each registers itself on `kit.collectors`.
  const FILES = {
    slice: 'collect-life',
    world: 'collect-life',
    mp: 'collect-life',
    anchors: 'collect-touch',
    gestures: 'collect-touch',
    // The reference game (step 10-12): `reference-bg` leaves the page with `leave` from collect-life.
    'reference-dom': 'collect-ref',
    'reference-bg': ['collect-life', 'collect-ref'],
    bench: 'collect-ref',
    'reference-mp': ['collect-life', 'collect-ref'],
    // The Mac's own browsers (step 14).
    'pinch-desktop': 'collect-mac',
    harness: 'collect-mac',
    'desktop-play': 'collect-mac',
  }
  const loaded = {}
  function load(name) {
    if (!loaded[name])
      loaded[name] = new Promise((resolve) => {
        const el = document.createElement('script')
        el.src = `/__walk/${name}.js`
        el.onload = el.onerror = () => resolve()
        ;(document.head || document.documentElement).append(el)
      })
    return loaded[name]
  }

  /** `_fresh=1`: the agent of the new document clears the persisted camera before the page boots (agent.js). */
  function freshUrl(u, item) {
    if (!item.plan.keepCamera) u.searchParams.set('_fresh', '1')
    return u.href
  }

  async function go(item) {
    const key = `${item.id}:${item.n}`
    // A helper tab (a second tab, a Private tab, the imported world: opened with a `-h...` tab id) did its part
    // of one check: it takes no further step. Left open, it would walk the next check beside the first tab. The
    // first tab never does (a first tab in a Private window measures itself, and walks on).
    if (get('helper') && isHelperTab()) return
    if (running === key || navigating) return
    if (!here(item)) {
      navigating = true
      if (!item.origin) return
      if (item.origin !== location.origin)
        return A.hop(item.origin, item.page, item.plan.keepCamera ? {} : { _fresh: '1' })
      return location.assign(freshUrl(new URL(item.page, location.origin), item))
    }
    if (served) {
      // A fresh document for every attempt. Not `location.reload()`: a reload revalidates every
      // subresource, and WebKit then sometimes refuses a worker script ("blocked by Cross-Origin-
      // Embedder-Policy", seen on the second `worldgen-bench.html` load); a plain navigation does not.
      navigating = true
      const u = new URL(location.href)
      u.searchParams.set('_walk', `${item.n}-${Date.now().toString(36)}`) // unique: `n` restarts at 1 for every check, and the same URL again is no navigation at all
      return location.assign(freshUrl(u, item))
    }
    if (get('helper') === key) return // a second tab of this attempt that already did its part
    served = true
    running = key
    A.bar.hide()
    const prior = json(get('col'), null)
    let reloaded = false
    // A second tab opened from this one copies its sessionStorage: only the same tab's mark is a reload.
    if (prior && prior.key === key && prior.tab === A.id.tab) {
      // This document is a reload of an attempt that never finished.
      const reloads = (prior.reloads || 0) + 1
      set('col', JSON.stringify({ key, reloads, tab: A.id.tab }))
      if (item.plan.resumable)
        reloaded = true // the check itself spans documents (kill-resume, drops)
      else if (item.plan.reloadIsFail)
        return finish(item, {
          ready: false,
          reloaded: true,
          reloads,
          final: { steps: json(get('steps'), []) },
          runs: json(get('runs'), []), // M37b: the runs that finished before the tab was discarded
        })
      else {
        A.send('attempt', { id: item.id, n: item.n, status: 'interrupted', reason: 'reload' })
        return
      }
    } else {
      set('col', JSON.stringify({ key, reloads: 0, tab: A.id.tab }))
      set('steps', null)
      set('runs', null)
    }
    for (const file of [FILES[item.plan.collector] ?? []].flat()) await load(file) // in order
    const collect = collectors[item.plan.collector]
    let data
    try {
      data = collect
        ? await collect(item, { reloaded })
        : { error: `no collector ${item.plan.collector}` }
    } catch (e) {
      data = { error: String((e && e.message) || e) }
    }
    if (data === null) {
      if (A.measure().interrupted) return // interrupted: wait for the person's Redo
      // A collector that gives up with nothing and no interruption: an act prompt ran out of time (the person,
      // or the driver, never did it). That is a result, not a reason to wait for ever (a driven round hung on
      // it for half an hour): the service evaluates what is missing.
      data = { ready: true, actTimedOut: true }
    }
    if (data && data.__walkHelper) {
      set('helper', key)
      set('col', null)
      if (data.data) await finish(item, data.data)
      return
    }
    await finish(item, data)
  }

  function onStep(s) {
    if (!s || s.kind !== 'walk') return
    if (get('helper') && isHelperTab()) return // a helper tab (second tab, Private tab) stays out of the walk once done
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
      if (mark && mark.tab === A.id.tab && mark.key === `${s.item.id}:${s.item.n}`) go(s.item)
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

  window.__walkKit = {
    A,
    get,
    set,
    json,
    sleep,
    waitFor,
    clone,
    orientation,
    check,
    readings,
    measureWindow,
    ask,
    live,
    helperDone,
    collectors,
    /** `{ token, run, tab }` of this tab: what a helper tab's link carries (a new tab id of its own). */
    linkFor(path, extra) {
      const id = json(get('id'), null)
      const u = new URL(path, location.origin)
      for (const [k, v] of Object.entries(extra || {})) u.searchParams.set(k, v)
      u.searchParams.set('walk', id.token)
      u.searchParams.set('run', id.run)
      u.searchParams.set(
        'tab',
        `${id.tab.split('-')[0]}-h${Math.random().toString(36).slice(2, 5)}`,
      )
      return u.href
    },
  }
  A.on('step', onStep)
  if (A.step) onStep(A.step)
})()
