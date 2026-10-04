// The Mac browsers' collectors (M39f step 14, docs/plan/39f-device-auto-runner.md): the rows that are the Mac's
// own, walked in a tab the service opens itself (`open -a Safari|Firefox`, mac-browser.mjs) on the loopback
// origin, with the same agent, driver and step machine as the phone. Plain JS, no build step, loaded by
// `driver.js` on demand (`/__walk/collect-mac.js`).
//   pinch-desktop  M11-pinch-desktop-safari: a trackpad pinch (`gesture*` events in Safari, a ctrl+wheel in
//                  Chromium) and what the camera and the page did with it
//   harness        M17b: `device.html?harness=1`'s own probe lines and errors after the person's recording; the
//                  allocation timeline and the GC markers stay the person's (a judge sheet, typed in the note)
//   desktop-play   M39-desktop-browsers: a scripted pan on the check build for `windowMs` in each Mac browser
//                  in turn (a leg each; the last leg sends the attempt's data), console and GPU errors, the
//                  long-frame proxy; a browser without `navigator.gpu` is recorded as unsupported
// Observer only: the page is read and its own `__check.act` drivers are used; the service decides pass or
// fail from what is sent (`checks.mjs`).
;(() => {
  const K = window.__walkKit
  if (!K || K.macLoaded) return
  K.macLoaded = true
  const { A, sleep, waitFor, readings, check, measureWindow, ask, clone, helperDone } = K

  const ready = (item) => waitFor(() => check()?.ready, item.opts.timeoutMs)
  const errors = () => {
    try {
      return clone(check().errors())
    } catch {
      return []
    }
  }
  const sum = (o) => Object.values(o || {}).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0)

  /** Pinch events seen since the log was installed (scalars; capture-phase passive listeners). */
  function pinchLog() {
    if (K.pinch) return K.pinch
    const st = { gestures: 0, wheel: 0, events: 0, scaleMax: 1, scaleMin: 1 }
    const opt = { capture: true, passive: true }
    addEventListener(
      'gesturechange',
      (e) => {
        st.gestures++
        st.events++
        if (typeof e.scale === 'number') {
          if (e.scale > st.scaleMax) st.scaleMax = e.scale
          if (e.scale < st.scaleMin) st.scaleMin = e.scale
        }
      },
      opt,
    )
    addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey) {
          st.wheel++
          st.events++
        }
      },
      opt,
    )
    K.pinch = st
    return st
  }

  /** Counts of the page's own errors since this call (a JS exception, a rejected promise, `console.error`). */
  function errorCounter() {
    if (K.pageErrors) return K.pageErrors
    const st = { n: 0 }
    addEventListener('error', () => st.n++)
    addEventListener('unhandledrejection', () => st.n++)
    const orig = console.error
    console.error = (...a) => {
      st.n++
      return orig.apply(console, a)
    }
    K.pageErrors = st
    return st
  }

  /**
   * Why this browser cannot run a WebGPU check at all, or null: no `navigator.gpu` (Firefox without it) or an
   * adapter request that answers nothing (Firefox with the API behind a flag and no adapter).
   */
  async function noWebgpu(name) {
    if (!navigator.gpu) return `${name}: no navigator.gpu (${navigator.userAgent})`
    let a = null
    try {
      a = await navigator.gpu.requestAdapter()
    } catch {}
    return a ? null : `${name}: navigator.gpu gave no adapter (${navigator.userAgent})`
  }

  const browserName = (item, k = 0) => (item.plan.browsers || [])[k] || 'this browser'

  const macCollectors = {
    async 'pinch-desktop'(item) {
      if (!(await ready(item))) return { ready: false, errors: errors() }
      const log = pinchLog()
      const base = readings().tiles_across
      const vv0 = window.visualViewport ? window.visualViewport.scale : 1
      const dpr0 = window.devicePixelRatio
      const moved = () => Math.abs(readings().tiles_across - base) > 0.01 * base
      await ask(item, {
        text: `In ${browserName(item)}: pinch in and out with the trackpad, over a landmark tile.`,
        detect: { 'pinch seen': () => log.events >= 3, 'zoom changed': moved },
        settleMs: 500,
      })
      const r = readings()
      const vv = window.visualViewport ? window.visualViewport.scale : 1
      return {
        ready: true,
        pointer: {
          pageZoomed: vv !== vv0 || window.devicePixelRatio !== dpr0,
          gestures: log.gestures,
          wheelPinch: log.wheel,
          scaleMax: log.scaleMax,
          scaleMin: log.scaleMin,
        },
        camera: {
          tilesAcrossChanged: moved(),
          tilesBefore: base,
          tilesAfter: r.tiles_across,
          pinchEvents: log.events,
        },
        errors: errors(),
      }
    },

    async harness(item) {
      const none = await noWebgpu(browserName(item))
      if (none) return { ready: false, noRun: true, unsupported: [none], harness: { ran: false } }
      if (!(await waitFor(() => window.__pageReady, item.opts.timeoutMs)))
        return { ready: false, harness: { ran: false } }
      const b = browserName(item)
      const tool =
        b === 'firefox'
          ? 'the Profiler with JS Allocations'
          : 'Web Inspector, Timelines, JavaScript Allocations'
      await ask(item, {
        text: `In ${b}: open ${tool}, start recording, press Run on the page, and stop the recording after the page prints its result.`,
        detect: { 'run finished': () => !!window.__deviceHarness },
      })
      const h = window.__deviceHarness
      const hud = document.getElementById('hud')
      const mem = h ? clone(h.memoryBytes()) : null
      return {
        ready: true,
        harness: {
          ran: !!h,
          errors: h ? h.errors().length : null,
          viewProbe: h ? h.viewProbePasses : null,
          sabWriteTexture: h ? h.sabWriteTextureOk : null,
          memory: mem,
          memoryTotal: mem ? sum(mem) : null,
          lines: hud ? hud.textContent.split('\n').slice(-12) : [],
        },
      }
    },

    async 'desktop-play'(item) {
      const state = K.live(item).state || {}
      const earlier = Object.keys(state).filter((k) => k.startsWith('leg:'))
      const k = earlier.length
      const browsers = item.plan.browsers || []
      const counter = errorCounter()
      const leg = {
        k,
        browser: browsers[k] || 'unknown',
        ua: navigator.userAgent,
        ready: true,
        windows: [],
        gpu: A.gpu,
        pageErrors: 0,
      }
      const none = await noWebgpu(leg.browser)
      if (none) leg.unsupported = none
      else if (!(await ready(item))) leg.ready = false
      else {
        // One window; once a second the scripted pan walks the camera round a circle of the spawn.
        const m = await measureWindow(item, async (_i, t) => {
          const r = readings()
          await check().act.moveTo({
            x: Math.round(r.spawn_x + 24 * Math.sin(t / 4000)),
            y: Math.round(r.spawn_y + 24 * Math.cos(t / 4000)),
            tiles: 40,
          })
        })
        if (!m) return null // interrupted by a hide: the service opens the redo
        leg.windows = [m.window]
        leg.gpu = A.gpu
        leg.pageErrors = counter.n + errors().length
      }
      if (k + 1 < browsers.length) {
        // Not the last browser: the leg's facts go to the service, which opens the next one.
        await A.sendAndWait(
          'reading',
          { id: item.id, n: item.n, key: `leg:${k}`, data: leg },
          15000,
        )
        await A.sendAndWait(
          'reading',
          { id: item.id, n: item.n, key: 'leg-done', data: { k } },
          15000,
        )
        return helperDone(null)
      }
      const legs = [...earlier.sort().map((key) => state[key]), leg]
      const played = legs.filter((l) => !l.unsupported)
      return {
        ready: true,
        legs: legs.map((l) => ({
          browser: l.browser,
          ua: l.ua,
          unsupported: l.unsupported || null,
        })),
        windows: legs.flatMap((l) => l.windows),
        gpu: {
          devices: legs.reduce((a, l) => a + (l.gpu?.devices || 0), 0),
          errors: legs.reduce((a, l) => a + (l.gpu?.errors || 0), 0),
          lost: legs.reduce((a, l) => a + (l.gpu?.lost || 0), 0),
        },
        pageErrors: legs.reduce((a, l) => a + (l.pageErrors || 0), 0),
        ran: played.length > 0 && played.every((l) => l.ready),
        noRun: played.length === 0,
        unsupported: legs.map((l) => l.unsupported).filter(Boolean),
      }
    },
  }

  Object.assign(K.collectors, macCollectors)
  K.sleepMac = sleep
})()
