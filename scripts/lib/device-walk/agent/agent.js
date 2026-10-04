// The device-walk agent (M39f, docs/plan/39f-device-auto-runner.md step 3). Plain JS, no build step, one
// file. `device-serve --walk` injects it into every served page and the phone API serves it at
// /__walk/agent.js; the same file is the runner page's library. It is inert unless the tab was opened
// with the run token (`?walk=<token>&run=<round>[&tab=<id>]`, kept in sessionStorage): a page
// served without the token behaves as if the agent were absent.
//
// Observer only. It records, it does not steer the page: environment facts, GPU device errors and loss
// (a wrapper of GPUAdapter.prototype.requestDevice), window errors, visibility and pagehide, an
// allocation-free rAF gap recorder, the screen wake lock. Everything goes to the service as sequenced
// messages through an outbox in sessionStorage (flushed in order after any drop, deduped by `seq`).
// Hot-path rule (.claude/rules/hot-paths.md): the rAF callback below allocates nothing per frame.
;(() => {
  if (window.__walkAgent) return
  const K = '__walk_'
  const store = (() => {
    try {
      return window.sessionStorage
    } catch {
      return null
    }
  })()
  const get = (k) => {
    try {
      return store ? store.getItem(K + k) : null
    } catch {
      return null
    }
  }
  const set = (k, v) => {
    try {
      if (store) store.setItem(K + k, v)
    } catch {}
  }
  const json = (s, d) => {
    try {
      return s ? JSON.parse(s) : d
    } catch {
      return d
    }
  }

  // --- Identity -------------------------------------------------------------------------------
  const q = new URLSearchParams(location.search)
  let id = json(get('id'), null)
  if (q.get('walk')) {
    const tab = q.get('tab') || id?.tab || Math.random().toString(36).slice(2, 8)
    // A hop gives the tab a new id (`<base>-<x>`): a new origin has its own sessionStorage, and a
    // counter continued across the unload messages of the old page would collide with them.
    if (!id || id.tab !== tab) {
      set('seq', '0')
      set('out', '[]')
      set('ack', '0')
    }
    id = { token: q.get('walk'), run: q.get('run') || '', tab }
    set('id', JSON.stringify(id))
    for (const p of ['walk', 'run', 'tab']) q.delete(p)
    const rest = q.toString()
    history.replaceState(
      history.state,
      '',
      location.pathname + (rest ? `?${rest}` : '') + location.hash,
    )
  }
  if (!id?.token) return

  // --- Events and the outbox ------------------------------------------------------------------
  const handlers = {}
  const on = (name, fn) => {
    if (!handlers[name]) handlers[name] = []
    handlers[name].push(fn)
  }
  const emit = (name, arg) => {
    for (const fn of handlers[name] || []) {
      try {
        fn(arg)
      } catch (e) {
        console.warn('walk handler', e)
      }
    }
  }
  let seq = +get('seq') || 0
  let outbox = json(get('out'), [])
  let lastAck = +get('ack') || 0
  const waiters = new Map()
  let ws = null
  let inflight = 0
  let failures = 0
  let reconnects = 0
  let lastRx = Date.now()
  let offset = 0
  let step = null
  const persist = () => {
    set('out', JSON.stringify(outbox))
    set('seq', String(seq))
    set('ack', String(lastAck))
  }
  const url = (path) =>
    `${location.origin}/__walk/${path}?walk=${encodeURIComponent(id.token)}&tab=${id.tab}`

  function onMessage(m) {
    lastRx = Date.now()
    if (m.now) offset = m.now - Date.now()
    if (m.type === 'welcome') {
      lastAck = Math.max(lastAck, m.lastSeq || 0)
      trim(lastAck)
      inflight = 0
      flush()
    } else if (m.type === 'ack') trim(m.seq)
    if (m.step) {
      step = m.step
      if (step.kind === 'walk' && step.phase !== 'idle') loadDriver()
      emit('step', step)
    }
    if (m.type === 'ack') {
      for (const [s, fn] of waiters)
        if (s <= m.seq) {
          waiters.delete(s)
          fn(m)
        }
    }
  }
  /** A walk round: load the driver (adapters, navigation) once; it reads `step` and does the rest. */
  function loadDriver() {
    if (window.__walkDriver) return
    window.__walkDriver = true
    const el = document.createElement('script')
    el.src = '/__walk/driver.js'
    ;(document.head || document.documentElement).append(el)
  }
  function trim(upTo) {
    const n = outbox.length
    outbox = outbox.filter((m) => m.seq > upTo)
    inflight = Math.max(0, inflight - (n - outbox.length))
    lastAck = Math.max(lastAck, upTo)
    persist()
  }
  function flush() {
    if (ws?.readyState !== 1) return
    for (let i = inflight; i < outbox.length; i++) ws.send(JSON.stringify(outbox[i]))
    inflight = outbox.length
  }
  /** Queue a sequenced message; returns its seq. */
  function send(type, body) {
    const m = { run: id.run, tab: id.tab, seq: ++seq, t: Date.now(), type }
    outbox.push(Object.assign(m, body))
    persist()
    flush()
    return m.seq
  }
  /** Send and wait for the service's ack (it carries the new step); resolves null on timeout. */
  function sendAndWait(type, body, ms = 8000) {
    const s = send(type, body)
    return new Promise((resolve) => {
      waiters.set(s, resolve)
      setTimeout(() => {
        if (waiters.delete(s)) resolve(null)
      }, ms)
    })
  }
  const control = (type, body) => {
    if (ws && ws.readyState === 1)
      ws.send(JSON.stringify(Object.assign({ tab: id.tab, type }, body)))
  }

  function connect() {
    const sock = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__walk/ws?walk=${encodeURIComponent(id.token)}&tab=${id.tab}`,
    )
    ws = sock
    sock.onopen = () => {
      failures = 0
      lastRx = Date.now()
      inflight = 0
      control('hello', { lastSeq: lastAck, path: location.pathname, vis: document.visibilityState })
      flush()
    }
    sock.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data))
      } catch {}
    }
    sock.onclose = () => lost(sock)
    sock.onerror = () => {}
  }
  function lost(sock) {
    if (ws !== sock) return
    ws = null
    failures++
    reconnects++
    setTimeout(connect, Math.min(3000, 250 * 2 ** Math.min(failures, 4)))
  }
  let posting = false
  async function postFlush() {
    if (posting || !outbox.length) return
    posting = true
    try {
      const r = await fetch(url('msg'), {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify(outbox),
      })
      if (r.ok) for (const m of (await r.json()).replies || []) onMessage(m)
    } catch {}
    posting = false
  }
  setInterval(() => {
    if (ws && ws.readyState === 1) {
      control('ping', { vis: document.visibilityState })
      if (step && step.kind === 'walk' && step.phase !== 'done') control('step?') // a walk waits on the Mac
      if (Date.now() - lastRx > 7000) {
        const dead = ws
        try {
          dead.close()
        } catch {}
        lost(dead)
      }
    } else if (failures >= 3) postFlush() // the socket is blocked (a proxy that drops upgrades)
  }, 2000)

  // --- Environment ----------------------------------------------------------------------------
  const num = (v) => (typeof v === 'number' ? v : null)
  async function envFacts() {
    const n = navigator
    const vv = window.visualViewport
    const env = {
      origin: location.origin,
      ua: n.userAgent,
      uaData: n.userAgentData
        ? {
            brands: n.userAgentData.brands,
            mobile: n.userAgentData.mobile,
            platform: n.userAgentData.platform,
          }
        : null,
      platform: n.platform,
      screen: { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight },
      dpr: window.devicePixelRatio,
      visualViewport: vv ? { w: vv.width, h: vv.height, scale: vv.scale } : null,
      crossOriginIsolated: !!window.crossOriginIsolated,
      cores: num(n.hardwareConcurrency),
      deviceMemory: num(n.deviceMemory),
      touchPoints: num(n.maxTouchPoints),
      media: {
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        coarse: matchMedia('(pointer: coarse)').matches,
      },
      wakeLock: !!n.wakeLock,
      gpu: null,
    }
    if (n.gpu) {
      try {
        const a = await n.gpu.requestAdapter()
        if (a) {
          const i = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {})
          env.gpu = {
            vendor: i.vendor || '',
            architecture: i.architecture || '',
            device: i.device || '',
            description: i.description || '',
            features: [...a.features].sort(),
            limits: {},
          }
          for (const k of [
            'maxTextureDimension2D',
            'maxBufferSize',
            'maxStorageBufferBindingSize',
            'maxComputeWorkgroupStorageSize',
          ])
            env.gpu.limits[k] = a.limits[k]
        } else env.gpu = { adapter: null }
      } catch (e) {
        env.gpu = { error: String(e?.message) }
      }
    }
    return env
  }
  if (!get(`env:${location.origin}`)) {
    addEventListener('load', () =>
      setTimeout(
        () =>
          envFacts().then((e) => {
            set(`env:${location.origin}`, '1') // only once it is queued: a reload before this resends it
            send('env', e)
          }),
        300,
      ),
    )
  }

  // --- GPU device errors and loss, window errors ----------------------------------------------
  const gpu = { devices: 0, errors: 0, lost: 0 }
  const report = (type, body) => send(type, body)
  if (self.GPUAdapter && GPUAdapter.prototype.requestDevice) {
    const orig = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const dev = await orig.apply(this, args)
      gpu.devices++
      dev.addEventListener('uncapturederror', (e) => {
        gpu.errors++
        report('gpu', {
          kind: 'uncapturederror',
          message: String(e.error?.message || '').slice(0, 300),
        })
      })
      dev.lost.then((info) => {
        gpu.lost++
        report('gpu', {
          kind: 'lost',
          reason: info.reason,
          message: String(info.message || '').slice(0, 300),
        })
      })
      return dev
    }
  }
  let errCount = 0
  const err = (kind, message) => {
    if (errCount++ < 30)
      report('error', { kind, message: String(message).slice(0, 300), path: location.pathname })
  }
  addEventListener('error', (e) => err('error', e.message))
  addEventListener('unhandledrejection', (e) => err('rejection', e.reason?.message || e.reason))
  const ce = console.error
  console.error = (...a) => {
    err('console', a.map(String).join(' '))
    ce.apply(console, a)
  }

  // --- Visibility, pagehide -------------------------------------------------------------------
  const vis = { hidden: 0 }
  // A measured attempt (beginMeasure) that sees the page hidden is interrupted, never failed: its data
  // is discarded (rAF recorder reset) and, on return, the bar offers "Redo this check".
  const meas = { on: false, id: null, n: 0, interrupted: false }
  function interrupt(why) {
    if (!meas.on) return
    meas.on = false
    meas.interrupted = true
    rafReset()
    send('attempt', { id: meas.id, n: meas.n, status: 'interrupted', reason: why })
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      vis.hidden++
      interrupt('hidden')
    }
    report('visibility', { state: document.visibilityState, path: location.pathname })
    rafLast = 0
    if (!document.hidden && meas.interrupted) {
      measuring = false
      bar.show({
        kind: 'interrupted',
        id: meas.id,
        n: meas.n,
        text: 'The page was hidden during this measurement, so it was stopped. Nothing from it is kept.',
      })
    }
  })
  addEventListener('pagehide', (e) => {
    interrupt('pagehide')
    report('visibility', { state: 'pagehide', persisted: !!e.persisted, path: location.pathname })
    try {
      navigator.sendBeacon(url('msg'), JSON.stringify(outbox)) // best effort; the service dedupes by seq
    } catch {}
  })

  // --- rAF gap recorder (allocation-free: one stable callback, one preallocated ring) ----------
  const ring = new Float32Array(512)
  const raf = { n: 0, frames: 0, long25: 0, long50: 0, max: 0 }
  let rafLast = 0
  function rafTick(t) {
    if (rafLast !== 0) {
      const d = t - rafLast
      ring[raf.n & 511] = d
      raf.n++
      raf.frames++
      if (d > 25) raf.long25++
      if (d > 50) raf.long50++
      if (d > raf.max) raf.max = d
    }
    rafLast = t
    requestAnimationFrame(rafTick)
  }
  requestAnimationFrame(rafTick)
  function rafStats() {
    const n = Math.min(raf.n, 512)
    const a = Array.from(ring.subarray(0, n)).sort((x, y) => x - y) // human-rate, outside the callback
    const pick = (p) => (n ? +a[Math.min(n - 1, Math.floor(p * n))].toFixed(2) : null)
    return {
      frames: raf.frames,
      long25: raf.long25,
      long50: raf.long50,
      max: +raf.max.toFixed(1),
      p50: pick(0.5),
      p95: pick(0.95),
    }
  }
  function rafReset() {
    raf.n = raf.frames = raf.long25 = raf.long50 = raf.max = 0
  }

  // --- Screen wake lock -----------------------------------------------------------------------
  const wake = {
    state: 'idle',
    requests: 0,
    granted: 0,
    releases: 0,
    releasesVisible: 0,
    denied: 0,
    error: '',
  }
  // Best effort (docs/plan/39f Deviations): iOS grants it only with user activation on this document, so
  // it is asked for on the Start tap and every bar tap; a denial never fails anything (Auto-Lock Never).
  async function wakeRequest(reason) {
    if (!navigator.wakeLock) {
      wake.state = 'unsupported'
      return wake.state
    }
    if (document.visibilityState !== 'visible') return wake.state
    wake.requests++
    try {
      const s = await navigator.wakeLock.request('screen')
      wake.granted++
      wake.state = 'held'
      report('wake', { event: 'granted', reason })
      s.addEventListener('release', () => {
        const visible = document.visibilityState === 'visible'
        wake.releases++
        if (visible) wake.releasesVisible++
        wake.state = 'released'
        report('wake', { event: 'released', visible })
      })
    } catch (e) {
      wake.denied++
      wake.state = 'denied'
      wake.error = String(e?.name || e)
      report('wake', { event: 'denied', reason, error: wake.error })
    }
    return wake.state
  }

  // --- Walk bar: a bottom sheet in a shadow root, removed entirely during a measuring window ---
  let host = null
  let barState = null
  let measuring = false
  function drawBar() {
    if (host) host.remove()
    host = null
    if (measuring || !barState) return
    host = document.createElement('div')
    host.id = 'walk-bar'
    host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647'
    const root = host.attachShadow({ mode: 'open' })
    const s = barState
    const btn = (label, fn, cls = '') => {
      const b = document.createElement('button')
      b.textContent = label
      b.className = cls
      b.onclick = () => {
        wakeRequest('tap')
        fn()
      }
      return b
    }
    root.innerHTML =
      '<style>.s{font:15px system-ui;background:#111c;color:#fff;padding:12px 14px calc(12px + env(safe-area-inset-bottom));border-top:1px solid #fff4;backdrop-filter:blur(8px)}button{font:inherit;margin:6px 6px 0 0;padding:8px 14px;border-radius:8px;border:1px solid #fff6;background:#334;color:#fff}input{font:inherit;width:100%;box-sizing:border-box;margin-top:6px;padding:6px}.d{opacity:.8;font-size:13px}</style><div class="s"></div>'
    const box = root.querySelector('.s')
    const p = document.createElement('div')
    p.textContent = s.text
    box.append(p)
    if (s.kind === 'act') {
      const d = document.createElement('div')
      d.className = 'd'
      d.textContent = Object.entries(s.detected || {})
        .map(([k, v]) => `${v ? '✓' : '○'} ${k}`)
        .join('   ')
      box.append(d)
      for (const b of s.buttons || []) box.append(btn(b.label, b.fn))
    }
    if (s.kind === 'interrupted') {
      box.append(
        btn('Redo this check', () => {
          meas.interrupted = false
          send('redo', { id: s.id, n: s.n })
          emit('redo', { id: s.id, n: s.n })
          bar.hide()
        }),
      )
      document.body.append(host)
      return
    }
    if (s.kind === 'judge') {
      const note = document.createElement('input')
      note.placeholder = 'note (optional)'
      box.append(note)
      for (const v of ['pass', 'fail', 'skip'])
        box.append(btn(v, () => send('answer', { id: s.id, n: s.n, value: v, note: note.value })))
    }
    box.append(
      btn('Redo previous', () => send('redo', { id: s.id, n: s.n })),
      btn('Pause', () => send('pause', { id: s.id, n: s.n })),
    )
    document.body.append(host)
  }
  const bar = {
    /** `{kind: 'act'|'judge', text, id, n, detected?: {name: bool}}` */
    show(s) {
      barState = s
      drawBar()
      if (s) send('prompt', { id: s.id, n: s.n, kind: s.kind, text: s.text })
    },
    hide() {
      barState = null
      drawBar()
    },
    tick(name, ok) {
      if (!barState) return
      barState.detected = Object.assign({}, barState.detected, { [name]: !!ok })
      drawBar()
    },
    present: () => !!host?.isConnected,
  }
  function setMeasuring(on) {
    measuring = !!on
    drawBar()
  }
  /** Open a measuring window for attempt `n` of check `id`: bar removed, recorder reset, hidden = interrupted. */
  function beginMeasure(id, n) {
    Object.assign(meas, { on: true, id, n, interrupted: false })
    rafReset()
    setMeasuring(true)
  }
  /** Close it; `interrupted` true means the data must be discarded. */
  function endMeasure() {
    const r = { id: meas.id, n: meas.n, interrupted: meas.interrupted }
    meas.on = false
    setMeasuring(false)
    return r
  }

  // --- Public surface -------------------------------------------------------------------------
  /** Navigate this tab to `path` on `origin`, carrying the token under a new tab id; waits (bounded) for acks. */
  async function hop(origin, path, extra) {
    for (let i = 0; i < 40 && outbox.length; i++) await new Promise((r) => setTimeout(r, 100))
    const u = new URL(path, origin)
    u.searchParams.set('walk', id.token)
    u.searchParams.set('run', id.run)
    u.searchParams.set('tab', `${id.tab.split('-')[0]}-${Math.random().toString(36).slice(2, 5)}`)
    for (const [k, v] of Object.entries(extra || {})) u.searchParams.set(k, v)
    location.href = u.href
  }
  window.__walkAgent = {
    id: { run: id.run, tab: id.tab },
    on,
    send,
    sendAndWait,
    hop,
    bar,
    setMeasuring,
    beginMeasure,
    endMeasure,
    measure: () => ({ on: meas.on, id: meas.id, n: meas.n, interrupted: meas.interrupted }),
    rafStats,
    rafReset,
    envFacts,
    /** Call from a user gesture (the runner's Start tap): remembers the wish and requests the lock. */
    start() {
      return wakeRequest('start')
    },
    wakeRequest,
    get wake() {
      return Object.assign({}, wake)
    },
    get gpu() {
      return Object.assign({}, gpu)
    },
    get hidden() {
      return vis.hidden
    },
    get step() {
      return step
    },
    /** Server clock now, from the last message (for timers the service defines). */
    serverNow: () => Date.now() + offset,
    state: () => ({
      connected: !!(ws && ws.readyState === 1),
      outbox: outbox.length,
      failures,
      reconnects,
      seq,
      lastAck,
      tab: id.tab,
      run: id.run,
    }),
  }
  connect()
})()
