import { appiumSession, timed, sleep, call } from './ap.mjs'
const [u, out] = process.argv.slice(2)
const s = await timed('new session (WDA already installed)', () => appiumSession())
const K = ['tiles_across', 'centre_x', 'centre_y', 'orientation', 'canvas_w', 'canvas_h', 'frames']
const web = async () => { const c = (await s.get('/contexts')).filter((x) => x.startsWith('WEBVIEW')); for (const w of c) { await s.post('/context', { name: w }); const h = await s.post('/execute/sync', { script: 'return location.href', args: [] }).catch(() => ''); if (String(h).includes('device.html')) return w } throw new Error('no device.html webview in ' + c) }
const native = () => s.post('/context', { name: 'NATIVE_APP' })
const js = async (src) => (await s.post('/execute/sync', { script: src, args: [] }))
const rd = async (t) => { const r = JSON.parse(await js('return JSON.stringify(window.__check.readings())')); const o = Object.fromEntries(K.map((k) => [k, r[k]])); console.log(t.padEnd(22), JSON.stringify(o)); return r }
try {
  await native()
  await timed('deepLink open device.html', () => s.exec('mobile: deepLink', { url: u + '/device.html', bundleId: 'com.apple.mobilesafari' }))
  await sleep(6000)
  console.log('contexts', JSON.stringify(await s.get('/contexts')))
  await timed('switch to WEBVIEW', web)
  console.log('url', await js('return location.href'), 'coi', await js('return crossOriginIsolated'))
  await rd('boot')
  await js(`window.__vis=[];document.addEventListener('visibilitychange',()=>__vis.push([document.visibilityState,Math.round(performance.now())]));window.__ori=[];addEventListener('resize',()=>__ori.push([innerWidth,innerHeight]))`)
  // rotate
  await native()
  await timed('rotate LANDSCAPE', () => s.post('/orientation', { orientation: 'LANDSCAPE' })); await sleep(2500)
  await web(); await rd('landscape'); console.log('  resize events', await js('return JSON.stringify(__ori)'))
  await native()
  await timed('rotate PORTRAIT', () => s.post('/orientation', { orientation: 'PORTRAIT' })); await sleep(2500)
  await web(); await rd('portrait again')
  // pinch
  await native()
  const pinch = async (name, scale, velocity) => {
    await timed(name, () => s.exec('mobile: pinch', { scale, velocity })); await sleep(1500)
    await web(); const r = await rd(name); await native(); return r
  }
  await pinch('pinch out scale 2.5', 2.5, 1)
  await pinch('pinch out scale 2.5', 2.5, 1)
  await pinch('pinch in scale 0.3', 0.3, -1)
  await pinch('pinch in scale 0.3', 0.3, -1)
  await pinch('pinch in scale 0.3', 0.3, -1)
  // Home and back
  await timed('press home', () => s.exec('mobile: pressButton', { name: 'home' })); await sleep(5000)
  await timed('activateApp Safari', () => s.exec('mobile: activateApp', { bundleId: 'com.apple.mobilesafari' })); await sleep(3000)
  await web().catch((e) => console.log('web ctx after return', e.message))
  console.log('  visibility events', await js('return JSON.stringify(__vis)').catch(String)); await rd('after return')
  await native()
  await timed('full screenshot', () => s.shot(`${out}/c-shot.png`))
} finally { await s.del().catch(() => {}) }
