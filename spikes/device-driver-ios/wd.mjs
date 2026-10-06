// Minimal W3C WebDriver client for `safaridriver -p 4630` driving the iPhone (spike; plain Node 22).
export const BASE = process.env.SD ?? 'http://127.0.0.1:4630'
export const UDID = '00008101-001845EE1A82001E'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const j = await r.json()
  if (j.value?.error) throw new Error(`${method} ${path}: ${j.value.error}: ${j.value.message}`)
  return j.value
}
export async function newSession() {
  const v = await call('POST', '/session', { capabilities: { alwaysMatch: { platformName: 'iOS', browserName: 'safari', 'safari:deviceUDID': UDID } } })
  return new Session(v.sessionId)
}
export class Session {
  constructor(id) { this.id = id; this.p = `/session/${id}` }
  get(url) { return call('POST', this.p + '/url', { url }) }
  js(script, ...args) { return call('POST', this.p + '/execute/sync', { script, args }) }
  async jsAsync(script, ...args) { return call('POST', this.p + '/execute/async', { script, args }) }
  actions(a) { return call('POST', this.p + '/actions', { actions: a }) }
  release() { return call('DELETE', this.p + '/actions') }
  async screenshot(file) { const b = await call('GET', this.p + '/screenshot'); (await import('node:fs')).writeFileSync(file, Buffer.from(b, 'base64')) }
  end() { return call('DELETE', this.p) }
  readings() { return this.js('return window.__check ? JSON.stringify(window.__check.readings()) : null').then((s) => s && JSON.parse(s)) }
}
// touch pointer helpers: sequences of [{type:'pointerMove',x,y,duration}...]
export const finger = (id, steps) => ({ type: 'pointer', id, parameters: { pointerType: 'touch' }, actions: steps })
export const down = () => ({ type: 'pointerDown', button: 0 })
export const up = () => ({ type: 'pointerUp', button: 0 })
export const mv = (x, y, duration = 0) => ({ type: 'pointerMove', duration, x: Math.round(x), y: Math.round(y), origin: 'viewport' })
export const pause = (duration) => ({ type: 'pause', duration })
