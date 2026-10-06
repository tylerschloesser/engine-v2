// The iOS backend (M39j step 4): a USB iPhone running Safari, driven through Appium's XCUITest driver and its
// WebDriverAgent (spikes/device-driver-ios/RESULT.md leg C). Page JS runs in Appium's WEBVIEW context (the
// webview whose `location.href` is ours: Safari lists extension pages too); touches, rotation, Home, the
// Control Center and Settings go through the NATIVE_APP context, so every call names the context it needs and
// switches only when it must. Two-finger pinch is a W3C actions sequence of two touch pointers (the
// `mobile: pinch` command once opened Safari's tab overview). safaridriver is not used: it cannot pinch, it
// blocks the phone ("Guided Access") and it wipes storage between sessions.
//
// The first session after WDA is down takes up to about 4.5 min (it builds and launches the runner app): the
// client timeout is 15 min and `start()` is meant to be called early so the warm-up overlaps the servers.
// The phone is a test device with one rule this file keeps: the screen is never turned off or locked, and
// Airplane and Low Power are only ever toggled for a prompt and back off in `cleanup()`.
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotDrivable } from './backend.mjs'

const SAFARI = 'com.apple.mobilesafari'
const SETTINGS = 'com.apple.Preferences'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CAPS = {
  platformName: 'iOS',
  'appium:automationName': 'XCUITest',
  'appium:udid': '00008101-001845EE1A82001E',
  'appium:xcodeOrgId': 'Z5N9W23WW4',
  'appium:xcodeSigningId': 'Apple Development',
  'appium:updatedWDABundleId': 'com.tylerschloesser.WebDriverAgentRunner',
  'appium:allowProvisioningUpdates': true,
  'appium:bundleId': SAFARI,
  'appium:wdaLaunchTimeout': 240_000,
  'appium:wdaConnectionTimeout': 240_000,
  'appium:newCommandTimeout': 1800,
}

/** W3C touch pointers for `fingers` (screen points), each moving over `ms`, optionally repeated `count` times (a tap). */
export function pointerActions(fingers, ms, { hold = 0 } = {}) {
  return fingers.map((f, i) => ({
    type: 'pointer',
    id: `finger${i + 1}`,
    parameters: { pointerType: 'touch' },
    actions: [
      {
        type: 'pointerMove',
        duration: 0,
        x: Math.round(f.from.x),
        y: Math.round(f.from.y),
        origin: 'viewport',
      },
      { type: 'pointerDown', button: 0 },
      ...(hold ? [{ type: 'pause', duration: hold }] : []),
      {
        type: 'pointerMove',
        duration: Math.max(1, Math.round(ms)),
        x: Math.round(f.to.x),
        y: Math.round(f.to.y),
        origin: 'viewport',
      },
      { type: 'pointerUp', button: 0 },
    ],
  }))
}

/** A tap (or `count` taps 80 ms apart) as one actions sequence. */
export function tapActions(x, y, count = 1) {
  const acts = [
    { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y), origin: 'viewport' },
  ]
  for (let i = 0; i < count; i++) {
    if (i) acts.push({ type: 'pause', duration: 80 })
    acts.push(
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 40 },
      { type: 'pointerUp', button: 0 },
    )
  }
  return [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: acts }]
}

