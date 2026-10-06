// The Android backend (M39j step 2): a USB Pixel running Chrome, driven by `adb` and raw CDP
// (spikes/device-driver-android/RESULT.md; lib.mjs is where this began). One finger is real OS input
// (`adb shell input`: pan, flick, tap, pull-down reach the page as kernel-timed touch events, which is how
// the flick-direction finding of M39i was made); two fingers are CDP `Input.dispatchTouchEvent` (an OS
// multi-touch injector needs root); rotation, Home, relaunch, Airplane are `settings`/`input`/`am`/`cmd`.
// The phone is a test device with one exception that this file enforces by never doing it: the screen is
// never turned off, locked or put to sleep, and the battery is never faked unplugged.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { NotDrivable } from './backend.mjs'
import { cdpConnect } from './cdp.mjs'

const CHROME = 'com.android.chrome'
const CHROME_MAIN = `${CHROME}/com.google.android.apps.chrome.Main`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** The one adb serial attached, or the one `ANDROID_SERIAL` names; throws when there is none or several. */
export function pickSerial(devicesOutput, wanted) {
  const serials = devicesOutput
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter(([, state]) => state === 'device')
    .map(([s]) => s)
  if (wanted) {
    if (!serials.includes(wanted))
      throw new Error(`adb: no device ${wanted} (have: ${serials.join(', ') || 'none'})`)
    return wanted
  }
  if (serials.length !== 1)
    throw new Error(
      `adb: ${serials.length} devices attached (${serials.join(', ')}); set ANDROID_SERIAL`,
    )
  return serials[0]
}

/**
 * CSS px of the page to physical screen px. `off*` is where the page's (0, 0) is on the screen in CSS px
 * (the status bar and toolbar above it, a camera cutout beside it); `dpr` is physical px per CSS px.
 */
export const toScreen = (cal, x, y) => ({
  x: Math.round((cal.offX + x) * cal.dpr),
  y: Math.round((cal.offY + y) * cal.dpr),
})

/**
 * The page's offset on the screen, without touching the page: Chrome's window is the whole screen
 * (`outerWidth/Height`), the page sits in it under the toolbar and above the chin below it: 0.5 CSS px for a
 * page that asks for `viewport-fit=cover` (drawn under the navigation bar), 24 for one that does not (Pixel 5).
 * Each kind's chin is learned once from one swallowed tap (`chin`); the toolbar hiding on a page that
 * scrolls is then followed by `innerHeight` alone.
 */
export const offsetsFor = (m, chin) => ({
  offX: m.outerWidth - m.innerWidth - (m.rightInset ?? 0),
  offY: m.outerHeight - m.innerHeight - chin,
  dpr: m.dpr,
})

/** The CDP touch events of two fingers moving in `steps` equal steps (`Input.dispatchTouchEvent` payloads). */
export function touchScript(fingers, steps) {
  const at = (f, k) => ({
    x: f.from.x + ((f.to.x - f.from.x) * k) / steps,
    y: f.from.y + ((f.to.y - f.from.y) * k) / steps,
  })
  const points = (k) =>
    fingers.map((f, id) => ({ ...at(f, k), id, radiusX: 8, radiusY: 8, force: 0.5 }))
  const out = [{ type: 'touchStart', touchPoints: points(0) }]
  for (let k = 1; k <= steps; k++) out.push({ type: 'touchMove', touchPoints: points(k) })
  out.push({ type: 'touchEnd', touchPoints: [] })
  return out
}

/**
 * @param {{ serial?: string, adb?: string, run?: (args: string[]) => string, runBuf?: (args: string[]) => Buffer,
 *   fetchJson?: (url: string) => Promise<any>, connect?: typeof cdpConnect, log?: (s: string) => void,
 *   sleep?: (ms: number) => Promise<void> }} [o] injectables are for the unit test (no phone)
 */
