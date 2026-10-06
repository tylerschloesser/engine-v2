// Shared helpers for the Android device-driver spike: adb wrapper, CDP attach, readings.
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'

export const SERIAL = '13061FDD4002VN'
export const ADB = '/opt/homebrew/bin/adb'
export const PORT = 4610
export const URL_BASE = `http://localhost:${PORT}`

export function adb(...args) {
  return execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' })
}
export const sh = (cmd) => adb('shell', cmd).trim()
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function screencap(path) {
  const buf = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], {
    maxBuffer: 64 << 20,
  })
  import('node:fs').then((fs) => fs.writeFileSync(path, buf))
  return buf.length
}

export function setup() {
  execFileSync(ADB, ['-s', SERIAL, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`])
  execFileSync(ADB, ['-s', SERIAL, 'forward', 'tcp:9222', 'localabstract:chrome_devtools_remote'])
}
export function teardown() {
  for (const a of [['reverse', '--remove', `tcp:${PORT}`], ['forward', '--remove', 'tcp:9222']]) {
    try {
      execFileSync(ADB, ['-s', SERIAL, ...a])
    } catch {}
  }
}

/** Open `path` in Chrome by intent, attach over CDP, return {browser, page}. */
export async function open(path, { fresh = true } = {}) {
  const url = `${URL_BASE}/${path}`
  if (fresh) sh('am force-stop com.android.chrome')
  sh(`am start -a android.intent.action.VIEW -d '${url}' com.android.chrome`)
  let browser
  for (let i = 0; i < 40; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
      break
    } catch {
      await sleep(500)
    }
  }
  if (!browser) throw new Error('CDP attach failed')
  const pageUrl = (p) => p.url().startsWith(`${URL_BASE}/${path.split('?')[0]}`)
  let page
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find(pageUrl)
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('page not found')
  await page.waitForFunction(() => window.__check?.ready === true, null, { timeout: 60000 })
  return { browser, page }
}

export const readings = (page) => page.evaluate(() => window.__check.readings())
export const pick = (r, keys) => Object.fromEntries(keys.map((k) => [k, r[k]]))

/** Screen pixels per CSS pixel is dpr; the screen is 1080x2340 physical. */
export const SCREEN = { w: 1080, h: 2340 }

/** Attach to the already-open tab whose URL starts with URL_BASE (no navigation, no force-stop). */
export async function attach(match = URL_BASE) {
  setup()
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(match))
  if (!page) throw new Error('no page matching ' + match)
  return { browser, page }
}
export const swipe = (x1, y1, x2, y2, ms) => sh(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`)
export const tap = (x, y) => sh(`input tap ${x} ${y}`)

// ---- kernel-level multi-touch through sendevent on the touchscreen node (shell is in group `input`) ----
export const TOUCH_DEV = '/dev/input/event2' // "sec_touchscreen" on this Pixel 5; getevent -p to find it
/** Build a shell script that plays a pinch: two fingers on a horizontal line centred (cx, cy), half-gap d0 -> d1. */
export function pinchScript({ cx = 540, cy = 1400, d0 = 100, d1 = 400, steps = 20, stepMs = 16, id0 = 100 }) {
  const e = (t, c, v) => `sendevent ${TOUCH_DEV} ${t} ${c} ${v}`
  const syn = e(0, 0, 0)
  const out = []
  const pos = (slot, x, y) => [e(3, 47, slot), e(3, 53, x), e(3, 54, y), e(3, 58, 40), e(3, 48, 20)]
  // down
  out.push(e(3, 47, 0), e(3, 57, id0), e(3, 53, cx - d0), e(3, 54, cy), e(3, 58, 40), e(3, 48, 20), e(1, 330, 1), e(1, 325, 1), syn)
  out.push(e(3, 47, 1), e(3, 57, id0 + 1), e(3, 53, cx + d0), e(3, 54, cy), e(3, 58, 40), e(3, 48, 20), syn)
  for (let i = 1; i <= steps; i++) {
    const d = Math.round(d0 + ((d1 - d0) * i) / steps)
    out.push(...pos(0, cx - d, cy), ...pos(1, cx + d, cy), syn, `sleep ${stepMs / 1000}`)
  }
  out.push(e(3, 47, 0), e(3, 57, -1), e(3, 47, 1), e(3, 57, -1), e(1, 330, 0), e(1, 325, 0), syn)
  return out.join('; ')
}
export const pinch = (opts) => sh(pinchScript(opts))

/** Raw CDP (no Playwright): evaluate expressions in the first page whose URL starts with URL_BASE. Node 22 global WebSocket. */
export async function rawCdp(match = URL_BASE) {
  setup()
  const list = await (await fetch('http://127.0.0.1:9222/json')).json()
  const target = list.find((t) => t.type === 'page' && t.url.startsWith(match))
  if (!target) throw new Error('no target')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.error || r.result.exceptionDetails) throw new Error(JSON.stringify(r).slice(0, 200)); return r.result.result.value }
  return { send, evaluate, close: () => ws.close() }
}
