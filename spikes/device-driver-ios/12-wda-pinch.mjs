import { appiumSession, timed, sleep } from './ap.mjs'
const [u, out] = process.argv.slice(2)
const s = await appiumSession()
const web = async () => { const c = (await s.get('/contexts')).filter((x) => x.startsWith('WEBVIEW')); for (const w of c) { await s.post('/context', { name: w }); const h = await s.post('/execute/sync', { script: 'return location.href', args: [] }).catch(() => ''); if (String(h).includes('device.html')) return w } throw new Error('no webview') }
const native = () => s.post('/context', { name: 'NATIVE_APP' })
const js = (src) => s.post('/execute/sync', { script: src, args: [] })
const rd = async (t) => { const r = JSON.parse(await js('return JSON.stringify(window.__check.readings())')); console.log(t.padEnd(30), r.tiles_across, r.centre_x, r.centre_y); return r }
const evs = async () => { const a = JSON.parse(await js('return JSON.stringify(__ev.splice(0))')); const k = {}; for (const e of a) k[e[0]] = (k[e[0]] ?? 0) + 1; console.log('  events', JSON.stringify(k), 'ptrIds', [...new Set(a.filter(e=>e[0].startsWith('pointer')).map(e => e[2]))].length, 'scale/vv', await js('return visualViewport.scale')) }
const f = (id, steps) => ({ type: 'pointer', id, parameters: { pointerType: 'touch' }, actions: steps })
const mv = (x, y, duration = 0) => ({ type: 'pointerMove', duration, x, y, origin: 'viewport' })
const dn = { type: 'pointerDown', button: 0 }, upp = { type: 'pointerUp', button: 0 }
try {
  await native()
  await s.exec('mobile: deepLink', { url: u + '/device.html', bundleId: 'com.apple.mobilesafari' }); await sleep(6000)
  await web(); await rd('boot')
  await js(`window.__ev=[];const t0=performance.now();for(const t of ['pointerdown','pointermove','pointerup','pointercancel','touchstart','touchend','gesturestart','gesturechange','gestureend'])addEventListener(t,e=>__ev.push([t,Math.round(performance.now()-t0),e.pointerId??'',e.scale??'']),true)`)
  // native mobile: pinch
  await native(); await timed('mobile: pinch 2.5 v1', () => s.exec('mobile: pinch', { scale: 2.5, velocity: 1 })); await sleep(1200); await web(); await rd('after mobile:pinch'); await evs()
  // W3C two-finger (points: 390x844 viewport)
  const pinch = async (name, a0, b0, a1, b1, y = 420) => {
    await native()
    await timed(name, () => s.post('/actions', { actions: [f('f1', [mv(a0, y), dn, mv(a1, y, 600), upp]), f('f2', [mv(b0, y), dn, mv(b1, y, 600), upp])] }))
    await s.call?.('x')
    await sleep(1200); await web(); await rd(name); await evs()
  }
  await pinch('W3C pinch OUT 60->300 apart', 165, 225, 45, 345)
  await pinch('W3C pinch OUT again', 165, 225, 45, 345)
  await pinch('W3C pinch IN 300->40 apart', 45, 345, 175, 215)
  await pinch('W3C pinch IN again', 45, 345, 175, 215)
  await pinch('W3C pinch IN again', 45, 345, 175, 215)
  await native(); await timed('screenshot', () => s.shot(`${out}/c-pinch-end.png`))
} finally { await s.del().catch(() => {}) }
