// The reference game's collectors (M39f steps 10-12, docs/plan/39f-device-auto-runner.md): M35 and M37b on
// the **release build, DOM and injection only** (no hook of the page is read: the release build has none),
// M39-large-save and M39-frame-shares on the bench build's `window.__bench` through its `window.__check`
// (steps 11), and M34 against the Mac bot partner (step 12). Plain JS, no build step, loaded by `driver.js`
// the first time a check of these kinds runs (`/__walk/collect-ref.js`).
//
// The same rules as the other collectors: the page is observed, never steered by this file beyond what its
// own `__check.act` offers (check build only); the service decides pass or fail from what is sent
// (`checks.mjs`); a measuring window (`A.beginMeasure`) that sees the page hidden is interrupted, a leave
// that is the event under test (M37b) never sits inside one (`K.leave`, collect-life.js).
;(() => {
  const K = window.__walkKit
  if (!K || K.refLoaded) return
  K.refLoaded = true
  const { A, sleep, waitFor, readings, check, measureWindow, json, get, set, clone } = K

  const pageReady = (item) => waitFor(() => window.__pageReady, item.opts.timeoutMs)
  const visible = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none'

  /**
   * What the release build's own DOM says (`src/ui/capability.ts`, `status.ts`): the capability screen, the
   * fatal screen, the `rendererLost` banner, the canvas and its size, and whether any text names a "delivery"
   * (the fixture pages' HUD line; the reference game shows none, `0017` §4).
   */
  function domFacts() {
    const c = document.getElementById('game')
    const w = c ? c.width : 0
    const h = c ? c.height : 0
    return {
      capability: !!document.querySelector('.capability-screen'),
      capability_codes: [...document.querySelectorAll('.capability-screen [data-code]')].map(
        (e) => e.dataset.code,
      ),
      fatal: !!document.querySelector('.engine-fatal'),
      start_failure: !!document.querySelector('.start-failure'),
      canvas: !!c && c.clientWidth > 0 && c.clientHeight > 0 && w > 0 && h > 0,
      canvas_w: w,
      canvas_h: h,
      renderer_lost: visible(document.querySelector('.renderer-lost')),
      delivery_line: /\bdelivery\b/i.test(document.body ? document.body.innerText : ''),
      link: document.querySelector('.link-status')?.dataset.state ?? null,
    }
  }

  const refCollectors = {
    /**
     * M35-safari-build-*: wait for the page, watch it for `observeMs` with the bar gone (frame cadence from
     * the agent's own rAF recorder), then read the DOM and the wrapped device. "The world is drawn" is the
     * person's: a release build has no hook that says what its canvas shows.
     */
    async 'reference-dom'(item) {
      const ready = await pageReady(item)
      A.beginMeasure(item.id, item.n)
      await sleep(item.opts.observeMs ?? item.plan.observeMs ?? 8000)
      if (A.measure().interrupted) {
        A.endMeasure()
        return null
      }
      const raf = A.rafStats()
      if (A.endMeasure().interrupted) return null
      return { ready: !!ready, dom: domFacts(), raf, gpu: A.gpu, reloads: 0 }
    },

    /**
     * M37b-ios-background: `plan.leaves.runs` deliberate leaves (the person backgrounds the tab for several
     * minutes under memory pressure). Per run: the wrapped device's loss and errors during the absence, the
     * `rendererLost` banner, the DOM's canvas and fatal screen, and whether the agent's rAF came back. A tab
     * Safari discards reloads: the boot nonce makes that a failure with the runs that finished (`runs`
     * lives in sessionStorage; `driver.js` sends it with the reload report).
     */
    async 'reference-bg'(item) {
      await pageReady(item)
      const want = item.plan.leaves.runs
      const runs = json(get('runs'), [])
      for (let i = runs.length; i < want; i++) {
        const g0 = A.gpu
        const r = await K.leave(item, {
          text: `Run ${i + 1} of ${want}: put this tab in the background under memory pressure (open the camera and a few heavy pages) for about {s} seconds, then come back to it.`,
          ms: item.plan.leaves.ms,
          onVisible: () => ({ frames: A.rafStats().frames }),
        })
        if (!r) return { ready: true, runs, reloads: 0, timedOut: true }
        const resumed = !!(await waitFor(() => A.rafStats().frames > r.atVisible.frames + 3, 6000))
        await sleep(500)
        const g1 = A.gpu
        const dom = domFacts()
        const run = {
          run: i + 1,
          ms: r.ms,
          deviceLost: g1.lost - g0.lost,
          gpuErrors: g1.errors - g0.errors,
          rendererLost: dom.renderer_lost,
          fatal: dom.fatal,
          canvas: dom.canvas,
          rafResumed: resumed,
          frozen: !resumed || dom.fatal || !dom.canvas,
        }
        runs.push(run)
        set('runs', JSON.stringify(runs))
        A.send('reading', { id: item.id, n: item.n, key: 'run', data: run })
      }
      return { ready: true, runs, reloads: 0, gpu: A.gpu, dom: domFacts() }
    },

    /**
     * M39-large-save and M39-frame-shares: the bench build's HUD through `__check.readings()` once a second
     * for `plan.windowMs`, the bar gone, a hide an interruption. `steady` is every sample after `warmupMs`
     * (the first ten seconds are not read: the first tick visits all 262,144 furnaces); `final` is the last
     * reading, which is also what a person copying the HUD would copy.
     */
    async bench(item) {
      if (!(await waitFor(() => check()?.ready, item.opts.timeoutMs)))
        return { ready: false, windows: [], steady: [], reloads: 0 }
      const m = await measureWindow(item)
      if (!m) return null
      const last = m.window.samples.at(-1) || {}
      return {
        ready: true,
        windows: [m.window],
        steady: m.steady,
        final: clone(last),
        reloads: 0,
        errors: clone(check().errors()),
      }
    },
  }

  Object.assign(K.collectors, refCollectors)
  K.refFacts = { domFacts, visible }
  void readings
})()