export function createAndroidBackend(o = {}) {
  const log = o.log ?? (() => {})
  const wait = o.sleep ?? sleep
  const adbBin = o.adb ?? process.env.ADB ?? 'adb'
  const connect = o.connect ?? cdpConnect
  const fetchJson = o.fetchJson ?? (async (u) => (await fetch(u)).json())
  let serial = o.serial ?? process.env.ANDROID_SERIAL
  const exec = (args, opt = {}) => execFileSync(adbBin, args, { encoding: 'utf8', ...opt })
  const run =
    o.run ??
    ((args) => {
      serial ??= pickSerial(exec(['devices']), undefined)
      return exec(['-s', serial, ...args])
    })
  const runBuf =
    o.runBuf ??
    ((args) => {
      serial ??= pickSerial(exec(['devices']), undefined)
      return execFileSync(adbBin, ['-s', serial, ...args], { maxBuffer: 64 << 20 })
    })
  const sh = (cmd) => run(['shell', cmd]).trim()

  const st = {
    port: null, // adb forward -> chrome_devtools_remote
    reversed: [],
    tab: null,
    origins: new Set(),
    chin: {}, // by page kind: `cover` (viewport-fit=cover: drawn under the navigation bar) or `plain`
    saved: null,
    airplaneOn: false,
  }

  function ensureForward() {
    if (st.port) return st.port
    const out = run(['forward', 'tcp:0', 'localabstract:chrome_devtools_remote']).trim()
    st.port = Number(out)
    if (!Number.isInteger(st.port)) throw new Error(`adb forward gave "${out}"`)
    return st.port
  }

  /** Never leave the screen off (Tyler): a wake key is the one key this driver ever sends toward power. */
  function keepAwake() {
    const w = /mWakefulness=(\w+)/.exec(sh('dumpsys power'))?.[1]
    if (w && w !== 'Awake') {
      sh('input keyevent KEYCODE_WAKEUP')
      log(`android: the screen was ${w}; woke it`)
      return true
    }
    return false
  }

  const pages = async () =>
    (await fetchJson(`http://127.0.0.1:${ensureForward()}/json`)).filter(
      (t) => t.type === 'page' && /^https?:/.test(t.url),
    )

  async function visible(t) {
    try {
      const c = await connect(t.webSocketDebuggerUrl, { timeoutMs: 1500 })
      try {
        return (await c.evaluate('document.visibilityState')) === 'visible'
      } finally {
        c.close()
      }
    } catch {
      return false
    }
  }

  /** The walk's tab: the remembered one, else the visible page on one of our origins, else any such page. */
  async function pageTarget() {
    const list = await pages()
    const mine = list.find((t) => t.id === st.tab)
    if (mine) return mine
    const ours = list.filter((t) => st.origins.size === 0 || st.origins.has(new URL(t.url).origin))
    const flags = await Promise.all(ours.map(visible))
    const t = ours.find((_, i) => flags[i]) ?? ours[0]
    if (!t) throw new Error('android: no page of ours in Chrome')
    st.tab = t.id
    return t
  }

  async function withPage(fn) {
    const t = await pageTarget()
    if (process.env.ANDROID_TRACE) log(`android> page ${t.id.slice(0, 6)} ${t.url.slice(0, 90)}`)
    const c = await connect(t.webSocketDebuggerUrl)
    try {
      return await fn(c)
    } finally {
      c.close()
    }
  }

  const intentOpen = (url) => sh(`am start -a android.intent.action.VIEW -d ${q(url)} ${CHROME}`)

  async function attachTo(url) {
    const origin = new URL(url).origin
    st.origins.add(origin)
    const before = new Set((await pages().catch(() => [])).map((t) => t.id))
    st.tab = null
    for (let i = 0; i < 60; i++) {
      const list = (await pages().catch(() => [])).filter((t) => new URL(t.url).origin === origin)
      const fresh = list.find((t) => !before.has(t.id)) ?? list[0]
      if (fresh) {
        st.tab = fresh.id
        return
      }
      await wait(500)
    }
    throw new Error(`android: Chrome never showed ${origin}`)
  }

  /** Pixels the page's measure says it has, plus what is needed to place a finger. */
  const measure = () =>
    withPage((c) =>
      c.evaluate(
        `({ innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio, scale: visualViewport.scale, kind: /viewport-fit\\s*=\\s*cover/.test(document.querySelector('meta[name=viewport]')?.content ?? '') ? 'cover' : 'plain', orientation: innerWidth > innerHeight ? 'landscape' : 'portrait' })`,
      ),
    )

  /**
   * One tap the page never sees (capture-phase listeners swallow its events) to learn the chin: where a
   * known physical point lands in client coordinates. Done once per page kind per backend, on the first gesture
   * the person makes on a page of that kind (the runner page for the fixture app, which has no gesture logs).
   */
  async function learnChin() {
    const m = await measure()
    const px = Math.round((m.outerWidth * m.dpr) / 2)
    const py = Math.round((m.outerHeight * m.dpr) / 2)
    const hit = await withPage(async (c) => {
      await c.evaluate(`(() => {
        window.__driveCal = null
        const swallow = (e) => { e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault() }
        const opt = { capture: true, passive: false }
        window.__driveCalOff = () => {
          for (const t of ['pointerdown','pointerup','pointercancel','click','touchstart','touchend','mousedown','mouseup','contextmenu']) removeEventListener(t, swallow, opt)
        }
        addEventListener('pointerdown', (e) => { window.__driveCal = { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY } }, { capture: true })
        for (const t of ['pointerdown','pointerup','pointercancel','click','touchstart','touchend','mousedown','mouseup','contextmenu']) addEventListener(t, swallow, opt)
      })()`)
      sh(`input tap ${px} ${py}`)
      let got = null
      for (let i = 0; i < 20 && !got; i++) {
        await wait(100)
        got = await c.evaluate('window.__driveCal')
      }
      await wait(300)
      await c.evaluate('window.__driveCalOff && window.__driveCalOff()')
      return got
    })
    if (!hit) throw new Error('android: the calibration tap did not reach the page')
    // The tap was at (px, py) physical = (px/dpr, py/dpr) CSS in screen space; client = screen - offset.
    const offY = py / m.dpr - hit.y
    st.chin[m.kind] = m.outerHeight - m.innerHeight - offY
    log(
      `android: calibrated a ${m.kind} page, chin ${st.chin[m.kind].toFixed(1)} css px, page offset y ${offY.toFixed(1)}, x ${(px / m.dpr - hit.x).toFixed(1)}`,
    )
  }

  async function placement() {
    let m = await measure()
    if (st.chin[m.kind] === undefined) {
      await learnChin()
      m = await measure()
    }
    return offsetsFor(m, st.chin[m.kind])
  }

  const api = {
    platform: 'android',
    // Home to the page's `hidden` event, measured on the Pixel 5 (a 5 s wait showed 4.35 s of absence).
    hideLagMs: 650,
    /** Ports the phone reaches on this Mac's loopback (`adb reverse`): the fixture servers of a no-tunnel round. */
    async reverse(ports) {
      for (const p of ports) {
        run(['reverse', `tcp:${p}`, `tcp:${p}`])
        st.reversed.push(p)
      }
    },

    async open(url) {
      keepAwake()
      sh(`am force-stop ${CHROME}`)
      await wait(300)
      intentOpen(url)
      await attachTo(url)
      keepAwake()
    },

    async readPage(js) {
      return withPage((c) => c.evaluate(js))
    },

    /** The page's measure (CSS px) and where a point of it is on the screen; for the person and the tests. */
    async viewport() {
      const m = await measure()
      return { width: m.innerWidth, height: m.innerHeight, dpr: m.dpr, orientation: m.orientation }
    },

    async swipe(x1, y1, x2, y2, durationMs) {
      const cal = await placement()
      const a = toScreen(cal, x1, y1)
      const b = toScreen(cal, x2, y2)
      sh(`input swipe ${a.x} ${a.y} ${b.x} ${b.y} ${Math.max(1, Math.round(durationMs))}`)
    },

    /** `count: 2` is two taps in one shell command (about 100 ms apart on the phone, inside a double-tap). */
    async tap(x, y, { count = 1 } = {}) {
      const cal = await placement()
      const a = toScreen(cal, x, y)
      sh(Array.from({ length: count }, () => `input tap ${a.x} ${a.y}`).join('; '))
    },

    async touch(fingers, durationMs) {
      if (fingers.length === 1) {
        const [f] = fingers
        return api.swipe(f.from.x, f.from.y, f.to.x, f.to.y, durationMs)
      }
      if (fingers.length !== 2) throw new Error('touch: one or two fingers')
      // Two fingers are injected inside Chrome (`pointerType: touch`, 2 pointers): OS multi-touch needs root.
      const steps = Math.max(8, Math.min(60, Math.round(durationMs / 30)))
      const script = touchScript(fingers, steps)
      const gap = durationMs / steps
      await withPage(async (c) => {
        for (const e of script) {
          const t0 = Date.now()
          await c.send('Input.dispatchTouchEvent', e)
          const left = gap - (Date.now() - t0)
          if (left > 1 && e.type === 'touchMove') await wait(left)
        }
      })
    },

    async rotate(orientation) {
      if (!st.saved)
        st.saved = {
          accel: sh('settings get system accelerometer_rotation'),
          user: sh('settings get system user_rotation'),
        }
      sh('settings put system accelerometer_rotation 0')
      sh(`settings put system user_rotation ${orientation === 'landscape' ? 1 : 0}`)
      await wait(500)
    },

    async home() {
      sh('input keyevent KEYCODE_HOME')
    },

    async returnToBrowser() {
      sh(`am start -n ${CHROME_MAIN}`)
      await wait(500)
      if (st.tab) {
        try {
          const list = await pages()
          if (list.some((t) => t.id === st.tab))
            await fetch(`http://127.0.0.1:${ensureForward()}/json/activate/${st.tab}`)
        } catch {}
      }
    },

    async relaunchBrowser(url) {
      return api.open(url)
    },

    async setAirplane(on) {
      sh(`cmd connectivity airplane-mode ${on ? 'enable' : 'disable'}`)
      st.airplaneOn = on
    },

    async setLowPower() {
      throw new NotDrivable(
        'Battery Saver does not engage while the Pixel is charging (low_power flips, the system keeps it off); faking a battery unplug turns the screen off and is not allowed',
      )
    },

    async screenshot(path) {
      writeFileSync(path, runBuf(['exec-out', 'screencap', '-p']))
    },

    async cleanup() {
      const tried = (f) => {
        try {
          f()
        } catch (e) {
          log(`android cleanup: ${String(e.message).split('\n')[0]}`)
        }
      }
      if (st.airplaneOn) tried(() => sh('cmd connectivity airplane-mode disable'))
      if (st.saved) {
        tried(() => sh(`settings put system user_rotation ${st.saved.user}`))
        tried(() => sh(`settings put system accelerometer_rotation ${st.saved.accel}`))
      }
      for (const p of st.reversed) tried(() => run(['reverse', '--remove', `tcp:${p}`]))
      if (st.port) tried(() => run(['forward', '--remove', `tcp:${st.port}`]))
      tried(() => keepAwake())
      Object.assign(st, { port: null, reversed: [], saved: null, airplaneOn: false })
    },
  }
  return api
}
