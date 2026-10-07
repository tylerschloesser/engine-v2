// The pointer collectors (M39f step 9 and M11-gestures, docs/plan/39f-device-auto-runner.md): `device.html`
// as the person's fingers use it. `gestures` (M11-gestures) asks for each gesture of the item's Steps with a
// live "detected" tick from what the page and the pointer log can see; `anchors` (M18) walks the overlay
// page: the anchor probe under a scripted pan and zoom sweep (M18-anchors), the highlighted ring the person
// must tap (M18-pick), the tap and the drag (M18-touch-ghost). Plain JS, loaded by `driver.js` on demand
// (`/__walk/collect-touch.js`).
//
// Observer only: capture-phase passive listeners write scalars (no per-event allocation: this runs on the
// page's input path, `.claude/rules/hot-paths.md`), and every verdict is the service's, from `checks.mjs`.
// What stays the person's: whether the world point stays under the finger and the flick glides ("judge"),
// and, in M18-anchors, that nothing swims (compositor-side movement is invisible to JavaScript).
;(() => {
  const K = window.__walkKit
  if (!K || K.touchLoaded) return
  K.touchLoaded = true
  const { A, sleep, waitFor, readings, check, measureWindow, ask, orientation, clone } = K

  const ready = (item) => waitFor(() => check()?.ready, item.opts.timeoutMs)
  const errors = () => {
    try {
      return clone(check().errors())
    } catch {
      return []
    }
  }
  const act = (name, arg) => check().act[name](arg)
  /** CSS px per tile of a reading (`tiles_across` over the long side of the page). */
  const pxPerTile = (r) => Math.max(innerWidth, innerHeight) / r.tiles_across
  const dist = (a, b) => Math.hypot(a.centre_x - b.centre_x, a.centre_y - b.centre_y)

  /** The world tile coordinates under client point (x, y): `transform.ts` `screenToWorld` (the canvas fills the page). */
  function worldUnder(r, x, y) {
    const c = document.querySelector('canvas')?.getBoundingClientRect()
    const w = c ? c.width : innerWidth
    const h = c ? c.height : innerHeight
    const ppt = Math.max(w, h) / r.tiles_across
    return {
      x: r.centre_x + (x - (c ? c.left : 0) - w / 2) / ppt,
      y: r.centre_y + (y - (c ? c.top : 0) - h / 2) / ppt,
    }
  }

  // --- the pointer log ----------------------------------------------------------------------------
  /** Scalars only. `flickSpeed` is the speed (px/ms) of the last move before a lift; `panMs` the time one
   * finger spent moving; `pull` a down within 60 px of the top edge that moved 100 px down. */
  function pointerLog() {
    if (K.ptr) return K.ptr
    const st = {
      downs: 0,
      active: 0,
      maxTouches: 0,
      panMs: 0,
      cancels: 0,
      cancelPanMs: -1,
      flickSpeed: 0,
      glide: 0,
      pull: false,
      dbl: false,
      scrolled: 0,
      zoomed: 0,
      gestures: 0,
      lastX: 0,
      lastY: 0,
      lastT: 0,
      speed: 0,
      pullY0: -1,
      watch: false, // the pan step: the world point under the first finger, kept from touch-down
      wpX: 0,
      wpY: 0,
      wpOk: false,
      drift: 0,
      driftN: 0,
      downT: 0,
      downX: 0,
      downY: 0,
      upX: 0,
      upY: 0,
      upT: 0,
    }
    const opt = { capture: true, passive: true }
    addEventListener(
      'pointerdown',
      (e) => {
        st.downs++
        st.active++
        if (st.active > st.maxTouches) st.maxTouches = st.active
        st.lastX = e.clientX
        st.lastY = e.clientY
        st.lastT = e.timeStamp
        st.speed = 0
        if (st.watch && st.active === 1) {
          // Once per pan, at touch-down (a rare event, not the move path): the camera and so the world point.
          const w = worldUnder(readings(), e.clientX, e.clientY)
          st.wpX = w.x
          st.wpY = w.y
          st.wpOk = true
        }
        st.pullY0 = e.clientY < 60 ? e.clientY : -1
        if (
          st.downT &&
          e.timeStamp - st.downT < 350 &&
          Math.hypot(e.clientX - st.downX, e.clientY - st.downY) < 40
        )
          st.dbl = true
        st.downT = e.timeStamp
        st.downX = e.clientX
        st.downY = e.clientY
      },
      opt,
    )
    addEventListener(
      'pointermove',
      (e) => {
        if (st.active === 0) return
        const dt = e.timeStamp - st.lastT
        if (dt > 0) {
          st.speed = Math.hypot(e.clientX - st.lastX, e.clientY - st.lastY) / dt
          if (st.active === 1 && dt < 250) st.panMs += dt
        }
        st.lastX = e.clientX
        st.lastY = e.clientY
        st.lastT = e.timeStamp
        if (st.pullY0 >= 0 && e.clientY - st.pullY0 >= 100) st.pull = true
      },
      opt,
    )
    const lift = (e) => {
      if (e.type === 'pointercancel') {
        // Evidence only (M39aa): a browser that takes a drag for its own gesture cuts the stream here.
        st.cancels++
        if (st.cancelPanMs < 0) st.cancelPanMs = st.panMs
      }
      if (st.active > 0) st.active--
      st.upX = e.clientX
      st.upY = e.clientY
      st.upT = e.timeStamp
      if (e.timeStamp - st.lastT < 80 && st.speed > st.flickSpeed) {
        st.flickSpeed = st.speed
        const c0 = readings()
        setTimeout(() => {
          const c1 = readings()
          if (c0.centre_x !== undefined) st.glide = Math.max(st.glide, dist(c0, c1))
        }, 300)
      }
    }
    addEventListener('pointerup', lift, opt)
    addEventListener('pointercancel', lift, opt)
    addEventListener(
      'scroll',
      () => {
        if (window.scrollY !== 0 || window.scrollX !== 0) st.scrolled++
      },
      opt,
    )
    const vv = window.visualViewport
    const zoomed = () => {
      if (vv && Math.abs(vv.scale - 1) > 0.01) {
        st.zoomed++
      }
    }
    if (vv) {
      vv.addEventListener('resize', zoomed)
      vv.addEventListener('scroll', zoomed)
    }
    for (const g of ['gesturestart', 'gesturechange']) addEventListener(g, () => st.gestures++, opt)
    K.ptr = st
    return st
  }

  // --- the tap log (M39r) -------------------------------------------------------------------------
  /**
   * Where each tap's events landed: capture-phase `pointerdown`, `pointerup` and `click` into a fixed ring of
   * slots written in place (no object per event; the tag is the DOM's own string), so the log can stay on the
   * page's input path. `since(n)` copies the events after the count `n` out, once per tap, never per frame.
   * Finding 7: a Pixel tap that never reached the engine left `{actTimedOut}` and no clue where it went.
   */
  function tapLog() {
    if (K.tapLogger) return K.tapLogger
    const N = 24
    const slots = []
    for (let i = 0; i < N; i++)
      slots.push({ type: '', tag: '', id: '', x: 0, y: 0, sx: 0, sy: 0, pt: '', t: 0 })
    const st = { n: 0 }
    const opt = { capture: true, passive: true }
    const rec = (e) => {
      const s = slots[st.n % N]
      const t = e.target
      s.type = e.type
      s.tag = t && t.tagName ? t.tagName : ''
      s.id = t && t.id ? t.id : ''
      s.x = e.clientX
      s.y = e.clientY
      s.sx = e.screenX
      s.sy = e.screenY
      s.pt = e.pointerType || ''
      s.t = Math.round(e.timeStamp)
      st.n++
    }
    for (const type of ['pointerdown', 'pointerup', 'click']) addEventListener(type, rec, opt)
    /** The events after count `n` (the last `N` at most), oldest first, as plain objects. */
    st.since = (n) => {
      const out = []
      for (let i = Math.max(n, st.n - N); i < st.n; i++) out.push({ ...slots[i % N] })
      return out
    }
    K.tapLogger = st
    return st
  }
  /** The window and visual viewport (CSS px), once per tap: what an OS-touch offset could be made of. */
  function viewInfo() {
    const v = window.visualViewport
    return {
      inner: [innerWidth, innerHeight],
      outer: [outerWidth, outerHeight],
      dpr: devicePixelRatio,
      vv: v ? [v.offsetLeft, v.offsetTop, v.scale] : null,
      scroll: [scrollX, scrollY],
    }
  }
  /** The box of the nearest `<button>` to a client point, or null (the neighbour a touch adjustment snaps to). */
  function nearestButton(x, y) {
    let best = null
    let bd = Infinity
    for (const b of document.querySelectorAll('button')) {
      const q = b.getBoundingClientRect()
      if (q.width === 0) continue // display: none
      const d = Math.hypot(
        Math.max(q.left - x, 0, x - q.right),
        Math.max(q.top - y, 0, y - q.bottom),
      )
      if (d < bd) {
        bd = d
        best = { left: q.left, top: q.top, right: q.right, bottom: q.bottom }
      }
    }
    return best && { ...best, gapPx: +bd.toFixed(1) }
  }

  // --- M11-gestures -------------------------------------------------------------------------------
  /**
   * The seven gestures of M11-gestures' Steps, one sheet each with its own "detected" ticks. The data:
   * what the page did (`pointer`: scrolled, zoomed, reloaded), what the camera did (`camera`: zoom range,
   * the tapped tile, the centre across the rotation) and the readings. Whether the world point stays under
   * the finger and the flick glides is the judge prompt that follows.
   */
  async function gestures(item) {
    if (!(await ready(item))) return { ready: false }
    const P = pointerLog()
    const o = item.opts
    const r0 = readings()
    let tmin = r0.tiles_across
    let tmax = r0.tiles_across
    const track = setInterval(() => {
      const r = readings()
      if (r.tiles_across < tmin) tmin = r.tiles_across
      if (r.tiles_across > tmax) tmax = r.tiles_across
    }, 100)
    const panMs = o.panMs ?? 10_000
    const step = async (text, detect, extra) => {
      const seen = await ask(item, { text, detect, settleMs: 300, ...extra })
      return !!seen
    }
    const s0 = { ...P }
    const ok = []
    // 0019 §3: "the world point under the finger stays under it". Taken at touch-down, compared every 40 ms
    // with the point under the finger's latest position (off the input path: a timer, not an event).
    P.watch = true
    P.wpOk = false
    P.drift = 0
    P.driftN = 0
    const watcher = setInterval(() => {
      if (P.active !== 1 || !P.wpOk) return
      const w = worldUnder(readings(), P.lastX, P.lastY)
      P.drift = Math.max(P.drift, Math.hypot(w.x - P.wpX, w.y - P.wpY))
      P.driftN++
    }, 40)
    ok.push(
      await step(`Pan with one finger for about ${Math.round(panMs / 1000)} seconds.`, {
        panned: () => dist(r0, readings()) >= 2,
        'moving long enough': () => P.panMs - s0.panMs >= panMs,
      }),
    )
    clearInterval(watcher)
    P.watch = false
    ok.push(
      await step('Flick the world and let it glide to a stop.', {
        flicked: () => P.flickSpeed > 0.8,
        glided: () => P.glide > 0.3,
      }),
    )
    ok.push(
      await step('Pinch out to the furthest zoom, then in to the closest.', {
        // The page opens at its closest zoom, so out comes first; "in" is back from the furthest.
        'zoomed out': () => tmax >= r0.tiles_across * 1.33,
        'zoomed in': () => tmax >= r0.tiles_across * 1.33 && readings().tiles_across <= tmax * 0.75,
      }),
    )
    const taps0 = readings().taps
    ok.push(
      await step('Tap a tile.', {
        tapped: () => readings().taps > taps0 && readings().cursor_valid === true,
      }),
    )
    const tapAt = { x: P.upX, y: P.upY }
    await sleep(300)
    const tapped = readings()
    const expected = await act('tileUnder', tapAt).catch(() => null)
    ok.push(
      await step('Pull down from the very top edge of the page, then let go.', {
        'pulled down': () => P.pull,
      }),
    )
    ok.push(
      await step('Double-tap anywhere.', {
        'double-tapped': () => P.dbl,
        'page not zoomed': () => P.zoomed === 0,
      }),
    )
    // A glide still running would be counted as the rotation moving the centre: wait for the camera to rest.
    let rest = readings()
    await waitFor(
      () => {
        const now = readings()
        const still = dist(rest, now) < 0.01
        rest = now
        return still
      },
      10_000,
      400,
    )
    const first = orientation()
    const c0 = readings()
    ok.push(
      await step(`Rotate the phone to ${first === 'portrait' ? 'landscape' : 'portrait'}.`, {
        rotated: () => orientation() !== first,
      }),
    )
    await sleep(1500) // the layout and the canvas settle
    const c1 = readings()
    clearInterval(track)
    const moved = dist(c0, c1)
    return {
      ready: true,
      completed: ok.every(Boolean),
      steps_done: ok.filter(Boolean).length,
      steps: ok,
      reloads: 0,
      pointer: {
        pageScrolled: P.scrolled > 0,
        // The page zooming is the visual viewport's scale moving. WebKit sends `gesturestart`/`gesturechange`
        // for every two-finger touch (the engine's own pinch input, found on the iPhone in M39j), so the gesture
        // events are counted for the record and are not what "the page zoomed" means.
        pageZoomed: P.zoomed > 0,
        gestureEvents: P.gestures,
        downs: P.downs,
        maxTouches: P.maxTouches,
        panMs: Math.round(P.panMs),
        pointerCancels: P.cancels,
        firstCancelPanMs: P.cancelPanMs < 0 ? null : Math.round(P.cancelPanMs),
        worldPointDriftTiles: P.driftN > 0 ? +P.drift.toFixed(3) : null,
        worldPointSamples: P.driftN,
        flickSpeed: +P.flickSpeed.toFixed(2),
        glide: +P.glide.toFixed(2),
        pull: P.pull,
        doubleTap: P.dbl,
      },
      camera: {
        tilesMin: tmin,
        tilesMax: tmax,
        tilesAcrossChanged: tmax - tmin > 0.01 * tmax,
        tap: {
          tile: [tapped.tap_tile_x, tapped.tap_tile_y],
          cursor: [tapped.cursor_tile_x, tapped.cursor_tile_y],
          expected: expected ? [expected.tileX, expected.tileY] : null,
        },
        // "The flick glides and stops": the person's, asked next ("the world point stays under the finger" is measured).
        judged: `zoom ${tmin} to ${tmax} tiles across; flick glided ${P.glide.toFixed(1)} tiles`,
      },
      // In CSS px (tiles x px per tile): 4 px is a tiny shift at 256 tiles across and a big one at 12.
      rotation: {
        centreShiftTiles: +moved.toFixed(3),
        centreShiftPx: +(moved * pxPerTile(c1)).toFixed(1),
        // For the judge sheet: the number and its units.
        shown: `the centre moved ${moved.toFixed(2)} tiles (${(moved * pxPerTile(c1)).toFixed(1)} px) across the rotation`,
        from: first,
      },
      final: readings(),
      errors: errors(),
    }
  }

  // --- M18 ----------------------------------------------------------------------------------------
  /**
   * A ring drawn over the canvas where a tap must land (pointer-events none: it never takes a tap). `border-box`:
   * its border box is centred on (x, y), where the person and the driver aim (M39r: as a content box it was 52 px
   * from -22 px, 4 px right of and below the ring; on the Pixel 5 every driven tap landed there).
   */
  function highlight(x, y, pickRadiusPx) {
    let el = document.getElementById('walk-ring')
    if (!el) {
      el = document.createElement('div')
      el.id = 'walk-ring'
      el.style.cssText =
        'position:fixed;box-sizing:border-box;width:44px;height:44px;margin:-22px 0 0 -22px;border:4px solid #f0f;border-radius:50%;pointer-events:none;z-index:2147483646;box-shadow:0 0 0 2px #fff'
      document.body.append(el)
    }
    el.dataset.r = pickRadiusPx ? String(pickRadiusPx) : '' // the ring's pick radius: the driver stays inside it
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }
  const unhighlight = () => document.getElementById('walk-ring')?.remove()

  /** The walk bar's room at the bottom of the page while it asks (the sheet is about 90 px at a phone's width). */
  const BAR_RESERVE_PX = 170

  const ANCHORS = {
    /**
     * M18-anchors and its fill-rate sibling's anchor half: per orientation, a stretch with the scripted pan
     * and zoom sweep and the rAF recorder alone (the Pass line's "HUD rAF p95 during the pinch"), then one
     * with the per-frame anchor probe on (50 `getBoundingClientRect` reads a frame make a frame time of
     * their own, so the two are never measured together). The largest error and the jitter over every probe
     * frame are what the judge sees next to the question "no swim, text crisp".
     */
    async swim(item) {
      const first = orientation()
      const windows = []
      const steady = []
      let maxErr = 0
      let jitter = 0
      let frames = 0
      await act('sweep', { on: true })
      for (let w = 0; w < 2; w++) {
        if (w === 1) {
          await act('sweep', { on: false })
          const want = first === 'portrait' ? 'landscape' : 'portrait'
          const turned = await ask(item, {
            text: `Rotate the phone to ${want}.`,
            detect: { rotated: () => orientation() !== first },
            settleMs: 1500,
          })
          if (!turned) break
          await act('sweep', { on: true })
        }
        const a = await measureWindow(item)
        if (!a) return null
        windows.push(a.window)
        steady.push(...a.steady)
        await act('probe', { on: true, reset: true })
        const b = await measureWindow(item)
        await act('probe', { on: false })
        if (!b) return null
        const r = readings()
        maxErr = Math.max(maxErr, r.anchor_err_max_px)
        jitter = Math.max(jitter, r.anchor_jitter_px)
        frames += r.anchor_frames
        windows.push({ ...b.window, probe: true })
      }
      await act('sweep', { on: false })
      return {
        ready: true,
        windows,
        steady,
        anchors: { maxErrorPx: maxErr, jitterPx: jitter, frames },
        final: readings(),
        errors: errors(),
      }
    },

    /**
     * M18-pick: at three zoom levels the bar highlights up to three rings (the nearest the middle of the
     * screen) and the person taps each; `pick_id` must be that ring's id every time. Then a button: a tap
     * on it must leave `pick_id` and the tap count alone (it never reaches the canvas).
     */
    async pick(item) {
      /** An act timeout keeps what the page saw: the last events and the tap that was asked for (M39r). */
      const timedOut = (log, mark, want, done) => ({
        ready: true,
        actTimedOut: true,
        tapLog: {
          asked: want,
          events: log.since(0),
          sinceAsk: log.n - mark,
          tapsDone: done.length,
        },
        errors: errors(),
      })
      const levels = item.plan.levels || [40, 20, 12]
      const taps = []
      const skipped = []
      let misses = 0
      const L = tapLog()
      for (let z = 0; z < levels.length; z++) {
        await act('zoomTo', { tiles: levels[z], x: 0.5, y: 0.5 })
        await sleep(600)
        const cands = []
        for (let id = 1; id <= 50; id++) {
          const s = await act('ringScreen', { pickId: id })
          if (!s.visible) continue
          // A ring is asked for only when a finger can reach it: the canvas is what is at its centre, and the
          // walk's own prompt bar (fixed at the bottom while it asks) is clear of its tappable disc (M39r: a tap
          // on ring 36 at 12 tiles landed on the bar).
          const reach = 0.85 * 0.6 * pxPerTile(readings())
          const top = document.elementFromPoint(s.x, s.tapY)
          if (s.tapY + reach > innerHeight - BAR_RESERVE_PX || (top && top.tagName !== 'CANVAS')) {
            skipped.push({ id, zoom: levels[z], under: top ? top.tagName : null })
            continue
          }
          cands.push({ id, s, d: Math.hypot(s.x - innerWidth / 2, s.tapY - innerHeight / 2) })
        }
        cands.sort((a, b) => a.d - b.d)
        // Rings are 3 tiles apart: three that are not neighbours of each other give no ambiguity.
        const chosen = cands.slice(0, 3)
        for (let k = 0; k < chosen.length; k++) {
          const c = chosen[k]
          const before = readings().taps
          const mark = L.n
          const want = {
            id: c.id,
            zoom: levels[z],
            x: c.s.x,
            y: c.s.tapY,
            button: null,
            view: viewInfo(),
          }
          await act('ringPhase', { pickId: c.id }) // only this ring's button, lifted clear of it (M39r)
          want.button = nearestButton(c.s.x, c.s.tapY) // the visible one: where it ended up
          highlight(c.s.x, c.s.tapY, 0.6 * pxPerTile(readings()))
          const seen = await ask(item, {
            text: `Zoom ${z + 1} of ${levels.length}: tap the highlighted ring (${k + 1} of ${chosen.length}).`,
            detect: { tapped: () => readings().taps > before },
          })
          unhighlight()
          await act('ringPhase')
          if (!seen) return timedOut(L, mark, want, taps)
          await sleep(200)
          const got = readings().pick_id
          taps.push({ zoom: levels[z], expected: c.id, got, events: L.since(mark), at: want })
          if (got !== c.id) misses++
        }
      }
      // A button: a ring near the middle that has a visible button.
      await act('zoomTo', { tiles: levels[1] ?? 20, x: 0.5, y: 0.5 })
      await sleep(600)
      let target = null
      for (const id of [26, 27, 25, 36, 16]) {
        const b = await act('buttonScreen', { pickId: id })
        if (b && b.x > 10 && b.y > 10 && b.x < innerWidth - 10 && b.y < innerHeight - 10) {
          target = { id, b }
          break
        }
      }
      let buttonChanged = null
      if (target) {
        const before = readings()
        const mark = L.n
        let clicked = false
        const onClick = (e) => {
          if (e.target && e.target.closest && e.target.closest('button')) clicked = true
        }
        document.addEventListener('click', onClick, true)
        highlight(target.b.x, target.b.y)
        const seen = await ask(item, {
          text: `Tap the highlighted button (it is numbered ${target.id}).`,
          detect: { 'tapped the button': () => clicked },
        })
        document.removeEventListener('click', onClick, true)
        unhighlight()
        if (!seen)
          return timedOut(L, mark, { button: target.id, x: target.b.x, y: target.b.y }, taps)
        await sleep(400)
        const after = readings()
        buttonChanged = after.taps !== before.taps || after.pick_id !== before.pick_id
      }
      return {
        ready: true,
        pick: { misses, taps, skipped, buttonChanged, buttonTested: !!target },
        final: readings(),
        errors: errors(),
      }
    },

    /** M18-touch-ghost: a tap (the cursor tile must be the tile under the finger, worked out here from the
     * pointer's own position), then a drag (the centre must move). The ghost itself is the judge's. */
    async ghost(item) {
      const P = pointerLog()
      await act('zoomTo', { tiles: item.plan.tiles || 20, x: 0.5, y: 0.5 })
      await sleep(600)
      const t0 = readings()
      const seen = await ask(item, {
        text: 'Tap a tile (away from the little buttons).',
        detect: { tapped: () => readings().taps > t0.taps },
        settleMs: 400,
      })
      if (!seen) return null
      const r = readings()
      // The tile the driver (or the finger) tapped: the tile under the up point, worked out by the page itself.
      const expected = await act('tileUnder', { x: P.upX, y: P.upY })
      // The ghost (M18-touch-ghost): is it in the draw list, and is the tile it is anchored to the tapped one.
      const g = await act('ghost')
      const c0 = readings()
      const dragged = await ask(item, {
        text: 'Now drag the map with one finger.',
        detect: { dragged: () => dist(c0, readings()) >= 1 },
      })
      return {
        ready: true,
        ghost: {
          tileMatches:
            r.cursor_valid === true &&
            r.cursor_tile_x === expected.tileX &&
            r.cursor_tile_y === expected.tileY,
          cursor: [r.cursor_tile_x, r.cursor_tile_y],
          expected: [expected.tileX, expected.tileY],
          tapped: `tapped tile ${expected.tileX},${expected.tileY}; ghost anchored to ${g.cursor ? g.cursor.join(',') : 'none'}`,
          drawn: g.drawn === true && g.anchored === true,
          onTapped:
            g.drawn === true &&
            g.anchored === true &&
            !!g.cursor &&
            g.cursor[0] === expected.tileX &&
            g.cursor[1] === expected.tileY,
          centreMoved: !!dragged,
        },
        final: readings(),
        errors: errors(),
      }
    },
  }

  K.collectors.gestures = gestures
  K.collectors.anchors = async (item) => {
    if (!(await ready(item))) return { ready: false }
    return ANCHORS[item.plan.mode](item)
  }
  K.touch = { pointerLog, gestures, ANCHORS, highlight, tapLog, nearestButton }
})()
