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
  const { A, sleep, waitFor, readings, check, measureWindow, ask, json, get, set, clone } = K

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

  // --- M34 on the check build, joined to the real-time server with the Mac bot as player 2 ------------
  // The phone and the bot talk through the round log: this side sends `reading {key: 'phone'}` (phase) and
  // reads `state.bot` / `state.botView` (what the service-side bot posted), both part of the step.
  const act = (name, arg) => check().act[name](arg)
  const errors = () => {
    try {
      return clone(check().errors())
    } catch {
      return []
    }
  }
  const joined = (item) =>
    waitFor(
      () => check()?.ready && readings().link === 'online' && readings().ui_seen,
      item.opts.timeoutMs,
    )
  const say = (item, phase, extra) =>
    A.send('reading', { id: item.id, n: item.n, key: 'phone', data: { phase, ...extra } })
  const stateOf = (item) => K.live(item).state || {}
  const botPhase = (item) => stateOf(item).bot?.phase
  const botMs = (item) => item.opts.botTimeoutMs ?? 150_000
  /** The own camera at the spawn and zoomed so a circle within a few tiles is drawn. */
  const stand = (item) =>
    act('moveTo', {
      x: readings().spawn_x,
      y: readings().spawn_y,
      tiles: item.opts.tilesAcross ?? 40,
    })
  const others = (dots, state) => dots.filter((d) => d.endsWith(`:${state}:other`)).length

  const MP = {
    /** M34-two-devices: the bot collects, crafts and places; each side sees the other; it drops and returns. */
    async two(item) {
      if (!(await joined(item))) return { ready: false, errors: errors() }
      await stand(item)
      say(item, 'joined')
      const max = { remote_entities: 0, furnaces: 0, roster_n: 0 }
      const look = () => {
        const r = readings()
        max.remote_entities = Math.max(max.remote_entities, r.remote_circles)
        max.furnaces = Math.max(max.furnaces, r.furnaces)
        max.roster_n = Math.max(max.roster_n, r.roster_n)
        return r
      }
      const placed = await waitFor(
        () => {
          look()
          return botPhase(item) === 'placed'
        },
        botMs(item),
        200,
      )
      await waitFor(() => look().furnaces >= 1 && look().remote_circles >= 1, 30_000, 200)
      say(item, 'saw-furnace')
      const t0 = Date.now()
      const hollow = await waitFor(
        () => others(readings().roster, 'offline') >= 1,
        item.opts.graceMs ?? 90_000,
        200,
      )
      const hollowAfterMs = Date.now() - t0
      say(item, 'saw-hollow')
      const filled = await waitFor(
        () => {
          const dots = readings().roster
          return (
            botPhase(item) === 'back' &&
            others(dots, 'online') >= 1 &&
            others(dots, 'offline') === 0
          )
        },
        botMs(item),
        200,
      )
      return {
        ready: true,
        timedOut: !placed,
        final: { ...max },
        roster: { hollowAfterDrop: !!hollow, hollowAfterMs, filledOnReturn: !!filled },
        botView: clone(stateOf(item).botView ?? null),
        errors: errors(),
      }
    },

    /** M34-own-timer-bar: three collects timed tap to result on Wi-Fi, then three on the other link. */
    async timer(item) {
      if (!(await joined(item))) return { ready: false, errors: errors() }
      const stone = item.plan.tiles.stone
      await act('moveTo', { x: stone.x, y: stone.y, tiles: 20 })
      await waitFor(
        () => document.querySelector(`[data-collect-tile="${stone.x},${stone.y}"]`),
        30_000,
        200,
      )
      const tol = item.plan.timer.toleranceMs
      const timers = []
      let link = 'wifi'
      for (let li = 0; li < 2; li++) {
        if (li === 1) {
          let chosen = null
          await ask(item, {
            text: 'Switch the phone off Wi-Fi now (cellular, or a throttled link), keep this page in front, then tap the button.',
            detect: { answered: () => chosen !== null },
            buttons: [
              { label: 'Wi-Fi is off', fn: () => (chosen = 'cellular') },
              { label: 'No cellular here', fn: () => (chosen = 'none') },
            ],
          })
          if (chosen !== 'cellular') break
          link = 'cellular'
          await sleep(item.opts.settleMs ?? 2000) // the socket redials over the new link
          await waitFor(() => readings().link === 'online', 30_000, 200)
        }
        for (let i = 0; i < 3; i++) {
          let r = await act('collectOnce', stone)
          if (!r.ok && /button/.test(r.reason || '')) {
            await sleep(1000) // the Ui had not caught up with the camera, or the last collect was ending
            r = await act('collectOnce', stone)
          }
          const gap = r.gapMs ?? null
          timers.push({
            link,
            ok: !!r.ok,
            ...(r.ok ? {} : { reason: r.reason }),
            durationMs: r.durationMs ?? null,
            gapMs: gap,
            fillAtResult: r.fillAtResult ?? null,
            resultBeforeFull: !!r.ok && gap !== null && gap < -tol,
            fullWaiting: !!r.ok && gap !== null && gap > tol,
          })
          await sleep(400)
        }
      }
      const links = [...new Set(timers.filter((t) => t.ok).map((t) => t.link))]
      return { ready: true, timers, links, errors: errors() }
    },

    /** M34-remote-motion: the bot walks, every frame's remote circle is kept; then the bot goes and the fade is. */
    async motion(item) {
      if (!(await joined(item))) return { ready: false, errors: errors() }
      await stand(item)
      const seen = await waitFor(() => readings().remote_circles >= 1, botMs(item), 200)
      if (!seen)
        return { ready: true, timedOut: true, motionFrames: [], fadeFrames: [], errors: errors() }
      say(item, 'ready')
      await act('sample', true)
      await waitFor(() => botPhase(item) === 'moved', botMs(item), 200)
      const walked = await act('sample', false)
      const motionFrames = (walked || [])
        .filter((f) => f.circles.length)
        .map((f) => [Math.round(f.t), +f.circles[0].x.toFixed(3), +f.circles[0].y.toFixed(3)])
      await act('sample', true)
      say(item, 'moved-seen') // the bot's socket goes away now
      const t0 = Date.now()
      let gone = 0
      await waitFor(
        () => {
          // the circle was drawn and has now been missing for a second: the fade is over
          gone = readings().remote_circles === 0 && Date.now() - t0 > 1500 ? gone + 1 : 0
          return gone > 5
        },
        item.opts.fadeMs ?? 25_000,
        200,
      )
      const faded = await act('sample', false)
      const fadeFrames = (faded || []).map((f) => [
        Math.round(f.t),
        f.circles.length,
        f.circles.length ? f.circles[0].alpha : null,
      ])
      return { ready: true, motionFrames, fadeFrames, errors: errors() }
    },
  }

  const refCollectors = {
    'reference-mp': (item) => MP[item.plan.mode](item),

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
      // What the judge reads per run (the value of `drawn_again_per_run`): the facts, in words.
      const summary = runs
        .map(
          (r) =>
            `run ${r.run}: ${r.frozen ? 'FROZEN or no canvas' : 'drawn again'} (frames ${r.rafResumed ? 'resumed' : 'did not resume'}, canvas ${r.canvas ? 'present' : 'missing'}, renderer-lost banner ${r.rendererLost ? 'shown' : 'not shown'}, device lost ${r.deviceLost})`,
        )
        .join('; ')
      return { ready: true, runs, summary, reloads: 0, gpu: A.gpu, dom: domFacts() }
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
})()
