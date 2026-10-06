// Leg B + A: background Safari by launching Settings with pymobiledevice3, return to Safari, read page visibility + readings
import { newSession, sleep } from './wd.mjs'
import { spawnSync } from 'node:child_process'
const [u] = process.argv.slice(2)
const pm = (...a) => { const r = spawnSync('pymobiledevice3', ['developer', 'dvt', ...a], { encoding: 'utf8' }); if (r.status) throw new Error(r.stderr.slice(-400)); return r.stdout.trim() }
const dc = (b) => { const r = spawnSync('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', '00008101-001845EE1A82001E', b], { encoding: 'utf8' }); return (r.stdout + r.stderr).trim().split('\n').pop() }
const s = await newSession()
const vis = () => s.js('return [document.visibilityState, document.hidden, window.__check.readings().frames, window.__check.readings().tiles_across]').catch((e) => 'ERR ' + e.message.slice(0, 160))
try {
  await s.get(u + '/device.html'); await sleep(5000)
  console.log('start', JSON.stringify(await vis()))
  console.log('safari pid', pm('process-id-for-bundle-id', 'com.apple.mobilesafari'))
  await s.js(`window.__vis=[];document.addEventListener('visibilitychange',()=>__vis.push([document.visibilityState,Math.round(performance.now())]))`)
  console.log('launch Settings (devicectl) ->', dc('com.apple.Preferences'))
  await sleep(6000)
  console.log('while backgrounded', JSON.stringify(await vis()))
  console.log('launch Safari (devicectl) ->', dc('com.apple.mobilesafari'))
  await sleep(4000)
  console.log('returned', JSON.stringify(await vis()), 'events', await s.js('return JSON.stringify(__vis)').catch(String))
} finally { await s.end().catch(() => {}) }
