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
      if (vv && Math.abs(vv.scale - 1) > 0.01) st.zoomed++
    }
    if (vv) {
      vv.addEventListener('resize', zoomed)
      vv.addEventListener('scroll', zoomed)
    }
    for (const g of ['gesturestart', 'gesturechange']) addEventListener(g, () => st.gestures++, opt)
    K.ptr = st
    return st
  }

  // --- M11-gestures -------------------------------------------------------------------------------
  /**
   * The seven gestures of M11-gestures' Steps, one sheet each with its own "detected" ticks. The data:
   * what the page did (`pointer`: scrolled, zoomed, reloaded), what the camera did (`camera`: zoom range,
   * the tapped tile, the centre across the rotation) and the readings. Whether the world point stays under
   * the finger and the flick glides is the judge prompt that follows.
   */
  async function gestures(item) {
    if (!(await ready(item))) return { ready: false, reloads: 0 }
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
    ok.push(
      await step(`Pan with one finger for about ${Math.round(panMs / 1000)} seconds.`, {
        panned: () => dist(r0, readings()) >= 2,
        'moving long enough': () => P.panMs - s0.panMs >= panMs,
      }),
    )
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
        'page not zoomed': () => P.zoomed === 0 && P.gestures === 0,
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
        pageZoomed: P.zoomed > 0 || P.gestures > 0,
        downs: P.downs,
        maxTouches: P.maxTouches,
        panMs: Math.round(P.panMs),
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
        // "The world point stays under the finger" and "the flick glides": the person's, asked next.
        judged: `zoom ${tmin} to ${tmax} tiles across; flick glided ${P.glide.toFixed(1)} tiles`,
      },
      // In CSS px (tiles x px per tile): 4 px is a tiny shift at 256 tiles across and a big one at 12.
      rotation: {
        centreShiftTiles: +moved.toFixed(3),
        centreShiftPx: +(moved * pxPerTile(c1)).toFixed(1),
        from: first,
      },
      final: readings(),
      errors: errors(),
    }
  }

  // --- M18 ----------------------------------------------------------------------------------------
  /** A ring drawn over the canvas where a tap must land (pointer-events none: it never takes a tap). */
  function highlight(x, y) {
    let el = document.getElementById('walk-ring')
    if (!el) {
      el = document.createElement('div')
      el.id = 'walk-ring'
      el.style.cssText =
        'position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border:4px solid #f0f;border-radius:50%;pointer-events:none;z-index:2147483646;box-shadow:0 0 0 2px #fff'
      document.body.append(el)
    }
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }
  const unhighlight = () => document.getElementById('walk-ring')?.remove()

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
      const levels = item.plan.levels || [40, 20, 12]
      const taps = []
      let misses = 0
      const P = pointerLog()
      void P
      for (let z = 0; z < levels.length; z++) {
        await act('zoomTo', { tiles: levels[z], x: 0.5, y: 0.5 })
        await sleep(600)
        const cands = []
        for (let id = 1; id <= 50; id++) {
          const s = await act('ringScreen', { pickId: id })
          if (s.visible)
            cands.push({ id, s, d: Math.hypot(s.x - innerWidth / 2, s.tapY - innerHeight / 2) })
        }
        cands.sort((a, b) => a.d - b.d)
        // Rings are 3 tiles apart: three that are not neighbours of each other give no ambiguity.
        const chosen = cands.slice(0, 3)
        for (let k = 0; k < chosen.length; k++) {
          const c = chosen[k]
          const before = readings().taps
          highlight(c.s.x, c.s.tapY)
          const seen = await ask(item, {
            text: `Zoom ${z + 1} of ${levels.length}: tap the highlighted ring (${k + 1} of ${chosen.length}).`,
            detect: { tapped: () => readings().taps > before },
          })
          unhighlight()
          if (!seen) return null
          await sleep(200)
          const got = readings().pick_id
          taps.push({ zoom: levels[z], expected: c.id, got })
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
        if (!seen) return null
        await sleep(400)
        const after = readings()
        buttonChanged = after.taps !== before.taps || after.pick_id !== before.pick_id
      }
      return {
        ready: true,
        pick: { misses, taps, buttonChanged, buttonTested: !!target },
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
      const expected = await act('tileUnder', { x: P.upX, y: P.upY })
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
  K.touch = { pointerLog, gestures, ANCHORS, highlight }
})()
