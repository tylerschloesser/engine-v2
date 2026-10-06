// Minimal Appium/WDA client (spike). Appium on :4725, caps.json beside this file.
import { readFileSync } from 'node:fs'
export const AP = process.env.AP ?? 'http://127.0.0.1:4725'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export async function call(method, path, body) {
  const r = await fetch(AP + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const j = await r.json()
  if (j.value?.error) throw new Error(`${method} ${path}: ${j.value.error}: ${String(j.value.message).slice(0, 300)}`)
  return j.value
}
export const timed = async (name, f) => { const t = performance.now(); try { const v = await f(); console.log(`[${Math.round(performance.now() - t)} ms] ${name}`); return v } catch (e) { console.log(`[${Math.round(performance.now() - t)} ms] ${name} FAILED ${e.message}`); throw e } }
export async function appiumSession(extra = {}) {
  const caps = JSON.parse(readFileSync(new URL('./caps.json', import.meta.url)))
  Object.assign(caps.capabilities.alwaysMatch, extra)
  const v = await call('POST', '/session', caps)
  const p = `/session/${v.sessionId}`
  return { id: v.sessionId, p, get: (x) => call('GET', p + x), post: (x, b = {}) => call('POST', p + x, b), del: () => call('DELETE', p),
    exec: (name, args = {}) => call('POST', p + '/execute/sync', { script: name, args: [args] }),
    async shot(file) { writeFileSync(file, Buffer.from(await call('GET', p + '/screenshot'), 'base64')) } }
}
import { writeFileSync } from 'node:fs'
