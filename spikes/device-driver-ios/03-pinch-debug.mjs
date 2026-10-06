import { newSession, sleep, finger, down, up, mv, pause } from './wd.mjs'
const [u] = process.argv.slice(2)
const s = await newSession()
try {
  await s.get(u + '/device.html'); await sleep(5000)
  await s.js(`window.__ev=[];const t0=performance.now();for(const t of ['pointerdown','pointermove','pointerup','pointercancel','touchstart','touchmove','touchend','gesturestart','gesturechange','gestureend'])addEventListener(t,e=>__ev.push([t,Math.round(performance.now()-t0),e.pointerId??'',Math.round(e.clientX??e.touches?.[0]?.clientX??-1),Math.round(e.clientY??-1),e.scale??'', e.touches?e.touches.length:'']),true)`)
  const pr = async (t) => { const r = await s.readings(); console.log(t, r.tiles_across, r.centre_x, r.centre_y) }
  await pr('before')
  const mode = process.argv[3] ?? 'slow'
  const ms = mode === 'slow' ? 800 : 300
  await s.actions([
    finger('f1', [mv(440, 900), down(), pause(100), mv(240, 900, ms), pause(100), up()]),
    finger('f2', [mv(540, 900), down(), pause(100), mv(740, 900, ms), pause(100), up()])])
  await sleep(1500)
  await pr('after')
  const ev = await s.js('return JSON.stringify(__ev)')
  const a = JSON.parse(ev); console.log(a.length, 'events; kinds', [...new Set(a.map(x=>x[0]))].join(','))
  console.log(a.filter(x=>x[0]!=='pointermove').map(x=>x.join(':')).join(' '))
  const mvs = a.filter(x=>x[0]==='pointermove'); console.log('pointermoves', mvs.length, 'ids', [...new Set(mvs.map(x=>x[2]))].join(','), mvs.slice(0,3).map(x=>x.join(':')).join(' '))
} finally { await s.end().catch(()=>{}) }
