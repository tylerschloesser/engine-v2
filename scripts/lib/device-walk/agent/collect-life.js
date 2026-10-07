// The lifecycle collectors (M39f steps 7-8, docs/plan/39f-device-auto-runner.md): `slice.html` (boot,
// round-trip, coexist, background, low-power), `world.html` (hidden-pause, kill-resume, private,
// world-busy, export-import) and `mp.html` (socket-resume, play-through-drop, net-heap). Plain JS, no build
// step, loaded by `driver.js` the first time a check of these kinds runs (`/__walk/collect-life.js`).
//
// Observer plus scripted hands, as the rest of the driver: the page's own `window.__check` (`act.paint`,
// `act.flick`, `readings()`) does what a finger would, the person is asked only for what no script can do
// (leave the app, lock the screen, Low Power Mode, a Private tab, a second tab, a network drop), and the
// service decides pass or fail from what is sent (`checks.mjs`).
//
// **Deliberate hides.** A `hidden` inside a measuring window (`A.beginMeasure`) interrupts the attempt, which
// is right for a frame-time window and wrong for a check whose subject is the hide. Those collectors never
// open a window around the hide: the leave is the event under test (`leave()` below, with the person told
// how long and the absence measured from the page's own `visibilitychange` events), and any window
// (coexist, net-heap) is a separate stretch with the page in front of the person.
;(() => {
  const K = window.__walkKit
  if (!K || K.lifeLoaded) return
  K.lifeLoaded = true
  const { A, sleep, waitFor, readings, check, measureWindow, ask, live, helperDone, clone } = K

  const ready = (item) => waitFor(() => check()?.ready, item.opts.timeoutMs)
  const errors = () => {
    try {
      return clone(check().errors())
    } catch {
      return []
    }
  }
  /** What the page says about itself when a wait timed out (the M39n `why` shape, without the resource list). */
  const notReadyWhy = () => {
    let link = null
    let isReady = false
    try {
      link = readings().link ?? null
    } catch {}
    try {
      isReady = !!check()?.ready
    } catch {}
    return {
      ready: isReady,
      link,
      errors: errors(),
      url: location.href,
      readyState: document.readyState,
    }
  }
  const act = (name, arg) => check().act[name](arg)
  const say = (item, text) =>
    A.bar.show({ kind: 'act', id: item.id, n: item.n, text, detected: {} })
  const isCurrent = (item) => {
    const s = A.step
    return !!(s && s.kind === 'walk' && s.item && s.item.id === item.id && s.item.n === item.n)
  }
  const pageParam = (item, key) => new URLSearchParams(item.page.split('?')[1] || '').get(key)

  /**
   * Ask the person to leave the page for about `ms` (the plan's `{s}` is replaced by the seconds) and
   * measure the absence from this page's own `visibilitychange` events, wall clock, so a frozen timer does
   * not matter. An absence under `minFrac` of the target (or over `maxFrac` when given) asks again.
   * `onHidden`/`onVisible` run inside the events (a synchronous reading of the page's tick, say).
   * Resolves `{ ms, hiddenAt, visibleAt, atHidden, atVisible }`, or null when nobody came back in time.
   */
  async function leave(item, { text, ms, minFrac = 0.7, maxFrac = null, onHidden, onVisible }) {
    const target = item.opts.leaveMs ?? ms
    const secs = Math.round(target / 100) / 10
    let miss = null
    for (;;) {
      let hiddenAt = 0
      let visibleAt = 0
      let atHidden = null
      let atVisible = null
      const onChange = () => {
        if (document.hidden && !hiddenAt) {
          hiddenAt = Date.now()
          atHidden = onHidden ? onHidden() : null
        } else if (!document.hidden && hiddenAt && !visibleAt) {
          visibleAt = Date.now()
          atVisible = onVisible ? onVisible() : null
        }
      }
      document.addEventListener('visibilitychange', onChange)
      const said = text.replace('{s}', String(secs))
      const seen = await ask(item, {
        text: miss === null ? said : `That was ${Math.round(miss / 100) / 10} s. ${said}`,
        detect: { left: () => hiddenAt > 0, returned: () => visibleAt > 0 },
        timeoutMs: Math.max(item.opts.actTimeoutMs, target * 4),
      })
      document.removeEventListener('visibilitychange', onChange)
      if (!seen) return null
      const got = visibleAt - hiddenAt
      if (got >= minFrac * target && (maxFrac === null || got <= maxFrac * target))
        return { ms: got, hiddenAt, visibleAt, atHidden, atVisible }
      miss = got
    }
  }

  K.leave = leave // the reference game's M37b leaves the same way (collect-ref.js)

  // --- slice.html -----------------------------------------------------------------------------
  const SLICE = {
    /** M16-slice-boot: the boot facts and "terrain drawn"; M03 comes from the round, the gestures from a tap. */
    async boot(item) {
      await waitFor(() => readings().terrain_drawn, item.opts.timeoutMs)
      return { ready: true, final: readings(), gestures: 'see M11-gestures', errors: errors() }
    },
    /** M16-round-trip: ten Paints through the page's own dispatch, the host's verdict and its latency each. */
    async roundtrip(item) {
      const latency = []
      for (let i = 0; i < 10; i++) {
        const r = await act('paint', { x: 50 + i, y: 50 })
        latency.push(r.ms)
        await sleep(150)
      }
      await waitFor(() => readings().confirmed >= 10, 10_000)
      return { ready: true, final: readings(), latency, errors: errors() }
    },
    /** M16-coexist: the whole window with the page's scripted pan (`?autopan=1`) and a Paint a second. */
    async coexist(item) {
      // M39t: the page publishes `engine_mem_grows` only after its first reading (a 3 s interval); a window
      // that sampled before that has no value to judge. Wait for it, bounded like the page's own ready.
      if (
        !(await ready(item)) ||
        !(await waitFor(() => readings().engine_mem_grows != null, item.opts.timeoutMs))
      )
        return { ready: false, why: notReadyWhy(), errors: errors() }
      let paints = 0
      const m = await measureWindow(item, async (i) => {
        A.task('paint')
        await act('paint', { x: 50 + (i % 20), y: 50 + (i % 7) })
        paints++
      })
      if (!m) return null
      return {
        ready: true,
        windows: [m.window],
        steady: m.steady,
        paints,
        reloads: 0,
        errors: errors(),
      }
    },
    /** M16-background: leave the page twice (another app, the lock screen); tick at hidden vs visible. */
    async background(item) {
      const rounds = []
      for (const L of item.plan.leaves) {
        const r = await leave(item, {
          text: L.text,
          ms: L.ms,
          onHidden: () => ({ tick: readings().tick }),
          onVisible: () => ({ tick: readings().tick, frames: readings().frames }),
        })
        if (!r) return { ready: true, hidden: { rounds }, reloads: 0, timedOut: true }
        const f0 = r.atVisible.frames
        const resumed = await waitFor(() => readings().frames > f0 + 3, 5000)
        rounds.push({
          ms: r.ms,
          tickDelta: r.atVisible.tick - r.atHidden.tick,
          rafResumed: !!resumed,
        })
      }
      return { ready: true, hidden: { rounds }, reloads: 0, final: readings(), errors: errors() }
    },
    /**
     * M16-low-power: Low Power Mode is a rAF cadence of about 30 Hz (the agent's own recorder, its ring
     * reset every 2.5 s so the median is recent). One scripted flick at the normal cadence, one at the halved
     * one; the service shows the ratio of the distances to the judge (time-based motion keeps it near 1).
     */
    async lowpower(item) {
      let resetAt = 0
      const cadence = () => {
        const now = Date.now()
        if (now - resetAt > 2500) {
          A.rafReset()
          resetAt = now
          return null
        }
        const st = A.rafStats()
        return st.frames >= 20 ? st.p50 : null
      }
      const normal = () => {
        const p = cadence()
        return p !== null && p <= 20
      }
      const low = () => {
        const p = cadence()
        return p !== null && p > 25
      }
      if (!(await waitFor(normal, 5000, 200))) {
        const off = await ask(item, {
          text: 'Low Power Mode looks on. Turn it off (Settings, Battery), then come back to this page.',
          detect: { normal },
          settleMs: 1000,
        })
        if (!off) return null
      }
      const p50Normal = A.rafStats().p50
      // Whatever happens from here on (a throw, a prompt nobody answered), the phone is asked to leave Low Power
      // Mode before the item ends: it stays on for every later item otherwise (M39u, finding 8 of m39r-iphone).
      let asked = false
      let result = null
      try {
        const f60 = await act('flick', {})
        asked = true
        const seen = await ask(item, {
          text: 'Turn Low Power Mode on (Settings, Battery), then come back to this page.',
          detect: { 'low power detected': low },
          settleMs: 1000,
        })
        if (!seen) {
          result = { ready: true, lowPower: { detected: false, p50Normal }, final: readings() }
          return result
        }
        const p50Low = A.rafStats().p50
        const f30 = await act('flick', {})
        result = {
          ready: true,
          lowPower: {
            detected: true,
            p50Normal,
            p50Low,
            tiles60: f60.tiles,
            tiles30: f30.tiles,
            release60: f60.releaseVx,
            release30: f30.releaseVx,
            spacing60: f60.spacingMaxMs,
            spacing30: f30.spacingMaxMs,
            releaseRatio: f60.releaseVx ? +(f30.releaseVx / f60.releaseVx).toFixed(3) : null,
            distanceRatio: f60.tiles > 0 ? +(f30.tiles / f60.tiles).toFixed(3) : null,
          },
          final: readings(),
          errors: errors(),
        }
        return result
      } finally {
        if (asked) {
          let restored = false
          try {
            restored = !!(await ask(item, {
              text: 'Low Power Mode looks on. Turn it off (Settings, Battery), then come back to this page.',
              detect: { normal },
              settleMs: 1000,
            }))
          } catch {}
          // A fact for the next items' numbers, never a criterion.
          if (result) result.lowPower.low_power_restored = restored
        }
      }
    },
  }

  // --- world.html -----------------------------------------------------------------------------
  const statusText = () => document.getElementById('world-op-status')?.textContent || ''
  const bannerShown = () => {
    const el = document.getElementById('world-busy')
    return !!el && getComputedStyle(el).display !== 'none'
  }
  /** The tab opened from the bar reports to the service and stays out of the walk. */
  async function reportAndRest(item, key, data, text) {
    await A.sendAndWait('reading', { id: item.id, n: item.n, key, data })
    say(item, text)
    return helperDone(null)
  }

  const WORLD = {
    /** M23-hidden-pause: Paint (a fresh tick), leave 30 s, Paint again: the second tick a few past the first. */
    async 'hidden-pause'(item) {
      if (!(await ready(item))) return { ready: false }
      const pre = await act('paint', { x: 0, y: 0 })
      const L = item.plan.leaves[0]
      const r = await leave(item, { text: L.text, ms: L.ms })
      if (!r) return null
      await sleep(300)
      const post = await act('paint', { x: 0, y: 0 })
      return {
        ready: true,
        hidden: { ms: r.ms, tickDelta: post.tick - pre.tick, pre: { tick: pre.tick }, post },
        reloads: 0,
        final: readings(),
        errors: errors(),
      }
    },

    /**
     * M23-kill-resume, two documents. Before: play for `playMs` (a Paint a second), take hash, tick and the
     * admitted count, wait out the log's once-a-second sync, keep the reading **on the service** and ask
     * for the kill. After (a new document: Safari reopened, or the QR scanned again): the same reading
     * compared. "Lost" is read from the log's order: frames land in order, so a world resumed at or past
     * the tick of the last admitted action has every action admitted before it (the frames after it, the
     * ticking of an idle world, may be lost: that is the log's sync window, not an action).
     */
    async kill(item) {
      const state = live(item).state || {}
      if (state.before) {
        const before = state.before
        if (!(await ready(item))) return { ready: false, before }
        await sleep(1500)
        const a = await act('read')
        const rd = readings()
        const loaded = !rd.load_failed && !rd.world_busy && !rd.save_incompatible
        const resumed = loaded && a.tick >= before.lastActionTick
        return {
          ready: true,
          before,
          after: {
            tick: a.tick,
            hash: a.hash,
            resumed,
            lost: resumed ? 0 : before.admitted,
            durable: rd.durable,
            hashEqual: a.hash === before.hash,
          },
          final: rd,
        }
      }
      if (!(await ready(item))) return null
      const t0 = Date.now()
      let lastActionTick = 0
      for (let i = 0; Date.now() - t0 < item.opts.playMs; i++) {
        lastActionTick = (await act('paint', { x: 50 + (i % 40), y: 50 + (i % 9) })).tick
        await sleep(1000)
      }
      await sleep(1500)
      const b = await act('read')
      const before = {
        tick: b.tick,
        lastActionTick,
        hash: b.hash,
        admitted: readings().admitted,
        at: Date.now(),
      }
      await sleep(1600) // the once-a-second `sync` passes the frames of `before`
      await A.sendAndWait('reading', { id: item.id, n: item.n, key: 'before', data: before })
      K.set('col', null) // the next document of this attempt is not a reload to retry
      let left = false
      const onVis = () => {
        if (document.hidden) left = true
      }
      document.addEventListener('visibilitychange', onVis)
      const asked = await ask(item, {
        text: 'Swipe Safari away in the app switcher (close it), then open Safari again. If this tab is gone, scan the QR code on the Mac again.',
        detect: { left: () => left },
        timeoutMs: 30 * 60_000,
      })
      document.removeEventListener('visibilitychange', onVis)
      if (!asked) return null
      // Still alive after the person came back (it was not killed): a fresh document does the "after".
      await waitFor(() => !document.hidden, 30 * 60_000, 500)
      const u = new URL(location.href)
      u.searchParams.set('_walk', `${item.n}k`)
      location.assign(u.href)
      return null
    },

    /** M23-world-busy: the first tab opens a second tab of the same world from the bar; both report. */
    async busy(item) {
      if (!(await ready(item))) return null
      const rd = readings()
      if (rd.world_busy)
        return reportAndRest(
          item,
          'second',
          { worldBusy: true, banner: bannerShown() },
          'This tab shows WorldBusy, as expected. Go back to the first tab (the round continues there); you can close this one.',
        )
      const p1 = await act('paint', { x: 50, y: 50 })
      const link = K.linkFor(`/${item.page}`)
      const seen = await ask(item, {
        text: 'Tap "Open second tab", look at the new tab, then come back to this one.',
        buttons: [
          { label: 'Open second tab', fn: () => window.open(link, '_blank') },
          { label: 'Copy link', fn: () => navigator.clipboard?.writeText(link) },
        ],
        detect: { 'second tab reported': () => live(item).state?.second },
        timeoutMs: item.opts.actTimeoutMs * 2,
      })
      if (!seen) return null
      await sleep(500)
      const p2 = await act('paint', { x: 51, y: 50 })
      const now = readings()
      return {
        ready: true,
        first: {
          superseded: !!(now.world_busy || now.load_failed),
          tickDelta: p2.tick - p1.tick,
          result: p2.result,
        },
        second: live(item).state.second,
        final: now,
        reloads: 0,
      }
    },

    /**
     * M23-private: a link on the bar is opened in a Private tab (Safari offers no way to do that from a
     * page). The Private tab, which can tell itself by `durable: false`, measures and sends the series; the
     * tab that asked just waits for the walk to move on.
     */
    async private(item) {
      if (!(await ready(item))) return null
      await waitFor(() => readings().durable !== null, 15_000)
      if (readings().durable === false) {
        const p1 = await act('paint', { x: 50, y: 50 })
        await sleep(1500)
        const p2 = await act('paint', { x: 51, y: 50 })
        say(item, 'Measured. Close this Private tab and go back to the first tab.')
        return helperDone({
          ready: true,
          final: readings(),
          paint: { tickDelta: p2.tick - p1.tick },
          reloads: 0,
          errors: errors(),
          via: 'private tab',
        })
      }
      const link = K.linkFor(`/${item.page}`)
      await ask(item, {
        text: `Open this link in a Private tab: ${link}`,
        buttons: [{ label: 'Copy link', fn: () => navigator.clipboard?.writeText(link) }],
        detect: { 'measured in the Private tab': () => !isCurrent(item) },
        timeoutMs: item.opts.actTimeoutMs * 2,
      })
      return null
    },

    /**
     * M23-export-import: the page's own Export and Import controls are the person's (a real download, a real
     * picker); the imported world is opened in a second tab from the bar and reports its hash and tick.
     * Hashes are compared only at equal ticks (a ticking world is never at the exported tick), otherwise the
     * numbers go to the judge.
     */
    async export(item) {
      if (!(await ready(item))) return null
      const mine = pageParam(item, 'world')
      const rd0 = readings()
      if (rd0.world !== mine) {
        const a = await act('read')
        const rd = readings()
        return reportAndRest(
          item,
          'import',
          {
            loaded: !rd.load_failed && !rd.world_busy && !rd.save_incompatible,
            hash: a.hash,
            tick: a.tick,
            world: rd.world,
          },
          'The imported world is open and was read. Go back to the first tab; you can close this one.',
        )
      }
      await act('paint', { x: 50, y: 50 })
      const exported = await ask(item, {
        text: `Tap Export on the page (the file ${mine}.world downloads; check that it arrives in Files).`,
        detect: { exported: () => /^exported \d+ bytes/.test(statusText()) },
        timeoutMs: item.opts.actTimeoutMs * 2,
      })
      if (!exported) return null
      const bytes = Number(/^exported (\d+) bytes/.exec(statusText())?.[1] ?? 0)
      const e = await act('read')
      const link = K.linkFor('/world.html', { world: item.plan.importId })
      const done = await ask(item, {
        text: `Now choose the downloaded file in Import, type the id ${item.plan.importId}, tap Import, then tap "Open the imported world".`,
        buttons: [{ label: 'Open the imported world', fn: () => window.open(link, '_blank') }],
        detect: {
          imported: () => /^imported as/.test(statusText()),
          'imported world read': () => live(item).state?.import,
        },
        timeoutMs: item.opts.actTimeoutMs * 3,
      })
      if (!done) return null
      const imp = live(item).state.import
      const ticksApart = Math.abs(imp.tick - e.tick)
      return {
        ready: true,
        export: { bytes, hash: e.hash, tick: e.tick },
        import: {
          ...imp,
          ticksApart,
          hashEqual: ticksApart === 0 ? imp.hash === e.hash : null,
        },
        final: readings(),
        errors: errors(),
      }
    },
  }

  // --- mp.html --------------------------------------------------------------------------------
  const SCAN = 'dialog[open],[role=dialog],[role=alertdialog],[aria-modal="true"],.modal'

  /**
   * One run of M29's choreography: the sheet says what to do and for about how long, the page measures the
   * absence from its own events (a hide: `visibilitychange`; a drop with the page in front: `offline` and
   * `online`, or the link leaving and returning to `online`), then reads the link log (close or silence,
   * visible to Welcome), whether the page kept rendering and panning, and whether a dialog ever showed. The
   * reading goes to the **service**, which holds the run to +-30% of its time and says what comes next.
   */
  async function oneRun(item, mp) {
    const { next, lastRejected } = mp
    const net = next.kind === 'net'
    const secs = next.targetMs ? Math.round(next.targetMs / 100) / 10 : null
    const t = { left: 0, back: 0, offline: 0, online: 0, linkDown: 0, linkUp: 0 }
    const startedAt = Date.now()
    K.set('mp_run', JSON.stringify({ scenario: next.scenario, at: startedAt }))
    const r0 = readings()
    let dialog = false
    const scan = () => {
      if (document.querySelector(SCAN)) dialog = true
    }
    const sample = () => {
      scan()
      const r = readings()
      const fresh = r.link_log_n > r0.link_log_n // the log has grown since this run began
      if (!t.linkDown && (r.link !== 'online' || (fresh && /^(close|silence)$/.test(r.link_last))))
        t.linkDown = Date.now()
      else if (t.linkDown && !t.linkUp && r.link === 'online' && r.link_last === 'Welcome')
        t.linkUp = Date.now()
    }
    const onVis = () => {
      if (net) return
      if (document.hidden && !t.left) t.left = Date.now()
      else if (!document.hidden && t.left && !t.back) t.back = Date.now()
    }
    const onOff = () => {
      if (net && !t.offline) t.offline = Date.now()
    }
    const onOn = () => {
      if (net && t.offline && !t.online) t.online = Date.now()
    }
    document.addEventListener('visibilitychange', onVis)
    addEventListener('offline', onOff)
    addEventListener('online', onOn)
    const left = () => (sample(), net ? !!(t.offline || t.linkDown) : t.left > 0)
    const returned = () => (sample(), net ? !!(t.online || (t.linkDown && t.linkUp)) : t.back > 0)
    const prefix = lastRejected
      ? `That run was ${Math.round((lastRejected.ms ?? 0) / 100) / 10} s, outside the time asked for. Once more. `
      : ''
    const seen = await ask(item, {
      text: `${prefix}Drop ${next.run} of ${next.of} (${next.scenario}): ${next.text.replace('{s}', String(secs))}`,
      detect: { left, returned },
      timeoutMs: Math.max(item.opts.actTimeoutMs, (next.targetMs || 0) * 4),
    })
    document.removeEventListener('visibilitychange', onVis)
    removeEventListener('offline', onOff)
    removeEventListener('online', onOn)
    if (!seen) return false
    const leftAt = net ? t.offline || t.linkDown : t.left
    const backAt = net ? t.online || t.linkUp : t.back
    // The Welcome: wait for the link, give the page a second of frames, then read the log.
    await waitFor(() => readings().link === 'online', 15_000, 100)
    await sleep(1200)
    scan()
    const r1 = readings()
    const log = await act('linkLog')
    const mine = log.events.filter((e) => e.t >= startedAt)
    const drop = mine.find((e) => e.state !== 'online')
    const welcome = drop && mine.find((e) => e.state === 'online' && e.t >= drop.t)
    const rows = log.rows.slice(0, Math.max(0, log.rows.length - r0.link_log_n))
    const first = (ev) => rows.findLast((x) => x.event === ev)
    const dropped = !!drop || rows.some((x) => x.event === 'close' || x.event === 'silence')
    const refBack = net ? t.online : t.back // the moment "visible" (or "online") happened
    const data = {
      scenario: next.scenario,
      run: next.run,
      ms: backAt && leftAt ? backAt - leftAt : null,
      dropped,
      survived: !dropped,
      welcomeMs: drop ? (welcome ? (refBack ? welcome.t - refBack : null) : 999_999) : null,
      outageMs: drop && welcome ? welcome.t - drop.t : null,
      neverOnline: !!drop && !welcome,
      closeMs: first('close') ? Math.round(first('close').msSinceVisible) : null,
      silenceMs: first('silence') ? Math.round(first('silence').msSinceVisible) : null,
      discarded: rows.some((x) => x.discarded) || r1.was_discarded === true,
      interactive: r1.frames - r0.frames >= 5 && Math.abs(r1.centre_x - r0.centre_x) > 0,
      dialog,
      rows: clone(rows),
    }
    await A.sendAndWait('reading', { id: item.id, n: item.n, key: 'run', data })
    K.set('mp_run', null)
    return true
  }

  const MP = {
    /** M29-socket-resume and M29-play-through-drop: the service's choreography, run by run, to the end. */
    async drops(item) {
      if (!(await ready(item))) return null
      await waitFor(() => readings().link === 'online', item.opts.timeoutMs, 100)
      const cut = K.json(K.get('mp_run'), null)
      if (cut) {
        // The page was reloaded in the middle of a run (iOS discarded it): that run is a discard, and
        // the Welcome is the one this document got.
        K.set('mp_run', null)
        await A.sendAndWait('reading', {
          id: item.id,
          n: item.n,
          key: 'run',
          data: {
            scenario: cut.scenario,
            ms: null,
            discarded: true,
            dropped: true,
            survived: false,
            welcomeMs: Math.round(performance.now()),
            interactive: true,
            dialog: false,
          },
        })
      }
      for (;;) {
        const mp = live(item).state?.mp
        if (!mp) {
          await sleep(300)
          continue
        }
        if (!mp.next)
          return { ready: true, runs: mp.accepted, reloads: 0, errors: errors(), final: readings() }
        if (!(await oneRun(item, mp))) return null
        await sleep(300) // the ack's step carries the service's verdict on that run
      }
    },
    /** M29-net-heap: the whole window, four Paints a second of steady traffic. */
    async netheap(item) {
      // Over a tunnel the agent attaches before the page has booted (`check.act` and `check.ready` are set
      // after `client.ready`) and before the link is Welcomed: wait for both, and report which one failed.
      if (
        !(await ready(item)) ||
        !(await waitFor(() => readings().link === 'online', item.opts.timeoutMs, 100))
      )
        return { ready: false, why: notReadyWhy(), errors: errors() }
      let paints = 0
      const m = await measureWindow(item, async () => {
        for (let k = 0; k < 4; k++) {
          A.task('paint')
          await act('paint', { x: 50 + (paints % 30), y: 50 + (paints % 11) })
          paints++
        }
      })
      if (!m) return null
      return {
        ready: true,
        windows: [m.window],
        steady: m.steady,
        paints,
        reloads: 0,
        errors: errors(),
      }
    },
  }

  K.collectors.slice = async (item) => {
    if (!(await ready(item))) return { ready: false }
    return SLICE[item.plan.mode](item)
  }
  K.collectors.world = (item) => WORLD[item.plan.mode](item)
  K.collectors.mp = (item) => MP[item.plan.mode](item)
  K.life = { leave, ready, errors, act, say, isCurrent, SLICE, WORLD, MP }
})()