/** A JSON call to Appium with a long timeout (`node:http`: fetch's own headers timeout is 5 min). */
export function appiumCall(base, method, path, body, timeoutMs = 900_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base)
    const data = body === undefined ? null : JSON.stringify(body)
    const req = request(
      u,
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          let j
          try {
            j = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            return reject(new Error(`${method} ${path}: not JSON (HTTP ${res.statusCode})`))
          }
          if (j.value?.error)
            reject(
              new Error(
                `${method} ${path}: ${j.value.error}: ${String(j.value.message).slice(0, 300)}`,
              ),
            )
          else resolve(j.value)
        })
      },
    )
    req.on('timeout', () =>
      req.destroy(new Error(`${method} ${path}: timed out after ${timeoutMs} ms`)),
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

/**
 * @param {{ port?: number, call?: (method: string, path: string, body?: any) => Promise<any>, spawnAppium?: boolean,
 *   log?: (s: string) => void, sleep?: (ms: number) => Promise<void> }} [o] `call` replaces the HTTP client (unit test)
 */
export function createIosBackend(o = {}) {
  const log = o.log ?? (() => {})
  const wait = o.sleep ?? sleep
  const port = o.port ?? 4725
  const base = `http://127.0.0.1:${port}`
  const raw = o.call ?? ((m, p, b, t) => appiumCall(base, m, p, b, t))
  const st = {
    appium: null,
    sid: null,
    starting: null,
    context: null,
    webName: null,
    origins: new Set(),
    cal: new Map(), // `${w}x${h}` -> { offX, offY }
    lowPower: false,
    airplane: false,
    orientation: 'PORTRAIT',
    autolock: null, // the Auto-Lock label found before the round, set back by cleanup
  }
  const call = async (m, path, b, t) => {
    if (!process.env.IOS_TRACE) return raw(m, st.sid ? `/session/${st.sid}${path}` : path, b, t)
    const t0 = Date.now()
    const brief = JSON.stringify(b ?? '').slice(0, 90)
    try {
      const v = await raw(m, st.sid ? `/session/${st.sid}${path}` : path, b, t)
      log(
        `ios> ${m} ${path} ${brief} (${Date.now() - t0} ms) -> ${JSON.stringify(v)?.slice(0, 80)}`,
      )
      return v
    } catch (e) {
      log(
        `ios> ${m} ${path} ${brief} (${Date.now() - t0} ms) FAILED ${String(e.message).slice(0, 100)}`,
      )
      throw e
    }
  }
  const exec = (name, args = {}) => call('POST', '/execute/sync', { script: name, args: [args] })

  async function startAppium() {
    if (o.call || st.appium) return
    try {
      await appiumCall(base, 'GET', '/status', undefined, 3000)
      return // someone else's server: leave it running
    } catch {}
    st.appium = spawn('appium', ['-p', String(port)], { stdio: 'ignore' })
    for (let i = 0; i < 60; i++) {
      try {
        await appiumCall(base, 'GET', '/status', undefined, 2000)
        return
      } catch {
        await wait(500)
      }
    }
    throw new Error('ios: Appium did not come up')
  }

  /** Appium, then a session (WDA starts with it): up to about 4.5 min the first time. Idempotent. */
  function start() {
    st.starting ??= (async () => {
      await startAppium()
      log('ios: starting the Appium session (WDA may take minutes the first time)')
      const t0 = Date.now()
      // WDA sometimes fails to launch right after the last session ended (xcodebuild exit 65): stop what is left
      // of it and ask again, up to three times. Nothing of a check has run yet, so this is not a retry of a result.
      let v
      for (let attempt = 1; ; attempt++) {
        try {
          v = await raw('POST', '/session', { capabilities: { alwaysMatch: CAPS } })
          break
        } catch (e) {
          if (attempt >= 3 || !/WebDriverAgent|xcodebuild/i.test(String(e.message))) throw e
          log(`ios: WDA did not start (attempt ${attempt}): ${String(e.message).slice(0, 120)}`)
          try {
            spawnSync('pkill', ['-f', 'APPIUM_XCODEBUILD_WDA_MARKER'])
          } catch {}
          await wait(8000)
        }
      }
      st.sid = v.sessionId
      log(`ios: session ${st.sid} after ${Math.round((Date.now() - t0) / 1000)} s`)
    })()
    return st.starting
  }

  async function ctx(name) {
    if (st.context === name) return
    await call('POST', '/context', { name })
    st.context = name
  }
  const native = () => ctx('NATIVE_APP')

  /** The webview whose page is one of ours (Safari lists extension pages and other tabs too). */
  async function web() {
    await start()
    const names = (await call('GET', '/contexts')).filter((x) => String(x).startsWith('WEBVIEW'))
    for (const w of names) {
      try {
        await call('POST', '/context', { name: w }, 8000)
        st.context = w
        // A Safari extension's webview may never answer: a short timeout, then the next one.
        const href = await call(
          'POST',
          '/execute/sync',
          { script: 'return location.href', args: [] },
          8000,
        )
        log(`ios: ${w} is ${String(href).slice(0, 80)}`)
        if (st.origins.size === 0 || st.origins.has(new URL(href).origin)) {
          st.webName = w
          return w
        }
      } catch (e) {
        log(`ios: ${w}: ${String(e.message).slice(0, 100)}`)
      }
    }
    st.context = null
    st.webName = null
    throw new Error(`ios: no webview of ours among ${names.join(', ') || 'none'}`)
  }

  /**
   * Run an expression in our webview: the last one used while it still is ours, else look again. The names of
   * the webviews are reassigned as tabs come and go (a cached one once pointed at a Safari extension's page), so
   * every call checks the origin in the same script that runs the expression.
   */
  const page = async (js) => {
    await start()
    const origins = JSON.stringify([...st.origins])
    const script = `if (${origins}.length && !${origins}.includes(location.origin)) return { __wrongPage: location.href }\nreturn (${js})`
    const run = async () => {
      const v = await call('POST', '/execute/sync', { script, args: [] }, 60000)
      if (v && typeof v === 'object' && '__wrongPage' in v) throw new Error('wrong webview')
      return v
    }
    if (st.webName) {
      try {
        await ctx(st.webName)
        return await run()
      } catch (e) {
        if (
          /page threw|JavaScript|is not|undefined|SyntaxError/i.test(String(e.message)) &&
          !/wrong webview|context|session/i.test(String(e.message))
        )
          throw e
        st.webName = null
        st.context = null
      }
    }
    await web()
    return run()
  }

  /** Where the page's (0, 0) is on the screen, in points, learned by one tap the page never sees. */
  async function placement() {
    const m = await page(
      `({ w: innerWidth, h: innerHeight, sw: screen.width, sh: screen.height, s: visualViewport.scale })`,
    )
    const key = `${m.w}x${m.h}`
    if (!st.cal.has(key)) {
      const px = Math.round(m.sw / 2)
      const py = Math.round(m.sh / 2)
      let hit = null
      for (let attempt = 0; attempt < 3 && !hit; attempt++) {
        await page(`(() => {
        window.__driveCal = null
        const swallow = (e) => { e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault() }
        const opt = { capture: true, passive: false }
        const T = ['pointerdown','pointerup','pointercancel','click','touchstart','touchend','mousedown','mouseup','contextmenu']
        addEventListener('pointerdown', (e) => { window.__driveCal = [e.clientX, e.clientY] }, { capture: true })
        for (const t of T) addEventListener(t, swallow, opt)
        window.__driveCalOff = () => { for (const t of T) removeEventListener(t, swallow, opt) }
        return 1
      })()`)
        await native()
        await call('POST', '/actions', { actions: tapActions(px, py) })
        for (let i = 0; i < 20 && !hit; i++) {
          await wait(150)
          hit = await page('window.__driveCal')
        }
        await wait(300)
        await page('window.__driveCalOff && window.__driveCalOff()').catch(() => {})
      }
      if (!hit) {
        const f = join(tmpdir(), 'ios-calibration-failed.png')
        await api.screenshot(f).catch(() => {})
        throw new Error(`ios: the calibration tap did not reach the page (screenshot ${f})`)
      }
      st.cal.set(key, { offX: px - hit[0], offY: py - hit[1] })
      log(`ios: calibrated ${key}: page offset (${px - hit[0]}, ${py - hit[1]}) points`)
    }
    return st.cal.get(key)
  }
  const at = (cal, x, y) => ({ x: cal.offX + x, y: cal.offY + y })

  async function pressHome() {
    await native()
    await exec('mobile: pressButton', { name: 'home' })
  }
  const activate = async (bundleId) => {
    await native()
    await exec('mobile: activateApp', { bundleId })
  }

  const el = async (using, value) =>
    Object.values(await call('POST', '/element', { using, value }))[0]
  const tryEl = (using, value) => el(using, value).catch(() => null)

  /** Control Center, the connectivity page: open, tap the Airplane Mode tile, read it back, close. */
  async function airplaneTile(want) {
    await native()
    await exec('mobile: dragFromToForDuration', {
      duration: 0.3,
      fromX: 360,
      fromY: 2,
      toX: 360,
      toY: 500,
    })
    await wait(1200)
    const tile = await tryEl('accessibility id', 'Airplane Mode')
    const value = async () =>
      tile ? String(await call('GET', `/element/${tile}/attribute/value`)) : null
    const isOn = tile ? (await value()) === '1' : null
    if (isOn === null || isOn !== want) await exec('mobile: tap', { x: 194, y: 163 })
    await wait(1500)
    const after = tile ? await value() : null
    await pressHome()
    return after
  }

  /**
   * Close the tabs earlier rounds left in Safari (error pages of dead tunnels, "Device walk" runner pages):
   * every `deepLink` opens a tab, and a webview that hangs behind ten of them slowed the driver. Only tabs whose
   * title says so are closed; the person's own tabs are never touched. Returns how many were closed.
   */
  async function closeStaleTabs() {
    const stale = /trycloudflare|Cloudflare Tunnel|Can.t Open Page|^Device walk/
    await activate(SAFARI)
    await wait(1000)
    const overview = await tryEl('accessibility id', 'TabOverviewButton')
    if (overview) {
      await call('POST', `/element/${overview}/click`)
      await wait(1200)
    }
    const items = async () => {
      const src = await call('GET', '/source')
      const out = []
      for (const m of src.matchAll(
        /<XCUIElementTypeButton type="[^"]+" name="TabOverviewItemView[^"]*"([^>]*)>/g,
      )) {
        const g = (k) => new RegExp(`${k}="([^"]*)"`).exec(m[1])?.[1]
        out.push({ label: g('label') ?? '', x: Number(g('x')), y: Number(g('y')) })
      }
      return out
    }
    let closed = 0
    for (let round = 0; round < 80; round++) {
      const its = await items()
      const hit = its.find((i) => i.y > 100 && stale.test(i.label))
      if (hit) {
        await exec('mobile: tap', { x: hit.x + 145, y: hit.y + 8 })
        closed++
        await wait(700)
        continue
      }
      const before = JSON.stringify(its.map((i) => i.label))
      await exec('mobile: dragFromToForDuration', {
        duration: 0.3,
        fromX: 200,
        fromY: 600,
        toX: 200,
        toY: 250,
      })
      await wait(800)
      if (JSON.stringify((await items()).map((i) => i.label)) === before) break
    }
    const done = await tryEl('accessibility id', 'DoneButton')
    if (done) await call('POST', `/element/${done}/click`)
    log(`ios: closed ${closed} stale Safari tab(s)`)
    return closed
  }

  const api = {
    platform: 'ios',
    hideLagMs: 300,
    closeStaleTabs,
    start,
    /** A raw call inside the session (diagnostics and the odd one-off). */
    raw: (m, p, b) => call(m, p, b),
    exec,

    async open(url) {
      await start()
      st.origins.add(new URL(url).origin)
      if (!st.tabsClosed) {
        st.tabsClosed = true
        await closeStaleTabs().catch((e) =>
          log(`ios: closing stale tabs failed: ${String(e.message).slice(0, 100)}`),
        )
      }
      await native()
      await exec('mobile: deepLink', { url, bundleId: SAFARI })
      log(`ios: deepLink sent`)
      for (let i = 0; i < 60; i++) {
        try {
          await web()
          return
        } catch {
          await wait(500)
        }
      }
      throw new Error(`ios: Safari never showed ${url}`)
    },

    readPage: (js) => page(js),

    async viewport() {
      const m = await page(
        `({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, orientation: innerWidth > innerHeight ? 'landscape' : 'portrait' })`,
      )
      return m
    },

    async touch(fingers, durationMs) {
      const cal = await placement()
      await native()
      const f = fingers.map((x) => ({
        from: at(cal, x.from.x, x.from.y),
        to: at(cal, x.to.x, x.to.y),
      }))
      await call('POST', '/actions', { actions: pointerActions(f, durationMs) })
    },
    async swipe(x1, y1, x2, y2, durationMs) {
      return api.touch([{ from: { x: x1, y: y1 }, to: { x: x2, y: y2 } }], durationMs)
    },
    async tap(x, y, { count = 1 } = {}) {
      const cal = await placement()
      const p = at(cal, x, y)
      await native()
      await call('POST', '/actions', { actions: tapActions(p.x, p.y, count) })
    },

    async rotate(orientation) {
      await native()
      st.orientation = orientation === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT'
      await call('POST', '/orientation', { orientation: st.orientation })
      await wait(2500)
    },

    async home() {
      await pressHome()
    },
    async returnToBrowser() {
      await activate(SAFARI)
      await wait(800)
    },
    async relaunchBrowser(url) {
      await native()
      await exec('mobile: terminateApp', { bundleId: SAFARI })
      await wait(500)
      await api.open(url)
    },

    async setAirplane(on) {
      const v = await airplaneTile(on)
      st.airplane = on
      log(`ios: Airplane ${on ? 'on' : 'off'} (tile value ${v})`)
      await api.returnToBrowser()
    },

    /** Settings > Battery: the Low Power Mode switch (Control Center has no tile for it on this phone). */
    async setLowPower(on) {
      await activate(SETTINGS)
      await wait(800)
      const find = () => tryEl('accessibility id', 'LOW_POWER_MODE_IDENTIFIER_SWITCH')
      let sw = await find()
      for (let attempt = 0; !sw && attempt < 2; attempt++) {
        let row = await tryEl(
          '-ios predicate string',
          `label == 'Battery' AND type == 'XCUIElementTypeButton'`,
        )
        if (!row) {
          // Settings reopens on the page it was left on (another pane, or this one's sub-page): start it afresh.
          await native()
          await exec('mobile: terminateApp', { bundleId: SETTINGS })
          await wait(500)
          await activate(SETTINGS)
          await wait(1200)
          row = await tryEl(
            '-ios predicate string',
            `label == 'Battery' AND type == 'XCUIElementTypeButton'`,
          )
        }
        if (!row) continue
        await call('POST', `/element/${row}/click`)
        await wait(1500)
        sw = await find()
      }
      if (!sw) throw new Error('ios: no Low Power Mode switch')
      const value = async () => String(await call('GET', `/element/${sw}/attribute/value`))
      if ((await value()) !== (on ? '1' : '0')) await call('POST', `/element/${sw}/click`)
      await wait(2500)
      const v = await value()
      st.lowPower = on
      log(`ios: Low Power Mode ${on ? 'on' : 'off'} (switch value ${v})`)
      await pressHome()
      await api.returnToBrowser()
    },

    async screenshot(path) {
      await start()
      const b64 = await call('GET', '/screenshot')
      writeFileSync(path, Buffer.from(b64, 'base64'))
    },

    async cleanup() {
      const tried = async (name, f) => {
        try {
          await f()
        } catch (e) {
          log(`ios cleanup (${name}): ${String(e.message).split('\n')[0]}`)
        }
      }
      if (st.sid) {
        if (st.lowPower) await tried('low power', () => api.setLowPower(false))
        if (st.airplane) await tried('airplane', () => api.setAirplane(false))
        if (st.orientation !== 'PORTRAIT') await tried('rotation', () => api.rotate('portrait'))
        await tried('session', () => raw('DELETE', `/session/${st.sid}`))
        st.sid = null
      }
      if (st.appium) {
        st.appium.kill('SIGTERM')
        st.appium = null
        await wait(1500)
        // WDA's xcodebuild is Appium's child but outlives a killed Appium: stop it by its own marker.
        try {
          spawnSync('pkill', ['-f', 'APPIUM_XCODEBUILD_WDA_MARKER'])
        } catch {}
      }
      st.starting = null
      st.context = null
    },
  }
  return api
}
